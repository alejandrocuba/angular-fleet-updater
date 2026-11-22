import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FleetRepoConfig } from './config.js';
import {
  commandExists,
  runCommand,
  runShellCommand,
  type CommandOptions,
  type CommandResult,
} from './exec.js';

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
  exitCode: number | null;
}

export interface DeterministicUpgradeResult {
  ok: boolean;
  failedStep?: 'install' | 'ng-update' | 'build' | 'test';
  logs: string;
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
): Promise<VerificationGateResult> {
  const logChunks: string[] = [];

  const buildResult = await runInRepoEnv(cwd, nodeVersion, buildCommand);
  logChunks.push(formatStepLog(buildCommand, buildResult));
  if (buildResult.exitCode !== 0) {
    return {
      ok: false,
      failedStep: 'build',
      logs: logChunks.join('\n'),
      exitCode: buildResult.exitCode,
    };
  }

  if (testCommand) {
    const testResult = await runInRepoEnv(cwd, nodeVersion, testCommand);
    logChunks.push(formatStepLog(testCommand, testResult));
    if (testResult.exitCode !== 0) {
      return {
        ok: false,
        failedStep: 'test',
        logs: logChunks.join('\n'),
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

export async function runDeterministicUpgrade(
  worktreePath: string,
  targetMajor: number,
  buildCommand: string,
  testCommand?: string,
): Promise<DeterministicUpgradeResult> {
  const nodeVersion = await detectNodeVersion(worktreePath);
  const logChunks: string[] = [];

  const installCommand = 'pnpm install --no-frozen-lockfile';
  const installResult = await runInRepoEnv(worktreePath, nodeVersion, installCommand);
  logChunks.push(formatStepLog(installCommand, installResult));
  if (installResult.exitCode !== 0) {
    return {
      ok: false,
      failedStep: 'install',
      logs: logChunks.join('\n'),
      exitCode: installResult.exitCode,
      nodeVersion,
    };
  }

  const updateCommand = `pnpm exec ng update @angular/core@${targetMajor} @angular/cli@${targetMajor} --allow-dirty --force`;
  const updateResult = await runInRepoEnv(worktreePath, nodeVersion, updateCommand);
  logChunks.push(formatStepLog(updateCommand, updateResult));
  if (updateResult.exitCode !== 0) {
    return {
      ok: false,
      failedStep: 'ng-update',
      logs: logChunks.join('\n'),
      exitCode: updateResult.exitCode,
      nodeVersion,
    };
  }

  const verification = await runVerificationGate(
    worktreePath,
    nodeVersion,
    buildCommand,
    testCommand,
  );
  logChunks.push(verification.logs);

  return {
    ok: verification.ok,
    ...(verification.failedStep ? { failedStep: verification.failedStep } : {}),
    logs: logChunks.join('\n'),
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

    const angularInfo = extractAngularCoreVersion(packageJsonContent);
    if (!angularInfo) {
      return {
        name: repo.name,
        localPath: repo.localPath,
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
