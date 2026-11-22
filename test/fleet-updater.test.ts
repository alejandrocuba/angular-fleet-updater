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
import {
  buildRemediationPrompt,
  discoverRepositorySkills,
  invokeRemediationAgent,
  resolveAgentCommand,
} from '../src/agent.js';
import {
  ConfigValidationError,
  DEFAULT_BUILD_COMMAND,
  loadFleetConfig,
} from '../src/config.js';
import { getLastLines, runCommand } from '../src/exec.js';
import {
  commitPushAndCreatePr,
  discardWorktreeChanges,
  fetchOrigin,
  getDirtyFiles,
  getGitDiff,
  getWorktreePath,
  readFileFromRef,
  resolveRemoteDefaultBranch,
  stashWorktreeChanges,
  withIsolatedWorktree,
} from '../src/git.js';
import {
  buildFailureReportText,
  formatConsolidatedError,
  runCli,
} from '../src/index.js';
import {
  detectNodeVersion,
  detectProjectFramework,
  ensureAngularPnpmPackageManager,
  extractAngularCoreVersion,
  parseMajorVersion,
  runDeterministicUpgrade,
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

      // Worktree directory and temporary local branch must be removed even after throw.
      await assert.rejects(() => stat(expectedWorktree));
      const branchVerify = await runCommand(
        'git',
        ['rev-parse', '--verify', '--quiet', 'refs/heads/chore/angular-upgrade-v19'],
        { cwd: localPath },
      );
      assert.notEqual(branchVerify.exitCode, 0);

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
  it('passes remediation.md, last 80 lines of logs (ANSI stripped), git diff, and tracks only AI-modified files', async () => {
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
        (_, idx) =>
          idx === 199 ? `\x1b[31mERR-LINE-${idx + 1}\x1b[0m` : `ERR-LINE-${idx + 1}`,
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
      assert.match(prompt, /ERR-LINE-121/);
      assert.match(prompt, /ERR-LINE-200/);
      assert.doesNotMatch(prompt, /ERR-LINE-120\b/);
      assert.doesNotMatch(prompt, /\x1b\[/);
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

describe('agy invocation, pnpm config, and dirty-tree resolution', () => {
  it('invokes agy with --mode accept-edits before --print=<prompt> and no stdin prompt', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-agy-'));
    const originalPath = process.env['PATH'] ?? '';

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const capturePath = path.join(tmpRoot, 'agy-capture.json');
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(fakeBin);
      await mkdir(path.join(repoDir, 'src'), { recursive: true });

      const fakeAgy = path.join(fakeBin, 'agy');
      await writeFile(
        fakeAgy,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
fs.writeFileSync(path.join(process.cwd(), 'src', 'app.ts'), 'export const fixed = true;\\n');
`,
      );
      await chmod(fakeAgy, 0o755);

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const fixed = false;\n');
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      process.env['PATH'] = `${fakeBin}:${originalPath}`;

      const resolved = await resolveAgentCommand(undefined, 30_000);
      assert.ok(resolved);
      assert.equal(resolved.kind, 'binary');
      if (resolved.kind === 'binary') {
        assert.equal(resolved.binary, 'agy');
        assert.equal(resolved.promptMode, 'print-flag');
        const modeIdx = resolved.args.indexOf('--mode');
        assert.notEqual(modeIdx, -1);
        assert.equal(resolved.args[modeIdx + 1], 'accept-edits');
        assert.equal(resolved.args.includes('--print'), false);
        assert.equal(resolved.args.includes('--disable-slash-commands'), false);
      }

      const result = await invokeRemediationAgent(
        {
          repoName: 'agy-test-app',
          worktreePath: repoDir,
          currentMajor: 21,
          targetMajor: 22,
          failedStep: 'ng-update',
          buildCommand: 'pnpm run build',
          nodeVersion: null,
          errorLog: 'ERR-AGY-TEST',
          gitDiff: '',
        },
        { timeoutMs: 10_000 },
      );

      assert.equal(result.invoked, true);
      assert.equal(result.succeeded, true);
      assert.deepEqual(result.aiModifiedFiles, ['src/app.ts']);

      const captured = JSON.parse(await readFile(capturePath, 'utf8')) as {
        argv: string[];
        stdin: string;
      };
      assert.equal(captured.stdin, '');
      const modeIndex = captured.argv.indexOf('--mode');
      const printIndex = captured.argv.findIndex((arg) => arg.startsWith('--print='));
      assert.notEqual(modeIndex, -1);
      assert.ok(printIndex > modeIndex);
      const printArg = captured.argv[printIndex] ?? '';
      assert.match(printArg, /# Angular Fleet Remediation Agent Instructions/);
      assert.match(printArg, /ERR-AGY-TEST/);
    } finally {
      process.env['PATH'] = originalPath;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('configures cli.packageManager to pnpm in angular.json when appropriate', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-ngcfg-'));
    try {
      const repoFromNpm = path.join(tmpRoot, 'from-npm');
      const repoNoCli = path.join(tmpRoot, 'no-cli');
      const repoAlreadyPnpm = path.join(tmpRoot, 'already-pnpm');
      const repoNoAngular = path.join(tmpRoot, 'no-angular');
      await mkdir(repoFromNpm);
      await mkdir(repoNoCli);
      await mkdir(repoAlreadyPnpm);
      await mkdir(repoNoAngular);

      await writeFile(path.join(repoFromNpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoFromNpm, 'angular.json'),
        JSON.stringify({ version: 1, cli: { packageManager: 'npm' } }, null, 2),
      );

      await writeFile(path.join(repoNoCli, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoNoCli, 'angular.json'),
        JSON.stringify({ version: 1, projects: {} }, null, 2),
      );

      await writeFile(path.join(repoAlreadyPnpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoAlreadyPnpm, 'angular.json'),
        JSON.stringify({ version: 1, cli: { packageManager: 'pnpm' } }, null, 2),
      );

      assert.equal(await ensureAngularPnpmPackageManager(repoFromNpm, null), true);
      const updatedFromNpm = JSON.parse(
        await readFile(path.join(repoFromNpm, 'angular.json'), 'utf8'),
      ) as { cli?: { packageManager?: string } };
      assert.equal(updatedFromNpm.cli?.packageManager, 'pnpm');

      assert.equal(await ensureAngularPnpmPackageManager(repoNoCli, null), true);
      const updatedNoCli = JSON.parse(
        await readFile(path.join(repoNoCli, 'angular.json'), 'utf8'),
      ) as { cli?: { packageManager?: string } };
      assert.equal(updatedNoCli.cli?.packageManager, 'pnpm');

      assert.equal(await ensureAngularPnpmPackageManager(repoAlreadyPnpm, null), false);
      assert.equal(await ensureAngularPnpmPackageManager(repoNoAngular, null), false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('detects dirty files, stashes them, and discards changes while preserving node_modules', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-dirty-'));
    try {
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(repoDir);
      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\n');
      await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n');
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      await mkdir(path.join(repoDir, 'node_modules'));
      await writeFile(path.join(repoDir, 'node_modules', 'pkg.txt'), 'keep-me\n');

      await writeFile(path.join(repoDir, 'tracked.txt'), 'v2\n');
      await writeFile(path.join(repoDir, 'untracked.txt'), 'temp\n');

      const dirty = await getDirtyFiles(repoDir);
      assert.equal(dirty.length, 2);
      assert.ok(dirty.some((line) => line.includes('tracked.txt')));
      assert.ok(dirty.some((line) => line.includes('untracked.txt')));

      await stashWorktreeChanges(repoDir);
      assert.deepEqual(await getDirtyFiles(repoDir), []);
      assert.equal(await readFile(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');
      await assert.rejects(() => stat(path.join(repoDir, 'untracked.txt')));
      assert.equal(
        await readFile(path.join(repoDir, 'node_modules', 'pkg.txt'), 'utf8'),
        'keep-me\n',
      );
      const stashList = await runCommand('git', ['stash', 'list'], { cwd: repoDir });
      assert.match(stashList.stdout, /angular-fleet-updater: pre-ng-update/);

      await writeFile(path.join(repoDir, 'tracked.txt'), 'v3\n');
      await writeFile(path.join(repoDir, 'untracked2.txt'), 'temp2\n');

      await discardWorktreeChanges(repoDir);
      assert.deepEqual(await getDirtyFiles(repoDir), []);
      assert.equal(await readFile(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');
      await assert.rejects(() => stat(path.join(repoDir, 'untracked2.txt')));
      assert.equal(
        await readFile(path.join(repoDir, 'node_modules', 'pkg.txt'), 'utf8'),
        'keep-me\n',
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('invokes resolveDirtyTree when pre-update steps dirty the worktree and handles skip and allow-dirty', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-updirty-'));
    const originalPath = process.env['PATH'] ?? '';

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const pnpmLog = path.join(tmpRoot, 'pnpm-calls.log');
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(fakeBin);
      await mkdir(repoDir);

      const fakePnpm = path.join(fakeBin, 'pnpm');
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'install') {
  fs.writeFileSync(path.join(process.cwd(), 'dirty-by-install.txt'), 'dirty\\n');
  process.exit(0);
}
if (args[0] === 'exec' && args[1] === 'ng' && args[2] === 'update') {
  if (!args.includes('--allow-dirty')) {
    process.stderr.write('Error: Repository is not clean.\\n');
    process.exit(1);
  }
  fs.writeFileSync(path.join(process.cwd(), 'updated.txt'), 'v22\\n');
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'build') {
  process.exit(0);
}
process.exit(0);
`,
      );
      await chmod(fakePnpm, 0o755);

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(
        path.join(repoDir, 'package.json'),
        JSON.stringify({ name: 'dirty-test', dependencies: { '@angular/core': '^21.0.0' } }),
      );
      await writeFile(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoDir, 'angular.json'),
        JSON.stringify({ version: 1, cli: { packageManager: 'pnpm' } }),
      );
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      process.env['PATH'] = `${fakeBin}:${originalPath}`;

      let observedDirty: string[] = [];
      const skipRes = await runDeterministicUpgrade(
        repoDir,
        22,
        'pnpm run build',
        undefined,
        undefined,
        async (dirtyFiles) => {
          observedDirty = dirtyFiles;
          return 'skip';
        },
      );

      assert.equal(skipRes.ok, false);
      assert.equal(skipRes.skippedByUser, true);
      assert.ok(observedDirty.some((entry) => entry.includes('dirty-by-install.txt')));

      const skipCalls = (await readFile(pnpmLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(
        skipCalls.some((args) => args[0] === 'exec' && args[2] === 'update'),
        false,
      );

      await discardWorktreeChanges(repoDir);
      await writeFile(pnpmLog, '');

      const allowRes = await runDeterministicUpgrade(
        repoDir,
        22,
        'pnpm run build',
        undefined,
        undefined,
        async () => 'allow-dirty',
      );

      assert.equal(allowRes.ok, true);
      const allowCalls = (await readFile(pnpmLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const updateCall = allowCalls.find(
        (args) => args[0] === 'exec' && args[1] === 'ng' && args[2] === 'update',
      );
      assert.ok(updateCall);
      assert.ok(updateCall.includes('--allow-dirty'));
      assert.ok(allowCalls.some((args) => args[0] === 'run' && args[1] === 'build'));
    } finally {
      process.env['PATH'] = originalPath;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('Analog metaframework detection and upgrade flow', () => {
  it('detects Analog projects via @analogjs/platform or @analogjs/* dependencies', () => {
    assert.equal(
      detectProjectFramework(
        JSON.stringify({
          dependencies: { '@angular/core': '^21.0.0' },
          devDependencies: { '@analogjs/platform': '2.5.2' },
        }),
      ),
      'analog',
    );
    assert.equal(
      detectProjectFramework(
        JSON.stringify({
          dependencies: { '@angular/core': '^21.0.0', '@analogjs/router': '2.5.2' },
        }),
      ),
      'analog',
    );
    assert.equal(
      detectProjectFramework(
        JSON.stringify({
          dependencies: { '@angular/core': '^21.0.0' },
          devDependencies: { '@angular/cli': '^21.0.0' },
        }),
      ),
      'angular',
    );
    assert.equal(detectProjectFramework('{invalid json'), 'angular');
  });

  it('upgrades Analog Angular CLI workspaces via ng update @analogjs/platform@latest', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-analog-cli-'));
    const originalPath = process.env['PATH'] ?? '';

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const pnpmLog = path.join(tmpRoot, 'pnpm-calls.log');
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(fakeBin);
      await mkdir(repoDir);

      const fakePnpm = path.join(fakeBin, 'pnpm');
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify(args) + '\\n');
process.exit(0);
`,
      );
      await chmod(fakePnpm, 0o755);

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(
        path.join(repoDir, 'package.json'),
        JSON.stringify({
          name: 'analog-cli-app',
          dependencies: { '@angular/core': '^21.0.0', '@analogjs/router': '2.5.2' },
          devDependencies: { '@analogjs/platform': '2.5.2' },
        }),
      );
      await writeFile(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoDir, 'angular.json'),
        JSON.stringify({ version: 1, cli: { packageManager: 'pnpm' } }),
      );
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      process.env['PATH'] = `${fakeBin}:${originalPath}`;

      const result = await runDeterministicUpgrade(repoDir, 22, 'pnpm run build');
      assert.equal(result.ok, true);
      assert.equal(result.framework, 'analog');

      const calls = (await readFile(pnpmLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);

      assert.deepEqual(calls, [
        ['install', '--no-frozen-lockfile'],
        ['exec', 'ng', 'update', '@analogjs/platform@latest'],
        ['run', 'build'],
      ]);
    } finally {
      process.env['PATH'] = originalPath;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('upgrades Analog Nx workspaces via nx migrate @analogjs/platform@latest, install, and --run-migrations', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-analog-nx-'));
    const originalPath = process.env['PATH'] ?? '';

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const pnpmLog = path.join(tmpRoot, 'pnpm-calls.log');
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(fakeBin);
      await mkdir(repoDir);

      const fakePnpm = path.join(fakeBin, 'pnpm');
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'exec' && args[1] === 'nx' && args[2] === 'migrate' && args[3] === '@analogjs/platform@latest') {
  fs.writeFileSync(path.join(process.cwd(), 'migrations.json'), '{"migrations":[]}\\n');
}
process.exit(0);
`,
      );
      await chmod(fakePnpm, 0o755);

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(
        path.join(repoDir, 'package.json'),
        JSON.stringify({
          name: 'analog-nx-app',
          dependencies: { '@angular/core': '^21.0.0' },
          devDependencies: { '@analogjs/platform': '2.5.2' },
        }),
      );
      await writeFile(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(path.join(repoDir, 'nx.json'), JSON.stringify({ version: 2 }));
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      process.env['PATH'] = `${fakeBin}:${originalPath}`;

      const result = await runDeterministicUpgrade(repoDir, 22, 'pnpm run build');
      assert.equal(result.ok, true);
      assert.equal(result.framework, 'analog');

      const calls = (await readFile(pnpmLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);

      assert.deepEqual(calls, [
        ['install', '--no-frozen-lockfile'],
        ['exec', 'nx', 'migrate', '@analogjs/platform@latest'],
        ['install', '--no-frozen-lockfile'],
        ['exec', 'nx', 'migrate', '--run-migrations'],
        ['run', 'build'],
      ]);
    } finally {
      process.env['PATH'] = originalPath;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('discovers repository Angular skills and references them in the remediation prompt', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-skills-'));
    try {
      const repoWithSkills = path.join(tmpRoot, 'with-skills');
      const repoWithoutSkills = path.join(tmpRoot, 'without-skills');
      await mkdir(
        path.join(repoWithSkills, '.agents', 'skills', 'angular-developer'),
        { recursive: true },
      );
      await mkdir(repoWithoutSkills, { recursive: true });
      await writeFile(
        path.join(
          repoWithSkills,
          '.agents',
          'skills',
          'angular-developer',
          'SKILL.md',
        ),
        '# Angular Developer Skill\n',
      );
      await writeFile(path.join(repoWithSkills, 'AGENTS.md'), '# Agents\n');

      const discovered = await discoverRepositorySkills(repoWithSkills);
      assert.deepEqual(discovered, [
        '.agents/skills/angular-developer/SKILL.md',
        'AGENTS.md',
      ]);

      const promptWithSkills = await buildRemediationPrompt({
        repoName: 'skills-app',
        worktreePath: repoWithSkills,
        framework: 'angular',
        currentMajor: 21,
        targetMajor: 22,
        failedStep: 'build',
        buildCommand: 'pnpm run build',
        nodeVersion: null,
        errorLog: 'TS2304: build error',
        gitDiff: '',
      });

      assert.match(promptWithSkills, /\.agents\/skills\/angular-developer\/SKILL\.md/);
      assert.match(promptWithSkills, /AGENTS\.md/);
      assert.match(
        promptWithSkills,
        /Follow Repository Angular Skills & Guidelines First/,
      );
      assert.doesNotMatch(promptWithSkills, /Prefer Angular's built-in control flow/);

      assert.deepEqual(await discoverRepositorySkills(repoWithoutSkills), []);
      const promptWithoutSkills = await buildRemediationPrompt({
        repoName: 'no-skills-app',
        worktreePath: repoWithoutSkills,
        framework: 'analog',
        currentMajor: 21,
        targetMajor: 22,
        failedStep: 'build',
        buildCommand: 'pnpm run build',
        nodeVersion: null,
        errorLog: 'build error',
        gitDiff: '',
      });
      assert.match(promptWithoutSkills, /none found in worktree/);
      assert.match(promptWithoutSkills, /Analog \(@analogjs\/platform\)/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('failure consolidation, verification skip, and git cleanup', () => {
  it('formats consolidated error sections and renders failure reports only for failed repos', () => {
    const longOutput = Array.from({ length: 40 }, (_, i) => `log-${i + 1}`).join('\n');
    const consolidated = formatConsolidatedError(
      [
        { title: 'Empty step', content: '   \n  ' },
        { title: 'Failed step: ng-update', content: longOutput },
        { title: 'Agent output', content: 'agent line 1\nagent line 2' },
      ],
      10,
    );

    assert.doesNotMatch(consolidated, /Empty step/);
    assert.match(consolidated, /--- Failed step: ng-update ---/);
    assert.doesNotMatch(consolidated, /\blog-30\b/);
    assert.match(consolidated, /\blog-31\b/);
    assert.match(consolidated, /\blog-40\b/);
    assert.match(consolidated, /--- Agent output ---\nagent line 1\nagent line 2/);

    const emptyReport = buildFailureReportText([
      { name: 'ok-app', upgradePath: 'v21 -> v22', status: 'pr-created', details: 'https://pr/1' },
      { name: 'skip-app', upgradePath: '-', status: 'skipped', details: 'Skipped' },
    ]);
    assert.equal(emptyReport, '');

    const report = buildFailureReportText([
      { name: 'ok-app', upgradePath: 'v21 -> v22', status: 'pr-created', details: 'https://pr/1' },
      {
        name: 'broken-app',
        upgradePath: 'v21 -> v22',
        status: 'failed',
        details: 'Update failed (ng-update) and no code changes were produced',
        errorOutput: consolidated,
      },
    ]);

    assert.doesNotMatch(report, /ok-app/);
    assert.match(
      report,
      /\[broken-app\] \(v21 -> v22\) - Update failed \(ng-update\) and no code changes were produced/,
    );
    assert.match(report, /--- Failed step: ng-update ---/);
  });

  it('skips verification when no code changes were produced, cleans up git, and prints consolidated error output', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-fail-cli-'));
    const originalPath = process.env['PATH'] ?? '';
    const repoName = `fail-cli-${Date.now()}`;
    const expectedWorktree = getWorktreePath(repoName);

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const pnpmLog = path.join(tmpRoot, 'pnpm-calls.log');
      const mockAgent = path.join(tmpRoot, 'noop-agent.mjs');
      const bareRemote = path.join(tmpRoot, 'remote.git');
      const seedClone = path.join(tmpRoot, 'seed');
      const localPath = path.join(tmpRoot, 'local');
      const cfgPath = path.join(tmpRoot, 'fleet.json');
      await mkdir(fakeBin);

      const fakePnpm = path.join(fakeBin, 'pnpm');
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'install') {
  process.exit(0);
}
if (args[0] === 'exec' && args[1] === 'ng' && args[2] === 'update') {
  process.stderr.write('NG-UPDATE-ERR-TAIL\\n');
  process.exit(1);
}
if (args[0] === 'run' && args[1] === 'build') {
  process.exit(0);
}
process.exit(0);
`,
      );
      await chmod(fakePnpm, 0o755);

      await writeFile(
        mockAgent,
        `process.stdout.write('AGENT-NO-CHANGES\\n');
`,
      );

      await runGit(['init', '--bare', '--initial-branch=main', bareRemote]);
      await runGit(['clone', bareRemote, seedClone]);
      await initGitIdentity(seedClone);
      await writeFile(
        path.join(seedClone, 'package.json'),
        JSON.stringify({ name: repoName, dependencies: { '@angular/core': '^21.0.0' } }),
      );
      await writeFile(path.join(seedClone, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(seedClone, 'angular.json'),
        JSON.stringify({ version: 1, cli: { packageManager: 'pnpm' } }),
      );
      await runGit(['add', '-A'], seedClone);
      await runGit(['commit', '-m', 'init'], seedClone);
      await runGit(['push', '-u', 'origin', 'main'], seedClone);

      await runGit(['clone', bareRemote, localPath]);
      await initGitIdentity(localPath);

      await writeFile(
        cfgPath,
        JSON.stringify([{ name: repoName, localPath, buildCommand: 'pnpm run build' }]),
      );

      process.env['PATH'] = `${fakeBin}:${originalPath}`;

      const stdoutChunks: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((
        chunk: string | Uint8Array,
        encoding?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
      ): boolean => {
        stdoutChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
        );
        if (typeof encoding === 'function') {
          encoding(null);
          return true;
        }
        if (typeof cb === 'function') {
          cb(null);
        }
        return true;
      }) as typeof process.stdout.write;

      let exitCode: number;
      try {
        exitCode = await runCli([
          '--yes',
          '--config',
          cfgPath,
          '--latest-version',
          '22.0.0',
          '--agent-cmd',
          `node ${JSON.stringify(mockAgent)}`,
        ]);
      } finally {
        process.stdout.write = originalWrite;
      }

      assert.equal(exitCode, 1);

      const calls = (await readFile(pnpmLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(
        calls.some((args) => args[0] === 'run' && args[1] === 'build'),
        false,
      );

      const branchVerify = await runCommand(
        'git',
        ['rev-parse', '--verify', '--quiet', 'refs/heads/chore/angular-upgrade-v22'],
        { cwd: localPath },
      );
      assert.notEqual(branchVerify.exitCode, 0);
      await assert.rejects(() => stat(expectedWorktree));

      const stdoutText = stdoutChunks.join('');
      assert.match(stdoutText, /Consolidated Failure Details/);
      assert.match(stdoutText, /NG-UPDATE-ERR-TAIL/);
      assert.match(stdoutText, /AGENT-NO-CHANGES/);
    } finally {
      process.env['PATH'] = originalPath;
      await rm(expectedWorktree, { recursive: true, force: true });
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('excludes lockfiles and binary/image assets from getGitDiff while preserving code diffs', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-diff-'));
    try {
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(path.join(repoDir, 'src'), { recursive: true });
      await mkdir(path.join(repoDir, 'images', 'projects', 'plant-me'), {
        recursive: true,
      });
      await mkdir(path.join(repoDir, 'sub'), { recursive: true });

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const v = 1;\n');
      await writeFile(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoDir, 'images', 'projects', 'plant-me', 'main.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
      );
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      await writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const v = 2;\n');
      await writeFile(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.1\n');
      await writeFile(
        path.join(repoDir, 'images', 'projects', 'plant-me', 'main.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]),
      );
      await writeFile(path.join(repoDir, 'src', 'new-file.ts'), 'export const n = 1;\n');
      await writeFile(path.join(repoDir, 'sub', 'pnpm-lock.yaml'), 'lock: true\n');
      await writeFile(path.join(repoDir, 'images', 'untracked.png'), 'png-bytes');

      const diff = await getGitDiff(repoDir);
      assert.match(diff, /src\/app\.ts/);
      assert.match(diff, /\+export const v = 2;/);
      assert.match(diff, /src\/new-file\.ts/);
      assert.doesNotMatch(diff, /pnpm-lock\.yaml/);
      assert.doesNotMatch(diff, /main\.png/);
      assert.doesNotMatch(diff, /untracked\.png/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('populates failedStepLogs with only the failing step log and omits earlier passing steps', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ng-fleet-step-logs-'));
    const originalPath = process.env['PATH'] ?? '';

    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const repoDir = path.join(tmpRoot, 'repo');
      await mkdir(fakeBin);
      await mkdir(repoDir);

      const fakePnpm = path.join(fakeBin, 'pnpm');
      await writeFile(
        fakePnpm,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'install') {
  process.stdout.write('INSTALL-OK-NOISE\\n');
  process.exit(0);
}
if (args[0] === 'exec' && args[1] === 'ng' && args[2] === 'update') {
  process.stdout.write('NG-UPDATE-OK-NOISE\\n');
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'build') {
  process.stderr.write('BUILD-STEP-FAILURE\\n');
  process.exit(1);
}
process.exit(0);
`,
      );
      await chmod(fakePnpm, 0o755);

      await runGit(['init', '--initial-branch=main', repoDir]);
      await initGitIdentity(repoDir);
      await writeFile(
        path.join(repoDir, 'package.json'),
        JSON.stringify({ name: 'step-logs-app', dependencies: { '@angular/core': '^21.0.0' } }),
      );
      await writeFile(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      await writeFile(
        path.join(repoDir, 'angular.json'),
        JSON.stringify({ version: 1, cli: { packageManager: 'pnpm' } }),
      );
      await runGit(['add', '-A'], repoDir);
      await runGit(['commit', '-m', 'init'], repoDir);

      process.env['PATH'] = `${fakeBin}:${originalPath}`;

      const res = await runDeterministicUpgrade(repoDir, 22, 'pnpm run build');
      assert.equal(res.ok, false);
      assert.equal(res.failedStep, 'build');
      assert.ok(res.failedStepLogs);
      assert.match(res.failedStepLogs, /BUILD-STEP-FAILURE/);
      assert.doesNotMatch(res.failedStepLogs, /INSTALL-OK-NOISE/);
      assert.doesNotMatch(res.failedStepLogs, /NG-UPDATE-OK-NOISE/);
    } finally {
      process.env['PATH'] = originalPath;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
