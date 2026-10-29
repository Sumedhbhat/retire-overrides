import { gzipSync } from "node:zlib";
import type { Advisory, EcosystemId } from "../types.ts";
import type { FetchLike } from "../registry/registry.ts";
import type { Recorder } from "../metadata/snapshot.ts";

export class AdvisoryDataUnavailableError extends Error {
  constructor(provider: string, detail: string) {
    super(`advisory data unavailable from ${provider}: ${detail}`);
  }
}

/**
 * Supplies advisories for packages. Callers pass every version they care about; providers return
 * every advisory affecting any of them. A provider must throw instead of returning a partial answer.
 */
export interface AdvisoryProvider {
  readonly id: string;
  supports(ecosystem: EcosystemId): boolean;
  advisoriesFor(ecosystem: EcosystemId, versions: Map<string, string[]>, options?: AdvisoryQueryOptions): Promise<Map<string, Advisory[]>>;
}

export interface AdvisoryQueryOptions {
  /** The versions are every published version: return every advisory for the package. */
  allVersions?: boolean;
}

const GHSA = /GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}/i;

/** Splits `a || b` into separate affected branches so reports show each one. */
export function splitBranches(range: string): string[] {
  return range
    .split("||")
    .map((r) => r.trim())
    .filter((r) => r !== "");
}

/** The npm registry's bulk advisory endpoint, which is what `npm audit` uses. Needs no credentials. */
export class NpmBulkAdvisoryProvider implements AdvisoryProvider {
  readonly id: string = "npm";
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly recorder: Recorder | undefined;

  /** Extra query string, used by the snapshot provider to name the ecosystem. */
  private readonly query: string;

  constructor(registryUrl: string, options: { fetch?: FetchLike; recorder?: Recorder; query?: string } = {}) {
    this.baseUrl = registryUrl.replace(/\/+$/, "");
    this.query = options.query ?? "";
    this.fetchImpl = options.fetch ?? fetch;
    this.recorder = options.recorder;
  }

  supports(ecosystem: EcosystemId): boolean {
    return ecosystem === "npm" || ecosystem === "pnpm" || ecosystem === "bun" || ecosystem === "yarn";
  }

  async advisoriesFor(_ecosystem: EcosystemId, versions: Map<string, string[]>): Promise<Map<string, Advisory[]>> {
    const result = new Map<string, Advisory[]>();
    const names = [...versions.keys()].sort();
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100);
      const body: Record<string, string[]> = {};
      for (const name of chunk) body[name] = versions.get(name) ?? [];
      const raw = await this.post(body);
      for (const name of chunk) {
        const list = mergeById((raw[name] ?? []).map((entry) => toAdvisory(name, entry)));
        result.set(name, list);
        this.recorder?.recordAdvisories(name, list);
      }
    }
    return result;
  }

  private async post(body: Record<string, string[]>): Promise<Record<string, RawBulkEntry[]>> {
    const url = `${this.baseUrl}/-/npm/v1/security/advisories/bulk${this.query}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipSync(JSON.stringify(body)),
      });
    } catch (error) {
      throw new AdvisoryDataUnavailableError(this.id, `request to ${url} failed: ${String(error)}`);
    }
    if (!response.ok) throw new AdvisoryDataUnavailableError(this.id, `${url} returned HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AdvisoryDataUnavailableError(this.id, `${url} returned an unexpected payload`);
    }
    return parsed as Record<string, RawBulkEntry[]>;
  }
}

/** The bulk endpoint returns one entry per affected branch; one advisory ID becomes one advisory. */
export function mergeById(list: Advisory[]): Advisory[] {
  const byId = new Map<string, Advisory>();
  for (const a of list) {
    const existing = byId.get(a.id);
    if (!existing) {
      byId.set(a.id, { ...a, ranges: [...a.ranges], aliases: [...a.aliases] });
      continue;
    }
    for (const r of a.ranges) if (!existing.ranges.includes(r)) existing.ranges.push(r);
    for (const x of a.aliases) if (!existing.aliases.includes(x)) existing.aliases.push(x);
  }
  return [...byId.values()];
}

interface RawBulkEntry {
  id: number | string;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions: string;
}

function toAdvisory(name: string, entry: RawBulkEntry): Advisory {
  const match = entry.url ? GHSA.exec(entry.url)?.[0] : undefined;
  // GitHub writes GHSA IDs as `GHSA-` followed by lowercase groups.
  const ghsa = match ? `GHSA-${match.slice(5).toLowerCase()}` : undefined;
  const advisory: Advisory = {
    id: ghsa ?? `npm-${entry.id}`,
    aliases: ghsa ? [`npm-${entry.id}`] : [],
    package: name,
    ranges: splitBranches(entry.vulnerable_versions),
  };
  if (entry.severity) advisory.severity = entry.severity;
  if (entry.title) advisory.title = entry.title;
  if (entry.url) advisory.url = entry.url;
  return advisory;
}

/**
 * Advisories replayed from a metadata snapshot through the snapshot registry. Covers every ecosystem
 * in the snapshot, so replays and tests use one provider for npm and PyPI alike.
 */
export class SnapshotAdvisoryProvider implements AdvisoryProvider {
  readonly id = "snapshot";
  private readonly url: string;
  private readonly options: { fetch?: FetchLike; recorder?: Recorder };

  constructor(registryUrl: string, options: { fetch?: FetchLike; recorder?: Recorder } = {}) {
    this.url = registryUrl;
    this.options = options;
  }

  supports(ecosystem: EcosystemId): boolean {
    return ecosystem !== "go" && ecosystem !== "cargo" && ecosystem !== "gradle" && ecosystem !== "maven" && ecosystem !== "nuget";
  }

  advisoriesFor(ecosystem: EcosystemId, versions: Map<string, string[]>): Promise<Map<string, Advisory[]>> {
    const query = ecosystem === "uv" ? "?ecosystem=PyPI" : "";
    return new NpmBulkAdvisoryProvider(this.url, { ...this.options, query }).advisoriesFor(ecosystem, versions);
  }
}

/** GitHub's global advisory database. Needs a token for reasonable rate limits. */
export class GitHubAdvisoryProvider implements AdvisoryProvider {
  readonly id = "github";
  private readonly apiUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly recorder: Recorder | undefined;

  constructor(options: { apiUrl?: string; token?: string; fetch?: FetchLike; recorder?: Recorder } = {}) {
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.recorder = options.recorder;
  }

  supports(ecosystem: EcosystemId): boolean {
    return ecosystem === "npm" || ecosystem === "pnpm" || ecosystem === "bun" || ecosystem === "yarn";
  }

  async advisoriesFor(_ecosystem: EcosystemId, versions: Map<string, string[]>): Promise<Map<string, Advisory[]>> {
    const result = new Map<string, Advisory[]>();
    for (const name of [...versions.keys()].sort()) {
      const list = await this.forPackage(name);
      result.set(name, list);
      this.recorder?.recordAdvisories(name, list);
    }
    return result;
  }

  private async forPackage(name: string): Promise<Advisory[]> {
    const advisories: Advisory[] = [];
    let url: string | null =
      `${this.apiUrl}/advisories?ecosystem=npm&affects=${encodeURIComponent(name)}&per_page=100`;
    while (url !== null) {
      const headers: Record<string, string> = { accept: "application/vnd.github+json" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { headers });
      } catch (error) {
        throw new AdvisoryDataUnavailableError(this.id, `request for ${name} failed: ${String(error)}`);
      }
      if (!response.ok) throw new AdvisoryDataUnavailableError(this.id, `${url} returned HTTP ${response.status}`);
      const page = (await response.json()) as RawGitHubAdvisory[];
      for (const raw of page) {
        if (raw.withdrawn_at) continue;
        const ranges = raw.vulnerabilities
          .filter((v) => v.package?.ecosystem === "npm" && v.package.name === name && v.vulnerable_version_range)
          .flatMap((v) => splitBranches(v.vulnerable_version_range!.replace(/,\s*/g, " ")));
        if (ranges.length === 0) continue;
        const advisory: Advisory = {
          id: raw.ghsa_id,
          aliases: raw.cve_id ? [raw.cve_id] : [],
          package: name,
          ranges,
        };
        if (raw.severity) advisory.severity = raw.severity;
        if (raw.summary) advisory.title = raw.summary;
        if (raw.html_url) advisory.url = raw.html_url;
        advisories.push(advisory);
      }
      url = nextLink(response.headers.get("link"));
    }
    return advisories;
  }
}

interface RawGitHubAdvisory {
  ghsa_id: string;
  cve_id?: string | null;
  html_url?: string;
  summary?: string;
  severity?: string;
  withdrawn_at?: string | null;
  vulnerabilities: Array<{
    package?: { ecosystem: string; name: string };
    vulnerable_version_range?: string | null;
  }>;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Queries several providers and merges their answers by advisory ID, taking the union of affected
 * ranges. Disagreement therefore errs towards "vulnerable". Any provider failure fails the query.
 */
export class CombinedAdvisoryProvider implements AdvisoryProvider {
  readonly id: string;
  private readonly providers: AdvisoryProvider[];

  constructor(providers: AdvisoryProvider[]) {
    this.providers = providers;
    this.id = providers.map((p) => p.id).join("+");
  }

  supports(ecosystem: EcosystemId): boolean {
    return this.providers.some((p) => p.supports(ecosystem));
  }

  async advisoriesFor(
    ecosystem: EcosystemId,
    versions: Map<string, string[]>,
    options?: AdvisoryQueryOptions,
  ): Promise<Map<string, Advisory[]>> {
    const applicable = this.providers.filter((p) => p.supports(ecosystem));
    if (applicable.length === 0) {
      throw new AdvisoryDataUnavailableError(this.id, `no configured provider covers ${ecosystem}`);
    }
    const answers = await Promise.all(applicable.map((p) => p.advisoriesFor(ecosystem, versions, options)));
    const merged = new Map<string, Advisory[]>();
    for (const name of versions.keys()) {
      const byId = new Map<string, Advisory>();
      for (const answer of answers) {
        for (const advisory of answer.get(name) ?? []) {
          const key = canonicalId(advisory);
          const existing = byId.get(key);
          if (existing === undefined) {
            byId.set(key, { ...advisory, ranges: [...advisory.ranges] });
          } else {
            for (const r of advisory.ranges) if (!existing.ranges.includes(r)) existing.ranges.push(r);
            for (const a of advisory.aliases) if (!existing.aliases.includes(a)) existing.aliases.push(a);
          }
        }
      }
      merged.set(name, [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));
    }
    return merged;
  }
}

function canonicalId(advisory: Advisory): string {
  return advisory.id.toLowerCase();
}

/**
 * For each ecosystem, uses the first provider that covers it. This is the default when the
 * configuration names no providers: the npm registry for JavaScript, OSV for everything else.
 */
export class FirstSupportingProvider implements AdvisoryProvider {
  readonly id: string;
  private readonly providers: AdvisoryProvider[];

  constructor(providers: AdvisoryProvider[]) {
    this.providers = providers;
    this.id = providers.map((p) => p.id).join("|");
  }

  supports(ecosystem: EcosystemId): boolean {
    return this.providers.some((p) => p.supports(ecosystem));
  }

  advisoriesFor(ecosystem: EcosystemId, versions: Map<string, string[]>): Promise<Map<string, Advisory[]>> {
    const provider = this.providers.find((p) => p.supports(ecosystem));
    if (!provider) throw new AdvisoryDataUnavailableError(this.id, `no configured provider covers ${ecosystem}`);
    return provider.advisoriesFor(ecosystem, versions);
  }
}
