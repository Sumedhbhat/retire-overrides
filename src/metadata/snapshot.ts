import { readFile, writeFile } from "node:fs/promises";
import type { Advisory, PackageMetadata } from "../types.ts";
import type { RawVersion } from "../registry/registry.ts";

/**
 * Saved registry and advisory metadata. Replaying a snapshot through the snapshot registry server,
 * with the same repository snapshot, package-manager versions, configuration and `--now`, reproduces
 * a decision exactly.
 */
export interface MetadataSnapshot {
  schemaVersion: 1;
  capturedAt?: string;
  packages: Record<string, SnapshotPackage>;
  advisories: SnapshotAdvisory[];
  /** Simulated outages, used by tests to prove failures never read as clean results. */
  failures?: {
    advisories?: boolean;
    packages?: string[];
  };
}

export interface SnapshotPackage {
  versions: Record<string, SnapshotVersion>;
  time: Record<string, string>;
  repository?: string;
}

export interface SnapshotVersion {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  deprecated?: string;
  dist?: { integrity?: string; shasum?: string };
}

export interface SnapshotAdvisory {
  id: string;
  package: string;
  /** Affected branches as node-semver ranges. */
  ranges: string[];
  severity?: string;
  title?: string;
  url?: string;
  aliases?: string[];
  /** When the advisory became public. Advisories published after `--now` are hidden. */
  published?: string;
}

export async function readSnapshot(path: string): Promise<MetadataSnapshot> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as MetadataSnapshot;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`${path}: unsupported metadata snapshot schemaVersion ${String(parsed.schemaVersion)}`);
  }
  parsed.packages ??= {};
  parsed.advisories ??= [];
  return parsed;
}

/** Collects every piece of metadata a run reads so it can be saved as a snapshot. */
export class Recorder {
  private readonly packages = new Map<string, SnapshotPackage>();
  private readonly advisories = new Map<string, SnapshotAdvisory>();

  recordPackage(metadata: PackageMetadata, raw: { versions?: Record<string, RawVersion> }): void {
    const versions: Record<string, SnapshotVersion> = {};
    for (const [v, meta] of Object.entries(metadata.versions)) {
      const entry: SnapshotVersion = {};
      if (Object.keys(meta.dependencies).length > 0) entry.dependencies = meta.dependencies;
      if (Object.keys(meta.optionalDependencies).length > 0) entry.optionalDependencies = meta.optionalDependencies;
      if (Object.keys(meta.peerDependencies).length > 0) entry.peerDependencies = meta.peerDependencies;
      if (meta.deprecated) entry.deprecated = meta.deprecated;
      const dist = raw.versions?.[v]?.dist;
      if (dist?.integrity || dist?.shasum) {
        entry.dist = {};
        if (dist.integrity) entry.dist.integrity = dist.integrity;
        if (dist.shasum) entry.dist.shasum = dist.shasum;
      }
      versions[v] = entry;
    }
    const pkg: SnapshotPackage = { versions, time: metadata.time };
    if (metadata.repository) pkg.repository = metadata.repository;
    this.packages.set(metadata.name, pkg);
  }

  recordAdvisories(name: string, advisories: Advisory[]): void {
    for (const a of advisories) {
      const entry: SnapshotAdvisory = { id: a.id, package: name, ranges: a.ranges };
      if (a.severity) entry.severity = a.severity;
      if (a.title) entry.title = a.title;
      if (a.url) entry.url = a.url;
      if (a.aliases.length > 0) entry.aliases = a.aliases;
      this.advisories.set(`${name}\0${a.id}`, entry);
    }
  }

  toSnapshot(capturedAt: Date): MetadataSnapshot {
    const packages: Record<string, SnapshotPackage> = {};
    for (const name of [...this.packages.keys()].sort()) packages[name] = this.packages.get(name)!;
    const advisories = [...this.advisories.values()].sort(
      (a, b) => a.package.localeCompare(b.package) || a.id.localeCompare(b.id),
    );
    return { schemaVersion: 1, capturedAt: capturedAt.toISOString(), packages, advisories };
  }

  async save(path: string, capturedAt: Date): Promise<void> {
    await writeFile(path, `${JSON.stringify(this.toSnapshot(capturedAt), null, 2)}\n`);
  }
}
