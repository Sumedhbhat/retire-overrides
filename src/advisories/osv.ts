import type { Recorder } from "../metadata/snapshot.ts";
import type { FetchLike } from "../registry/registry.ts";
import { schemeFor, type VersionScheme } from "../schemes.ts";
import type { Advisory, EcosystemId } from "../types.ts";
import { isAffectedBy } from "../versions.ts";
import { AdvisoryDataUnavailableError, type AdvisoryProvider, type AdvisoryQueryOptions, mergeById } from "./providers.ts";

/** OSV's name for each ecosystem's package registry. */
const OSV_ECOSYSTEM: Partial<Record<EcosystemId, string>> = {
  npm: "npm",
  pnpm: "npm",
  bun: "npm",
  yarn: "npm",
  uv: "PyPI",
  cargo: "crates.io",
  go: "Go",
  maven: "Maven",
  gradle: "Maven",
  nuget: "NuGet",
};

/** Above this many versions per package, one package-wide query beats per-version batch queries. */
const BATCH_VERSION_LIMIT = 50;

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  withdrawn?: string;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { ecosystem: string; name: string };
    ranges?: Array<{ type: string; events: OsvEvent[] }>;
    versions?: string[];
  }>;
}

/** The OSV database (osv.dev), which covers every ecosystem the adapters target. No credentials needed. */
export class OsvAdvisoryProvider implements AdvisoryProvider {
  readonly id = "osv";
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly recorder: Recorder | undefined;
  private readonly details = new Map<string, Promise<OsvVuln>>();

  constructor(options: { apiUrl?: string; fetch?: FetchLike; recorder?: Recorder } = {}) {
    this.apiUrl = (options.apiUrl ?? "https://api.osv.dev").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.recorder = options.recorder;
  }

  supports(ecosystem: EcosystemId): boolean {
    return OSV_ECOSYSTEM[ecosystem] !== undefined;
  }

  async advisoriesFor(
    ecosystem: EcosystemId,
    versions: Map<string, string[]>,
    options: AdvisoryQueryOptions = {},
  ): Promise<Map<string, Advisory[]>> {
    const osvEcosystem = OSV_ECOSYSTEM[ecosystem];
    if (!osvEcosystem) throw new AdvisoryDataUnavailableError(this.id, `OSV does not cover ${ecosystem}`);
    const scheme = schemeFor(ecosystem);
    const result = new Map<string, Advisory[]>();

    // Package-wide when the caller needs every version, or when per-version queries would be many.
    const wide = (v: string[]) => options.allVersions === true || v.length > BATCH_VERSION_LIMIT;
    const small = [...versions].filter(([, v]) => !wide(v));
    const large = [...versions].filter(([, v]) => wide(v));

    // Batch path: which vulnerabilities affect these exact versions, then fetch each record once.
    const ids = new Map<string, Set<string>>();
    const queries = small.flatMap(([name, list]) => list.map((version) => ({ name, version })));
    for (let i = 0; i < queries.length; i += 1000) {
      const chunk = queries.slice(i, i + 1000);
      const answer = await this.post<{ results: Array<{ vulns?: Array<{ id: string }>; next_page_token?: string }> }>(
        "/v1/querybatch",
        { queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: osvEcosystem }, version: q.version })) },
      );
      if (!Array.isArray(answer.results) || answer.results.length !== chunk.length) {
        throw new AdvisoryDataUnavailableError(this.id, "querybatch returned a different number of results than queries");
      }
      for (const [j, r] of answer.results.entries()) {
        const q = chunk[j]!;
        const set = ids.get(q.name) ?? new Set<string>();
        for (const v of r.vulns ?? []) set.add(v.id);
        // A truncated answer means more vulnerabilities than one page; ask for the whole package instead.
        if (r.next_page_token) large.push([q.name, versions.get(q.name) ?? []]);
        ids.set(q.name, set);
      }
    }
    for (const [name] of small) {
      if (large.some(([n]) => n === name)) continue;
      const vulns = await Promise.all([...(ids.get(name) ?? [])].map((id) => this.detail(id)));
      result.set(name, this.toAdvisories(name, osvEcosystem, vulns, scheme, versions.get(name) ?? []));
    }

    // Package-wide path: every vulnerability record for the package, paginated.
    for (const [name] of new Map(large)) {
      const vulns: OsvVuln[] = [];
      let pageToken: string | undefined;
      do {
        const page = await this.post<{ vulns?: OsvVuln[]; next_page_token?: string }>("/v1/query", {
          package: { name, ecosystem: osvEcosystem },
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        vulns.push(...(page.vulns ?? []));
        pageToken = page.next_page_token;
      } while (pageToken);
      result.set(name, this.toAdvisories(name, osvEcosystem, vulns, scheme, versions.get(name) ?? []));
    }

    for (const [name, list] of result) this.recorder?.recordAdvisories(name, list);
    return result;
  }

  private toAdvisories(name: string, ecosystem: string, vulns: OsvVuln[], scheme: VersionScheme, versions: string[]): Advisory[] {
    const out: Advisory[] = [];
    for (const vuln of vulns) {
      if (vuln.withdrawn) continue;
      const ranges: string[] = [];
      let unusable = false;
      for (const affected of vuln.affected ?? []) {
        if (affected.package?.ecosystem !== ecosystem || !sameName(affected.package.name, name, ecosystem)) continue;
        const usable = (affected.ranges ?? []).filter((r) => r.type === "SEMVER" || r.type === "ECOSYSTEM");
        for (const r of usable) ranges.push(...eventsToRanges(r.events, scheme));
        // OSV defines the affected set as the union of the ranges and the listed versions.
        const listed = affected.versions ?? [];
        ranges.push(...listed.map((v) => scheme.exact(v)));
        if (usable.length === 0 && listed.length === 0) unusable = true;
      }
      if (unusable && ranges.length === 0) {
        // Only git ranges: the affected registry versions are unknown. Refuse to guess "not affected".
        throw new AdvisoryDataUnavailableError(this.id, `${vuln.id} gives no registry version ranges for ${name}`);
      }
      if (ranges.length === 0) continue;
      const ghsa = [vuln.id, ...(vuln.aliases ?? [])].find((a) => a.startsWith("GHSA-"));
      const id = ghsa ?? vuln.id;
      const advisory: Advisory = {
        id,
        aliases: [vuln.id, ...(vuln.aliases ?? [])].filter((a) => a !== id),
        package: name,
        ranges: [...new Set(ranges)],
      };
      if (vuln.summary) advisory.title = vuln.summary;
      if (vuln.database_specific?.severity) advisory.severity = vuln.database_specific.severity.toLowerCase();
      advisory.url = `https://osv.dev/vulnerability/${vuln.id}`;
      // Callers asked about specific versions; return what affects at least one of them.
      if (versions.length === 0 || versions.some((v) => isAffectedBy(v, advisory, scheme))) out.push(advisory);
    }
    // OSV often publishes one issue twice (a PYSEC or GO record and its GHSA alias); merge by ID.
    return mergeById(out).sort((a, b) => a.id.localeCompare(b.id));
  }

  private detail(id: string): Promise<OsvVuln> {
    let cached = this.details.get(id);
    if (!cached) {
      cached = this.get<OsvVuln>(`/v1/vulns/${encodeURIComponent(id)}`);
      this.details.set(id, cached);
    }
    return cached;
  }

  private async get<T>(path: string): Promise<T> {
    return this.call<T>(path, { headers: { accept: "application/json" } });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, init);
    } catch (error) {
      throw new AdvisoryDataUnavailableError(this.id, `request to ${path} failed: ${String(error)}`);
    }
    if (!response.ok) throw new AdvisoryDataUnavailableError(this.id, `${path} returned HTTP ${response.status}`);
    return (await response.json()) as T;
  }
}

/** Turns OSV introduced/fixed/last_affected events into ranges, one per affected branch. */
export function eventsToRanges(events: OsvEvent[], scheme: VersionScheme): string[] {
  const ranges: string[] = [];
  let start: string | undefined;
  let open = false;
  for (const event of events) {
    if (event.introduced !== undefined) {
      start = event.introduced === "0" ? undefined : event.introduced;
      open = true;
    } else if (open && event.fixed !== undefined) {
      ranges.push(scheme.interval({ ...(start ? { gte: start } : {}), lt: event.fixed }));
      open = false;
    } else if (open && event.last_affected !== undefined) {
      ranges.push(scheme.interval({ ...(start ? { gte: start } : {}), lte: event.last_affected }));
      open = false;
    } else if (open && event.limit !== undefined) {
      ranges.push(scheme.interval({ ...(start ? { gte: start } : {}), lt: event.limit }));
      open = false;
    }
  }
  if (open) ranges.push(scheme.interval(start ? { gte: start } : {}));
  return ranges;
}

function sameName(a: string, b: string, ecosystem: string): boolean {
  if (ecosystem !== "PyPI") return a === b;
  const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");
  return norm(a) === norm(b);
}
