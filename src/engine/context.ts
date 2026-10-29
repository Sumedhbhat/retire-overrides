import type { AdvisoryProvider } from "../advisories/providers.ts";
import type { EcosystemAdapter } from "../adapters/adapter.ts";
import type { Config } from "../config.ts";
import { versionsByName } from "../graph.ts";
import type { RegistryClient } from "../registry/registry.ts";
import { declaredRangeIn } from "../registry/registry.ts";
import type { Advisory, EcosystemId, GraphNode, PackageMetadata, ResolvedGraph } from "../types.ts";
import { schemeFor } from "../schemes.ts";
import { affectingAdvisories } from "../versions.ts";
import type { AdvisoryRef } from "./report.ts";

/** An open PR from Dependabot, Renovate or another bot that may already fix something. */
export interface ExternalChange {
  url: string;
  title: string;
  branch: string;
  author: string;
}

export interface EngineOptions {
  repo: string;
  commit: string;
  now: Date;
  config: Config;
  registry: RegistryClient;
  advisories: AdvisoryProvider;
  adapters: EcosystemAdapter[];
  /** Registry URL handed to package managers (snapshot replay); undefined uses the repository's own configuration. */
  packageManagerRegistry?: string;
  externalChanges?: ExternalChange[];
  log?: (message: string) => void;
  /** Called with every graph read, so a recorder can capture metadata for replay. */
  onGraph?: (graph: ResolvedGraph) => void;
}

export interface Finding {
  name: string;
  version: string;
  advisory: string;
}

export class EngineContext {
  readonly options: EngineOptions;
  private readonly allAdvisoriesCache = new Map<string, Promise<Advisory[]>>();

  constructor(options: EngineOptions) {
    this.options = options;
  }

  get now(): Date {
    return this.options.now;
  }

  get config(): Config {
    return this.options.config;
  }

  log(message: string): void {
    this.options.log?.(message);
  }

  package(name: string): Promise<PackageMetadata> {
    return this.options.registry.getPackage(name);
  }

  /** Every known advisory for a package, across all of its published versions. */
  allAdvisories(ecosystem: EcosystemId, name: string): Promise<Advisory[]> {
    const key = `${ecosystem}\0${name}`;
    let cached = this.allAdvisoriesCache.get(key);
    if (cached === undefined) {
      cached = (async () => {
        const meta = await this.package(name);
        const answer = await this.options.advisories.advisoriesFor(ecosystem, new Map([[name, Object.keys(meta.versions)]]), { allVersions: true });
        return answer.get(name) ?? [];
      })();
      this.allAdvisoriesCache.set(key, cached);
    }
    return cached;
  }

  /** Audits every resolved version in a graph. Throws when advisory data is unavailable. */
  async audit(ecosystem: EcosystemId, graph: ResolvedGraph): Promise<Finding[]> {
    const versions = versionsByName(graph);
    if (versions.size === 0) return [];
    const answer = await this.options.advisories.advisoriesFor(ecosystem, versions);
    const findings: Finding[] = [];
    for (const [name, list] of versions) {
      const advisories = answer.get(name);
      if (advisories === undefined) throw new Error(`advisory provider returned no answer for ${name}`);
      for (const version of list) {
        for (const a of affectingAdvisories(version, advisories, schemeFor(ecosystem))) findings.push({ name, version, advisory: a.id });
      }
    }
    return findings;
  }

  /** Declared range of `dep` in a node: from the lockfile when recorded, else from the published manifest. */
  async declaredRange(node: GraphNode, dep: string): Promise<string | undefined> {
    const local = node.declared?.[dep];
    if (local !== undefined) return local;
    if (node.importer !== undefined) return undefined;
    const meta = await this.package(node.name);
    return declaredRangeIn(meta.versions[node.version], dep);
  }

  /** Whether `dep` is only a peer of the node (peers don't choose versions; another edge or auto-install does). */
  async isPeerEdge(node: GraphNode, dep: string): Promise<boolean> {
    if (node.importer !== undefined) return false;
    if (node.peers !== undefined) return node.peers.has(dep);
    const meta = (await this.package(node.name)).versions[node.version];
    return meta !== undefined && dep in meta.peerDependencies && !(dep in meta.dependencies) && !(dep in meta.optionalDependencies);
  }

  seen(graph: ResolvedGraph): void {
    this.options.onGraph?.(graph);
  }
}

export function advisoryRefs(advisories: Advisory[]): AdvisoryRef[] {
  return advisories.map((a) => {
    const ref: AdvisoryRef = { id: a.id, ranges: a.ranges };
    if (a.severity) ref.severity = a.severity;
    if (a.title) ref.title = a.title;
    if (a.url) ref.url = a.url;
    return ref;
  });
}

export function findingKey(f: Finding): string {
  return `${f.name}@${f.version}:${f.advisory}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
