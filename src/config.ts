import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BUILD_COMMAND = 'pnpm run build';

export interface FleetRepoConfig {
  name: string;
  localPath: string;
  buildCommand: string;
  testCommand?: string;
}

export type FleetConfig = FleetRepoConfig[];

export class ConfigValidationError extends Error {
  readonly issues: string[];

  constructor(configPath: string, issues: string[]) {
    super(
      `Invalid fleet configuration at "${configPath}":\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const VALID_REPO_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadFleetConfig(configPath: string): Promise<FleetConfig> {
  const resolvedPath = path.resolve(configPath);
  let rawContent: string;

  try {
    rawContent = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read fleet config at "${resolvedPath}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in fleet config "${resolvedPath}": ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigValidationError(resolvedPath, [
      'Root value must be a JSON array of repository objects.',
    ]);
  }

  if (parsed.length === 0) {
    throw new ConfigValidationError(resolvedPath, [
      'Fleet configuration array must contain at least one repository entry.',
    ]);
  }

  const issues: string[] = [];
  const seenNames = new Set<string>();
  const validated: FleetConfig = [];

  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    const prefix = `entries[${index}]`;

    if (!isPlainObject(entry)) {
      issues.push(`${prefix}: must be a JSON object.`);
      continue;
    }

    let validEntry = true;

    const rawName = entry['name'];
    let name = '';
    if (typeof rawName !== 'string' || rawName.trim().length === 0) {
      issues.push(`${prefix}.name: must be a non-empty string.`);
      validEntry = false;
    } else {
      name = rawName.trim();
      if (name === '.' || name === '..' || !VALID_REPO_NAME_REGEX.test(name)) {
        issues.push(
          `${prefix}.name ("${name}"): may only contain letters, digits, ".", "_", and "-", and must not be "." or "..".`,
        );
        validEntry = false;
      } else if (seenNames.has(name)) {
        issues.push(`${prefix}.name ("${name}"): duplicate repository name.`);
        validEntry = false;
      } else {
        seenNames.add(name);
      }
    }

    const rawLocalPath = entry['localPath'];
    let localPath = '';
    if (typeof rawLocalPath !== 'string' || rawLocalPath.trim().length === 0) {
      issues.push(`${prefix}.localPath: must be a non-empty absolute path string.`);
      validEntry = false;
    } else {
      localPath = rawLocalPath.trim();
      if (!path.isAbsolute(localPath)) {
        issues.push(`${prefix}.localPath ("${localPath}"): must be an absolute path.`);
        validEntry = false;
      } else {
        try {
          const stats = await stat(localPath);
          if (!stats.isDirectory()) {
            issues.push(`${prefix}.localPath ("${localPath}"): path exists but is not a directory.`);
            validEntry = false;
          }
        } catch {
          issues.push(`${prefix}.localPath ("${localPath}"): directory does not exist or is not accessible.`);
          validEntry = false;
        }
      }
    }

    let buildCommand = DEFAULT_BUILD_COMMAND;
    if ('buildCommand' in entry && entry['buildCommand'] !== undefined) {
      const rawBuild = entry['buildCommand'];
      if (typeof rawBuild !== 'string' || rawBuild.trim().length === 0) {
        issues.push(`${prefix}.buildCommand: when provided, must be a non-empty string.`);
        validEntry = false;
      } else {
        buildCommand = rawBuild.trim();
      }
    }

    let testCommand: string | undefined;
    if ('testCommand' in entry && entry['testCommand'] !== undefined) {
      const rawTest = entry['testCommand'];
      if (typeof rawTest !== 'string' || rawTest.trim().length === 0) {
        issues.push(`${prefix}.testCommand: when provided, must be a non-empty string.`);
        validEntry = false;
      } else {
        testCommand = rawTest.trim();
      }
    }

    if (validEntry) {
      validated.push({
        name,
        localPath,
        buildCommand,
        ...(testCommand !== undefined ? { testCommand } : {}),
      });
    }
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(resolvedPath, issues);
  }

  return validated;
}
