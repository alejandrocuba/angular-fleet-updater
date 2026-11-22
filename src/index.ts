import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  invokeRemediationAgent,
} from './agent.js';
import { loadFleetConfig, type FleetRepoConfig } from './config.js';
import { getLastLines } from './exec.js';
import {
  cleanupAllActiveWorktrees,
  commitPushAndCreatePr,
  fetchOrigin,
  getGitDiff,
  hasPendingChanges,
  readFileFromRef,
  resolveRemoteDefaultBranch,
  withIsolatedWorktree,
} from './git.js';
import {
  analyzeRepoDryRun,
  detectNodeVersion,
  extractAngularCoreVersion,
  fetchLatestAngularVersion,
  runDeterministicUpgrade,
  runVerificationGate,
  type DryRunRepoReport,
  type LatestAngularInfo,
} from './upgrade.js';

type RepoOutcomeStatus =
  | 'pr-created'
  | 'draft-pr-created'
  | 'up-to-date'
  | 'skipped'
  | 'failed';

interface RepoExecutionSummary {
  name: string;
  upgradePath: string;
  status: RepoOutcomeStatus;
  details: string;
}

function printHelp(): void {
  console.log(`angular-fleet-updater - Deterministic-First, Agent-Fallback Angular CLI fleet upgrader

Usage:
  pnpm start -- [options]
  pnpm run dry-run

Options:
  --dry-run                  Analyze Angular versions in fleet.json without modifying repos or creating worktrees
  --config <path>            Path to fleet config JSON (default: ./fleet.json)
  --timeout <seconds>        Agent remediation timeout per repository in seconds (default: ${DEFAULT_AGENT_TIMEOUT_MS / 1000})
  --agent-cmd <command>      Override local headless agent command (receives prompt via stdin)
  --latest-version <semver>  Override latest @angular/core version check instead of running npm view
  -h, --help                 Show this help message
`);
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, columnIndex) => {
    const cellWidths = rows.map((row) => (row[columnIndex] ?? '').length);
    return Math.max(header.length, ...cellWidths);
  });

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex] ?? cell.length))
      .join('  ');

  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  return [renderRow(headers), separator, ...rows.map(renderRow)].join('\n');
}

function printDryRunTable(
  reports: DryRunRepoReport[],
  latest: LatestAngularInfo,
): void {
  console.log(
    `\nAngular Fleet Dry Run (latest @angular/core: v${latest.version} / major ${latest.major})\n`,
  );

  const headers = ['Repository', 'Current', 'Latest', 'Target', 'Node', 'Status'];
  const rows = reports.map((report) => {
    const current =
      report.currentMajor !== null && report.currentRaw !== null
        ? `v${report.currentMajor} (${report.currentRaw})`
        : '-';
    const target = report.targetMajor !== null ? `v${report.targetMajor}` : '-';
    const node = report.nodeVersion ?? 'default';
    const status = report.message
      ? `${report.status}: ${report.message}`
      : report.status;

    return [
      report.name,
      current,
      `v${report.latestMajor}`,
      target,
      node,
      status,
    ];
  });

  console.log(formatTable(headers, rows));
  console.log('');
}

function printSummaryTable(summaries: RepoExecutionSummary[]): void {
  console.log('\n=== Final Fleet Upgrade Summary ===\n');
  const headers = ['Repository', 'Upgrade', 'Outcome', 'Details'];
  const rows = summaries.map((item) => [
    item.name,
    item.upgradePath,
    item.status,
    item.details,
  ]);
  console.log(formatTable(headers, rows));
  console.log('');
}

async function processRepository(
  repo: FleetRepoConfig,
  latest: LatestAngularInfo,
  agentTimeoutMs: number,
  agentCmd?: string,
): Promise<RepoExecutionSummary> {
  console.log(`\n[${repo.name}] Fetching origin in ${repo.localPath}...`);
  await fetchOrigin(repo.localPath);
  const baseRef = await resolveRemoteDefaultBranch(repo.localPath);
  const packageJsonRaw = await readFileFromRef(repo.localPath, baseRef, 'package.json');
  const angularInfo = extractAngularCoreVersion(packageJsonRaw);

  if (!angularInfo) {
    console.log(`[${repo.name}] @angular/core not found in ${baseRef}:package.json; skipping.`);
    return {
      name: repo.name,
      upgradePath: '-',
      status: 'skipped',
      details: '@angular/core not found',
    };
  }

  if (angularInfo.major >= latest.major) {
    console.log(
      `[${repo.name}] Already at v${angularInfo.major} (latest v${latest.major}); skipping.`,
    );
    return {
      name: repo.name,
      upgradePath: `v${angularInfo.major}`,
      status: 'up-to-date',
      details: `Already at v${angularInfo.major} (latest v${latest.major})`,
    };
  }

  const currentMajor = angularInfo.major;
  const targetMajor = currentMajor + 1;
  const branchName = `chore/angular-upgrade-v${targetMajor}`;
  const upgradePath = `v${currentMajor} -> v${targetMajor}`;

  console.log(
    `[${repo.name}] Upgrading ${upgradePath} on branch "${branchName}" from "${baseRef}" in isolated worktree...`,
  );

  return withIsolatedWorktree(
    repo.localPath,
    repo.name,
    branchName,
    baseRef,
    async (worktreePath): Promise<RepoExecutionSummary> => {
      const deterministic = await runDeterministicUpgrade(
        worktreePath,
        targetMajor,
        repo.buildCommand,
        repo.testCommand,
      );

      let agentIntervened = false;
      let aiModifiedFiles: string[] = [];

      if (!deterministic.ok) {
        const failedStep = deterministic.failedStep ?? 'build';
        console.warn(
          `[${repo.name}] Deterministic step "${failedStep}" failed (exit ${deterministic.exitCode ?? 'null'}).`,
        );

        if (failedStep === 'install') {
          return {
            name: repo.name,
            upgradePath,
            status: 'failed',
            details: `pnpm install failed:\n${getLastLines(deterministic.logs, 15)}`,
          };
        }

        console.log(
          `[${repo.name}] Invoking bounded remediation agent (timeout: ${Math.round(agentTimeoutMs / 1000)}s)...`,
        );
        agentIntervened = true;

        const gitDiff = await getGitDiff(worktreePath);
        const agentResult = await invokeRemediationAgent(
          {
            repoName: repo.name,
            worktreePath,
            currentMajor,
            targetMajor,
            failedStep,
            buildCommand: repo.buildCommand,
            ...(repo.testCommand !== undefined ? { testCommand: repo.testCommand } : {}),
            nodeVersion: deterministic.nodeVersion,
            errorLog: deterministic.logs,
            gitDiff,
          },
          {
            timeoutMs: agentTimeoutMs,
            ...(agentCmd !== undefined ? { agentCommand: agentCmd } : {}),
          },
        );

        aiModifiedFiles = agentResult.aiModifiedFiles;

        if (!agentResult.succeeded) {
          return {
            name: repo.name,
            upgradePath,
            status: 'failed',
            details: agentResult.error ?? 'Remediation agent failed.',
          };
        }

        console.log(
          `[${repo.name}] Agent completed (${aiModifiedFiles.length} file(s) changed). Re-running verification gate...`,
        );

        const nodeVersion =
          deterministic.nodeVersion ?? (await detectNodeVersion(worktreePath));
        const reverify = await runVerificationGate(
          worktreePath,
          nodeVersion,
          repo.buildCommand,
          repo.testCommand,
        );

        if (!reverify.ok) {
          return {
            name: repo.name,
            upgradePath,
            status: 'failed',
            details: `Verification gate (${reverify.failedStep ?? 'build'}) still failed after agent remediation:\n${getLastLines(reverify.logs, 20)}`,
          };
        }
      }

      if (!(await hasPendingChanges(worktreePath))) {
        return {
          name: repo.name,
          upgradePath,
          status: 'skipped',
          details: 'No file changes produced by upgrade.',
        };
      }

      console.log(`[${repo.name}] Verification gate passed. Pushing branch and opening PR...`);
      const delivery = await commitPushAndCreatePr({
        worktreePath,
        repoName: repo.name,
        branchName,
        baseRef,
        currentMajor,
        targetMajor,
        agentIntervened,
        aiModifiedFiles,
      });

      return {
        name: repo.name,
        upgradePath,
        status: agentIntervened ? 'draft-pr-created' : 'pr-created',
        details: delivery.prUrl || `${branchName} pushed`,
      };
    },
  );
}

export async function runCli(argv: string[]): Promise<number> {
  // pnpm passes a literal "--" separator through to scripts (e.g. `pnpm start -- --dry-run`).
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: normalizedArgv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      config: { type: 'string', default: './fleet.json' },
      timeout: { type: 'string', default: String(DEFAULT_AGENT_TIMEOUT_MS / 1000) },
      'agent-cmd': { type: 'string' },
      'latest-version': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return 0;
  }

  const timeoutSeconds = Number.parseFloat(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid --timeout value "${values.timeout}": expected positive seconds.`);
  }
  const agentTimeoutMs = Math.round(timeoutSeconds * 1000);

  const configPath = path.resolve(values.config);
  const fleet = await loadFleetConfig(configPath);
  const latest = await fetchLatestAngularVersion(values['latest-version']);

  if (values['dry-run']) {
    const reports = await Promise.all(
      fleet.map((repo) => analyzeRepoDryRun(repo, latest)),
    );
    printDryRunTable(reports, latest);
    const hasErrors = reports.some((report) => report.status === 'error');
    return hasErrors ? 1 : 0;
  }

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`\nReceived ${signal}; cleaning up active git worktrees...`);
    void cleanupAllActiveWorktrees().finally(() => {
      process.exit(130);
    });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const summaries: RepoExecutionSummary[] = [];

  try {
    for (const repo of fleet) {
      try {
        const summary = await processRepository(
          repo,
          latest,
          agentTimeoutMs,
          values['agent-cmd'],
        );
        summaries.push(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${repo.name}] Error: ${message}`);
        summaries.push({
          name: repo.name,
          upgradePath: '-',
          status: 'failed',
          details: message.split(/\r?\n/)[0] ?? message,
        });
      }
    }
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanupAllActiveWorktrees();
  }

  printSummaryTable(summaries);
  const hasFailures = summaries.some((summary) => summary.status === 'failed');
  return hasFailures ? 1 : 0;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    });
}
