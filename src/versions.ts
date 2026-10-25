import semver from "semver";
import type { Advisory, PackageMetadata } from "./types.ts";

const LOOSE = { includePrerelease: true } as const;
const DAY_MS = 86_400_000;

export function isAffectedBy(version: string, advisory: Advisory): boolean {
  return advisory.ranges.some((range) => satisfies(version, range));
}

export function affectingAdvisories(version: string, advisories: Advisory[]): Advisory[] {
  return advisories.filter((a) => isAffectedBy(version, a));
}

export function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, LOOSE);
  } catch {
    return false;
  }
}

export function validRange(range: string): boolean {
  try {
    return semver.validRange(range, LOOSE) !== null;
  } catch {
    return false;
  }
}

/**
 * Splits a declared dependency spec into the package it really refers to and its semver range.
 * Returns null for specs that are not registry ranges (git, file, link, workspace, tags, URLs).
 */
export function parseSpec(name: string, spec: string): { name: string; range: string } | null {
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    if (at <= 0) return { name: rest, range: "*" };
    return parseSpec(rest.slice(0, at), rest.slice(at + 1));
  }
  const range = spec.trim() === "" || spec === "latest" ? null : spec;
  if (range === null || !validRange(range)) return null;
  return { name, range };
}

/** Published versions that the range allows and at least one advisory affects. */
export function permittedVulnerableVersions(
  range: string,
  metadata: PackageMetadata,
  advisories: Advisory[],
): string[] {
  return Object.keys(metadata.versions).filter(
    (v) => satisfies(v, range) && advisories.some((a) => isAffectedBy(v, a)),
  );
}

export function availableVersions(metadata: PackageMetadata, now: Date): string[] {
  return Object.keys(metadata.versions)
    .filter((v) => semver.valid(v) !== null)
    .filter((v) => {
      const t = metadata.time[v];
      return t === undefined || Date.parse(t) <= now.getTime();
    })
    .sort(semver.compare);
}

/** Highest available version the range allows, as a fresh resolution would pick it. */
export function maxSatisfying(metadata: PackageMetadata, range: string, now: Date): string | null {
  const candidates = availableVersions(metadata, now).filter(
    (v) => semver.prerelease(v) === null && satisfies(v, range),
  );
  return candidates.at(-1) ?? null;
}

export function ageInDays(published: string, now: Date): number {
  return (now.getTime() - Date.parse(published)) / DAY_MS;
}

/** The release line a version belongs to for compatibility purposes: `1` for 1.x, `0.3` for 0.3.x. */
export function compatibleLine(version: string): string {
  const v = semver.parse(version);
  if (v === null) return version;
  if (v.major > 0) return String(v.major);
  return `0.${v.minor}`;
}

export function isMajorChange(from: string, to: string): boolean {
  return compatibleLine(from) !== compatibleLine(to);
}

export interface FixedVersionChoice {
  version: string;
  /** True when the fix leaves the current compatible release line. */
  major: boolean;
  /** True when the release is at least `minAgeDays` old. */
  mature: boolean;
}

/**
 * Picks the version to move a vulnerable instance to. The candidate must be unaffected by every
 * known advisory (all affected branches), must not be a downgrade, and must not be deprecated or a
 * prerelease. Within the current compatible line the newest mature release wins, falling back to the
 * lowest fixed release (security fixes may skip the release-age wait). Otherwise the lowest fixed
 * release on a later line is returned and flagged as a major change.
 */
export function chooseFixedVersion(input: {
  metadata: PackageMetadata;
  advisories: Advisory[];
  current: string;
  now: Date;
  minAgeDays: number;
}): FixedVersionChoice | null {
  const { metadata, advisories, current, now, minAgeDays } = input;
  const fixed = availableVersions(metadata, now).filter((v) => {
    const meta = metadata.versions[v];
    return (
      semver.prerelease(v) === null &&
      !meta?.deprecated &&
      semver.gte(v, current) &&
      v !== current &&
      advisories.every((a) => !isAffectedBy(v, a))
    );
  });
  if (fixed.length === 0) return null;

  const mature = (v: string) => {
    const t = metadata.time[v];
    return t !== undefined && ageInDays(t, now) >= minAgeDays;
  };
  const line = compatibleLine(current);
  const sameLine = fixed.filter((v) => compatibleLine(v) === line);
  if (sameLine.length > 0) {
    const newestMature = sameLine.filter(mature).at(-1);
    const version = newestMature ?? sameLine[0]!;
    return { version, major: false, mature: mature(version) };
  }
  const version = fixed[0]!;
  return { version, major: true, mature: mature(version) };
}

/** Keeps the operator style of an existing spec when bumping it, e.g. `~1.2.0` → `~1.4.1`. */
export function bumpSpec(existing: string, version: string): string {
  const simple = /^\s*(\^|~|>=|=)?\s*v?\d+\.\d+\.\d+\S*\s*$/.exec(existing);
  if (simple === null) return `^${version}`;
  return `${simple[1] ?? ""}${version}`;
}
