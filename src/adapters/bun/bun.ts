import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import semver from "semver";
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
  selectorMatches,
  writeJsonDocument,
} from "../node-common.ts";
import { asStrings, deleteKeyPath, peerOnly, setKeyPath, UnsupportedLockfileError } from "../npm/npm.ts";

const FIELDS = ["overrides", "resolutions"] as const;

/**
 * Bun 1.4.0 added parent-scoped (`{ "parent": { "pkg": … } }`) and version-selected (`pkg@3`) overrides.
 * Every 1.3.x release silently ignores both and honors only plain global keys.
 */
export function bunHonorsScopedOverrides(version: string): boolean {
  const v = semver.coerce(version);
  return v !== null && semver.gte(v, "1.4.0");
}

/** Bun: `overrides` / `resolutions` in the root package.json, resolved through the text lockfile bun.lock. */
export class BunAdapter implements ImplementedAdapter {
  readonly id = "bun" as const;
  readonly support = "implemented" as const;
  readonly mechanisms =
    "`overrides` and `resolutions` in the root package.json: global keys on every Bun version; parent-scoped and version-selected keys on Bun 1.4+";
  readonly limitations =
    "Bun 1.3.x silently ignores parent-scoped and version-selected overrides, so they are reported as unsupported there and new overrides are global. A Bun nested override applies only to the direct parent. Requires the text lockfile bun.lock (bun.lockb is reported). `.` entries, `$name` references and Yarn-style resolution paths are reported, not evaluated.";

  async detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }> {
    const projects: Project[] = [];
    const unsupported: UnsupportedForm[] = [];
    for (const lockfile of await findFiles(repo, new Set(["bun.lock", "bun.lockb"]))) {
      const dir = posix.dirname(lockfile) === "." ? "" : posix.dirname(lockfile);
      if (lockfile.endsWith(".lockb")) {
        unsupported.push({
          ecosystem: "bun",
          file: lockfile,
          message: "binary bun.lockb is not readable; migrate with `bun install --save-text-lockfile`",
        });
        continue;
      }
      const manifest = projectPath(dir, "package.json");
      let data: Record<string, unknown>;
      try {
        data = (await readJsonDocument(join(repo, manifest))).data;
      } catch {
        unsupported.push({ ecosystem: "bun", file: lockfile, message: "lockfile has no readable package.json beside it" });
        continue;
      }
      const installed = (await cliVersion("bun", join(repo, dir))) ?? "0.0.0";
      const pinned = pinnedVersion(data, "bun");
      projects.push({
        ecosystem: "bun",
        dir,
        manifest,
        lockfile,
        packageManager: { name: "bun", installed, ...(pinned ? { pinned } : {}) },
      });
    }
    return { projects, unsupported };
  }

  preflight(project: Project): string[] {
    if (project.packageManager.installed === "0.0.0") return ["bun is not installed"];
    const mismatch = packageManagerMismatch("bun", project.packageManager.installed, project.packageManager.pinned);
    if (mismatch.length > 0) return mismatch;
    // Bun's override semantics changed within major 1, so a pin must also match on the 1.4 boundary.
    const pinned = project.packageManager.pinned;
    if (pinned && bunHonorsScopedOverrides(pinned) !== bunHonorsScopedOverrides(project.packageManager.installed)) {
      return [`bun@${pinned} is pinned but bun@${project.packageManager.installed} is installed, and they treat scoped overrides differently`];
    }
    return [];
  }

  private version(project: Project): string {
    return project.packageManager.pinned ?? project.packageManager.installed;
  }

  overrideCapabilities(project: Project): OverrideCapabilities {
    const scoped = bunHonorsScopedOverrides(this.version(project));
    return { parentScope: scoped, versionSelector: scoped };
  }

  async readOverrides(project: Project, dir: string) {
    const entries: OverrideEntry[] = [];
    const unsupported: UnsupportedForm[] = [];
    const root = (await readJsonDocument(join(dir, project.manifest))).data;
    const scoped = bunHonorsScopedOverrides(this.version(project));
    const file = project.manifest;
    const report = (selector: string, message: string) => unsupported.push({ ecosystem: "bun", file, selector, message });

    for (const field of FIELDS) {
      const block = root[field];
      if (block === undefined) continue;
      if (!isRecord(block)) {
        report(field, `${field} is not an object`);
        continue;
      }
      for (const [key, value] of Object.entries(block)) {
        if (key.includes("/") && !key.startsWith("@")) {
          report(key, "Yarn-style resolution paths are not supported by Bun");
          continue;
        }
        const target = parseSelector(key);
        if (typeof value === "string") {
          if (target.range && !scoped) {
            report(key, `bun ${this.version(project)} ignores version-selected override keys (supported from Bun 1.4.0)`);
            continue;
          }
          this.collect(entries, report, file, [field, key], target, [], value);
        } else if (isRecord(value)) {
          if (!scoped) {
            report(key, `bun ${this.version(project)} ignores parent-scoped overrides (supported from Bun 1.4.0)`);
            continue;
          }
          for (const [childKey, childValue] of Object.entries(value)) {
            if (childKey === ".") {
              report(`${key} > .`, "`.` self-override entries are not evaluated for Bun");
            } else if (typeof childValue !== "string") {
              report(`${key} > ${childKey}`, "Bun honors only one level of parent scoping");
            } else {
              this.collect(entries, report, file, [field, key, childKey], parseSelector(childKey), [target], childValue);
            }
          }
        } else {
          report(key, "override value is neither a string nor an object");
        }
      }
    }
    return { entries, unsupported };
  }

  private collect(
    entries: OverrideEntry[],
    report: (selector: string, message: string) => void,
    file: string,
    keyPath: string[],
    target: PackageSelector,
    scope: PackageSelector[],
    value: string,
  ): void {
    const selector = this.selectorFor(target, scope);
    if (value.startsWith("$")) {
      report(selector, `reference ${value} is not evaluated for Bun`);
      return;
    }
    if (value.startsWith("npm:") || parseSpec(target.name, value) === null) {
      report(selector, `override value "${value}" is not a registry version range (aliases, git, file and URL values are not evaluated)`);
      return;
    }
    entries.push({ ecosystem: "bun", file, project: "", selector, keyPath, target, scope, value });
  }

  selectorFor(target: PackageSelector, scope: PackageSelector[]): string {
    return [...scope, target].map(formatSelector).join(" > ");
  }

  overrideApplies(entry: OverrideEntry, path: DependencyPath): boolean {
    const last = path.steps.at(-1);
    if (!last || !selectorMatches(entry.target, last.name, last.version)) return false;
    if (entry.scope.length === 0) return true;
    // Unlike npm, a Bun nested override reaches only the scope's direct children.
    const parent = path.steps.at(-2);
    return parent !== undefined && selectorMatches(entry.scope[0]!, parent.name, parent.version);
  }

  async readGraph(project: Project, dir: string): Promise<ResolvedGraph> {
    const lock = parseBunLock(await readFile(join(dir, project.lockfile), "utf8"));
    const version = Number(lock.lockfileVersion);
    if (![1, 2, 3].includes(version) || !isRecord(lock.packages) || !isRecord(lock.workspaces)) {
      throw new UnsupportedLockfileError(
        `${project.lockfile} has lockfileVersion ${String(lock.lockfileVersion)}; only bun.lock versions 1 to 3 are supported`,
      );
    }
    const packages = lock.packages as Record<string, unknown>;
    const nodes = new Map<string, GraphNode>();
    const importers: string[] = [];
    // Bun keys a workspace package's own nested dependencies under its package name.
    const importerByName = new Map<string, string>();

    for (const [path, raw] of Object.entries(lock.workspaces as Record<string, unknown>)) {
      if (!isRecord(raw)) continue;
      const key = `importer:${path}`;
      const declared = {
        ...asStrings(raw.peerDependencies),
        ...asStrings(raw.optionalDependencies),
        ...asStrings(raw.devDependencies),
        ...asStrings(raw.dependencies),
      };
      nodes.set(key, { key, name: typeof raw.name === "string" ? raw.name : path, version: "0.0.0", declared, children: new Map(), importer: path });
      importers.push(key);
      if (path !== "" && typeof raw.name === "string") importerByName.set(raw.name, path);
    }

    for (const [key, raw] of Object.entries(packages)) {
      if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
      const ident = raw[0];
      const at = ident.indexOf("@", ident.startsWith("@") ? 1 : 0);
      const name = at === -1 ? ident : ident.slice(0, at);
      const version = at === -1 ? "0.0.0" : ident.slice(at + 1);
      if (version.startsWith("workspace:")) continue;
      const meta = raw.find((x: unknown) => isRecord(x)) as Record<string, unknown> | undefined;
      const declared = meta
        ? { ...asStrings(meta.peerDependencies), ...asStrings(meta.optionalDependencies), ...asStrings(meta.dependencies) }
        : {};
      nodes.set(key, { key, name, version, declared, children: new Map(), peers: meta ? peerOnly(meta) : new Set() });
    }

    const resolveFrom = (start: string[], dep: string): string | undefined => {
      for (let i = start.length; i >= 0; i--) {
        const candidate = [...start.slice(0, i), dep].join("/");
        const raw = packages[candidate];
        if (raw === undefined) continue;
        const ident = Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
        const ws = /@workspace:(.*)$/.exec(ident);
        if (ws) return `importer:${ws[1]}`;
        return candidate;
      }
      return undefined;
    };
    for (const node of nodes.values()) {
      const start =
        node.importer !== undefined
          ? node.importer === ""
            ? []
            : [nameForImporter(importerByName, node.importer) ?? node.name]
          : splitKey(node.key);
      for (const dep of Object.keys(node.declared ?? {})) {
        const target = resolveFrom(start, dep);
        if (target !== undefined && nodes.has(target)) node.children.set(dep, target);
      }
    }
    return { nodes, importers };
  }

  /** Why locked versions may be kept during a removal, when this Bun cannot refresh selectively. */
  refreshLimitation(project: Project): string | undefined {
    if (bunHonorsScopedOverrides(this.version(project))) return undefined;
    return `bun ${this.version(project)} cannot refresh single packages, so locked versions inside declared ranges were kept; safety rests on the parent-constraint and per-copy checks`;
  }

  async resolve(project: Project, dir: string, options: ResolveOptions): Promise<void> {
    const cwd = join(dir, project.dir);
    const cache = options.registry ? await mkdtemp(join(tmpdir(), "retire-overrides-bun-cache-")) : undefined;
    const env: Record<string, string | undefined> = {};
    if (options.registry) {
      env.BUN_CONFIG_REGISTRY = options.registry;
      env.BUN_INSTALL_CACHE_DIR = cache;
    }
    const flags = ["--lockfile-only", "--ignore-scripts", "--no-progress", "--no-summary"];
    const targeted = bunHonorsScopedOverrides(this.version(project));
    try {
      if (options.refresh.length > 0 && !targeted && options.fullRefreshAllowed) {
        // Bun 1.3 has no selective refresh: a missing lockfile entry re-resolves the whole tree.
        await dropLockedPackages(join(dir, project.lockfile), new Set(options.refresh));
      }
      await run("bun", ["install", ...flags], { cwd, env });
      if (options.refresh.length > 0 && targeted) {
        // `bun update <pkg>` re-resolves just that package and its dependencies. It may rewrite a
        // direct dependency's spec, so manifests are restored and the lockfile re-synced afterwards.
        const manifests = await findFiles(cwd, new Set(["package.json"]));
        const saved = await Promise.all(manifests.map(async (m) => [m, await readFile(join(cwd, m), "utf8")] as const));
        await run("bun", ["update", ...flags, ...options.refresh], { cwd, env });
        for (const [m, text] of saved) await writeFile(join(cwd, m), text);
        await run("bun", ["install", ...flags], { cwd, env });
      }
    } finally {
      if (cache) await rm(cache, { recursive: true, force: true });
    }
  }

  async removeOverride(_project: Project, dir: string, entry: OverrideEntry): Promise<void> {
    const path = join(dir, entry.file);
    const doc = await readJsonDocument(path);
    deleteKeyPath(doc.data, entry.keyPath);
    await writeJsonDocument(path, doc);
  }

  async writeOverride(project: Project, dir: string, write: OverrideWrite): Promise<{ file: string; selector: string }> {
    const path = join(dir, project.manifest);
    const doc = await readJsonDocument(path);
    if (write.replaces) {
      setKeyPath(doc.data, write.replaces.keyPath, write.value);
      await writeJsonDocument(path, doc);
      return { file: write.replaces.file, selector: write.replaces.selector };
    }
    // Add to whichever field the project already uses; `overrides` otherwise.
    const field = !isRecord(doc.data.overrides) && isRecord(doc.data.resolutions) ? "resolutions" : "overrides";
    if (!isRecord(doc.data[field])) doc.data[field] = {};
    let node = doc.data[field] as Record<string, unknown>;
    const parent = write.scope.at(-1);
    if (parent) {
      const key = formatSelector(parent);
      if (!isRecord(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[formatSelector(write.target)] = write.value;
    await writeJsonDocument(path, doc);
    return { file: project.manifest, selector: this.selectorFor(write.target, parent ? [parent] : []) };
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

function nameForImporter(byName: Map<string, string>, path: string): string | undefined {
  for (const [name, p] of byName) if (p === path) return name;
  return undefined;
}

/** `a/@s/b/c` → ["a", "@s/b", "c"]. */
export function splitKey(key: string): string[] {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.startsWith("@") && i + 1 < parts.length) {
      out.push(`${parts[i]}/${parts[i + 1]}`);
      i++;
    } else {
      out.push(parts[i]!);
    }
  }
  return out;
}

/** bun.lock is JSON with trailing commas. Strip those (outside strings) and parse. */
export function parseBunLock(text: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  const parsed: unknown = JSON.parse(out);
  return isRecord(parsed) ? parsed : {};
}

/** Removes every locked copy of the named packages so `bun install` resolves them again. */
async function dropLockedPackages(lockfile: string, names: Set<string>): Promise<void> {
  const lock = parseBunLock(await readFile(lockfile, "utf8"));
  const packages = lock.packages;
  if (!isRecord(packages)) return;
  for (const [key, raw] of Object.entries(packages)) {
    const ident = Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
    const at = ident.indexOf("@", ident.startsWith("@") ? 1 : 0);
    const real = at === -1 ? ident : ident.slice(0, at);
    if (names.has(splitKey(key).at(-1)!) || names.has(real)) delete packages[key];
  }
  await writeFile(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
}
