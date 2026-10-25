// A small, fictional package universe shared by the scenario tests.
//
//   app ──> bundler-kit ──> tar-lite      (the lifecycle from the policy: parent pins a vulnerable range)
//   app ──> legacy-pack ──> tar-lite@2    (a second resolved copy on another release line)
//
// tar-lite advisory GHSA-2222-3333-4444 affects <3.1.4, published 2026-02-01.
import type { MetadataSnapshot, SnapshotAdvisory, SnapshotPackage } from "../../src/metadata/snapshot.ts";

export const GHSA = "GHSA-2222-3333-4444";
export const GHSA_TWO_BRANCH = "GHSA-5555-6666-7777";
export const GHSA_LATE = "GHSA-8888-9999-cccc";

export interface UniverseOptions {
  /** When bundler-kit 2.5.0 (depends on tar-lite `bundlerNewRange`) is published; omitted = never. */
  bundlerFixedAt?: string;
  bundlerNewRange?: string;
  /** bundler-kit 2.4.0's range for tar-lite. */
  bundlerOldRange?: string;
  /** Extra tar-lite releases: version → publish time. */
  tarExtra?: Record<string, string>;
  advisories?: SnapshotAdvisory[];
  failures?: MetadataSnapshot["failures"];
  /** Drop publish times for these tar-lite versions (missing release dates). */
  tarMissingTime?: string[];
}

export function universe(o: UniverseOptions = {}): MetadataSnapshot {
  const bundler: SnapshotPackage = {
    versions: { "2.4.0": { dependencies: { "tar-lite": o.bundlerOldRange ?? "~3.0.0" } } },
    time: { "2.4.0": "2025-12-01T00:00:00Z" },
    repository: "https://github.com/example/bundler-kit",
  };
  if (o.bundlerFixedAt) {
    bundler.versions["2.5.0"] = { dependencies: { "tar-lite": o.bundlerNewRange ?? "^3.1.4" } };
    bundler.time["2.5.0"] = o.bundlerFixedAt;
  }
  const tarTimes: Record<string, string> = {
    "2.3.0": "2024-06-01T00:00:00Z",
    "2.4.1": "2026-02-01T00:00:00Z",
    "3.0.0": "2025-01-01T00:00:00Z",
    "3.0.5": "2025-06-01T00:00:00Z",
    "3.1.4": "2026-02-01T00:00:00Z",
    "3.2.0": "2026-03-01T00:00:00Z",
    "4.0.0": "2026-04-01T00:00:00Z",
    ...o.tarExtra,
  };
  const tar: SnapshotPackage = { versions: {}, time: {} };
  for (const [v, t] of Object.entries(tarTimes)) {
    tar.versions[v] = {};
    if (!o.tarMissingTime?.includes(v)) tar.time[v] = t;
  }
  const snapshot: MetadataSnapshot = {
    schemaVersion: 1,
    packages: {
      "bundler-kit": bundler,
      "tar-lite": tar,
      "legacy-pack": {
        versions: { "1.0.0": { dependencies: { "tar-lite": "^2.0.0" } } },
        time: { "1.0.0": "2024-07-01T00:00:00Z" },
      },
      "left-pad": { versions: { "1.3.0": {} }, time: { "1.3.0": "2020-01-01T00:00:00Z" } },
      // A plugin that accepts any tar-lite as a peer, like unplugin does for esbuild.
      "peer-plugin": { versions: { "1.0.0": { peerDependencies: { "tar-lite": "*" } } }, time: { "1.0.0": "2024-01-01T00:00:00Z" } },
    },
    advisories: o.advisories ?? [
      { id: GHSA, package: "tar-lite", ranges: ["<3.1.4"], severity: "high", title: "Path traversal in tar-lite", published: "2026-02-01T00:00:00Z" },
    ],
  };
  if (o.failures) snapshot.failures = o.failures;
  return snapshot;
}

export function appManifest(deps: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "app", version: "1.0.0", private: true, dependencies: deps, ...extra };
}
