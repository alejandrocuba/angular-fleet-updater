# angular-fleet-updater

A local TypeScript CLI implementing the **Deterministic-First, Agent-Fallback** pattern to safely upgrade multiple local Angular repositories by one major version at a time using isolated `git worktree` sandboxes.

## Quick Start

1. Verify `fleet.json` lists the Angular repositories you want to update (`name`, `localPath`, and optional `buildCommand` / `testCommand`).
2. Preview pending upgrades (read-only):
   ```bash
   pnpm run dry-run
   ```
3. Run the upgrades and open PRs:
   ```bash
   pnpm start
   ```

## Architecture

- `src/index.ts` — CLI entry point (`--dry-run`, `--config`, `--timeout`, `--agent-cmd`, `--latest-version`, `--help`) and per-repo orchestration + final summary report.
- `src/config.ts` — Loads and strictly validates `fleet.json`.
- `src/git.ts` — Performs `git fetch origin`, resolves `origin/main` or `origin/master`, manages isolated worktrees under `/tmp/ng-fleet/<name>` with guaranteed `try / finally` cleanup, computes workspace diffs, and delivers PRs via `git` + `gh`.
- `src/upgrade.ts` — Detects `.nvmrc` / `.node-version` for `fnm exec`, compares `@angular/core` against `pnpm view @angular/core version`, runs `pnpm install --no-frozen-lockfile`, `pnpm exec ng update @angular/core@<targetMajor> @angular/cli@<targetMajor> --allow-dirty --force`, and enforces the build/test verification gate.
- `src/agent.ts` — Headless bounded fallback agent runner invoked strictly when `ng update`, `buildCommand`, or `testCommand` fails, enforcing timeouts, git `HEAD` immutability, and AI-modified file tracking.
- `src/exec.ts` — Subprocess spawning, process-group timeout escalation, and bounded log tail utilities.
- `prompts/remediation.md` — Strict Angular migration remediation prompt forbidding downgrades, `@ts-ignore`/`@ts-nocheck`, ESLint disables, test deletion/skipping, and git mutations.

## Prerequisites

- Node.js & `pnpm`
- `git`
- `gh` (GitHub CLI, authenticated for PR creation)
- `fnm` (required only for repositories defining `.nvmrc` or `.node-version`)
- A local headless coding agent CLI (`agy`, `claude`, `gemini`, `codex`) or a custom `AGENT_CMD` / `--agent-cmd` (only required when deterministic upgrades fail and trigger fallback remediation)

## Setup & Usage

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Create or update `fleet.json` with an array of repository entries:
   ```json
   [
     {
       "name": "my-app",
       "localPath": "/abs/path/to/my-app",
       "buildCommand": "pnpm run build",
       "testCommand": "pnpm test -- --watch=false"
     }
   ]
   ```

3. Run a read-only dry run across your fleet:
   ```bash
   pnpm run dry-run
   ```

4. Execute fleet upgrades:
   ```bash
   pnpm start
   ```

5. Optional flags:
   ```bash
   pnpm start -- --config ./fleet.json --timeout 300 --agent-cmd "claude -p --permission-mode acceptEdits"
   ```

## Verification

```bash
pnpm run typecheck
pnpm test
```
