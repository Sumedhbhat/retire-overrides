import type { DependencyPath, GraphNode, Instance, ResolvedGraph } from "./types.ts";

export const MAX_PATHS_PER_INSTANCE = 25;

export interface Edge {
  parent: GraphNode;
  child: GraphNode;
  /** Dependency name as the parent declares it (differs from child.name for aliases). */
  as: string;
}

export function incomingEdges(graph: ResolvedGraph, key: string): Edge[] {
  const child = graph.nodes.get(key);
  if (!child) return [];
  const edges: Edge[] = [];
  for (const parent of graph.nodes.values()) {
    for (const [as, target] of parent.children) {
      if (target === key) edges.push({ parent, child, as });
    }
  }
  return edges;
}

/** Every resolved copy of a package, with up to MAX_PATHS_PER_INSTANCE paths each. */
export function instancesOf(graph: ResolvedGraph, name: string): Instance[] {
  const out: Instance[] = [];
  for (const node of graph.nodes.values()) {
    if (node.name !== name || node.importer !== undefined) continue;
    const { paths, truncated } = pathsTo(graph, node.key, MAX_PATHS_PER_INSTANCE);
    out.push({ name, version: node.version, nodeKey: node.key, paths, pathsTruncated: truncated });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version) || a.nodeKey.localeCompare(b.nodeKey));
}

/** Enumerates importer→node paths breadth-first so the shortest paths are reported first. */
export function pathsTo(graph: ResolvedGraph, key: string, limit: number): { paths: DependencyPath[]; truncated: boolean } {
  // Walk backwards from the node to importers.
  const paths: DependencyPath[] = [];
  const parents = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const target of node.children.values()) {
      const list = parents.get(target) ?? [];
      if (!list.includes(node.key)) list.push(node.key);
      parents.set(target, list);
    }
  }
  const queue: string[][] = [[key]];
  let truncated = false;
  let expanded = 0;
  while (queue.length > 0) {
    const chain = queue.shift()!;
    const head = chain[0]!;
    const node = graph.nodes.get(head)!;
    if (node.importer !== undefined) {
      if (paths.length >= limit) {
        truncated = true;
        break;
      }
      paths.push({
        importer: node.importer,
        steps: chain.slice(1).map((k) => {
          const n = graph.nodes.get(k)!;
          return { name: n.name, version: n.version };
        }),
      });
      continue;
    }
    if (++expanded > 20_000) {
      truncated = true;
      break;
    }
    for (const parent of parents.get(head) ?? []) {
      if (!chain.includes(parent)) queue.push([parent, ...chain]);
    }
  }
  return { paths, truncated };
}

export function formatPath(path: DependencyPath): string {
  const root = path.importer === "" || path.importer === "." ? "(root)" : path.importer;
  return [root, ...path.steps.map((s) => `${s.name}@${s.version}`)].join(" > ");
}

/** name → sorted distinct versions, excluding importers. */
export function versionsByName(graph: ResolvedGraph): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const node of graph.nodes.values()) {
    if (node.importer !== undefined) continue;
    const set = map.get(node.name) ?? new Set<string>();
    set.add(node.version);
    map.set(node.name, set);
  }
  return new Map([...map].map(([name, set]) => [name, [...set].sort()]));
}

/** Versions present in `after` that `before` did not have. */
export function addedVersions(before: ResolvedGraph, after: ResolvedGraph): Array<{ name: string; version: string }> {
  const prior = versionsByName(before);
  const added: Array<{ name: string; version: string }> = [];
  for (const [name, versions] of versionsByName(after)) {
    const had = new Set(prior.get(name) ?? []);
    for (const v of versions) if (!had.has(v)) added.push({ name, version: v });
  }
  return added.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function sameResolution(a: ResolvedGraph, b: ResolvedGraph): boolean {
  return addedVersions(a, b).length === 0 && addedVersions(b, a).length === 0;
}
