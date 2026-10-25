import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import semver from "semver";
import { run } from "../exec.ts";
import type { DependencyPath, PackageSelector } from "../types.ts";

export interface JsonDocument {
  data: Record<string, unknown>;
  indent: string;
  newline: boolean;
}

export async function readJsonDocument(path: string): Promise<JsonDocument> {
  const text = await readFile(path, "utf8");
  // Single-line files stay single-line; otherwise reuse the file's own indentation.
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? (text.trim().includes("\n") ? "  " : "");
  return { data: JSON.parse(text) as Record<string, unknown>, indent, newline: text.endsWith("\n") };
}

/** Writes JSON back with the file's own indentation. Key order is preserved. */
export async function writeJsonDocument(path: string, doc: JsonDocument): Promise<void> {
  await writeFile(path, JSON.stringify(doc.data, null, doc.indent) + (doc.newline ? "\n" : ""));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Splits `@scope/name@range` / `name@range` / `name`. */
export function parseSelector(text: string): PackageSelector {
  const at = text.indexOf("@", text.startsWith("@") ? 1 : 0);
  if (at === -1) return { name: text };
  return { name: text.slice(0, at), range: text.slice(at + 1) };
}

export function formatSelector(selector: PackageSelector): string {
  return selector.range ? `${selector.name}@${selector.range}` : selector.name;
}

export function selectorMatches(selector: PackageSelector, name: string, version: string): boolean {
  if (selector.name !== name) return false;
  if (!selector.range) return true;
  try {
    return semver.satisfies(version, selector.range, { includePrerelease: true });
  } catch {
    return false;
  }
}

/**
 * True when `scope` appears, in order, among the ancestors of the path's last step. Both npm nested
 * overrides and pnpm parent selectors restrict an override to a subtree in this way.
 */
export function scopeMatchesPath(scope: PackageSelector[], path: DependencyPath): boolean {
  const ancestors = path.steps.slice(0, -1);
  let i = 0;
  for (const step of ancestors) {
    const want = scope[i];
    if (want && selectorMatches(want, step.name, step.version)) i++;
    if (i === scope.length) return true;
  }
  return scope.length === 0;
}

/** Version of a package-manager CLI, or undefined when it is not installed. */
export async function cliVersion(command: string, cwd: string): Promise<string | undefined> {
  try {
    const result = await run(command, ["--version"], { cwd, allowFailure: true, env: { npm_config_registry: undefined } });
    const version = result.stdout.trim().split("\n").at(-1)?.trim();
    return result.code === 0 && version && semver.valid(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Version pinned by `packageManager` or `devEngines.packageManager` for the given manager. */
export function pinnedVersion(manifest: Record<string, unknown>, manager: string): string | undefined {
  const field = manifest.packageManager;
  if (typeof field === "string") {
    const m = /^([^@]+)@([^+]+)/.exec(field);
    if (m && m[1] === manager) return m[2];
  }
  const devEngines = manifest.devEngines;
  if (isRecord(devEngines) && isRecord(devEngines.packageManager)) {
    const pm = devEngines.packageManager;
    if (pm.name === manager && typeof pm.version === "string") return pm.version;
  }
  return undefined;
}

/** A pinned major that differs from the installed one changes lockfile semantics; refuse to guess. */
export function packageManagerMismatch(manager: string, installed: string, pinned: string | undefined): string[] {
  if (pinned === undefined) return [];
  const want = semver.coerce(pinned)?.major;
  const have = semver.major(installed);
  if (want !== undefined && want !== have) {
    return [
      `${manager}@${pinned} is pinned but ${manager}@${installed} is installed; enable Corepack or install the pinned version`,
    ];
  }
  return [];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".yarn", "dist", "build", "vendor", "target"]);

/** Repository-relative paths of files with one of the given names, skipping dependency folders. */
export async function findFiles(repo: string, names: Set<string>, rel = ""): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(join(repo, rel), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = rel === "" ? entry.name : posix.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".retire-overrides")) {
        found.push(...(await findFiles(repo, names, path)));
      }
    } else if (names.has(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

export function projectPath(dir: string, file: string): string {
  return dir === "" ? file : posix.join(dir, file);
}

/**
 * 1-based line of a JSON key path such as `["overrides", "bundler-kit", "tar-lite"]`, found by
 * scanning for each key in turn. Good enough for blame; undefined when a key cannot be found.
 */
export function locateKeyPath(text: string, keys: string[]): number | undefined {
  const lines = text.split("\n");
  let from = 0;
  let found: number | undefined;
  for (const key of keys) {
    const needle = `${JSON.stringify(key)}:`;
    const needleYaml = new RegExp(`^\\s*(?:${escapeRegExp(key)}|${escapeRegExp(JSON.stringify(key))}|'${escapeRegExp(key)}')\\s*:`);
    found = undefined;
    for (let i = from; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.includes(needle) || needleYaml.test(line)) {
        found = i;
        break;
      }
    }
    if (found === undefined) return undefined;
    from = found + 1;
  }
  return found === undefined ? undefined : found + 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
