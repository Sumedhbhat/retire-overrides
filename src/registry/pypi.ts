import type { Recorder } from "../metadata/snapshot.ts";
import { normalizeName, parseRequirement } from "../pep440.ts";
import type { PackageMetadata, PackageVersionMetadata } from "../types.ts";
import { type FetchLike, MetadataUnavailableError, type RegistryClient } from "./registry.ts";

interface PypiFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
  yanked_reason?: string | null;
}

interface PypiDocument {
  info?: { name?: string; requires_dist?: string[] | null; project_urls?: Record<string, string> | null };
  releases?: Record<string, PypiFile[]>;
  urls?: PypiFile[];
}

/**
 * Reads PyPI's JSON API (or any server speaking it, such as the snapshot registry). Release times are
 * the earliest upload of each version's files; dependencies come from each version's `requires_dist`.
 */
export class PypiClient implements RegistryClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly recorder: Recorder | undefined;
  private readonly packages = new Map<string, Promise<PackageMetadata>>();
  private readonly versions = new Map<string, Promise<PackageVersionMetadata | undefined>>();

  constructor(baseUrl = "https://pypi.org", options: { fetch?: FetchLike; recorder?: Recorder } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.recorder = options.recorder;
  }

  getPackage(name: string): Promise<PackageMetadata> {
    const key = normalizeName(name);
    let cached = this.packages.get(key);
    if (!cached) {
      cached = this.loadPackage(key);
      this.packages.set(key, cached);
    }
    return cached;
  }

  getVersion(name: string, version: string): Promise<PackageVersionMetadata | undefined> {
    const key = `${normalizeName(name)}@${version}`;
    let cached = this.versions.get(key);
    if (!cached) {
      cached = this.loadVersion(normalizeName(name), version);
      this.versions.set(key, cached);
    }
    return cached;
  }

  private async loadPackage(name: string): Promise<PackageMetadata> {
    const doc = await this.fetchJson(`/pypi/${name}/json`, name);
    const versions: Record<string, PackageVersionMetadata> = {};
    const time: Record<string, string> = {};
    for (const [version, files] of Object.entries(doc.releases ?? {})) {
      // A version with no files can't be installed; skip it like resolvers do.
      if (files.length === 0) continue;
      const entry: PackageVersionMetadata = { version, dependencies: {}, optionalDependencies: {}, peerDependencies: {} };
      if (files.every((f) => f.yanked)) entry.deprecated = `yanked${files[0]?.yanked_reason ? `: ${files[0].yanked_reason}` : ""}`;
      versions[version] = entry;
      const uploads = files.map((f) => f.upload_time_iso_8601).filter((t): t is string => typeof t === "string").sort();
      if (uploads[0]) time[version] = uploads[0];
    }
    const metadata: PackageMetadata = { name, versions, time };
    const repo = Object.entries(doc.info?.project_urls ?? {}).find(([k]) => /source|repository|code/i.test(k))?.[1];
    if (repo) metadata.repository = repo;
    this.recorder?.recordPackage(metadata, {}, "pypi");
    return metadata;
  }

  private async loadVersion(name: string, version: string): Promise<PackageVersionMetadata | undefined> {
    const meta = await this.getPackage(name);
    const base = meta.versions[version];
    if (!base) return undefined;
    const doc = await this.fetchJson(`/pypi/${name}/${encodeURIComponent(version)}/json`, `${name}==${version}`);
    // Several requirements on one package (different markers or extras) are alternatives: whichever
    // applies may be in effect, so the declared range is their union. That errs towards "permits".
    const alternatives = new Map<string, string[]>();
    for (const line of doc.info?.requires_dist ?? []) {
      const req = parseRequirement(line);
      if (req === null) continue;
      const list = alternatives.get(req.name) ?? [];
      list.push(req.specifier === "" ? ">=0" : req.specifier);
      alternatives.set(req.name, list);
    }
    const dependencies: Record<string, string> = {};
    for (const [dep, list] of alternatives) dependencies[dep] = [...new Set(list)].join(" || ");
    const entry: PackageVersionMetadata = { ...base, dependencies };
    meta.versions[version] = entry;
    this.recorder?.recordPackage(meta, {}, "pypi");
    return entry;
  }

  private async fetchJson(path: string, subject: string): Promise<PypiDocument> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new MetadataUnavailableError(subject, `request to ${url} failed: ${String(error)}`);
    }
    if (!response.ok) throw new MetadataUnavailableError(subject, `${url} returned HTTP ${response.status}`);
    return (await response.json()) as PypiDocument;
  }
}
