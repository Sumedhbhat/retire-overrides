import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { run } from "../../exec.ts";
import type {
  DependencyPath,
  GraphNode,
  OverrideEntry,
  PackageSelector,
  ResolvedGraph,
  UnsupportedForm,
} from "../../types.ts";
import { parseSpec } from "../../versions.ts";
import type { ImplementedAdapter, OverrideCapabilities, OverrideWrite, Project, ResolveOptions } from "../adapter.ts";
import {
  cliVersion,
  findFiles,
  formatSelector,
  isRecord,
  locateKeyPath,
  packageManagerMismatch,
  parseSelector,
  pinnedVersion,
  projectPath,
  readJsonDocument,
  scopeMatchesPath,
  selectorMatches,
  writeJsonDocument,
} from "../node-common.ts";

export class UnsupportedLockfileError extends Error {}

/** npm: `overrides` in the root package.json, resolved through package-lock.json. */
export class NpmAdapter implements ImplementedAdapter {
  readonly id = "npm" as const;
  readonly support = "implemented" as const;
  readonly mechanisms = "`overrides` in the root package.json (global, nested/parent-scoped, version-selected keys, `.` entries, `$name` references)";
  readonly limitations =
    "Only the root package.json's overrides are honored by npm; overrides in workspace packages are reported as unsupported. Requires lockfileVersion 2 or 3.";

  async detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }> {
    const projects: Project[] = [];
    const unsupported: UnsupportedForm[] = [];
    for (const lockfile of await findFiles(repo, new Set(["package-lock.json", "npm-shrinkwrap.json"]))) {
      const dir = posix.dirname(lockfile) === "." ? "" : posix.dirname(lockfile);
      const manifest = projectPath(dir, "package.json");
      let data: Record<string, unknown>;
      try {
        data = (await readJsonDocument(join(repo, manifest))).data;
      } catch {
        unsupported.push({ ecosystem: "npm", file: lockfile, message: "lockfile has no readable package.json beside it" });
        continue;
      }
      const installed = (await cliVersion("npm", join(repo, dir))) ?? "0.0.0";
      const pinned = pinnedVersion(data, "npm");
      projects.push({
        ecosystem: "npm",
        dir,
        manifest,
        lockfile,
        packageManager: { name: "npm", installed, ...(pinned ? { pinned } : {}) },
      });
    }
    return { projects, unsupported };
  }

  preflight(project: Project): string[] {
    if (project.packageManager.installed === "0.0.0") return ["npm is not installed"];
    return packageManagerMismatch("npm", project.packageManager.installed, project.packageManager.pinned);
  }

  async readOverrides(project: Project, dir: string) {
    const entries: OverrideEntry[] = [];
    const unsupported: UnsupportedForm[] = [];
    const root = (await readJsonDocument(join(dir, project.manifest))).data;
    const rootDeps = { ...asStrings(root.devDependencies), ...asStrings(root.optionalDependencies), ...asStrings(root.dependencies) };

    const walk = (node: Record<string, unknown>, keyPath: string[], scope: PackageSelector[]) => {
      for (const [key, value] of Object.entries(node)) {
        if (key === ".") continue;
        const selector = parseSelector(key);
        const here = [...keyPath, key];
        if (typeof value === "string") {
          this.collect(project, entries, unsupported, here, selector, scope, value, rootDeps);
        } else if (isRecord(value)) {
          const self = value["."];
          if (typeof self === "string") {
            this.collect(project, entries, unsupported, [...here, "."], selector, scope, self, rootDeps);
          }
          walk(value, here, [...scope, selector]);
        } else {
          unsupported.push({ ecosystem: "npm", file: project.manifest, selector: here.slice(1).join(" > "), message: "override value is neither a string nor an object" });
        }
      }
    };
    if (isRecord(root.overrides)) walk(root.overrides, ["overrides"], []);

    // npm ignores overrides anywhere but the root manifest. Say so instead of pretending they work.
    const graphText = await readFile(join(dir, project.lockfile), "utf8").catch(() => "{}");
    const lock = safeJson(graphText);
    const packages = isRecord(lock.packages) ? lock.packages : {};
    for (const location of Object.keys(packages)) {
      if (location === "" || location.includes("node_modules")) continue;
      const file = projectPath(project.dir, posix.join(location, "package.json"));
      const member = await readJsonDocument(join(dir, file)).catch(() => undefined);
      if (member && member.data.overrides !== undefined) {
        unsupported.push({
          ecosystem: "npm",
          file,
          message: "npm only honors overrides in the root package.json; these workspace overrides have no effect",
        });
      }
    }
    return { entries, unsupported };
  }

  private collect(
    project: Project,
    entries: OverrideEntry[],
    unsupported: UnsupportedForm[],
    keyPath: string[],
    target: PackageSelector,
    scope: PackageSelector[],
    value: string,
    rootDeps: Record<string, string>,
  ): void {
    const selector = this.selectorFor(target, scope);
    let effective = value;
    if (value.startsWith("$")) {
      const ref = rootDeps[value.slice(1)];
      if (ref === undefined) {
        unsupported.push({ ecosystem: "npm", file: project.manifest, selector, message: `reference ${value} does not name a root dependency` });
        return;
      }
      effective = ref;
    }
    if (effective.startsWith("npm:") || parseSpec(target.name, effective) === null) {
      unsupported.push({
        ecosystem: "npm",
        file: project.manifest,
        selector,
        message: `override value "${value}" is not a registry version range (aliases, git, file and URL values are not evaluated)`,
      });
      return;
    }
    entries.push({ ecosystem: "npm", file: project.manifest, project: project.dir, selector, keyPath, target, scope, value });
  }

  selectorFor(target: PackageSelector, scope: PackageSelector[]): string {
    return [...scope, target].map(formatSelector).join(" > ");
  }

  overrideApplies(entry: OverrideEntry, path: DependencyPath): boolean {
    const last = path.steps.at(-1);
    if (!last || !selectorMatches(entry.target, last.name, last.version)) return false;
    return scopeMatchesPath(entry.scope, path);
  }

  async readGraph(project: Project, dir: string): Promise<ResolvedGraph> {
    const lock = safeJson(await readFile(join(dir, project.lockfile), "utf8"));
    const version = Number(lock.lockfileVersion);
    if (!(version >= 2) || !isRecord(lock.packages)) {
      throw new UnsupportedLockfileError(
        `${project.lockfile} has lockfileVersion ${String(lock.lockfileVersion)}; regenerate it with npm 7 or later`,
      );
    }
    const packages = lock.packages as Record<string, Record<string, unknown>>;
    const nodes = new Map<string, GraphNode>();
    const importers: string[] = [];
    for (const [location, entry] of Object.entries(packages)) {
      if (entry.link === true) continue;
      const isImporter = !location.includes("node_modules");
      const name =
        typeof entry.name === "string" ? entry.name : isImporter ? location || "(root)" : location.split("node_modules/").at(-1)!;
      const declared = {
        ...asStrings(entry.peerDependencies),
        ...asStrings(entry.optionalDependencies),
        ...(isImporter ? asStrings(entry.devDependencies) : {}),
        ...asStrings(entry.dependencies),
      };
      const node: GraphNode = {
        key: location,
        name,
        version: typeof entry.version === "string" ? entry.version : "0.0.0",
        declared,
        children: new Map(),
        peers: peerOnly(entry),
      };
      if (isImporter) {
        node.importer = location;
        importers.push(location);
      }
      nodes.set(location, node);
    }
    for (const node of nodes.values()) {
      for (const dep of Object.keys(node.declared ?? {})) {
        const target = resolveLocation(packages, node.key, dep);
        if (target !== undefined && nodes.has(target)) node.children.set(dep, target);
      }
    }
    return { nodes, importers };
  }

  async resolve(project: Project, dir: string, options: ResolveOptions): Promise<void> {
    const cwd = join(dir, project.dir);
    const flags = ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"];
    const cache = options.registry ? await mkdtemp(join(tmpdir(), "retire-overrides-npm-cache-")) : undefined;
    if (options.registry) flags.push(`--registry=${options.registry}`, `--cache=${cache}`);
    const env = { npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", npm_config_audit: "false" };
    try {
      await run("npm", ["install", ...flags], { cwd, env });
      // npm keeps locked versions that still satisfy their ranges. `update` re-resolves the named
      // packages (transitive copies and workspaces included) from declared ranges; --no-save keeps
      // manifests untouched. Deleting lockfile entries instead is not repaired inside workspaces.
      if (options.refresh.length > 0) await run("npm", ["update", "--no-save", ...flags, ...options.refresh], { cwd, env });
    } finally {
      if (cache) await rm(cache, { recursive: true, force: true });
    }
  }

  async removeOverride(project: Project, dir: string, entry: OverrideEntry): Promise<void> {
    const path = join(dir, entry.file);
    const doc = await readJsonDocument(path);
    deleteKeyPath(doc.data, entry.keyPath);
    await writeJsonDocument(path, doc);
  }

  overrideCapabilities(): OverrideCapabilities {
    return { parentScope: true, versionSelector: true };
  }

  async writeOverride(project: Project, dir: string, write: OverrideWrite): Promise<{ file: string; selector: string }> {
    const path = join(dir, project.manifest);
    const doc = await readJsonDocument(path);
    if (write.replaces) {
      setKeyPath(doc.data, write.replaces.keyPath, write.value);
      await writeJsonDocument(path, doc);
      return { file: write.replaces.file, selector: write.replaces.selector };
    }
    if (!isRecord(doc.data.overrides)) doc.data.overrides = {};
    let node = doc.data.overrides as Record<string, unknown>;
    for (const parent of write.scope) {
      const key = formatSelector(parent);
      const existing = node[key];
      if (typeof existing === "string") node[key] = { ".": existing };
      else if (!isRecord(existing)) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    const key = formatSelector(write.target);
    if (isRecord(node[key])) (node[key] as Record<string, unknown>)["."] = write.value;
    else node[key] = write.value;
    await writeJsonDocument(path, doc);
    return { file: project.manifest, selector: this.selectorFor(write.target, write.scope) };
  }

  async directSpec(project: Project, dir: string, importer: string, name: string): Promise<string | undefined> {
    const data = (await readJsonDocument(join(dir, importerManifest(project, importer)))).data;
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
      const deps = data[field];
      if (isRecord(deps) && typeof deps[name] === "string") return deps[name];
    }
    return undefined;
  }

  async setDependencySpec(project: Project, dir: string, importer: string, name: string, spec: string): Promise<void> {
    const path = join(dir, importerManifest(project, importer));
    const doc = await readJsonDocument(path);
    for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
      const deps = doc.data[field];
      if (isRecord(deps) && typeof deps[name] === "string") {
        deps[name] = spec;
        await writeJsonDocument(path, doc);
        return;
      }
    }
    throw new Error(`${name} is not a direct dependency of ${importer || "the root project"}`);
  }

  async locate(_project: Project, dir: string, entry: OverrideEntry): Promise<number | undefined> {
    const text = await readFile(join(dir, entry.file), "utf8");
    return locateKeyPath(text, entry.keyPath);
  }
}

function importerManifest(project: Project, importer: string): string {
  return projectPath(project.dir, importer === "" ? "package.json" : posix.join(importer, "package.json"));
}

/** Names declared in peerDependencies and nowhere else. */
export function peerOnly(entry: Record<string, unknown>): Set<string> {
  const other = new Set([...Object.keys(asStrings(entry.dependencies)), ...Object.keys(asStrings(entry.optionalDependencies))]);
  return new Set(Object.keys(asStrings(entry.peerDependencies)).filter((n) => !other.has(n)));
}

export function asStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Node's module resolution over lockfile locations: nearest `node_modules/<dep>` walking up. */
function resolveLocation(packages: Record<string, Record<string, unknown>>, from: string, dep: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${dep}` : `${dir}/node_modules/${dep}`;
    const entry = packages[candidate];
    if (entry !== undefined) {
      if (entry.link === true && typeof entry.resolved === "string") return entry.resolved;
      return candidate;
    }
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf("/");
    dir = cut === -1 ? "" : dir.slice(0, cut);
  }
}

export function deleteKeyPath(root: Record<string, unknown>, keyPath: string[]): void {
  const parents: Array<Record<string, unknown>> = [root];
  let node: unknown = root;
  for (const key of keyPath.slice(0, -1)) {
    if (!isRecord(node)) return;
    node = node[key];
    if (!isRecord(node)) return;
    parents.push(node);
  }
  delete parents.at(-1)![keyPath.at(-1)!];
  // Prune objects left empty, and collapse `{ ".": "x" }` back to `"x"` the way people write it.
  for (let i = parents.length - 1; i > 0; i--) {
    const child = parents[i]!;
    const parent = parents[i - 1]!;
    const key = keyPath[i - 1]!;
    if (Object.keys(child).length === 0) delete parent[key];
    else if (i > 1 && Object.keys(child).length === 1 && typeof child["."] === "string") parent[key] = child["."];
  }
}

export function setKeyPath(root: Record<string, unknown>, keyPath: string[], value: string): void {
  let node: Record<string, unknown> = root;
  for (const key of keyPath.slice(0, -1)) {
    if (!isRecord(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keyPath.at(-1)!] = value;
}

