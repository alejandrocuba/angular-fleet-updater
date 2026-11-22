import { readFile } from 'node:fs/promises';
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
  deleteLocalBranch,
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
import {
  createRepoTaskLogger,
  promptDirtyWorktreeAction,
  selectReposToUpgrade,
  uiCancel,
  uiIntro,
  uiNote,
  uiOutro,
  uiWarn,
  watchRepoFiles,
} from './ui.js';

class UserCancelledError extends Error {
  constructor() {
    super('Fleet upgrade cancelled by user.');
    this.name = 'UserCancelledError';
  }
}

export type RepoOutcomeStatus =
  | 'pr-created'
  | 'draft-pr-created'
  | 'up-to-date'
  | 'skipped'
  | 'failed';

export interface RepoExecutionSummary {
  name: string;
  upgradePath: string;
  status: RepoOutcomeStatus;
  details: string;
  errorOutput?: string;
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
  --latest-version <semver>  Override latest @angular/core version check instead of running pnpm view
  -y, --yes                  Skip interactive project selection and update all eligible repositories
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

function buildDryRunTableText(
  reports: DryRunRepoReport[],
  latest: LatestAngularInfo,
): string {
  const headerLine = `Angular Fleet Status (latest @angular/core: v${latest.version} / major ${latest.major})`;
  const headers = ['Repository', 'Framework', 'Current', 'Latest', 'Target', 'Node', 'Status'];
  const rows = reports.map((report) => {
    const framework = report.framework === 'analog' ? 'Analog' : 'Angular';
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
      framework,
      current,
      `v${report.latestMajor}`,
      target,
      node,
      status,
    ];
  });

  return `${headerLine}\n\n${formatTable(headers, rows)}`;
}

function printDryRunTable(
  reports: DryRunRepoReport[],
  latest: LatestAngularInfo,
): void {
  console.log(`\n${buildDryRunTableText(reports, latest)}\n`);
}

function buildSummaryTableText(summaries: RepoExecutionSummary[]): string {
  const headers = ['Repository', 'Upgrade', 'Outcome', 'Details'];
  const rows = summaries.map((item) => [
    item.name,
    item.upgradePath,
    item.status,
    item.details,
  ]);
  return formatTable(headers, rows);
}

export function formatConsolidatedError(
  sections: Array<{ title: string; content: string }>,
  maxLinesPerSection = 30,
): string {
  const rendered: string[] = [];
  for (const section of sections) {
    const trimmed = section.content.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const tail = getLastLines(trimmed, maxLinesPerSection).trim();
    if (tail.length === 0) {
      continue;
    }
    rendered.push(`--- ${section.title} ---\n${tail}`);
  }
  return rendered.join('\n\n');
}

export function buildFailureReportText(
  summaries: RepoExecutionSummary[],
): string {
  const failed = summaries.filter((item) => item.status === 'failed');
  if (failed.length === 0) {
    return '';
  }

  return failed
    .map((item) => {
      const header = `[${item.name}] (${item.upgradePath}) - ${item.details}`;
      if (!item.errorOutput || item.errorOutput.trim().length === 0) {
        return header;
      }
      return `${header}\n${item.errorOutput.trimEnd()}`;
    })
    .join('\n\n');
}

async function processRepository(
  repo: FleetRepoConfig,
  latest: LatestAngularInfo,
  agentTimeoutMs: number,
  interactive: boolean,
  agentCmd?: string,
): Promise<RepoExecutionSummary> {
  const repoLogger = createRepoTaskLogger(repo.name, repo.localPath);

  try {
    const prepGroup = repoLogger.startGroup('Git fetch & version check');
    let baseRef: string;
    let angularInfo: ReturnType<typeof extractAngularCoreVersion>;
    try {
      prepGroup.message(`Fetching origin in ${repo.localPath}...`);
      await fetchOrigin(repo.localPath);
      baseRef = await resolveRemoteDefaultBranch(repo.localPath);
      const packageJsonRaw = await readFileFromRef(repo.localPath, baseRef, 'package.json');
      angularInfo = extractAngularCoreVersion(packageJsonRaw);
      prepGroup.success(
        `Base: ${baseRef} | Angular: ${angularInfo ? `v${angularInfo.major} (${angularInfo.rawRange})` : 'not found'}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      prepGroup.error(`Git fetch & version check failed: ${msg.split(/\r?\n/)[0] ?? msg}`);
      throw error;
    }

    if (!angularInfo) {
      let localDetail = `@angular/core not found in ${baseRef}:package.json`;
      let summaryDetail = '@angular/core not found';
      try {
        const localPkgRaw = await readFile(
          path.join(repo.localPath, 'package.json'),
          'utf8',
        );
        const localInfo = extractAngularCoreVersion(localPkgRaw);
        if (localInfo) {
          localDetail = `${localDetail} (local working tree has v${localInfo.major}; push/merge to ${baseRef} first)`;
          summaryDetail = `Not in ${baseRef} (local has v${localInfo.major})`;
        }
      } catch {
        // Ignore unreadable/invalid local package.json during skip reporting.
      }

      repoLogger.success(`[${repo.name}] Skipped (${localDetail})`);
      return {
        name: repo.name,
        upgradePath: '-',
        status: 'skipped',
        details: summaryDetail,
      };
    }

    if (angularInfo.major >= latest.major) {
      repoLogger.success(
        `[${repo.name}] Up to date (v${angularInfo.major} >= v${latest.major})`,
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

    repoLogger.message(
      `Creating isolated worktree for ${upgradePath} on branch "${branchName}" from "${baseRef}"...`,
    );

    const summary = await withIsolatedWorktree(
      repo.localPath,
      repo.name,
      branchName,
      baseRef,
      async (worktreePath): Promise<RepoExecutionSummary> => {
        repoLogger.message(
          `Worktree ready at ${worktreePath}. Watching file changes in real time...`,
        );
        const fileWatcher = watchRepoFiles(worktreePath, repo.name, (line) =>
          repoLogger.message(line),
        );

        try {
          const deterministic = await runDeterministicUpgrade(
            worktreePath,
            targetMajor,
            repo.buildCommand,
            repo.testCommand,
            repoLogger,
            async (dirtyFiles) => {
              if (!interactive) {
                repoLogger.message(
                  `Worktree has ${dirtyFiles.length} uncommitted change(s) (non-interactive mode); continuing with --allow-dirty`,
                );
                return 'allow-dirty';
              }

              fileWatcher.pause();
              try {
                return await promptDirtyWorktreeAction(repo.name, dirtyFiles);
              } finally {
                fileWatcher.resume();
              }
            },
          );

          if (deterministic.cancelledByUser) {
            throw new UserCancelledError();
          }

          if (deterministic.skippedByUser) {
            repoLogger.success(
              `[${repo.name}] ${upgradePath} skipped (dirty git tree)`,
            );
            return {
              name: repo.name,
              upgradePath,
              status: 'skipped',
              details: 'Skipped by user (dirty git tree)',
            };
          }

          let agentIntervened = false;
          let aiModifiedFiles: string[] = [];

          if (!deterministic.ok) {
            const failedStep = deterministic.failedStep ?? 'build';
            const failureLog = deterministic.failedStepLogs ?? deterministic.logs;

            if (failedStep === 'install') {
              repoLogger.error(`[${repo.name}] ${upgradePath} failed: pnpm install failed`);
              return {
                name: repo.name,
                upgradePath,
                status: 'failed',
                details: 'pnpm install failed',
                errorOutput: formatConsolidatedError([
                  { title: 'Failed step: install', content: failureLog },
                ]),
              };
            }

            repoLogger.message(
              `Deterministic step "${failedStep}" failed (exit ${deterministic.exitCode ?? 'null'}). Invoking remediation agent...`,
            );
            agentIntervened = true;

            const gitDiff = await getGitDiff(worktreePath);
            const agentResult = await invokeRemediationAgent(
              {
                repoName: repo.name,
                worktreePath,
                ...(deterministic.framework !== undefined
                  ? { framework: deterministic.framework }
                  : {}),
                currentMajor,
                targetMajor,
                failedStep,
                buildCommand: repo.buildCommand,
                ...(repo.testCommand !== undefined ? { testCommand: repo.testCommand } : {}),
                nodeVersion: deterministic.nodeVersion,
                errorLog: failureLog,
                gitDiff,
              },
              {
                timeoutMs: agentTimeoutMs,
                ...(agentCmd !== undefined ? { agentCommand: agentCmd } : {}),
                repoLogger,
              },
            );

            aiModifiedFiles = agentResult.aiModifiedFiles;

            if (!agentResult.succeeded) {
              const errDetail = agentResult.error ?? 'Remediation agent failed.';
              const firstLine = errDetail.split(/\r?\n/)[0] ?? errDetail;
              repoLogger.error(`[${repo.name}] ${upgradePath} failed: ${firstLine}`);
              return {
                name: repo.name,
                upgradePath,
                status: 'failed',
                details: firstLine,
                errorOutput: formatConsolidatedError([
                  { title: `Failed step: ${failedStep}`, content: failureLog },
                  {
                    title: 'Remediation agent',
                    content:
                      agentResult.output.trim().length > 0
                        ? agentResult.output
                        : errDetail,
                  },
                ]),
              };
            }

            const pendingChanges = await hasPendingChanges(worktreePath);
            if (!pendingChanges || aiModifiedFiles.length === 0) {
              const reason = !pendingChanges
                ? `Update failed (${failedStep}) and no code changes were produced`
                : `Remediation agent made no code changes after "${failedStep}" failed`;
              repoLogger.error(`[${repo.name}] ${upgradePath} failed: ${reason}`);
              return {
                name: repo.name,
                upgradePath,
                status: 'failed',
                details: reason,
                errorOutput: formatConsolidatedError([
                  { title: `Failed step: ${failedStep}`, content: failureLog },
                  { title: 'Remediation agent output', content: agentResult.output },
                ]),
              };
            }

            const nodeVersion =
              deterministic.nodeVersion ?? (await detectNodeVersion(worktreePath));
            const reverify = await runVerificationGate(
              worktreePath,
              nodeVersion,
              repo.buildCommand,
              repo.testCommand,
              repoLogger,
            );

            if (!reverify.ok) {
              const details = `Verification gate (${reverify.failedStep ?? 'build'}) failed after remediation`;
              repoLogger.error(`[${repo.name}] ${upgradePath} failed: ${details}`);
              return {
                name: repo.name,
                upgradePath,
                status: 'failed',
                details,
                errorOutput: formatConsolidatedError([
                  {
                    title: `Verification gate (${reverify.failedStep ?? 'build'})`,
                    content: reverify.logs,
                  },
                ]),
              };
            }
          }

          if (!(await hasPendingChanges(worktreePath))) {
            repoLogger.success(
              `[${repo.name}] ${upgradePath} skipped (no file changes produced)`,
            );
            return {
              name: repo.name,
              upgradePath,
              status: 'skipped',
              details: 'No file changes produced by upgrade.',
            };
          }

          const prGroup = repoLogger.startGroup('Commit, push & open PR');
          let delivery: Awaited<ReturnType<typeof commitPushAndCreatePr>>;
          try {
            prGroup.message(
              `Pushing "${branchName}" and opening ${agentIntervened ? 'draft PR' : 'PR'}...`,
            );
            delivery = await commitPushAndCreatePr({
              worktreePath,
              repoName: repo.name,
              branchName,
              baseRef,
              ...(deterministic.framework !== undefined
                ? { framework: deterministic.framework }
                : {}),
              currentMajor,
              targetMajor,
              agentIntervened,
              aiModifiedFiles,
            });
            prGroup.success(delivery.prUrl || branchName);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            prGroup.error(`PR delivery failed: ${msg.split(/\r?\n/)[0] ?? msg}`);
            throw error;
          }

          const statusLabel = agentIntervened ? 'Draft PR' : 'PR';
          repoLogger.success(
            `[${repo.name}] ${upgradePath} | ${statusLabel}: ${delivery.prUrl || branchName}`,
          );

          return {
            name: repo.name,
            upgradePath,
            status: agentIntervened ? 'draft-pr-created' : 'pr-created',
            details: delivery.prUrl || `${branchName} pushed`,
          };
        } finally {
          fileWatcher.stop();
        }
      },
    );

    if (summary.status === 'failed' || summary.status === 'skipped') {
      await deleteLocalBranch(repo.localPath, branchName);
    }

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const firstLine = message.split(/\r?\n/)[0] ?? message;
    repoLogger.error(`[${repo.name}] ${firstLine}`);
    throw error;
  }
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
      yes: { type: 'boolean', short: 'y', default: false },
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

  uiIntro('angular-fleet-updater');
  const reports = await Promise.all(fleet.map((repo) => analyzeRepoDryRun(repo, latest)));
  uiNote(buildDryRunTableText(reports, latest), 'Fleet Status');

  const interactive = !values.yes && Boolean(process.stdin.isTTY);
  let targetFleet = fleet;
  if (interactive) {
    const selectedNames = await selectReposToUpgrade(reports);
    if (selectedNames === null) {
      return 0;
    }
    const selectedSet = new Set(selectedNames);
    targetFleet = fleet.filter((repo) => selectedSet.has(repo.name));
  }

  if (targetFleet.length === 0) {
    uiOutro('No repositories selected for upgrade.');
    return 0;
  }

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    uiWarn('fleet', `Received ${signal}; cleaning up active git worktrees...`);
    void cleanupAllActiveWorktrees().finally(() => {
      process.exit(130);
    });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const summaries: RepoExecutionSummary[] = [];

  try {
    for (const repo of targetFleet) {
      try {
        const summary = await processRepository(
          repo,
          latest,
          agentTimeoutMs,
          interactive,
          values['agent-cmd'],
        );
        summaries.push(summary);
      } catch (error) {
        if (error instanceof UserCancelledError) {
          uiCancel('Fleet upgrade cancelled.');
          return 130;
        }
        const message = error instanceof Error ? error.message : String(error);
        const firstLine = message.split(/\r?\n/)[0] ?? message;
        summaries.push({
          name: repo.name,
          upgradePath: '-',
          status: 'failed',
          details: firstLine,
          errorOutput: formatConsolidatedError([
            { title: 'Unexpected error', content: message },
          ]),
        });
      }
    }
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanupAllActiveWorktrees();
  }

  uiNote(buildSummaryTableText(summaries), 'Final Fleet Upgrade Summary');
  const hasFailures = summaries.some((summary) => summary.status === 'failed');
  if (hasFailures) {
    const failureReport = buildFailureReportText(summaries);
    if (failureReport.length > 0) {
      uiNote(failureReport, 'Consolidated Failure Details');
    }
  }
  uiOutro(hasFailures ? 'Fleet run finished with failures.' : 'Fleet run completed.');
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
