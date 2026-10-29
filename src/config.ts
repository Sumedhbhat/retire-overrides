import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EcosystemId, OverrideEntry } from "./types.ts";

/** Matches overrides by package, and optionally ecosystem, file and selector. */
export interface EntryMatcher {
  package: string;
  ecosystem?: EcosystemId;
  file?: string;
  selector?: string;
  reason?: string;
}

export interface Config {
  /** Ordinary upgrades (including incidental ones during removal) wait this long after release. */
  minimumReleaseAgeDays: number;
  /** A still-needed override older than this gets one tracking issue. */
  staleAfterDays: number;
  /** Intentional overrides: never proposed for removal. */
  keep: EntryMatcher[];
  /** Explicit opt-in: existing overrides this tool did not create, which it may remove automatically. */
  manage: EntryMatcher[];
  /** Advisory sources, merged. When unset: the npm registry for JavaScript ecosystems, OSV for the rest. */
  advisoryProviders?: Array<"npm" | "github" | "osv">;
  ecosystems?: EcosystemId[];
  autoMerge: boolean;
  mergeMethod: "squash" | "merge" | "rebase";
  labels: string[];
  /** Above this many distinct parents, an added override is global (version-selected) instead of parent-scoped. */
  maxScopedParents: number;
}

export const DEFAULT_CONFIG: Config = {
  minimumReleaseAgeDays: 14,
  staleAfterDays: 90,
  keep: [],
  manage: [],
  autoMerge: true,
  mergeMethod: "squash",
  labels: ["dependencies", "security"],
  maxScopedParents: 5,
};

export const CONFIG_PATHS = [".github/retire-overrides.yml", ".github/retire-overrides.yaml", "retire-overrides.yml"];

export class ConfigError extends Error {}

export async function loadConfig(repo: string, explicit?: string): Promise<{ config: Config; path?: string }> {
  const candidates = explicit ? [explicit] : CONFIG_PATHS;
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFile(join(repo, candidate), "utf8");
    } catch {
      if (explicit) throw new ConfigError(`config file ${explicit} not found`);
      continue;
    }
    return { config: parseConfig(parseYaml(text), candidate), path: candidate };
  }
  return { config: { ...DEFAULT_CONFIG } };
}

const KNOWN_KEYS = new Set([
  "version",
  "minimumReleaseAgeDays",
  "staleAfterDays",
  "keep",
  "manage",
  "advisoryProviders",
  "ecosystems",
  "autoMerge",
  "mergeMethod",
  "labels",
  "maxScopedParents",
]);

export function parseConfig(raw: unknown, source = "config"): Config {
  if (raw === null || raw === undefined) return { ...DEFAULT_CONFIG };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${source}: expected a mapping`);
  const data = raw as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) throw new ConfigError(`${source}: unknown key "${key}"`);
  }
  if (data.version !== undefined && data.version !== 1) throw new ConfigError(`${source}: version must be 1`);
  const config: Config = { ...DEFAULT_CONFIG };
  if (data.minimumReleaseAgeDays !== undefined) config.minimumReleaseAgeDays = nonNegative(data.minimumReleaseAgeDays, "minimumReleaseAgeDays", source);
  if (data.staleAfterDays !== undefined) config.staleAfterDays = nonNegative(data.staleAfterDays, "staleAfterDays", source);
  if (data.maxScopedParents !== undefined) config.maxScopedParents = nonNegative(data.maxScopedParents, "maxScopedParents", source);
  if (data.keep !== undefined) config.keep = matchers(data.keep, "keep", source);
  if (data.manage !== undefined) config.manage = matchers(data.manage, "manage", source);
  if (data.advisoryProviders !== undefined) {
    const list = stringList(data.advisoryProviders, "advisoryProviders", source);
    for (const p of list) if (p !== "npm" && p !== "github" && p !== "osv") throw new ConfigError(`${source}: unknown advisory provider "${p}"`);
    if (list.length === 0) throw new ConfigError(`${source}: advisoryProviders must not be empty`);
    config.advisoryProviders = list as Config["advisoryProviders"];
  }
  if (data.ecosystems !== undefined) config.ecosystems = stringList(data.ecosystems, "ecosystems", source) as EcosystemId[];
  if (data.autoMerge !== undefined) {
    if (typeof data.autoMerge !== "boolean") throw new ConfigError(`${source}: autoMerge must be true or false`);
    config.autoMerge = data.autoMerge;
  }
  if (data.mergeMethod !== undefined) {
    if (data.mergeMethod !== "squash" && data.mergeMethod !== "merge" && data.mergeMethod !== "rebase") {
      throw new ConfigError(`${source}: mergeMethod must be squash, merge or rebase`);
    }
    config.mergeMethod = data.mergeMethod;
  }
  if (data.labels !== undefined) config.labels = stringList(data.labels, "labels", source);
  return config;
}

function nonNegative(value: unknown, key: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${source}: ${key} must be a non-negative number`);
  }
  return value;
}

function stringList(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${source}: ${key} must be a list of strings`);
  }
  return value as string[];
}

function matchers(value: unknown, key: string, source: string): EntryMatcher[] {
  if (!Array.isArray(value)) throw new ConfigError(`${source}: ${key} must be a list`);
  return value.map((item, i) => {
    if (typeof item === "string") return { package: item };
    if (item === null || typeof item !== "object" || typeof (item as { package?: unknown }).package !== "string") {
      throw new ConfigError(`${source}: ${key}[${i}] needs a package`);
    }
    const m = item as Record<string, unknown>;
    for (const k of Object.keys(m)) {
      if (!["package", "ecosystem", "file", "selector", "reason"].includes(k)) {
        throw new ConfigError(`${source}: ${key}[${i}] has unknown key "${k}"`);
      }
    }
    return m as unknown as EntryMatcher;
  });
}

export function findMatch(list: EntryMatcher[], entry: OverrideEntry): EntryMatcher | undefined {
  return list.find(
    (m) =>
      m.package === entry.target.name &&
      (m.ecosystem === undefined || m.ecosystem === entry.ecosystem) &&
      (m.file === undefined || m.file === entry.file) &&
      (m.selector === undefined || m.selector === entry.selector),
  );
}
