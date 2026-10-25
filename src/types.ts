// Shared domain types. Every adapter, provider and publisher speaks in these terms.

export type EcosystemId =
  | "npm"
  | "pnpm"
  | "yarn"
  | "uv"
  | "cargo"
  | "go"
  | "gradle"
  | "maven"
  | "nuget";

/** Outcome of evaluating one existing override. */
export type OverrideStatus = "NEEDED" | "WAITING" | "REMOVABLE" | "REVIEW_NEEDED" | "BLOCKED";

/** Outcome of planning a fix for one vulnerable package. */
export type FixStatus = "PROPOSED" | "DEFERRED" | "REVIEW_NEEDED" | "BLOCKED";

export interface Reason {
  /** Stable machine-readable code, e.g. `parent-permits-vulnerable`. */
  code: string;
  message: string;
}

/** `name` plus an optional version selector, as used in override keys and scopes. */
export interface PackageSelector {
  name: string;
  range?: string;
}

/** Why an override exists, as far as the tool can tell without a ledger. */
export type OverrideIntent =
  | { kind: "tool"; commit: string; advisories: string[]; date: string }
  | { kind: "managed"; source: "config" }
  | { kind: "keep"; reason?: string }
  | { kind: "unknown" };

export interface Provenance {
  commit?: string;
  author?: string;
  date?: string;
  source: "trailer" | "blame" | "unavailable";
}

/** One override as written in a native manifest or package-manager configuration. */
export interface OverrideEntry {
  ecosystem: EcosystemId;
  /** Repository-relative path of the file that holds the override. */
  file: string;
  /** Repository-relative path of the project root (where the lockfile lives). */
  project: string;
  /** Human-readable native selector, e.g. `bundler-kit>tar-lite` or `overrides.bundler-kit.tar-lite`. */
  selector: string;
  /** Key path inside the file, used for edits. */
  keyPath: string[];
  target: PackageSelector;
  /** Ancestors the override is restricted to, outermost first. Empty means global. */
  scope: PackageSelector[];
  value: string;
}

export interface UnsupportedForm {
  ecosystem: EcosystemId;
  file: string;
  selector?: string;
  message: string;
}

export interface Advisory {
  /** GHSA ID when known; otherwise the provider's ID. */
  id: string;
  aliases: string[];
  package: string;
  /** Each entry is one affected branch as a node-semver range. */
  ranges: string[];
  severity?: string;
  title?: string;
  url?: string;
}

export interface PackageVersionMetadata {
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  deprecated?: string;
}

export interface PackageMetadata {
  name: string;
  versions: Record<string, PackageVersionMetadata>;
  /** Publish time per version (ISO-8601). Missing entries mean the release date is unknown. */
  time: Record<string, string>;
  repository?: string;
}

/** A resolved package instance in a dependency graph. */
export interface GraphNode {
  key: string;
  name: string;
  version: string;
  /** Declared ranges by dependency name, when the lockfile records them. */
  declared?: Record<string, string>;
  /** Resolved children by dependency name → node key. */
  children: Map<string, string>;
  /** Set for project roots (npm `""`, workspace packages, pnpm importers). */
  importer?: string;
}

export interface ResolvedGraph {
  nodes: Map<string, GraphNode>;
  /** Node keys of importers (root project and workspace packages). */
  importers: string[];
}

export interface PathStep {
  name: string;
  version: string;
}

/** One dependency path from an importer to a package instance. */
export interface DependencyPath {
  importer: string;
  steps: PathStep[];
}

export interface Instance {
  name: string;
  version: string;
  nodeKey: string;
  paths: DependencyPath[];
  pathsTruncated: boolean;
}
