import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import { run } from "../../exec.ts";
import type {
  DependencyPath,
  GraphNode,
  OverrideEntry,
  PackageSelector,
  ResolvedGraph,
  UnsupportedForm,
} from "../../types.ts";
import { parseSpec, satisfies } from "../../versions.ts";
import type { ImplementedAdapter, OverrideCapabilities, OverrideWrite, Project, ResolveOptions } from "../adapter.ts";
import {
  cliVersion,
  findFiles,
  isRecord,
  locateKeyPath,
  packageManagerMismatch,
  parseSelector,
  pinnedVersion,
  projectPath,
  readJsonDocument,
  selectorMatches,
  writeJsonDocument,
} from "../node-common.ts";
import { asStrings, peerOnly, UnsupportedLockfileError } from "../npm/npm.ts";
import { splitKey } from "../bun/bun.ts";

/** Yarn Classic (1.x) and modern Yarn (2+, "Berry") differ in every mechanism that matters here. */
export type YarnLine = "classic" | "berry";

export function yarnLine(version: string): YarnLine {
  return (semver.coerce(version)?.major ?? 1) >= 2 ? "berry" : "classic";
}

/**
 * One `resolutions` key, split into path segments. Classic matches the whole segment list as a glob
 * against the dependency path from the project root (`**` spans any depth; a bare name means
 * `**\/name`). Berry honors only `pkg`, `pkg@descriptor`, and `parent[@descriptor]/pkg[@descriptor]`.
 */
export interface ResolutionKey {
  segments: PackageSelector[];
}

export function parseResolutionKey(key: string): ResolutionKey {
  return { segments: splitKey(key).map((s) => (s === "**" ? { name: "**" } : parseSelector(s))) };
}

/** Classic glob semantics: does the key's segment pattern match this list of package names? */
export function classicPatternMatches(segments: string[], names: string[]): boolean {
  const pattern = segments.length === 1 && segments[0] !== "**" ? ["**", ...segments] : segments;
  const match = (p: number, n: number): boolean => {
    if (p === pattern.length) return n === names.length;
    if (pattern[p] === "**") return match(p + 1, n) || (n < names.length && match(p, n + 1));
    return n < names.length && pattern[p] === names[n] && match(p + 1, n + 1);
  };
  return match(0, 0);
}

/** `npm:^1.2.0` → `^1.2.0`; other protocols are not plain registry ranges. */
function registryRange(value: string): string | null {
  const v = value.startsWith("npm:") ? value.slice(4) : value;
  if (/^[^@\s]+@/.test(v) && !/^[\d^~<>=*xX]/.test(v)) return null; // npm:alias@range
  return parseSpec("x", v) === null ? null : v;
}

/** Yarn: `resolutions` in the root package.json, resolved through yarn.lock (Classic v1 or Berry YAML). */
export class YarnAdapter implements ImplementedAdapter {
  readonly id = "yarn" as const;
  readonly support = "implemented" as const;
  readonly mechanisms =
    "`resolutions` in the root package.json: Classic path globs (`pkg`, `**/pkg`, `a/b/pkg`, `a/**/pkg`); Berry `pkg`, `pkg@descriptor` and `parent/pkg` keys";
  readonly limitations =
    "Classic matches a key against the full path from the root and fails on `pkg@range` keys; it has no lockfile-only mode, so resolution fetches and extracts packages into a throwaway folder (scripts never run). Berry silently ignores `**` globs and deeper paths, and applies `parent/pkg` to direct children only. Berry runs the repository's committed yarnPath release and plugins. Non-registry values (patch:, portal:, link:, file:, aliases) are reported, not evaluated.";

  async detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }> {
    const projects: Project[] = [];
    const unsupported: UnsupportedForm[] = [];
    for (const lockfile of await findFiles(repo, new Set(["yarn.lock"]))) {
      const dir = posix.dirname(lockfile) === "." ? "" : posix.dirname(lockfile);
      const manifest = projectPath(dir, "package.json");
      let data: Record<string, unknown>;
      try {
        data = (await readJsonDocument(join(repo, manifest))).data;
      } catch {
        unsupported.push({ ecosystem: "yarn", file: lockfile, message: "lockfile has no readable package.json beside it" });
        continue;
      }
      const installed = (await cliVersion("yarn", join(repo, dir))) ?? "0.0.0";
      const pinned = pinnedVersion(data, "yarn") ?? (await yarnPathVersion(join(repo, dir)));
      projects.push({
        ecosystem: "yarn",
        dir,
        manifest,
        lockfile,
        packageManager: { name: "yarn", installed, ...(pinned ? { pinned } : {}) },
      });
    }
    return { projects, unsupported };
  }

  preflight(project: Project): string[] {
    if (project.packageManager.installed === "0.0.0") return ["yarn is not installed"];
    return packageManagerMismatch("yarn", project.packageManager.installed, project.packageManager.pinned);
  }

  private line(project: Project): YarnLine {
    return yarnLine(project.packageManager.pinned ?? project.packageManager.installed);
  }

  overrideCapabilities(): OverrideCapabilities {
    // Neither line has a version selector with npm's meaning: Classic rejects `pkg@range` keys and
    // Berry's `pkg@descriptor` matches the requested range string, not the resolved version.
    return { parentScope: true, versionSelector: false };
  }

  async readOverrides(project: Project, dir: string) {
    const entries: OverrideEntry[] = [];
    const unsupported: UnsupportedForm[] = [];
    const root = (await readJsonDocument(join(dir, project.manifest))).data;
    const file = project.manifest;
    const line = this.line(project);
    const report = (selector: string, message: string) => unsupported.push({ ecosystem: "yarn", file, selector, message });
    const block = root.resolutions;
    if (block !== undefined && !isRecord(block)) report("resolutions", "resolutions is not an object");
    for (const [key, value] of Object.entries(isRecord(block) ? block : {})) {
      if (typeof value !== "string") {
        report(key, "resolution value is not a string");
        continue;
      }
      const { segments } = parseResolutionKey(key);
      const target = segments.at(-1)!;
      if (target.name === "**" || segments.length === 0) {
        report(key, "resolution key does not end in a package name");
        continue;
      }
      if (line === "classic" && segments.some((s) => s.range !== undefined)) {
        report(key, "Yarn Classic fails on version-selected resolution keys");
        continue;
      }
      if (line === "berry" && (segments.length > 2 || segments.some((s) => s.name === "**"))) {
        report(key, "Yarn 2+ silently ignores `**` globs and paths deeper than parent/package");
        continue;
      }
      if (registryRange(value) === null) {
        report(key, `resolution value "${value}" is not a registry version range (patch:, portal:, link:, file:, git and alias values are not evaluated)`);
        continue;
      }
      entries.push({
        ecosystem: "yarn",
        file,
        project: project.dir,
        selector: key,
        keyPath: ["resolutions", key],
        target: target.range !== undefined ? { name: target.name, range: target.range.replace(/^npm:/, "") } : { name: target.name },
        scope: segments.slice(0, -1).map((s) => (s.range !== undefined ? { name: s.name, range: s.range.replace(/^npm:/, "") } : { name: s.name })),
        value,
        ...(line === "classic" ? { pathGlob: true } : {}),
      });
    }
    return { entries, unsupported };
  }

  selectorFor(target: PackageSelector, scope: PackageSelector[]): string {
    const parent = scope.at(-1);
    if (!parent) return target.name;
    // Classic matches the full path from the root, so `**/` gives "direct child of parent" anywhere.
    return `**/${parent.name}/${target.name}`;
  }

  private berrySelectorFor(target: PackageSelector, scope: PackageSelector[]): string {
    const parent = scope.at(-1);
    return parent ? `${parent.name}/${target.name}` : target.name;
  }

  overrideApplies(entry: OverrideEntry, path: DependencyPath): boolean {
    const last = path.steps.at(-1);
    if (!last || last.name !== entry.target.name) return false;
    if (entry.pathGlob) {
      return classicPatternMatches([...entry.scope, entry.target].map((s) => s.name), path.steps.map((s) => s.name));
    }
    // Berry: `pkg` everywhere, `parent/pkg` only where parent is the direct parent. A descriptor on the
    // target matches the requested range, which a path doesn't record, so it is treated as matching.
    if (entry.scope.length === 0) return true;
    const parent = path.steps.at(-2);
    return parent !== undefined && selectorMatches(entry.scope[0]!, parent.name, parent.version);
  }

  async readGraph(project: Project, dir: string): Promise<ResolvedGraph> {
    const text = await readFile(join(dir, project.lockfile), "utf8");
    const root = (await readJsonDocument(join(dir, project.manifest))).data;
    const importers = await this.importerManifests(project, dir, root);
    // An empty yarn.lock means "nothing locked yet" to both lines: only the importers exist.
    if (/^# yarn lockfile v1$/m.test(text) || text.trim() === "") return classicGraph(text, importers);
    const lock = parseYaml(text) as Record<string, unknown> | null;
    if (!isRecord(lock) || !isRecord(lock.__metadata)) {
      throw new UnsupportedLockfileError(`${project.lockfile} is neither a Yarn Classic (v1) nor a Yarn 2+ lockfile`);
    }
    return berryGraph(lock, isRecord(root.resolutions) ? asStrings(root.resolutions) : {});
  }

  /** Root and workspace manifests, keyed by importer path ("" for the root). */
  private async importerManifests(project: Project, dir: string, root: Record<string, unknown>): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>([["", root]]);
    const raw = root.workspaces;
    const globs = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.packages) ? raw.packages : [];
    if (globs.length === 0) return out;
    const base = join(dir, project.dir);
    for (const manifest of await findFiles(base, new Set(["package.json"]))) {
      const path = posix.dirname(manifest);
      if (path === "." || !globs.some((g) => typeof g === "string" && classicPatternMatches(g.split("/").map((s) => (s === "*" ? "**" : s)), path.split("/")))) continue;
      const data = await readJsonDocument(join(base, manifest)).then((d) => d.data).catch(() => undefined);
      if (data) out.set(path, data);
    }
    return out;
  }

  async resolve(project: Project, dir: string, options: ResolveOptions): Promise<void> {
    const cwd = join(dir, project.dir);
    const lockfile = join(dir, project.lockfile);
    if (options.refresh.length > 0) await dropLockedPackages(lockfile, new Set(options.refresh));
    const scratch = await mkdtemp(join(tmpdir(), "retire-overrides-yarn-"));
    try {
      if (this.line(project) === "classic") {
        // Classic has no lockfile-only mode: it fetches and extracts into a throwaway modules folder.
        const args = [
          "install", "--ignore-scripts", "--non-interactive", "--no-progress", "--ignore-engines",
          "--ignore-platform", "--production=false", "--modules-folder", join(scratch, "node_modules"),
        ];
        if (options.registry) {
          // A replay registry serves synthetic tarballs, so recorded checksums can't match them.
          args.push("--registry", options.registry, "--cache-folder", join(scratch, "cache"), "--update-checksums");
          // Classic fetches from each entry's recorded `resolved` URL, not the configured registry.
          await retargetResolved(lockfile, options.registry);
        }
        await run("yarn", args, { cwd, env: { npm_config_registry: undefined } });
      } else {
        const env: Record<string, string | undefined> = {
          npm_config_registry: undefined,
          YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
          YARN_ENABLE_SCRIPTS: "false",
          YARN_ENABLE_TELEMETRY: "0",
          YARN_ENABLE_PROGRESS_BARS: "false",
        };
        if (options.registry) {
          env.YARN_NPM_REGISTRY_SERVER = options.registry.replace(/\/+$/, "");
          env.YARN_UNSAFE_HTTP_WHITELIST = new URL(options.registry).hostname;
          env.YARN_ENABLE_GLOBAL_CACHE = "false";
          env.YARN_CACHE_FOLDER = join(scratch, "cache");
          // Berry also caches registry metadata in its global folder, keyed by host, which would
          // serve another run's snapshot (and its tarball URLs) back to this one.
          env.YARN_GLOBAL_FOLDER = join(scratch, "global");
        }
        const state = join(cwd, ".yarn", "install-state.gz");
        const hadState = await exists(state);
        // `yarn up` ignores --mode=update-lockfile on some versions and links (and builds) packages,
        // so refreshes delete lockfile entries instead and let update-lockfile resolve them again.
        await run("yarn", ["install", "--mode=update-lockfile"], { cwd, env });
        if (!hadState) await unlink(state).catch(() => undefined);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async removeOverride(_project: Project, dir: string, entry: OverrideEntry): Promise<void> {
    const path = join(dir, entry.file);
    const doc = await readJsonDocument(path);
    const block = doc.data.resolutions;
    if (isRecord(block)) {
      delete block[entry.keyPath.at(-1)!];
      if (Object.keys(block).length === 0) delete doc.data.resolutions;
    }
    await writeJsonDocument(path, doc);
  }

  async writeOverride(project: Project, dir: string, write: OverrideWrite): Promise<{ file: string; selector: string }> {
    const path = join(dir, project.manifest);
    const doc = await readJsonDocument(path);
    if (!isRecord(doc.data.resolutions)) doc.data.resolutions = {};
    const block = doc.data.resolutions as Record<string, unknown>;
    const key =
      write.replaces?.keyPath.at(-1) ??
      (this.line(project) === "classic" ? this.selectorFor(write.target, write.scope) : this.berrySelectorFor(write.target, write.scope));
    block[key] = write.value;
    await writeJsonDocument(path, doc);
    return { file: write.replaces?.file ?? project.manifest, selector: key };
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
    return locateKeyPath(await readFile(join(dir, entry.file), "utf8"), entry.keyPath);
  }
}

function importerManifest(project: Project, importer: string): string {
  return projectPath(project.dir, importer === "" ? "package.json" : posix.join(importer, "package.json"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A Berry project pins its release with `yarnPath: .yarn/releases/yarn-X.Y.Z.cjs`. */
async function yarnPathVersion(projectDir: string): Promise<string | undefined> {
  const rc = await readFile(join(projectDir, ".yarnrc.yml"), "utf8").catch(() => "");
  return /^yarnPath:\s*\S*yarn-(\d+\.\d+\.\d+[^/\s]*)\.c?js\s*$/m.exec(rc)?.[1];
}

function nameOf(descriptor: string): string {
  const at = descriptor.indexOf("@", descriptor.startsWith("@") ? 1 : 0);
  return at === -1 ? descriptor : descriptor.slice(0, at);
}

/** Splits a lockfile header like `"a@^1", a@^1.2:` or `"a@npm:^1, a@npm:^1.2":` into descriptors. */
export function headerDescriptors(header: string): string[] {
  return header
    .replace(/:\s*$/, "")
    .split(/,\s*/)
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d !== "");
}

/** Yarn Classic's custom lockfile format. Returns entries by descriptor (`name@range`). */
export function parseClassicLock(text: string): Map<string, { name: string; version: string; dependencies: Record<string, string>; optional: Set<string> }> {
  const out = new Map<string, { name: string; version: string; dependencies: Record<string, string>; optional: Set<string> }>();
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
    if (lines.length === 0 || /^\s/.test(lines[0]!)) continue;
    const descriptors = headerDescriptors(lines[0]!);
    const entry = { name: nameOf(descriptors[0]!), version: "0.0.0", dependencies: {} as Record<string, string>, optional: new Set<string>() };
    let section: string | undefined;
    for (const line of lines.slice(1)) {
      const m = /^( +)("?[^"\s]+"?) +"?([^"]*)"?$/.exec(line);
      const header = /^ {2}(\w+):$/.exec(line);
      if (header) {
        section = header[1];
        continue;
      }
      if (!m) continue;
      const [, indent, rawKey, value] = m as unknown as [string, string, string, string];
      const key = rawKey.replace(/^"|"$/g, "");
      if (indent.length === 2) {
        section = undefined;
        if (key === "version") entry.version = value;
      } else if (indent.length === 4 && (section === "dependencies" || section === "optionalDependencies")) {
        entry.dependencies[key] = value;
        if (section === "optionalDependencies") entry.optional.add(key);
      }
    }
    for (const d of descriptors) out.set(d, entry);
  }
  return out;
}

function classicGraph(text: string, importers: Map<string, Record<string, unknown>>): ResolvedGraph {
  const entries = parseClassicLock(text);
  const nodes = new Map<string, GraphNode>();
  const keyOf = (e: { name: string; version: string }) => `${e.name}@${e.version}`;
  for (const e of new Set(entries.values())) {
    nodes.set(keyOf(e), { key: keyOf(e), name: e.name, version: e.version, declared: e.dependencies, children: new Map(), peers: new Set() });
  }
  const workspaceByName = new Map<string, string>();
  const importerKeys: string[] = [];
  for (const [path, manifest] of importers) {
    const key = `importer:${path}`;
    const declared = { ...asStrings(manifest.optionalDependencies), ...asStrings(manifest.devDependencies), ...asStrings(manifest.dependencies) };
    nodes.set(key, { key, name: typeof manifest.name === "string" ? manifest.name : path || "(root)", version: "0.0.0", declared, children: new Map(), importer: path });
    importerKeys.push(key);
    if (path !== "" && typeof manifest.name === "string") workspaceByName.set(manifest.name, key);
  }
  for (const node of nodes.values()) {
    for (const [dep, range] of Object.entries(node.declared ?? {})) {
      const entry = entries.get(`${dep}@${range}`);
      if (entry) node.children.set(dep, keyOf(entry));
      else if (workspaceByName.has(dep)) node.children.set(dep, workspaceByName.get(dep)!);
    }
  }
  return { nodes, importers: importerKeys };
}

/**
 * Berry keeps a parent's original descriptor in `dependencies` and keys the forced package by the
 * resolution's descriptor, so edges are rebuilt by applying the root `resolutions` the way Yarn does:
 * parent-scoped rules first, then descriptor-specific, then global.
 */
function berryGraph(lock: Record<string, unknown>, resolutions: Record<string, string>): ResolvedGraph {
  const nodes = new Map<string, GraphNode>();
  const byDescriptor = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const importers: string[] = [];
  // Raw descriptors (`npm:~3.0.0`) for edge lookup; `declared` holds plain ranges for the engine.
  const descriptors = new Map<string, Record<string, string>>();
  for (const [header, raw] of Object.entries(lock)) {
    if (header === "__metadata" || !isRecord(raw) || typeof raw.resolution !== "string") continue;
    const resolution = raw.resolution;
    const name = nameOf(resolution);
    const protocol = resolution.slice(name.length + 1);
    const workspace = /^workspace:(.*)$/.exec(protocol);
    const key = workspace ? `importer:${workspace[1] === "." ? "" : workspace[1]}` : resolution;
    const rawDeps = { ...asStrings(raw.peerDependencies), ...asStrings(raw.dependencies) };
    descriptors.set(key, rawDeps);
    const declared: Record<string, string> = {};
    for (const [dep, d] of Object.entries(rawDeps)) declared[dep] = registryRange(d) ?? d;
    const node: GraphNode = {
      key,
      name,
      version: workspace ? "0.0.0" : String(raw.version ?? "0.0.0"),
      declared,
      children: new Map(),
      peers: peerOnly({ dependencies: raw.dependencies, peerDependencies: raw.peerDependencies }),
    };
    if (workspace) {
      node.importer = workspace[1] === "." ? "" : workspace[1]!;
      importers.push(key);
    }
    nodes.set(key, node);
    for (const d of headerDescriptors(header)) byDescriptor.set(d, key);
    byName.set(name, [...(byName.get(name) ?? []), key]);
  }
  const rules = Object.entries(resolutions).map(([k, v]) => ({ key: parseResolutionKey(k), value: v }));
  const strip = (r: string | undefined) => r?.replace(/^npm:/, "");
  const redirect = (parent: GraphNode, dep: string, descriptor: string): string | undefined => {
    const requested = strip(descriptor);
    const applicable = rules.filter(({ key }) => {
      const segs = key.segments;
      const target = segs.at(-1)!;
      if (segs.length > 2 || segs.some((s) => s.name === "**") || target.name !== dep) return false;
      if (target.range !== undefined && strip(target.range) !== requested) return false;
      if (segs.length === 2) {
        const p = segs[0]!;
        if (p.name !== parent.name) return false;
        if (p.range !== undefined && !satisfies(parent.version, strip(p.range)!)) return false;
      }
      return true;
    });
    applicable.sort((a, b) => b.key.segments.length - a.key.segments.length || Number(b.key.segments.at(-1)!.range !== undefined) - Number(a.key.segments.at(-1)!.range !== undefined));
    const rule = applicable[0];
    if (!rule) return undefined;
    return rule.value.includes(":") ? rule.value : `npm:${rule.value}`;
  };
  for (const node of nodes.values()) {
    for (const [dep, descriptor] of Object.entries(descriptors.get(node.key) ?? {})) {
      const forced = redirect(node, dep, descriptor);
      let target = byDescriptor.get(`${dep}@${forced ?? descriptor}`) ?? byDescriptor.get(`${dep}@${descriptor}`);
      if (target === undefined && descriptor.startsWith("workspace:")) {
        target = [...nodes.values()].find((n) => n.importer !== undefined && n.name === dep)?.key;
      }
      if (target === undefined && byName.get(dep)?.length === 1) target = byName.get(dep)![0];
      if (target !== undefined) node.children.set(dep, target);
    }
  }
  return { nodes, importers };
}

/** Points Classic `resolved` URLs at another registry (snapshot replay only). */
async function retargetResolved(lockfile: string, registry: string): Promise<void> {
  const text = await readFile(lockfile, "utf8").catch(() => undefined);
  if (text === undefined) return;
  const base = registry.replace(/\/+$/, "");
  await writeFile(lockfile, text.replace(/^( {2}resolved ")https?:\/\/[^/"]+/gm, `$1${base}`));
}

/** Removes the named packages' lockfile blocks (every format), so the next install resolves them again. */
async function dropLockedPackages(lockfile: string, names: Set<string>): Promise<void> {
  const text = await readFile(lockfile, "utf8");
  const blocks = text.split(/\n(?=\S)/);
  const kept = blocks.filter((block) => {
    const header = block.split("\n")[0]!;
    if (header.startsWith("#") || header.startsWith("__metadata") || !header.trimEnd().endsWith(":")) return true;
    return !headerDescriptors(header).some((d) => names.has(nameOf(d)));
  });
  await writeFile(lockfile, kept.join("\n"));
}
