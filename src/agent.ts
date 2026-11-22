import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  commandExists,
  getLastLines,
  runCommand,
  runShellCommand,
  type CommandResult,
} from './exec.js';
import {
  diffWorkspaceSnapshots,
  getHeadSha,
  snapshotWorkspaceState,
} from './git.js';

export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;
export const ERROR_LOG_TAIL_LINES = 150;
export const MAX_DIFF_CHARS = 100_000;

export interface AgentInvocationContext {
  repoName: string;
  worktreePath: string;
  currentMajor: number;
  targetMajor: number;
  failedStep: 'ng-update' | 'build' | 'test';
  buildCommand: string;
  testCommand?: string;
  nodeVersion: string | null;
  errorLog: string;
  gitDiff: string;
}

export interface AgentOptions {
  timeoutMs?: number;
  agentCommand?: string;
}

export interface AgentRunResult {
  invoked: boolean;
  succeeded: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  aiModifiedFiles: string[];
  error?: string;
}

type ResolvedAgent =
  | { kind: 'shell'; command: string; label: string }
  | { kind: 'binary'; binary: string; args: string[]; label: string };

const REMEDIATION_PROMPT_PATH = fileURLToPath(
  new URL('../prompts/remediation.md', import.meta.url),
);

function formatBoundedDiff(gitDiff: string): string {
  const trimmed = gitDiff.trim();
  if (trimmed.length === 0) {
    return '(no uncommitted git diff present yet)';
  }

  if (trimmed.length <= MAX_DIFF_CHARS) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_DIFF_CHARS)}\n\n...[git diff truncated at ${MAX_DIFF_CHARS} characters]...`;
}

export async function buildRemediationPrompt(
  ctx: AgentInvocationContext,
): Promise<string> {
  const baseInstructions = await readFile(REMEDIATION_PROMPT_PATH, 'utf8');
  const tailLog = getLastLines(ctx.errorLog, ERROR_LOG_TAIL_LINES);
  const diffSection = formatBoundedDiff(ctx.gitDiff);
  const nodeWrapper = ctx.nodeVersion
    ? `fnm exec --using=${ctx.nodeVersion} -- <command>`
    : 'system default Node';

  return [
    baseInstructions.trimEnd(),
    '',
    '---',
    '',
    '## Runtime Failure Context',
    '',
    `- **Repository:** \`${ctx.repoName}\``,
    `- **Worktree Directory:** \`${ctx.worktreePath}\``,
    `- **Angular Upgrade:** \`v${ctx.currentMajor}\` -> \`v${ctx.targetMajor}\``,
    `- **Failed Step:** \`${ctx.failedStep}\``,
    `- **Node Environment:** \`${nodeWrapper}\``,
    `- **Build Verification Command:** \`${ctx.buildCommand}\``,
    `- **Test Verification Command:** \`${ctx.testCommand ?? 'none'}\``,
    '',
    `## Last ${ERROR_LOG_TAIL_LINES} Lines of Error Log`,
    '',
    '```text',
    tailLog.length > 0 ? tailLog : '(empty log)',
    '```',
    '',
    '## Current `git diff`',
    '',
    '```diff',
    diffSection,
    '```',
    '',
    'Apply the minimal code fixes needed inside the current worktree, verify the build/test commands pass, and exit without running any git commit/push or PR commands.',
  ].join('\n');
}

export async function resolveAgentCommand(
  override: string | undefined,
  timeoutMs: number,
): Promise<ResolvedAgent | null> {
  const explicit = override ?? process.env['AGENT_CMD'];
  if (explicit && explicit.trim().length > 0) {
    const trimmed = explicit.trim();
    return { kind: 'shell', command: trimmed, label: trimmed };
  }

  const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));

  if (await commandExists('agy')) {
    return {
      kind: 'binary',
      binary: 'agy',
      args: [
        '--print',
        '--mode',
        'accept-edits',
        '--disable-slash-commands',
        '--print-timeout',
        `${timeoutSecs}s`,
      ],
      label: 'agy --print --mode accept-edits',
    };
  }

  if (await commandExists('claude')) {
    return {
      kind: 'binary',
      binary: 'claude',
      args: ['-p', '--permission-mode', 'acceptEdits'],
      label: 'claude -p --permission-mode acceptEdits',
    };
  }

  if (await commandExists('gemini')) {
    return {
      kind: 'binary',
      binary: 'gemini',
      args: ['-p', '', '--approval-mode', 'auto_edit'],
      label: 'gemini -p "" --approval-mode auto_edit',
    };
  }

  if (await commandExists('codex')) {
    return {
      kind: 'binary',
      binary: 'codex',
      args: ['exec', '--full-auto', '-'],
      label: 'codex exec --full-auto -',
    };
  }

  return null;
}

export async function invokeRemediationAgent(
  ctx: AgentInvocationContext,
  options: AgentOptions = {},
): Promise<AgentRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const resolved = await resolveAgentCommand(options.agentCommand, timeoutMs);

  if (!resolved) {
    return {
      invoked: false,
      succeeded: false,
      timedOut: false,
      exitCode: null,
      durationMs: 0,
      output: '',
      aiModifiedFiles: [],
      error:
        'No local CLI coding agent found on PATH (checked agy, claude, gemini, codex). Pass --agent-cmd or set AGENT_CMD.',
    };
  }

  const [headBefore, filesBefore, prompt] = await Promise.all([
    getHeadSha(ctx.worktreePath),
    snapshotWorkspaceState(ctx.worktreePath),
    buildRemediationPrompt(ctx),
  ]);

  let result: CommandResult;
  try {
    if (resolved.kind === 'shell') {
      result = await runShellCommand(resolved.command, {
        cwd: ctx.worktreePath,
        stdin: prompt,
        timeoutMs,
      });
    } else {
      result = await runCommand(resolved.binary, resolved.args, {
        cwd: ctx.worktreePath,
        stdin: prompt,
        timeoutMs,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      invoked: true,
      succeeded: false,
      timedOut: false,
      exitCode: null,
      durationMs: 0,
      output: '',
      aiModifiedFiles: [],
      error: `Agent invocation ("${resolved.label}") failed to start: ${message}`,
    };
  }

  const [headAfter, filesAfter] = await Promise.all([
    getHeadSha(ctx.worktreePath),
    snapshotWorkspaceState(ctx.worktreePath),
  ]);

  const aiModifiedFiles = diffWorkspaceSnapshots(filesBefore, filesAfter);

  if (headAfter !== headBefore) {
    return {
      invoked: true,
      succeeded: false,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.combined,
      aiModifiedFiles,
      error: `Agent policy violation: HEAD changed from ${headBefore} to ${headAfter}. Commits and branch mutations are forbidden.`,
    };
  }

  if (result.timedOut) {
    return {
      invoked: true,
      succeeded: false,
      timedOut: true,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.combined,
      aiModifiedFiles,
      error: `Agent ("${resolved.label}") timed out after ${Math.round(timeoutMs / 1000)}s.`,
    };
  }

  if (result.exitCode !== 0) {
    return {
      invoked: true,
      succeeded: false,
      timedOut: false,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.combined,
      aiModifiedFiles,
      error: `Agent ("${resolved.label}") exited with code ${result.exitCode}.`,
    };
  }

  return {
    invoked: true,
    succeeded: true,
    timedOut: false,
    exitCode: 0,
    durationMs: result.durationMs,
    output: result.combined,
    aiModifiedFiles,
  };
}
