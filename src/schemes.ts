import semver from "semver";
import { PEP440 } from "./pep440.ts";
import type { EcosystemId } from "./types.ts";

/**
 * How one ecosystem compares versions and reads ranges. The engine never assumes node-semver; it asks
 * the scheme of the ecosystem it is evaluating, so PEP 440 and other schemes plug in here.
 */
export interface VersionScheme {
  readonly id: "semver" | "pep440";
  valid(version: string): boolean;
  /** Negative, zero or positive, like Array.prototype.sort comparators. */
  compare(a: string, b: string): number;
  isPrerelease(version: string): boolean;
  /** Whether a version is inside a range written in this scheme's syntax. Invalid input is never inside. */
  satisfies(version: string, range: string): boolean;
  validRange(range: string): boolean;
  /** The release line used for compatibility: `1` for 1.x, `0.3` for 0.3.x. */
  compatibleLine(version: string): string;
  /** A range in this scheme's syntax for an interval; no bounds means every version. */
  interval(bounds: { gte?: string; lt?: string; lte?: string }): string;
  /** A range matching exactly one version. */
  exact(version: string): string;
  /** Moves an existing requirement to a new version, keeping its operator style where possible. */
  bump(existing: string, version: string): string;
}

const LOOSE = { includePrerelease: true } as const;

export const SEMVER: VersionScheme = {
  id: "semver",
  valid: (v) => semver.valid(v) !== null,
  compare: (a, b) => semver.compare(a, b),
  isPrerelease: (v) => semver.prerelease(v) !== null,
  satisfies(version, range) {
    try {
      return semver.satisfies(version, range, LOOSE);
    } catch {
      return false;
    }
  },
  validRange(range) {
    try {
      return semver.validRange(range, LOOSE) !== null;
    } catch {
      return false;
    }
  },
  compatibleLine(version) {
    const v = semver.parse(version);
    if (v === null) return version;
    return v.major > 0 ? String(v.major) : `0.${v.minor}`;
  },
  interval({ gte, lt, lte }) {
    const parts = [gte ? `>=${gte}` : "", lt ? `<${lt}` : "", lte ? `<=${lte}` : ""].filter((p) => p !== "");
    return parts.length > 0 ? parts.join(" ") : "*";
  },
  exact: (v) => v,
  bump(existing, version) {
    const simple = /^\s*(\^|~|>=|=)?\s*v?\d+\.\d+\.\d+\S*\s*$/.exec(existing);
    return simple === null ? `^${version}` : `${simple[1] ?? ""}${version}`;
  },
};

const schemes = new Map<EcosystemId, VersionScheme>([["uv", PEP440]]);

export function registerScheme(ecosystem: EcosystemId, scheme: VersionScheme): void {
  schemes.set(ecosystem, scheme);
}

/** The version scheme for an ecosystem; JavaScript ecosystems use node-semver. */
export function schemeFor(ecosystem: EcosystemId): VersionScheme {
  return schemes.get(ecosystem) ?? SEMVER;
}
