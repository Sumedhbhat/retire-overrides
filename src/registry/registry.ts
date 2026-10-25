import type { PackageMetadata, PackageVersionMetadata } from "../types.ts";
import type { Recorder } from "../metadata/snapshot.ts";

export class MetadataUnavailableError extends Error {
  readonly subject: string;
  constructor(subject: string, detail: string) {
    super(`metadata unavailable for ${subject}: ${detail}`);
    this.subject = subject;
  }
}

export interface RegistryClient {
  /** Full metadata for a package. Throws MetadataUnavailableError when it cannot be fetched. */
  getPackage(name: string): Promise<PackageMetadata>;
}

export type FetchLike = typeof fetch;

/** Reads package metadata from any npm-compatible registry (registry.npmjs.org, a mirror, or a snapshot server). */
export class NpmRegistryClient implements RegistryClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly recorder: Recorder | undefined;
  private readonly cache = new Map<string, Promise<PackageMetadata>>();

  constructor(baseUrl: string, options: { fetch?: FetchLike; recorder?: Recorder } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.recorder = options.recorder;
  }

  getPackage(name: string): Promise<PackageMetadata> {
    let cached = this.cache.get(name);
    if (cached === undefined) {
      cached = this.load(name);
      this.cache.set(name, cached);
    }
    return cached;
  }

  private async load(name: string): Promise<PackageMetadata> {
    const url = `${this.baseUrl}/${name.replace("/", "%2f")}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (error) {
      throw new MetadataUnavailableError(name, `request to ${url} failed: ${String(error)}`);
    }
    if (!response.ok) {
      throw new MetadataUnavailableError(name, `${url} returned HTTP ${response.status}`);
    }
    const doc = (await response.json()) as RawPackument;
    const metadata = normalizePackument(name, doc);
    this.recorder?.recordPackage(metadata, doc);
    return metadata;
  }
}

interface RawPackument {
  name?: string;
  versions?: Record<string, RawVersion>;
  time?: Record<string, string>;
  repository?: string | { url?: string };
}

export interface RawVersion {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  deprecated?: string | boolean;
  dist?: { integrity?: string; shasum?: string; tarball?: string };
}

export function normalizePackument(name: string, doc: RawPackument): PackageMetadata {
  const versions: Record<string, PackageVersionMetadata> = {};
  for (const [version, raw] of Object.entries(doc.versions ?? {})) {
    const entry: PackageVersionMetadata = {
      version,
      dependencies: raw.dependencies ?? {},
      optionalDependencies: raw.optionalDependencies ?? {},
      peerDependencies: raw.peerDependencies ?? {},
    };
    if (raw.deprecated) entry.deprecated = String(raw.deprecated);
    versions[version] = entry;
  }
  const time: Record<string, string> = {};
  for (const [version, iso] of Object.entries(doc.time ?? {})) {
    if (version in versions) time[version] = iso;
  }
  const repo = typeof doc.repository === "string" ? doc.repository : doc.repository?.url;
  const metadata: PackageMetadata = { name, versions, time };
  if (repo) metadata.repository = repo;
  return metadata;
}

/** All declared ranges a published version has for a dependency, in npm's precedence order. */
export function declaredRangeIn(meta: PackageVersionMetadata | undefined, dep: string): string | undefined {
  if (meta === undefined) return undefined;
  return meta.dependencies[dep] ?? meta.optionalDependencies[dep] ?? meta.peerDependencies[dep];
}
