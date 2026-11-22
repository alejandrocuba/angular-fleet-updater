import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FleetRepoConfig } from './config.js';
import {
  commandExists,
  runCommand,
  runShellCommand,
  type CommandOptions,
  type CommandResult,
} from './exec.js';
import {
  discardWorktreeChanges,
  getDirtyFiles,
  stashWorktreeChanges,
} from './git.js';
import {
  createCommandStreamCallbacks,
  type DirtyTreeAction,
  type RepoTaskLogger,
} from './ui.js';

export type ProjectFramework = 'angular' | 'analog';

export interface AngularVersionInfo {
  rawRange: string;
  major: number;
}

export interface LatestAngularInfo {
  version: string;
  major: number;
}

export interface DryRunRepoReport {
  name: string;
  localPath: string;
  framework: ProjectFramework;
  currentRaw: string | null;
  currentMajor: number | null;
  latestVersion: string;
  latestMajor: number;
  targetMajor: number | null;
  nodeVersion: string | null;
  status: 'upgrade-available' | 'up-to-date' | 'not-angular' | 'error';
  message?: string;
}

export interface VerificationGateResult {
  ok: boolean;
  failedStep?: 'build' | 'test';
  logs: string;
  failedStepLogs?: string;
  exitCode: number | null;
}

export interface DeterministicUpgradeResult {
  ok: boolean;
  framework?: ProjectFramework;
  failedStep?: 'install' | 'ng-update' | 'build' | 'test';
  skippedByUser?: boolean;
  cancelledByUser?: boolean;
  logs: string;
  failedStepLogs?: string;
  exitCode: number | null;
  nodeVersion: string | null;
}

const VALID_NODE_VERSION_REGEX = /^[a-zA-Z0-9._/-]+$/;
const SEMVER_LEADING_MAJOR_REGEX =
  /^(?:[\^~]|>=|<=|>|<|=)?v?(\d+)(?:\.(?:\d+|x|X|\*))?(?:\.(?:\d+|x|X|\*))?(?:[-+].*)?$/i;

export function parseMajorVersion(versionRange: string): number | null {
  const trimmed = versionRange.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const firstComparator = trimmed.split(/\s+/)[0] ?? '';
  const match = SEMVER_LEADING_MAJOR_REGEX.exec(firstComparator);
  if (!match?.[1]) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(major) || major < 0) {
    return null;
  }

  return major;
}

export function extractAngularCoreVersion(
  packageJsonContent: string,
): AngularVersionInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonContent) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid package.json JSON: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package.json root must be a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const deps =
    typeof record['dependencies'] === 'object' && record['dependencies'] !== null
      ? (record['dependencies'] as Record<string, unknown>)
      : undefined;
  const devDeps =
    typeof record['devDependencies'] === 'object' && record['devDependencies'] !== null
      ? (record['devDependencies'] as Record<string, unknown>)
      : undefined;

  const rawValue = deps?.['@angular/core'] ?? devDeps?.['@angular/core'];
  if (typeof rawValue !== 'string') {
    return null;
  }

  const major = parseMajorVersion(rawValue);
  if (major === null) {
    throw new Error(
      `Unable to parse numeric major version from "@angular/core": "${rawValue}".`,
    );
  }

  return {
    rawRange: rawValue,
    major,
  };
}

export function detectProjectFramework(
  packageJsonContent: string,
): ProjectFramework {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonContent) as unknown;
  } catch {
    return 'angular';
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'angular';
  }

  const record = parsed as Record<string, unknown>;
  for (const sectionName of ['dependencies', 'devDependencies'] as const) {
    const section = record[sectionName];
    if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
      for (const pkgName of Object.keys(section as Record<string, unknown>)) {
        if (pkgName === '@analogjs/platform' || pkgName.startsWith('@analogjs/')) {
          return 'analog';
        }
      }
    }
  }

  return 'angular';
}

export async function fetchLatestAngularVersion(
  overrideVersion?: string,
): Promise<LatestAngularInfo> {
  const explicit = overrideVersion ?? process.env['NG_LATEST_VERSION'];
  if (explicit && explicit.trim().length > 0) {
    const version = explicit.trim();
    const major = parseMajorVersion(version);
    if (major === null) {
      throw new Error(`Invalid Angular version override "${version}".`);
    }
    return { version, major };
  }

  const result = await runCommand('pnpm', ['view', '@angular/core', 'version']);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to query latest @angular/core version via pnpm (exit ${result.exitCode}):\n${result.combined.trim()}`,
    );
  }

  const version = result.stdout.trim();
  const major = parseMajorVersion(version);
  if (major === null) {
    throw new Error(`Unexpected "pnpm view @angular/core version" output: "${version}".`);
  }

  return { version, major };
}

export async function detectNodeVersion(repoDir: string): Promise<string | null> {
  for (const fileName of ['.nvmrc', '.node-version']) {
    const filePath = path.join(repoDir, fileName);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    const candidate = lines[0];
    if (!candidate) {
      continue;
    }

    if (candidate.startsWith('-') || !VALID_NODE_VERSION_REGEX.test(candidate)) {
      throw new Error(
        `Invalid Node version "${candidate}" in "${filePath}". Expected alphanumeric/semver/alias characters.`,
      );
    }

    return candidate;
  }

  return null;
}

export async function runInRepoEnv(
  cwd: string,
  nodeVersion: string | null,
  shellCommand: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    CI: 'true',
    NG_CLI_ANALYTICS: 'false',
  };

  if (nodeVersion !== null) {
    if (!(await commandExists('fnm'))) {
      throw new Error(
        `Repository specifies Node "${nodeVersion}" (.nvmrc/.node-version), but "fnm" is not installed or not on PATH.`,
      );
    }

    return runCommand(
      'fnm',
      ['exec', `--using=${nodeVersion}`, '--', 'sh', '-c', shellCommand],
      {
        ...options,
        cwd,
        env,
      },
    );
  }

  return runShellCommand(shellCommand, {
    ...options,
    cwd,
    env,
  });
}

async function runStreamedStep(
  repoLogger: RepoTaskLogger | undefined,
  label: string,
  cwd: string,
  nodeVersion: string | null,
  shellCommand: string,
): Promise<CommandResult> {
  const stepGroup = repoLogger?.startGroup(`${label}: ${shellCommand}`);
  const stream = repoLogger
    ? createCommandStreamCallbacks(repoLogger.repoName, (line, isErr) => {
        stepGroup?.message(isErr ? `[stderr] ${line}` : line);
      })
    : undefined;

  try {
    const result = await runInRepoEnv(cwd, nodeVersion, shellCommand, {
      ...(stream ? { onStdout: stream.onStdout, onStderr: stream.onStderr } : {}),
    });
    stream?.flush();
    if (stepGroup) {
      const secs = (result.durationMs / 1000).toFixed(1);
      if (result.exitCode === 0) {
        stepGroup.success(`${label} passed in ${secs}s`);
      } else {
        stepGroup.error(`${label} failed (exit ${result.exitCode ?? 'null'}) in ${secs}s`);
      }
    }
    return result;
  } catch (error) {
    stream?.flush();
    stepGroup?.error(`${label} error`);
    throw error;
  }
}

function formatStepLog(command: string, result: CommandResult): string {
  const statusLine = result.timedOut
    ? `[timed out after ${result.durationMs}ms]`
    : `[exit ${result.exitCode ?? 'null'} in ${result.durationMs}ms]`;
  return `=== $ ${command} ${statusLine} ===\n${result.combined.trimEnd()}\n`;
}

export async function runVerificationGate(
  cwd: string,
  nodeVersion: string | null,
  buildCommand: string,
  testCommand?: string,
  repoLogger?: RepoTaskLogger,
): Promise<VerificationGateResult> {
  const logChunks: string[] = [];

  const buildResult = await runStreamedStep(
    repoLogger,
    'Build verification',
    cwd,
    nodeVersion,
    buildCommand,
  );
  const buildLog = formatStepLog(buildCommand, buildResult);
  logChunks.push(buildLog);
  if (buildResult.exitCode !== 0) {
    return {
      ok: false,
      failedStep: 'build',
      logs: logChunks.join('\n'),
      failedStepLogs: buildLog,
      exitCode: buildResult.exitCode,
    };
  }

  if (testCommand) {
    const testResult = await runStreamedStep(
      repoLogger,
      'Test verification',
      cwd,
      nodeVersion,
      testCommand,
    );
    const testLog = formatStepLog(testCommand, testResult);
    logChunks.push(testLog);
    if (testResult.exitCode !== 0) {
      return {
        ok: false,
        failedStep: 'test',
        logs: logChunks.join('\n'),
        failedStepLogs: testLog,
        exitCode: testResult.exitCode,
      };
    }
  }

  return {
    ok: true,
    logs: logChunks.join('\n'),
    exitCode: 0,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureAngularPnpmPackageManager(
  worktreePath: string,
  nodeVersion: string | null,
  repoLogger?: RepoTaskLogger,
): Promise<boolean> {
  const angularJsonPath = path.join(worktreePath, 'angular.json');
  let raw: string;
  try {
    raw = await readFile(angularJsonPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  const record = parsed as Record<string, unknown>;
  const existingCli =
    typeof record['cli'] === 'object' &&
    record['cli'] !== null &&
    !Array.isArray(record['cli'])
      ? (record['cli'] as Record<string, unknown>)
      : undefined;

  if (existingCli?.['packageManager'] === 'pnpm') {
    return false;
  }

  const hasPnpmLock = await fileExists(path.join(worktreePath, 'pnpm-lock.yaml'));
  const hasNpm = await commandExists('npm');
  if (!hasPnpmLock && hasNpm) {
    return false;
  }

  let updatedViaCli = false;
  try {
    const cliResult = await runInRepoEnv(
      worktreePath,
      nodeVersion,
      'pnpm exec ng config cli.packageManager pnpm',
    );
    updatedViaCli = cliResult.exitCode === 0;
  } catch {
    updatedViaCli = false;
  }

  if (!updatedViaCli) {
    const nextCli = existingCli ? { ...existingCli } : {};
    nextCli['packageManager'] = 'pnpm';
    record['cli'] = nextCli;
    await writeFile(angularJsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  repoLogger?.message('Configured Angular CLI packageManager to "pnpm" in angular.json');
  return true;
}

async function detectFrameworkFromWorktree(
  worktreePath: string,
): Promise<ProjectFramework> {
  try {
    const raw = await readFile(path.join(worktreePath, 'package.json'), 'utf8');
    return detectProjectFramework(raw);
  } catch {
    return 'angular';
  }
}

async function runUpgradeCommandSequence(
  worktreePath: string,
  nodeVersion: string | null,
  framework: ProjectFramework,
  targetMajor: number,
  allowDirty: boolean,
  repoLogger: RepoTaskLogger | undefined,
  logChunks: string[],
): Promise<
  { ok: true } | { ok: false; exitCode: number | null; failedStepLogs: string }
> {
  const runStep = async (
    label: string,
    command: string,
  ): Promise<{ exitCode: number | null; stepLog: string }> => {
    const result = await runStreamedStep(
      repoLogger,
      label,
      worktreePath,
      nodeVersion,
      command,
    );
    const stepLog = formatStepLog(command, result);
    logChunks.push(stepLog);
    return { exitCode: result.exitCode, stepLog };
  };

  if (framework === 'analog') {
    const isNx = await fileExists(path.join(worktreePath, 'nx.json'));
    if (isNx) {
      const migrateResult = await runStep(
        'Analog migrate (Nx) -> @analogjs/platform@latest',
        'pnpm exec nx migrate @analogjs/platform@latest',
      );
      if (migrateResult.exitCode !== 0) {
        return {
          ok: false,
          exitCode: migrateResult.exitCode,
          failedStepLogs: migrateResult.stepLog,
        };
      }

      const reinstallResult = await runStep(
        'Install migrated dependencies',
        'pnpm install --no-frozen-lockfile',
      );
      if (reinstallResult.exitCode !== 0) {
        return {
          ok: false,
          exitCode: reinstallResult.exitCode,
          failedStepLogs: reinstallResult.stepLog,
        };
      }

      if (await fileExists(path.join(worktreePath, 'migrations.json'))) {
        const applyResult = await runStep(
          'Run Analog Nx migrations',
          'pnpm exec nx migrate --run-migrations',
        );
        if (applyResult.exitCode !== 0) {
          return {
            ok: false,
            exitCode: applyResult.exitCode,
            failedStepLogs: applyResult.stepLog,
          };
        }
      }

      return { ok: true };
    }

    const analogUpdateCommand = `pnpm exec ng update @analogjs/platform@latest${allowDirty ? ' --allow-dirty' : ''}`;
    const analogUpdateResult = await runStep(
      'Analog update -> @analogjs/platform@latest',
      analogUpdateCommand,
    );
    return analogUpdateResult.exitCode === 0
      ? { ok: true }
      : {
          ok: false,
          exitCode: analogUpdateResult.exitCode,
          failedStepLogs: analogUpdateResult.stepLog,
        };
  }

  const updateCommand = `pnpm exec ng update @angular/core@${targetMajor} @angular/cli@${targetMajor}${allowDirty ? ' --allow-dirty' : ''}`;
  const updateResult = await runStep(
    `Angular update -> v${targetMajor}`,
    updateCommand,
  );
  return updateResult.exitCode === 0
    ? { ok: true }
    : {
        ok: false,
        exitCode: updateResult.exitCode,
        failedStepLogs: updateResult.stepLog,
      };
}

export async function runDeterministicUpgrade(
  worktreePath: string,
  targetMajor: number,
  buildCommand: string,
  testCommand?: string,
  repoLogger?: RepoTaskLogger,
  resolveDirtyTree?: (dirtyFiles: string[]) => Promise<DirtyTreeAction>,
): Promise<DeterministicUpgradeResult> {
  const [nodeVersion, framework] = await Promise.all([
    detectNodeVersion(worktreePath),
    detectFrameworkFromWorktree(worktreePath),
  ]);
  const logChunks: string[] = [];

  const installCommand = 'pnpm install --no-frozen-lockfile';
  const installResult = await runStreamedStep(
    repoLogger,
    'Install dependencies',
    worktreePath,
    nodeVersion,
    installCommand,
  );
  const installLog = formatStepLog(installCommand, installResult);
  logChunks.push(installLog);
  if (installResult.exitCode !== 0) {
    return {
      ok: false,
      framework,
      failedStep: 'install',
      logs: logChunks.join('\n'),
      failedStepLogs: installLog,
      exitCode: installResult.exitCode,
      nodeVersion,
    };
  }

  await ensureAngularPnpmPackageManager(worktreePath, nodeVersion, repoLogger);

  const dirtyFiles = await getDirtyFiles(worktreePath);
  let allowDirty = false;

  if (dirtyFiles.length > 0) {
    const action = resolveDirtyTree
      ? await resolveDirtyTree(dirtyFiles)
      : 'allow-dirty';

    if (action === 'allow-dirty') {
      allowDirty = true;
      repoLogger?.message(
        `Worktree has ${dirtyFiles.length} uncommitted change(s); running ng update with --allow-dirty`,
      );
    } else if (action === 'discard') {
      repoLogger?.message(
        `Discarding ${dirtyFiles.length} uncommitted change(s) in worktree before ng update...`,
      );
      await discardWorktreeChanges(worktreePath);
    } else if (action === 'stash') {
      repoLogger?.message(
        `Stashing ${dirtyFiles.length} uncommitted change(s) in worktree before ng update...`,
      );
      await stashWorktreeChanges(worktreePath);
    } else if (action === 'skip') {
      repoLogger?.message('Skipping repository due to dirty git worktree.');
      return {
        ok: false,
        framework,
        skippedByUser: true,
        logs: logChunks.join('\n'),
        exitCode: 0,
        nodeVersion,
      };
    } else {
      repoLogger?.message('Upgrade cancelled by user due to dirty git worktree.');
      return {
        ok: false,
        framework,
        cancelledByUser: true,
        logs: logChunks.join('\n'),
        exitCode: 130,
        nodeVersion,
      };
    }
  }

  const updateSequence = await runUpgradeCommandSequence(
    worktreePath,
    nodeVersion,
    framework,
    targetMajor,
    allowDirty,
    repoLogger,
    logChunks,
  );
  if (!updateSequence.ok) {
    return {
      ok: false,
      framework,
      failedStep: 'ng-update',
      logs: logChunks.join('\n'),
      failedStepLogs: updateSequence.failedStepLogs,
      exitCode: updateSequence.exitCode,
      nodeVersion,
    };
  }

  const verification = await runVerificationGate(
    worktreePath,
    nodeVersion,
    buildCommand,
    testCommand,
    repoLogger,
  );
  logChunks.push(verification.logs);

  return {
    ok: verification.ok,
    framework,
    ...(verification.failedStep ? { failedStep: verification.failedStep } : {}),
    logs: logChunks.join('\n'),
    ...(!verification.ok && verification.failedStepLogs
      ? { failedStepLogs: verification.failedStepLogs }
      : {}),
    exitCode: verification.exitCode,
    nodeVersion,
  };
}

export async function analyzeRepoDryRun(
  repo: FleetRepoConfig,
  latest: LatestAngularInfo,
): Promise<DryRunRepoReport> {
  try {
    const packageJsonPath = path.join(repo.localPath, 'package.json');
    const [packageJsonContent, nodeVersion] = await Promise.all([
      readFile(packageJsonPath, 'utf8'),
      detectNodeVersion(repo.localPath),
    ]);

    const framework = detectProjectFramework(packageJsonContent);
    const angularInfo = extractAngularCoreVersion(packageJsonContent);
    if (!angularInfo) {
      return {
        name: repo.name,
        localPath: repo.localPath,
        framework,
        currentRaw: null,
        currentMajor: null,
        latestVersion: latest.version,
        latestMajor: latest.major,
        targetMajor: null,
        nodeVersion,
        status: 'not-angular',
        message: '@angular/core not found in dependencies or devDependencies',
      };
    }

    if (angularInfo.major >= latest.major) {
      return {
        name: repo.name,
        localPath: repo.localPath,
        framework,
        currentRaw: angularInfo.rawRange,
        currentMajor: angularInfo.major,
        latestVersion: latest.version,
        latestMajor: latest.major,
        targetMajor: null,
        nodeVersion,
        status: 'up-to-date',
      };
    }

    return {
      name: repo.name,
      localPath: repo.localPath,
      framework,
      currentRaw: angularInfo.rawRange,
      currentMajor: angularInfo.major,
      latestVersion: latest.version,
      latestMajor: latest.major,
      targetMajor: angularInfo.major + 1,
      nodeVersion,
      status: 'upgrade-available',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: repo.name,
      localPath: repo.localPath,
      framework: 'angular',
      currentRaw: null,
      currentMajor: null,
      latestVersion: latest.version,
      latestMajor: latest.major,
      targetMajor: null,
      nodeVersion: null,
      status: 'error',
      message,
    };
  }
}
