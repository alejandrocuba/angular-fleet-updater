import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { commandExists, runCommand } from './exec.js';

export const WORKTREE_ROOT = '/tmp/ng-fleet';

const activeWorktrees = new Map<string, string>();

export interface PrDeliveryParams {
  worktreePath: string;
  repoName: string;
  branchName: string;
  baseRef: string;
  currentMajor: number;
  targetMajor: number;
  agentIntervened: boolean;
  aiModifiedFiles: string[];
}

export interface PrDeliveryResult {
  prUrl: string;
  created: boolean;
}

export function getWorktreePath(repoName: string): string {
  return path.join(WORKTREE_ROOT, repoName);
}

export async function cleanupAllActiveWorktrees(): Promise<void> {
  const entries = Array.from(activeWorktrees.entries());
  for (const [worktreePath, localPath] of entries) {
    await removeWorktree(localPath, worktreePath);
  }
}

export async function fetchOrigin(localPath: string): Promise<void> {
  const result = await runCommand('git', ['fetch', 'origin'], { cwd: localPath });
  if (result.exitCode !== 0) {
    throw new Error(
      `git fetch origin failed in "${localPath}" (exit ${result.exitCode}):\n${result.combined.trim()}`,
    );
  }
}

export async function resolveRemoteDefaultBranch(localPath: string): Promise<string> {
  const symbolic = await runCommand(
    'git',
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    { cwd: localPath },
  );

  if (symbolic.exitCode === 0) {
    const resolved = symbolic.stdout.trim();
    if (resolved.startsWith('origin/')) {
      return resolved;
    }
  }

  for (const candidate of ['origin/main', 'origin/master']) {
    const verify = await runCommand(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`],
      { cwd: localPath },
    );
    if (verify.exitCode === 0) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to determine remote default branch (origin/HEAD, origin/main, or origin/master) in "${localPath}".`,
  );
}

export async function readFileFromRef(
  localPath: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const result = await runCommand('git', ['show', `${ref}:${filePath}`], {
    cwd: localPath,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to read "${filePath}" from "${ref}" in "${localPath}": ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout;
}

export async function removeWorktree(
  localPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await runCommand('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: localPath,
    });
  } catch {
    // Best-effort removal; fall through to prune and fs.rm.
  }

  try {
    await runCommand('git', ['worktree', 'prune'], { cwd: localPath });
  } catch {
    // Ignore prune errors during cleanup.
  }

  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: failed to remove leftover directory "${worktreePath}": ${message}`);
  } finally {
    activeWorktrees.delete(worktreePath);
  }
}

export async function createWorktree(
  localPath: string,
  repoName: string,
  branchName: string,
  baseRef: string,
): Promise<string> {
  await mkdir(WORKTREE_ROOT, { recursive: true });
  const worktreePath = getWorktreePath(repoName);

  // Ensure any stale worktree registration or directory from an earlier crashed run is removed.
  await removeWorktree(localPath, worktreePath);

  const addResult = await runCommand(
    'git',
    ['worktree', 'add', '-B', branchName, worktreePath, baseRef],
    { cwd: localPath },
  );

  if (addResult.exitCode !== 0) {
    await removeWorktree(localPath, worktreePath);
    throw new Error(
      `git worktree add failed for "${repoName}" at "${worktreePath}" (branch "${branchName}" from "${baseRef}"):\n${addResult.combined.trim()}`,
    );
  }

  activeWorktrees.set(worktreePath, localPath);
  return worktreePath;
}

export async function withIsolatedWorktree<T>(
  localPath: string,
  repoName: string,
  branchName: string,
  baseRef: string,
  fn: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const worktreePath = await createWorktree(localPath, repoName, branchName, baseRef);
  try {
    return await fn(worktreePath);
  } finally {
    await removeWorktree(localPath, worktreePath);
  }
}

export async function getHeadSha(worktreePath: string): Promise<string> {
  const result = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed in "${worktreePath}": ${result.combined.trim()}`);
  }
  return result.stdout.trim();
}

export async function getGitDiff(worktreePath: string): Promise<string> {
  const [trackedDiff, untrackedFiles] = await Promise.all([
    runCommand('git', ['diff'], { cwd: worktreePath }),
    runCommand('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
    }),
  ]);

  const sections: string[] = [];
  const diffText = trackedDiff.stdout.trim();
  if (diffText.length > 0) {
    sections.push(diffText);
  }

  const untracked = untrackedFiles.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (untracked.length > 0) {
    sections.push(`Untracked files:\n${untracked.map((file) => `  + ${file}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

export async function snapshotWorkspaceState(
  worktreePath: string,
): Promise<Map<string, string>> {
  const statusResult = await runCommand(
    'git',
    ['status', '--porcelain=v1', '-uall', '-z'],
    { cwd: worktreePath },
  );

  if (statusResult.exitCode !== 0) {
    throw new Error(
      `git status failed in "${worktreePath}": ${statusResult.combined.trim()}`,
    );
  }

  const state = new Map<string, string>();
  const tokens = statusResult.stdout.split('\0');
  const changedPaths = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 4) {
      continue;
    }

    const statusCode = token.slice(0, 2);
    const filePath = token.slice(3);
    if (filePath.length > 0) {
      changedPaths.add(filePath);
    }

    // With -z, renames/copies include an additional NUL-delimited original path token.
    if (statusCode.includes('R') || statusCode.includes('C')) {
      const oldPath = tokens[index + 1];
      if (oldPath && oldPath.length > 0) {
        changedPaths.add(oldPath);
      }
      index += 1;
    }
  }

  for (const relativePath of changedPaths) {
    const fullPath = path.join(worktreePath, relativePath);
    try {
      const stats = await lstat(fullPath);
      if (stats.isDirectory()) {
        state.set(relativePath, 'DIR');
        continue;
      }
      if (stats.isSymbolicLink()) {
        state.set(relativePath, 'SYMLINK');
        continue;
      }
      const content = await readFile(fullPath);
      const digest = createHash('sha256').update(content).digest('hex');
      state.set(relativePath, digest);
    } catch {
      state.set(relativePath, 'DELETED');
    }
  }

  return state;
}

export function diffWorkspaceSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const allPaths = new Set<string>([...before.keys(), ...after.keys()]);
  const modified: string[] = [];

  for (const filePath of allPaths) {
    if (before.get(filePath) !== after.get(filePath)) {
      modified.push(filePath);
    }
  }

  return modified.sort((a, b) => a.localeCompare(b));
}

export async function hasPendingChanges(worktreePath: string): Promise<boolean> {
  const result = await runCommand('git', ['status', '--porcelain'], {
    cwd: worktreePath,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

function buildPrBody(params: PrDeliveryParams): string {
  const lines: string[] = [
    `## Angular Fleet Upgrade: \`${params.repoName}\``,
    '',
    `- **Upgrade Path:** \`@angular/core\` & \`@angular/cli\` **v${params.currentMajor} -> v${params.targetMajor}**`,
    `- **Base Ref:** \`${params.baseRef}\``,
    `- **Mode:** ${params.agentIntervened ? 'Deterministic upgrade + Bounded AI Remediation (Draft PR)' : 'Deterministic upgrade'}`,
    '- **Verification Gate:** Passed (`exit 0`)',
  ];

  if (params.agentIntervened) {
    lines.push('', '## AI-Modified Files');
    if (params.aiModifiedFiles.length === 0) {
      lines.push('- _No files were modified during agent remediation._');
    } else {
      for (const filePath of params.aiModifiedFiles) {
        lines.push(`- \`${filePath}\``);
      }
    }
  }

  return lines.join('\n');
}

export async function commitPushAndCreatePr(
  params: PrDeliveryParams,
): Promise<PrDeliveryResult> {
  if (!(await commandExists('gh'))) {
    throw new Error(
      'GitHub CLI ("gh") is required to open pull requests but was not found on PATH.',
    );
  }

  const title = `chore(deps): upgrade Angular from v${params.currentMajor} to v${params.targetMajor}`;
  const body = buildPrBody(params);

  const stageResult = await runCommand('git', ['add', '-A'], {
    cwd: params.worktreePath,
  });
  if (stageResult.exitCode !== 0) {
    throw new Error(`git add -A failed:\n${stageResult.combined.trim()}`);
  }

  const commitResult = await runCommand(
    'git',
    ['commit', '-m', title, '-m', body],
    { cwd: params.worktreePath },
  );
  if (commitResult.exitCode !== 0) {
    throw new Error(`git commit failed:\n${commitResult.combined.trim()}`);
  }

  const pushResult = await runCommand(
    'git',
    ['push', '-u', 'origin', params.branchName, '--force'],
    { cwd: params.worktreePath },
  );
  if (pushResult.exitCode !== 0) {
    throw new Error(`git push failed:\n${pushResult.combined.trim()}`);
  }

  const existingResult = await runCommand(
    'gh',
    ['pr', 'list', '--head', params.branchName, '--state', 'open', '--json', 'url'],
    { cwd: params.worktreePath },
  );

  if (existingResult.exitCode === 0) {
    try {
      const existingPrs = JSON.parse(existingResult.stdout) as Array<{ url?: string }>;
      const existingUrl = existingPrs[0]?.url;
      if (existingUrl) {
        await runCommand('gh', ['pr', 'edit', existingUrl, '--body', body], {
          cwd: params.worktreePath,
        });
        return { prUrl: existingUrl, created: false };
      }
    } catch {
      // Fall through to creating a new PR if listing output could not be parsed.
    }
  }

  const baseBranch = params.baseRef.startsWith('origin/')
    ? params.baseRef.slice('origin/'.length)
    : params.baseRef;

  const prArgs = [
    'pr',
    'create',
    '--title',
    title,
    '--body',
    body,
    '--base',
    baseBranch,
    '--head',
    params.branchName,
  ];

  if (params.agentIntervened) {
    prArgs.push('--draft');
  }

  const prResult = await runCommand('gh', prArgs, { cwd: params.worktreePath });
  if (prResult.exitCode !== 0) {
    throw new Error(`gh pr create failed:\n${prResult.combined.trim()}`);
  }

  return {
    prUrl: prResult.stdout.trim(),
    created: true,
  };
}
