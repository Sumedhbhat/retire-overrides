import type {
  DependencyPath,
  EcosystemId,
  OverrideEntry,
  PackageSelector,
  ResolvedGraph,
  UnsupportedForm,
} from "../types.ts";

export type SupportLevel = "implemented" | "planned";

export interface PackageManagerInfo {
  name: string;
  /** Version that will run, from `<pm> --version`. */
  installed: string;
  /** Version the repository pins (`packageManager` or `devEngines`), when it pins one. */
  pinned?: string;
}

/** One resolvable project: a root manifest and the lockfile its package manager owns. */
export interface Project {
  ecosystem: EcosystemId;
  /** Repository-relative project directory; `""` for the repository root. */
  dir: string;
  /** Repository-relative path of the root manifest. */
  manifest: string;
  /** Repository-relative path of the lockfile. */
  lockfile: string;
  packageManager: PackageManagerInfo;
}

/** Settings for a package-manager resolution run. Resolution never installs or runs scripts. */
export interface ResolveOptions {
  /** Packages whose locked versions must be discarded and resolved again from declared ranges. */
  refresh: string[];
  /** Registry URL to resolve against instead of the repository's configuration. */
  registry?: string;
  /**
   * When the package manager cannot refresh packages selectively, allow re-resolving the whole tree
   * instead. Fix candidates allow it (verification flags the incidental upgrades); removals do not.
   */
  fullRefreshAllowed?: boolean;
}

export interface OverrideCapabilities {
  /** Overrides can be restricted to a parent (`parent > pkg`, `parent>pkg`). */
  parentScope: boolean;
  /** Keys can carry a version selector (`pkg@3`, `parent@2 > pkg`). */
  versionSelector: boolean;
}

export interface OverrideWrite {
  target: PackageSelector;
  scope: PackageSelector[];
  value: string;
  /** Existing entry to change in place instead of adding a new one. */
  replaces?: OverrideEntry;
}

/**
 * An ecosystem adapter knows one package manager's native files. The engine never parses manifests
 * or lockfiles itself; it asks the adapter, so adding an ecosystem means adding an adapter.
 */
export interface EcosystemAdapter {
  readonly id: EcosystemId;
  readonly support: SupportLevel;
  /** Native mechanisms the adapter inspects, for the support matrix. */
  readonly mechanisms: string;
  readonly limitations: string;

  /** Finds projects in the repository. Planned adapters only report what they found as unsupported. */
  detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }>;
}

export interface ImplementedAdapter extends EcosystemAdapter {
  readonly support: "implemented";

  /** Problems that make the project impossible to evaluate (for example a package-manager mismatch). */
  preflight(project: Project): string[];

  readOverrides(project: Project, dir: string): Promise<{ entries: OverrideEntry[]; unsupported: UnsupportedForm[] }>;
  readGraph(project: Project, dir: string): Promise<ResolvedGraph>;
  resolve(project: Project, dir: string, options: ResolveOptions): Promise<void>;

  removeOverride(project: Project, dir: string, entry: OverrideEntry): Promise<void>;
  /** Writes an override and returns the file and selector it was written under. */
  writeOverride(project: Project, dir: string, write: OverrideWrite): Promise<{ file: string; selector: string }>;
  /** Rewrites a direct dependency's spec in an importer's manifest. */
  setDependencySpec(project: Project, dir: string, importer: string, name: string, spec: string): Promise<void>;
  /** Declared spec of a direct dependency in an importer's manifest. */
  directSpec(project: Project, dir: string, importer: string, name: string): Promise<string | undefined>;

  /** Whether an override entry governs a package reached by this path, using the package manager's semantics. */
  overrideApplies(entry: OverrideEntry, path: DependencyPath): boolean;
  /** Selector text the adapter would write for a scope, for identities and reports. */
  selectorFor(target: PackageSelector, scope: PackageSelector[]): string;
  /** Set when this package-manager version cannot refresh single packages (removals then keep locked versions). */
  refreshLimitation?(project: Project): string | undefined;
  /** Which selector shapes the project's package-manager version honors when writing new overrides. */
  overrideCapabilities(project: Project): OverrideCapabilities;
  /** 1-based line of an entry in its file, for blame. */
  locate(project: Project, dir: string, entry: OverrideEntry): Promise<number | undefined>;
}

export function isImplemented(adapter: EcosystemAdapter): adapter is ImplementedAdapter {
  return adapter.support === "implemented";
}
