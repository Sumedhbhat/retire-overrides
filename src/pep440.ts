// PEP 440 versions and specifiers, for Python ecosystems. Follows the rules in
// https://packaging.python.org/en/latest/specifications/version-specifiers/.
import type { VersionScheme } from "./schemes.ts";

const VERSION =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

export interface Pep440Version {
  epoch: number;
  release: number[];
  pre?: [string, number];
  post?: number;
  dev?: number;
  local?: Array<number | string>;
}

export function parseVersion(text: string): Pep440Version | null {
  const m = VERSION.exec(text);
  if (!m) return null;
  const v: Pep440Version = { epoch: m[1] ? Number(m[1]) : 0, release: m[2]!.split(".").map(Number) };
  if (m[3]) {
    const letter = m[3].toLowerCase();
    const normalized = letter === "alpha" ? "a" : letter === "beta" ? "b" : ["c", "pre", "preview"].includes(letter) ? "rc" : letter;
    v.pre = [normalized, m[4] ? Number(m[4]) : 0];
  }
  if (m[5] !== undefined) v.post = Number(m[5]);
  else if (m[6]) v.post = m[7] ? Number(m[7]) : 0;
  if (m[8]) v.dev = m[9] ? Number(m[9]) : 0;
  if (m[10]) v.local = m[10].toLowerCase().split(/[-_.]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  return v;
}

const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };

function cmpNumbers(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Orders two parsed versions; `local` is compared only when `withLocal` is set. */
export function compareParsed(a: Pep440Version, b: Pep440Version, withLocal = true): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const r = cmpNumbers(a.release, b.release);
  if (r !== 0) return r;
  // A dev release with no pre or post sorts before every pre-release of the same release.
  const preKey = (v: Pep440Version): number[] => {
    if (v.pre) return [PRE_ORDER[v.pre[0]] ?? 0, v.pre[1]];
    if (v.post === undefined && v.dev !== undefined) return [-1, 0];
    return [3, 0];
  };
  const p = cmpNumbers(preKey(a), preKey(b));
  if (p !== 0) return p;
  const postKey = (v: Pep440Version) => (v.post === undefined ? -1 : v.post);
  if (postKey(a) !== postKey(b)) return postKey(a) - postKey(b);
  const devKey = (v: Pep440Version) => (v.dev === undefined ? Number.POSITIVE_INFINITY : v.dev);
  if (devKey(a) !== devKey(b)) return devKey(a) < devKey(b) ? -1 : 1;
  if (!withLocal) return 0;
  if (!a.local && !b.local) return 0;
  if (!a.local) return -1;
  if (!b.local) return 1;
  for (let i = 0; i < Math.max(a.local.length, b.local.length); i++) {
    const x = a.local[i];
    const y = b.local[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (typeof x === "number") {
      return 1;
    } else if (typeof y === "number") {
      return -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

interface Clause {
  op: "~=" | "==" | "!=" | "<=" | ">=" | "<" | ">" | "===";
  version: string;
  wildcard: boolean;
}

const CLAUSE = /^\s*(~=|===|==|!=|<=|>=|<|>)\s*([^\s,;]+)\s*$/;

/** Parses `>=1.0, <2, !=1.5.*`. An empty string means any version. Returns null when invalid. */
export function parseSpecifierSet(text: string): Clause[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const clauses: Clause[] = [];
  for (const part of trimmed.split(",")) {
    const m = CLAUSE.exec(part);
    if (!m) return null;
    const op = m[1] as Clause["op"];
    let version = m[2]!;
    const wildcard = version.endsWith(".*");
    if (wildcard) {
      if (op !== "==" && op !== "!=") return null;
      version = version.slice(0, -2);
    }
    if (op !== "===" && parseVersion(version) === null) return null;
    if (op === "~=" && (parseVersion(version)!.release.length < 2 || wildcard)) return null;
    clauses.push({ op, version, wildcard });
  }
  return clauses;
}

function prefixMatch(candidate: Pep440Version, prefix: Pep440Version): boolean {
  if (candidate.epoch !== prefix.epoch) return false;
  return prefix.release.every((n, i) => (candidate.release[i] ?? 0) === n);
}

function matches(candidate: Pep440Version, raw: string, clause: Clause): boolean {
  if (clause.op === "===") return raw.trim().toLowerCase() === clause.version.toLowerCase();
  const spec = parseVersion(clause.version)!;
  const withLocal = spec.local !== undefined;
  const cmp = compareParsed(candidate, spec, withLocal);
  switch (clause.op) {
    case "==":
      return clause.wildcard ? prefixMatch(candidate, spec) : cmp === 0;
    case "!=":
      return clause.wildcard ? !prefixMatch(candidate, spec) : cmp !== 0;
    case "<=":
      return compareParsed(candidate, spec, false) <= 0;
    case ">=":
      return compareParsed(candidate, spec, false) >= 0;
    case "<":
      // `<V` excludes pre-releases of V itself unless V is a pre-release.
      if (compareParsed(candidate, spec, false) >= 0) return false;
      const candidatePre = candidate.pre !== undefined || candidate.dev !== undefined;
      return !(!spec.pre && spec.dev === undefined && candidatePre && cmpNumbers(candidate.release, spec.release) === 0);
    case ">": {
      // `>V` excludes post-releases and local versions of V unless V is itself a post-release.
      if (compareParsed(candidate, spec, false) <= 0) return false;
      const sameRelease = cmpNumbers(candidate.release, spec.release) === 0 && candidate.epoch === spec.epoch;
      return !(sameRelease && spec.post === undefined && candidate.post !== undefined && !candidate.pre);
    }
    case "~=": {
      if (compareParsed(candidate, spec, false) < 0) return false;
      const prefix: Pep440Version = { epoch: spec.epoch, release: spec.release.slice(0, -1) };
      return prefixMatch(candidate, prefix);
    }
  }
}

export const PEP440: VersionScheme = {
  id: "pep440",
  valid: (v) => parseVersion(v) !== null,
  compare(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return a.localeCompare(b);
    return compareParsed(x, y);
  },
  isPrerelease(v) {
    const p = parseVersion(v);
    return p !== null && (p.pre !== undefined || p.dev !== undefined);
  },
  // Advisory and constraint checks include pre-releases, like node-semver's includePrerelease.
  // ` || ` joins alternatives (requirements that differ by environment marker). It is internal only:
  // nothing written to a manifest uses it.
  satisfies(version, range) {
    const v = parseVersion(version);
    if (!v) return false;
    return range.split("||").some((alt) => {
      const clauses = parseSpecifierSet(alt);
      return clauses !== null && clauses.every((c) => matches(v, version, c));
    });
  },
  validRange: (range) => range.split("||").every((alt) => parseSpecifierSet(alt) !== null),
  compatibleLine(version) {
    const v = parseVersion(version);
    if (!v) return version;
    const major = v.release[0] ?? 0;
    return major > 0 ? `${v.epoch ? `${v.epoch}!` : ""}${major}` : `0.${v.release[1] ?? 0}`;
  },
  interval({ gte, lt, lte }) {
    const parts = [gte ? `>=${gte}` : "", lt ? `<${lt}` : "", lte ? `<=${lte}` : ""].filter((p) => p !== "");
    return parts.length > 0 ? parts.join(",") : ">=0";
  },
  exact: (v) => `==${v}`,
  bump(existing, version) {
    const single = /^\s*(==|>=|~=)\s*[^,]+\s*$/.exec(existing);
    return single ? `${single[1]}${version}` : `>=${version}`;
  },
};

/** PEP 503 name normalization: lowercase, runs of `-`, `_` and `.` become `-`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export interface Requirement {
  name: string;
  extras: string[];
  specifier: string;
  marker?: string;
}

/** Parses a PEP 508 requirement such as `Jinja2[i18n] (>=2.10,<3); python_version >= "3.8"`. Null for URL requirements. */
export function parseRequirement(text: string): Requirement | null {
  const [main, ...markerParts] = text.split(";");
  const marker = markerParts.join(";").trim();
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\)|([^@]*))?\s*$/.exec(main ?? "");
  if (!m) return null;
  const specifier = (m[3] ?? m[4] ?? "").trim();
  if (parseSpecifierSet(specifier) === null) return null;
  const req: Requirement = {
    name: normalizeName(m[1]!),
    extras: (m[2] ?? "").split(",").map((e) => e.trim()).filter((e) => e !== ""),
    specifier,
  };
  if (marker) req.marker = marker;
  return req;
}
