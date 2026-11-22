import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { styleText } from 'node:util';
import {
  S_BAR,
  cancel,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  taskLog,
} from '@clack/prompts';
import type { DryRunRepoReport } from './upgrade.js';

const IGNORED_WATCH_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.angular',
  'dist',
  '.nx',
  '.vite',
  'coverage',
]);

function tag(repoName: string, color: 'cyan' | 'green' | 'yellow' | 'red' = 'cyan'): string {
  return styleText([color, 'bold'], `[${repoName}]`);
}

export function uiIntro(title: string): void {
  intro(styleText(['bgCyan', 'black', 'bold'], ` ${title} `));
}

export function uiOutro(message: string): void {
  outro(styleText(['green', 'bold'], message));
}

export function uiCancel(message: string): void {
  cancel(styleText('yellow', message));
}

export function uiStep(repoName: string, message: string): void {
  log.step(`${tag(repoName, 'cyan')} ${message}`);
}

export function uiInfo(repoName: string, message: string): void {
  log.info(`${tag(repoName, 'cyan')} ${message}`);
}

export function uiSuccess(repoName: string, message: string): void {
  log.success(`${tag(repoName, 'green')} ${styleText('green', message)}`);
}

export function uiWarn(repoName: string, message: string): void {
  log.warn(`${tag(repoName, 'yellow')} ${styleText('yellow', message)}`);
}

export function uiError(repoName: string, message: string): void {
  log.error(`${tag(repoName, 'red')} ${styleText('red', message)}`);
}

export function uiNote(body: string, title: string): void {
  note(body, styleText(['cyan', 'bold'], title));
}

export function classifyFileType(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  const base = path.basename(normalized);

  if (base === 'package.json') return 'package.json';
  if (base === 'pnpm-lock.yaml' || base === 'package-lock.json' || base === 'yarn.lock') {
    return 'lockfile';
  }
  if (base === 'angular.json' || base === 'nx.json' || base.startsWith('tsconfig')) {
    return 'config';
  }
  if (normalized.endsWith('.spec.ts') || normalized.endsWith('.test.ts')) {
    return 'test';
  }
  if (normalized.endsWith('.ts') || normalized.endsWith('.mts') || normalized.endsWith('.cts')) {
    return 'TypeScript';
  }
  if (normalized.endsWith('.html')) return 'HTML';
  if (
    normalized.endsWith('.scss') ||
    normalized.endsWith('.css') ||
    normalized.endsWith('.sass') ||
    normalized.endsWith('.less')
  ) {
    return 'styles';
  }
  if (normalized.endsWith('.json')) return 'JSON';
  if (normalized.endsWith('.md')) return 'Markdown';
  return 'file';
}

export interface CommandStreamCallbacks {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  flush: () => void;
}

export interface RepoTaskGroup {
  message(line: string): void;
  success(message: string): void;
  error(message: string): void;
}

export interface RepoTaskLogger {
  readonly repoName: string;
  message(line: string): void;
  startGroup(title: string): RepoTaskGroup;
  success(message: string): void;
  error(message: string): void;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function createRepoTaskLogger(
  repoName: string,
  subtitle?: string,
): RepoTaskLogger {
  const tl = taskLog({
    title: subtitle ? `${repoName} (${subtitle})` : repoName,
    limit: 12,
    retainLog: true,
  });

  let activeGroup: ReturnType<typeof tl.group> | undefined;

  return {
    repoName,
    message(line: string): void {
      const clean = stripAnsi(line).replace(/\r$/, '');
      if (clean.length === 0) {
        return;
      }
      if (activeGroup) {
        activeGroup.message(clean);
      } else {
        tl.message(clean);
      }
    },
    startGroup(title: string): RepoTaskGroup {
      const group = tl.group(title);
      activeGroup = group;
      return {
        message(line: string): void {
          const clean = stripAnsi(line).replace(/\r$/, '');
          if (clean.length > 0) {
            group.message(clean);
          }
        },
        success(message: string): void {
          if (activeGroup === group) {
            activeGroup = undefined;
          }
          group.success(message);
        },
        error(message: string): void {
          if (activeGroup === group) {
            activeGroup = undefined;
          }
          group.error(message);
        },
      };
    },
    success(message: string): void {
      activeGroup = undefined;
      tl.success(message);
    },
    error(message: string): void {
      activeGroup = undefined;
      tl.error(message, { showLog: true });
    },
  };
}

export function createCommandStreamCallbacks(
  repoName: string,
  sink?: (line: string, isErr: boolean) => void,
): CommandStreamCallbacks {
  let stdoutBuf = '';
  let stderrBuf = '';
  const bar = styleText('gray', S_BAR);
  const prefix = styleText('dim', `[${repoName}]`);

  const writeLine = (line: string, isErr: boolean): void => {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length === 0) {
      return;
    }
    if (sink) {
      const clean = stripAnsi(trimmed);
      if (clean.length > 0) {
        sink(clean, isErr);
      }
      return;
    }
    const colored = isErr ? styleText('yellow', trimmed) : styleText('dim', trimmed);
    process.stdout.write(`${bar}  ${prefix} ${colored}\n`);
  };

  const pump = (buf: string, chunk: string, isErr: boolean): string => {
    const combined = buf + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() ?? '';
    for (const line of lines) {
      writeLine(line, isErr);
    }
    return remainder;
  };

  return {
    onStdout: (chunk: string) => {
      stdoutBuf = pump(stdoutBuf, chunk, false);
    },
    onStderr: (chunk: string) => {
      stderrBuf = pump(stderrBuf, chunk, true);
    },
    flush: () => {
      if (stdoutBuf.length > 0) {
        writeLine(stdoutBuf, false);
        stdoutBuf = '';
      }
      if (stderrBuf.length > 0) {
        writeLine(stderrBuf, true);
        stderrBuf = '';
      }
    },
  };
}

export function watchRepoFiles(
  worktreePath: string,
  repoName: string,
  sink?: (line: string) => void,
): { stop: () => void; pause: () => void; resume: () => void } {
  const lastSeen = new Map<string, number>();
  const bar = styleText('gray', S_BAR);
  let watcher: FSWatcher | undefined;
  let paused = false;

  try {
    watcher = watch(worktreePath, { recursive: true }, (eventType, filename) => {
      if (paused || !filename) {
        return;
      }
      const normalized = filename.replaceAll('\\', '/');
      const parts = normalized.split('/');
      if (parts.some((part) => IGNORED_WATCH_SEGMENTS.has(part))) {
        return;
      }

      const now = Date.now();
      const prev = lastSeen.get(normalized) ?? 0;
      if (now - prev < 250) {
        return;
      }
      lastSeen.set(normalized, now);

      const fileType = classifyFileType(normalized);
      if (sink) {
        sink(`✎ [${fileType}] ${normalized} (${eventType})`);
        return;
      }
      const badge = styleText('magenta', `[${fileType}]`);
      const action = styleText('dim', `(${eventType})`);
      process.stdout.write(
        `${bar}  ${styleText('cyan', '✎')} ${tag(repoName, 'cyan')} ${badge} ${normalized} ${action}\n`,
      );
    });

    watcher.on('error', () => {
      // Ignore transient watcher errors during worktree teardown.
    });
  } catch {
    // Best-effort real-time watcher; ignore if OS watcher limit is reached.
  }

  return {
    stop: () => {
      watcher?.close();
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
}

export async function selectReposToUpgrade(
  reports: DryRunRepoReport[],
): Promise<string[] | null> {
  const selectable = reports.filter(
    (report) => report.status === 'upgrade-available' || report.status === 'up-to-date',
  );

  if (selectable.length === 0) {
    return [];
  }

  const options = reports.map((report) => {
    const versionText =
      report.currentMajor !== null && report.targetMajor !== null
        ? `v${report.currentMajor} -> v${report.targetMajor}`
        : report.currentMajor !== null
          ? `v${report.currentMajor}`
          : '-';

    const statusBadge =
      report.status === 'upgrade-available'
        ? styleText('green', 'upgrade-available')
        : report.status === 'up-to-date'
          ? styleText('dim', 'up-to-date')
          : styleText('red', report.status);

    const frameworkPrefix = report.framework === 'analog' ? 'Analog | ' : '';

    return {
      value: report.name,
      label: report.name,
      hint: `${frameworkPrefix}${versionText} | ${statusBadge}${report.nodeVersion ? ` | Node ${report.nodeVersion}` : ''}`,
    };
  });

  const defaultSelected = reports
    .filter((report) => report.status === 'upgrade-available')
    .map((report) => report.name);

  const selected = await multiselect({
    message: 'Select the projects you want to update (space to toggle, enter to confirm):',
    options,
    initialValues: defaultSelected,
    required: false,
  });

  if (isCancel(selected)) {
    uiCancel('Fleet upgrade cancelled.');
    return null;
  }

  return selected;
}

export type DirtyTreeAction =
  | 'allow-dirty'
  | 'discard'
  | 'stash'
  | 'skip'
  | 'cancel';

export async function promptDirtyWorktreeAction(
  repoName: string,
  dirtyFiles: string[],
): Promise<DirtyTreeAction> {
  const maxPreview = 10;
  const previewLines = dirtyFiles.slice(0, maxPreview).map((entry) => `  ${entry}`);
  if (dirtyFiles.length > maxPreview) {
    previewLines.push(`  ... and ${dirtyFiles.length - maxPreview} more`);
  }

  uiWarn(
    repoName,
    `Dirty git worktree detected (${dirtyFiles.length} change(s)):\n${previewLines.join('\n')}`,
  );

  const choice = await select<DirtyTreeAction>({
    message: `[${repoName}] Git worktree is dirty before ng update. How would you like to proceed?`,
    options: [
      {
        value: 'allow-dirty',
        label: 'Continue with --allow-dirty',
        hint: 'Keep current changes in the isolated worktree and run ng update --allow-dirty',
      },
      {
        value: 'discard',
        label: 'Discard uncommitted changes',
        hint: 'Run git reset --hard HEAD && git clean -fd (keeps node_modules)',
      },
      {
        value: 'stash',
        label: 'Stash changes temporarily',
        hint: 'Run git stash --include-untracked before ng update',
      },
      {
        value: 'skip',
        label: 'Skip this repository',
        hint: 'Skip this repo and continue with the remaining repositories',
      },
    ],
  });

  if (isCancel(choice)) {
    return 'cancel';
  }

  return choice;
}
