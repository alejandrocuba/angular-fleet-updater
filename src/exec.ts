import { spawn } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  maxCombinedBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const KILL_ESCALATION_MS = 5_000;

class BoundedBufferTail {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1024, maxBytes);
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }

    if (chunk.length >= this.maxBytes) {
      this.chunks = [chunk.subarray(chunk.length - this.maxBytes)];
      this.totalBytes = this.maxBytes;
      this.truncated = true;
      return;
    }

    this.chunks.push(chunk);
    this.totalBytes += chunk.length;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      if (!oldest) {
        break;
      }
      const excess = this.totalBytes - this.maxBytes;
      if (oldest.length <= excess) {
        this.chunks.shift();
        this.totalBytes -= oldest.length;
      } else {
        this.chunks[0] = oldest.subarray(excess);
        this.totalBytes -= excess;
      }
      this.truncated = true;
    }
  }

  toString(): string {
    const body = Buffer.concat(this.chunks).toString('utf8');
    if (this.truncated) {
      return `...[output truncated to last ${this.maxBytes} bytes]...\n${body}`;
    }
    return body;
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child PID if process-group signaling fails.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Process has already exited.
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const startedAt = Date.now();
  const maxBytes = options.maxCombinedBytes ?? DEFAULT_MAX_BYTES;
  const stdoutTail = new BoundedBufferTail(maxBytes);
  const stderrTail = new BoundedBufferTail(maxBytes);
  const combinedTail = new BoundedBufferTail(maxBytes);

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let timedOut = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const cleanupTimers = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (killHandle) {
        clearTimeout(killHandle);
        killHandle = undefined;
      }
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, 'SIGTERM');
        killHandle = setTimeout(() => {
          killProcessTree(child.pid, 'SIGKILL');
        }, KILL_ESCALATION_MS);
        killHandle.unref();
      }, options.timeoutMs);
      timeoutHandle.unref();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutTail.append(chunk);
      combinedTail.append(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail.append(chunk);
      combinedTail.append(chunk);
    });

    // Avoid unhandled stream errors when the child exits before draining stdin.
    child.stdin.on('error', () => {
      // Ignore EPIPE when child exits without reading stdin.
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, 'utf8');
    } else {
      child.stdin.end();
    }

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      reject(new Error(`Failed to execute "${command}": ${error.message}`));
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimers();
      resolve({
        exitCode,
        signal,
        stdout: stdoutTail.toString(),
        stderr: stderrTail.toString(),
        combined: combinedTail.toString(),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runShellCommand(
  shellCommand: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand('sh', ['-c', shellCommand], options);
}

export function getLastLines(text: string, lineCount: number): string {
  if (lineCount <= 0 || text.length === 0) {
    return '';
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  if (lines.length <= lineCount) {
    return lines.join('\n');
  }

  return lines.slice(lines.length - lineCount).join('\n');
}

export async function commandExists(binary: string): Promise<boolean> {
  try {
    const result = await runCommand('which', [binary]);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
