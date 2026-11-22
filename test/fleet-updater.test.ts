import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { invokeRemediationAgent } from '../src/agent.js';
import {
  ConfigValidationError,
  DEFAULT_BUILD_COMMAND,
  loadFleetConfig,
} from '../src/config.js';
import { getLastLines, runCommand } from '../src/exec.js';
import {
  commitPushAndCreatePr,
  fetchOrigin,
  getWorktreePath,
  readFileFromRef,
  resolveRemoteDefaultBranch,
  withIsolatedWorktree,
} from '../src/git.js';
import { runCli } from '../src/index.js';
import {
  detectNodeVersion,
  extractAngularCoreVersion,
  parseMajorVersion,
} from '../src/upgrade.js';

async function runGit(args: string[], cwd?: string): Promise<void> {
  const result = await runCommand('git', args, cwd ? { cwd } : {});
  assert.equal(
    result.exitCode,
    0,
    `git ${args.join(' ')} failed (${result.exitCode}): ${result.combined}`,
  );
}

async function initGitIdentity(cwd: string): Promise<void> {
  await runGit(['config', 'user.name', 'Fleet Bot'], cwd);
  await runGit(['config', 'user.email', 'fleet@example.com'], cwd);
  await runGit(['config', 'commit.gpgsign', 'false'], cwd);
  await runGit(['config', 'tag.gpgsign', 'false'], cwd);
}

describe('config.ts', () => {
  it('loads valid config and applies default buildCommand', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-cfg-'));
    try {
      const repoA = path.join(tmpRoot, 'repo-a');
      const repoB = path.join(tmpRoot, 'repo-b');
      await mkdir(repoA);
      await mkdir(repoB);

      const cfgPath = path.join(tmpRoot, 'fleet.json');
      await writeFile(
        cfgPath,
        JSON.stringify([
          { name: 'repo-a', localPath: repoA },
          {
            name: 'repo-b',
            localPath: repoB,
            buildCommand: 'pnpm nx build web',
            testCommand: 'pnpm nx test web',
          },
        ]),
      );

      const config = await loadFleetConfig(cfgPath);
      assert.equal(config.length, 2);
      assert.deepEqual(config[0], {
        name: 'repo-a',
        localPath: repoA,
        buildCommand: DEFAULT_BUILD_COMMAND,
      });
      assert.deepEqual(config[1], {
        name: 'repo-b',
        localPath: repoB,
        buildCommand: 'pnpm nx build web',
        testCommand: 'pnpm nx test web',
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects relative paths, path-traversal names, and duplicates', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-badcfg-'));
    try {
      const repoA = path.join(tmpRoot, 'repo-a');
      await mkdir(repoA);

      const cfgPath = path.join(tmpRoot, 'fleet.json');
      await writeFile(
        cfgPath,
        JSON.stringify([
          { name: '../evil', localPath: 'relative/path' },
          { name: 'dup-repo', localPath: repoA },
          { name: 'dup-repo', localPath: path.join(tmpRoot, 'missing') },
        ]),
      );

      await assert.rejects(
        () => loadFleetConfig(cfgPath),
        (err: unknown) => {
          assert.ok(err instanceof ConfigValidationError);
          assert.ok(err.issues.length >= 4);
          return true;
        },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('upgrade.ts & exec.ts helpers', () => {
  it('parses major versions from semver ranges and rejects non-numeric tags', () => {
    assert.equal(parseMajorVersion('^18.2.0'), 18);
    assert.equal(parseMajorVersion('~17.3.1'), 17);
    assert.equal(parseMajorVersion('19.0.0-next.4'), 19);
    assert.equal(parseMajorVersion('>=18.0.0 <19.0.0'), 18);
    assert.equal(parseMajorVersion('20.x'), 20);
    assert.equal(parseMajorVersion('v21.1.0'), 21);
    assert.equal(parseMajorVersion('*'), null);
    assert.equal(parseMajorVersion('latest'), null);
    assert.equal(parseMajorVersion('workspace:*'), null);
    assert.equal(parseMajorVersion('https://example.com/1.2.3.tgz'), null);
  });

  it('extracts @angular/core from dependencies or devDependencies', () => {
    const fromDeps = extractAngularCoreVersion(
      JSON.stringify({ dependencies: { '@angular/core': '^18.2.3' } }),
    );
    assert.deepEqual(fromDeps, { rawRange: '^18.2.3', major: 18 });

    const fromDevDeps = extractAngularCoreVersion(
      JSON.stringify({ devDependencies: { '@angular/core': '~19.1.0' } }),
    );
    assert.deepEqual(fromDevDeps, { rawRange: '~19.1.0', major: 19 });

    const nonAngular = extractAngularCoreVersion(
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );
    assert.equal(nonAngular, null);
  });

  it('detects Node version with .nvmrc precedence over .node-version', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-node-'));
    try {
      assert.equal(await detectNodeVersion(tmpRoot), null);

      await writeFile(path.join(tmpRoot, '.node-version'), '20.12.0\n');
      assert.equal(await detectNodeVersion(tmpRoot), '20.12.0');

      await writeFile(path.join(tmpRoot, '.nvmrc'), '# comment\n\nv22.1.0\n');
      assert.equal(await detectNodeVersion(tmpRoot), 'v22.1.0');

      await writeFile(path.join(tmpRoot, '.nvmrc'), '20; rm -rf /\n');
      await assert.rejects(() => detectNodeVersion(tmpRoot), /Invalid Node version/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('extracts the exact last N lines of logs', () => {
    const lines = Array.from({ length: 220 }, (_, i) => `line-${i + 1}`);
    const tail = getLastLines(`${lines.join('\n')}\n`, 150);
    const tailLines = tail.split('\n');
    assert.equal(tailLines.length, 150);
    assert.equal(tailLines[0], 'line-71');
    assert.equal(tailLines[149], 'line-220');
  });
});

describe('git.ts isolation and PR delivery', () => {
  it('fetches origin, isolates worktree in /tmp/ng-fleet, preserves localPath, and guarantees cleanup on failure', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-git-'));
    const repoName = `test-iso-${Date.now()}`;
    const expectedWorktree = getWorktreePath(repoName);

    try {
      const bareRemote = path.join(tmpRoot, 'remote.git');
      const seedClone = path.join(tmpRoot, 'seed');
      const localPath = path.join(tmpRoot, 'local-checkout');

      await runGit(['init', '--bare', '--initial-branch=main', bareRemote]);
      await runGit(['clone', bareRemote, seedClone]);
      await initGitIdentity(seedClone);
      await writeFile(
        path.join(seedClone, 'package.json'),
        JSON.stringify({ name: repoName, dependencies: { '@angular/core': '^18.0.0' } }),
      );
      await runGit(['add', '-A'], seedClone);
      await runGit(['commit', '-m', 'init'], seedClone);
      await runGit(['push', '-u', 'origin', 'main'], seedClone);

      await runGit(['clone', bareRemote, localPath]);
      await initGitIdentity(localPath);
      // Leave an uncommitted dirty file in the user's active checkout.
      await writeFile(path.join(localPath, 'local-notes.txt'), 'do not touch');

      // Advance origin/main without pulling into localPath.
      await writeFile(
        path.join(seedClone, 'package.json'),
        JSON.stringify({ name: repoName, dependencies: { '@angular/core': '^18.2.0' } }),
      );
      await runGit(['add', '-A'], seedClone);
      await runGit(['commit', '-m', 'bump minor on remote'], seedClone);
      await runGit(['push', 'origin', 'main'], seedClone);

      await fetchOrigin(localPath);
      const baseRef = await resolveRemoteDefaultBranch(localPath);
      assert.equal(baseRef, 'origin/main');

      const remotePkg = await readFileFromRef(localPath, baseRef, 'package.json');
      assert.match(remotePkg, /\^18\.2\.0/);

      await assert.rejects(
        () =>
          withIsolatedWorktree(
            localPath,
            repoName,
            'chore/angular-upgrade-v19',
            baseRef,
            async (worktreePath) => {
              assert.equal(worktreePath, expectedWorktree);
              const wtStat = await stat(worktreePath);
              assert.ok(wtStat.isDirectory());
              await writeFile(path.join(worktreePath, 'mutated.txt'), 'inside-wt');
              throw new Error('simulated build crash');
            },
          ),
        /simulated build crash/,
      );

      // Worktree directory must be removed even after throw.
      await assert.rejects(() => stat(expectedWorktree));

      // localPath working tree must remain untouched.
      const localNotes = await readFile(path.join(localPath, 'local-notes.txt'), 'utf8');
      assert.equal(localNotes, 'do not touch');
      await assert.rejects(() => stat(path.join(localPath, 'mutated.txt')));
    } finally {
      await rm(expectedWorktree, { recursive: true, force: true });
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('commits, force-pushes, and passes --draft with AI-modified files to gh pr create', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-pr-'));
    const originalPath = process.env['PATH'] ?? '';

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const ghLog = path.join(tmpRoot, 'gh-calls.log');
      await mkdir(fakeBin);

      const fakeGh = path.join(fakeBin, 'gh');
      await writeFile(
        fakeGh,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('https://github.com/org/repo/pull/42\\n');
  process.exit(0);
}
process.exit(0);
`,
      );
      await chmod(fakeGh, 0o755);

      const bareRemote = path.join(tmpRoot, 'remote.git');
      const localClone = path.join(tmpRoot, 'repo');
      await runGit(['init', '--bare', '--initial-branch=main', bareRemote]);
      await runGit(['clone', bareRemote, localClone]);
      await initGitIdentity(localClone);
      await writeFile(path.join(localClone, 'README.md'), '# app\n');
      await runGit(['add', '-A'], localClone);
      await runGit(['commit', '-m', 'init'], localClone);
      await runGit(['push', '-u', 'origin', 'main'], localClone);

      await runGit(['checkout', '-b', 'chore/angular-upgrade-v19'], localClone);
      await writeFile(path.join(localClone, 'src.ts'), 'export const v = 19;\n');

      process.env['PATH'] = `${fakeBin}:${originalPath}`;
      const result = await commitPushAndCreatePr({
        worktreePath: localClone,
        repoName: 'demo-app',
        branchName: 'chore/angular-upgrade-v19',
        baseRef: 'origin/main',
        currentMajor: 18,
        targetMajor: 19,
        agentIntervened: true,
        aiModifiedFiles: ['src/app.component.ts', 'src/main.ts'],
      });

      assert.equal(result.created, true);
      assert.equal(result.prUrl, 'https://github.com/org/repo/pull/42');

      const logLines = (await readFile(ghLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const createCall = logLines.find((args) => args[0] === 'pr' && args[1] === 'create');
      assert.ok(createCall);
      assert.ok(createCall.includes('--draft'));
      const bodyIndex = createCall.indexOf('--body');
      assert.notEqual(bodyIndex, -1);
      const prBody = createCall[bodyIndex + 1] ?? '';
      assert.match(prBody, /## AI-Modified Files/);
      assert.match(prBody, /src\/app\.component\.ts/);
      assert.match(prBody, /src\/main\.ts/);
    } finally {
      process.env['PATH'] = originalPath;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('agent.ts bounded fallback and guardrails', () => {
  it('passes remediation.md, last 150 lines of logs, git diff, and tracks only AI-modified files', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-agent-'));
    try {
      const repoDir = path.join(tmpRoot, 'repo');
      const promptCapture = path.join(tmpRoot, 'captured-prompt.txt');
      const mockAgentScript = path.join(tmpRoot, 'mock-agent.mjs');
      await mkdir(path.join(repoDir, 'src'), { recursive: true });

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(path.join(repoDir, 'package.json'), '{"version":"18"}\n');
      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const x = 1;\n');
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      // Simulate deterministic ng update modifying package.json before agent runs.
      await writeFile(path.join(repoDir, 'package.json'), '{"version":"19"}\n');

      await writeFile(
        mockAgentScript,
        `import fs from 'node:fs';
import path from 'node:path';
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(promptCapture)}, prompt);
fs.writeFileSync(path.join(process.cwd(), 'src', 'app.ts'), 'export const x = 2;\\n');
fs.writeFileSync(path.join(process.cwd(), 'src', 'new-helper.ts'), 'export const y = 3;\\n');
`,
      );

      const errorLines = Array.from(
        { length: 200 },
        (_, idx) => `ERR-LINE-${idx + 1}`,
      ).join('\n');

      const result = await invokeRemediationAgent(
        {
          repoName: 'agent-test-app',
          worktreePath: repoDir,
          currentMajor: 18,
          targetMajor: 19,
          failedStep: 'build',
          buildCommand: 'pnpm run build',
          testCommand: 'pnpm test',
          nodeVersion: '20.11.0',
          errorLog: errorLines,
          gitDiff: 'diff --git a/package.json b/package.json\n-18\n+19',
        },
        {
          agentCommand: `node ${JSON.stringify(mockAgentScript)}`,
          timeoutMs: 10_000,
        },
      );

      assert.equal(result.invoked, true);
      assert.equal(result.succeeded, true);
      assert.deepEqual(result.aiModifiedFiles, [
        'src/app.ts',
        'src/new-helper.ts',
      ]);

      const prompt = await readFile(promptCapture, 'utf8');
      assert.match(prompt, /NO Dependency Downgrades/);
      assert.match(prompt, /@ts-ignore/);
      assert.match(prompt, /ERR-LINE-51/);
      assert.match(prompt, /ERR-LINE-200/);
      assert.doesNotMatch(prompt, /ERR-LINE-50\b/);
      assert.match(prompt, /diff --git a\/package\.json/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('enforces strict timeout and rejects HEAD commits by agent', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-guard-'));
    try {
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(repoDir);
      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(path.join(repoDir, 'file.txt'), 'ok\n');
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      const timeoutResult = await invokeRemediationAgent(
        {
          repoName: 'timeout-app',
          worktreePath: repoDir,
          currentMajor: 18,
          targetMajor: 19,
          failedStep: 'build',
          buildCommand: 'pnpm run build',
          nodeVersion: null,
          errorLog: 'build error',
          gitDiff: '',
        },
        {
          agentCommand: 'node -e "setTimeout(() => {}, 10000)"',
          timeoutMs: 200,
        },
      );

      assert.equal(timeoutResult.invoked, true);
      assert.equal(timeoutResult.timedOut, true);
      assert.equal(timeoutResult.succeeded, false);

      const commitPolicyResult = await invokeRemediationAgent(
        {
          repoName: 'commit-app',
          worktreePath: repoDir,
          currentMajor: 18,
          targetMajor: 19,
          failedStep: 'build',
          buildCommand: 'pnpm run build',
          nodeVersion: null,
          errorLog: 'build error',
          gitDiff: '',
        },
        {
          agentCommand: 'git commit --allow-empty -m "forbidden"',
          timeoutMs: 10_000,
        },
      );

      assert.equal(commitPolicyResult.invoked, true);
      assert.equal(commitPolicyResult.succeeded, false);
      assert.match(commitPolicyResult.error ?? '', /Agent policy violation/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('index.ts CLI dry-run & help', () => {
  it('supports --help and --dry-run without modifying repos or creating worktrees', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-cli-'));
    try {
      assert.equal(await runCli(['--help']), 0);
      assert.equal(await runCli(['--', '--help']), 0);

      const appA = path.join(tmpRoot, 'app-a');
      const appB = path.join(tmpRoot, 'app-b');
      await mkdir(appA);
      await mkdir(appB);

      await writeFile(
        path.join(appA, 'package.json'),
        JSON.stringify({ dependencies: { '@angular/core': '^18.2.0' } }),
      );
      await writeFile(path.join(appA, '.nvmrc'), '20.11.0\n');

      await writeFile(
        path.join(appB, 'package.json'),
        JSON.stringify({ dependencies: { '@angular/core': '^20.0.0' } }),
      );

      const cfgPath = path.join(tmpRoot, 'fleet.json');
      await writeFile(
        cfgPath,
        JSON.stringify([
          { name: 'cli-dry-a', localPath: appA },
          { name: 'cli-dry-b', localPath: appB },
        ]),
      );

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      };

      let exitCode: number;
      try {
        exitCode = await runCli([
          '--dry-run',
          '--config',
          cfgPath,
          '--latest-version',
          '20.1.0',
        ]);
      } finally {
        console.log = originalLog;
      }

      assert.equal(exitCode, 0);
      const output = logs.join('\n');
      assert.match(output, /cli-dry-a/);
      assert.match(output, /v18 \(\^18\.2\.0\)/);
      assert.match(output, /v19/);
      assert.match(output, /20\.11\.0/);
      assert.match(output, /upgrade-available/);
      assert.match(output, /cli-dry-b/);
      assert.match(output, /up-to-date/);

      await assert.rejects(() => stat(getWorktreePath('cli-dry-a')));
      await assert.rejects(() => stat(getWorktreePath('cli-dry-b')));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
