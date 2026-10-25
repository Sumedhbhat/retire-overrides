import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import semver from "semver";
import { parse as parseYaml, parseDocument } from "yaml";
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
import { UnsupportedLockfileError } from "../npm/npm.ts";

type Location = "pnpm-workspace.yaml" | "package.json";

/**
 * Where a pnpm version reads `overrides` from. pnpm 9 and earlier read `pnpm.overrides` in
 * package.json; pnpm 10 reads both; pnpm 11 and later read only pnpm-workspace.yaml.
 */
export function honoredLocations(pnpmVersion: string): Location[] {
  const major = semver.coerce(pnpmVersion)?.major ?? 0;
  if (major >= 11) return ["pnpm-workspace.yaml"];
  if (major === 10) return ["pnpm-workspace.yaml", "package.json"];
  return ["package.json"];
}

// pnpm's own delimiter rule: a `>` that does not follow a space, `|` or `@` separates parent from child.
const PARENT_DELIMITER = /[^ |@]>/;

export function parseOverrideKey(key: string): { target: PackageSelector; scope: PackageSelector[] } | null {
  const m = PARENT_DELIMITER.exec(key);
  if (!m) return { target: parseSelector(key), scope: [] };
  const parent = key.slice(0, m.index + 1);
  const child = key.slice(m.index + 2);
  if (PARENT_DELIMITER.test(child)) return null;
  return { target: parseSelector(child), scope: [parseSelector(parent)] };
}

/** pnpm: `overrides` in pnpm-workspace.yaml or package.json (by version), resolved through pnpm-lock.yaml v9. */
export class PnpmAdapter implements ImplementedAdapter {
  readonly id = "pnpm" as const;
  readonly support = "implemented" as const;
  readonly mechanisms =
    "`overrides` in pnpm-workspace.yaml (pnpm 10+) or `pnpm.overrides` in package.json (pnpm 10 and earlier), with `parent>child` and version selectors";
  readonly limitations =
    "Reads the location the pinned pnpm version honors and reports the other as unsupported. Requires lockfileVersion 9.0. Removal (`-`), catalog, link and file overrides, multi-level parent selectors and .pnpmfile.cjs hooks are reported, not evaluated.";

  async detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }> {
    const projects: Project[] = [];
    const unsupported: UnsupportedForm[] = [];
    for (const lockfile of await findFiles(repo, new Set(["pnpm-lock.yaml"]))) {
      const dir = posix.dirname(lockfile) === "." ? "" : posix.dirname(lockfile);
      const manifest = projectPath(dir, "package.json");
      let data: Record<string, unknown>;
      try {
        data = (await readJsonDocument(join(repo, manifest))).data;
      } catch {
        unsupported.push({ ecosystem: "pnpm", file: lockfile, message: "lockfile has no readable package.json beside it" });
        continue;
      }
      const installed = (await cliVersion("pnpm", join(repo, dir))) ?? "0.0.0";
      const pinned = pinnedVersion(data, "pnpm");
      projects.push({
        ecosystem: "pnpm",
        dir,
        manifest,
        lockfile,
        packageManager: { name: "pnpm", installed, ...(pinned ? { pinned } : {}) },
      });
      if (await exists(join(repo, projectPath(dir, ".pnpmfile.cjs")))) {
        unsupported.push({
          ecosystem: "pnpm",
          file: projectPath(dir, ".pnpmfile.cjs"),
          message: "readPackage hooks can rewrite dependencies; they are not inspected, so results assume the hook does not touch affected packages",
        });
      }
    }
    return { projects, unsupported };
  }

  preflight(project: Project): string[] {
    if (project.packageManager.installed === "0.0.0") return ["pnpm is not installed"];
    return packageManagerMismatch("pnpm", project.packageManager.installed, project.packageManager.pinned);
  }

  private version(project: Project): string {
    return project.packageManager.pinned ?? project.packageManager.installed;
  }

  async readOverrides(project: Project, dir: string) {
    const entries: OverrideEntry[] = [];
    const unsupported: UnsupportedForm[] = [];
    const honored = honoredLocations(this.version(project));
    for (const location of ["pnpm-workspace.yaml", "package.json"] as const) {
      const file = projectPath(project.dir, location);
      const overrides = await readOverridesAt(join(dir, file), location);
      if (overrides === undefined) continue;
      if (!honored.includes(location)) {
        unsupported.push({
          ecosystem: "pnpm",
          file,
          message: `pnpm ${this.version(project)} ignores overrides in ${location === "package.json" ? "package.json (pnpm.overrides)" : "pnpm-workspace.yaml"}; move them to ${honored.join(" or ")}`,
        });
        continue;
      }
      const prefix = location === "package.json" ? ["pnpm", "overrides"] : ["overrides"];
      for (const [key, raw] of Object.entries(overrides)) {
        const value = typeof raw === "number" ? String(raw) : raw;
        if (typeof value !== "string") {
          unsupported.push({ ecosystem: "pnpm", file, selector: key, message: "override value is not a string" });
          continue;
        }
        const parsed = parseOverrideKey(key);
        if (parsed === null) {
          unsupported.push({ ecosystem: "pnpm", file, selector: key, message: "multi-level parent selectors are not supported by pnpm" });
          continue;
        }
        if (value === "-") {
          unsupported.push({ ecosystem: "pnpm", file, selector: key, message: 'override "-" removes the dependency; it is not a version override' });
          continue;
        }
        const effective = value.startsWith("$") ? "*" : value;
        if (effective.startsWith("npm:") || parseSpec(parsed.target.name, effective) === null) {
          unsupported.push({
            ecosystem: "pnpm",
            file,
            selector: key,
            message: `override value "${value}" is not a registry version range (catalog, link, file, git and alias values are not evaluated)`,
          });
          continue;
        }
        entries.push({
          ecosystem: "pnpm",
          file,
          project: project.dir,
          selector: key,
          keyPath: [...prefix, key],
          target: parsed.target,
          scope: parsed.scope,
          value,
        });
      }
    }
    return { entries, unsupported };
  }

  selectorFor(target: PackageSelector, scope: PackageSelector[]): string {
    if (scope.length === 0) return formatSelector(target);
    return `${formatSelector(scope.at(-1)!)}>${formatSelector(target)}`;
  }

  overrideApplies(entry: OverrideEntry, path: DependencyPath): boolean {
    const last = path.steps.at(-1);
    if (!last || !selectorMatches(entry.target, last.name, last.version)) return false;
    if (entry.scope.length === 0) return true;
    const parent = path.steps.at(-2);
    return parent !== undefined && selectorMatches(entry.scope[0]!, parent.name, parent.version);
  }

  async readGraph(project: Project, dir: string): Promise<ResolvedGraph> {
    const lock = parseYaml(await readFile(join(dir, project.lockfile), "utf8")) as Record<string, unknown> | null;
    if (!isRecord(lock) || String(lock.lockfileVersion) !== "9.0") {
      throw new UnsupportedLockfileError(
        `${project.lockfile} has lockfileVersion ${String(lock?.lockfileVersion)}; only lockfileVersion 9.0 (pnpm 9 and later) is supported`,
      );
    }
    const nodes = new Map<string, GraphNode>();
    const importers: string[] = [];
    const importerMap = isRecord(lock.importers) ? lock.importers : {};
    const snapshots = isRecord(lock.snapshots) ? lock.snapshots : {};

    for (const [id, raw] of Object.entries(importerMap)) {
      const key = `importer:${id}`;
      const declared: Record<string, string> = {};
      const children = new Map<string, string>();
      if (isRecord(raw)) {
        for (const field of ["optionalDependencies", "devDependencies", "dependencies"]) {
          const deps = raw[field];
          if (!isRecord(deps)) continue;
          for (const [name, dep] of Object.entries(deps)) {
            if (!isRecord(dep)) continue;
            if (typeof dep.specifier === "string") declared[name] = dep.specifier;
            if (typeof dep.version === "string") children.set(name, refToKey(name, dep.version, id));
          }
        }
      }
      nodes.set(key, { key, name: id, version: "0.0.0", declared, children, importer: id === "." ? "" : id });
      importers.push(key);
    }
    for (const [key, raw] of Object.entries(snapshots)) {
      const { name, version } = splitSnapshotKey(key);
      const children = new Map<string, string>();
      if (isRecord(raw)) {
        for (const field of ["optionalDependencies", "dependencies"]) {
          const deps = raw[field];
          if (!isRecord(deps)) continue;
          for (const [dep, ref] of Object.entries(deps)) {
            if (typeof ref === "string") children.set(dep, refToKey(dep, ref, "."));
          }
        }
      }
      nodes.set(key, { key, name, version, children });
    }
    for (const node of nodes.values()) {
      for (const [dep, target] of node.children) if (!nodes.has(target)) node.children.delete(dep);
    }
    return { nodes, importers };
  }

  async resolve(project: Project, dir: string, options: ResolveOptions): Promise<void> {
    const cwd = join(dir, project.dir);
    const common = ["--lockfile-only", "--ignore-scripts", "--config.confirm-modules-purge=false"];
    const store = options.registry ? await mkdtemp(join(tmpdir(), "retire-overrides-pnpm-")) : undefined;
    if (options.registry) common.push(`--config.registry=${options.registry}`, `--config.cache-dir=${store}/cache`, `--config.store-dir=${store}/store`);
    const env = { npm_config_registry: undefined, CI: "true" };
    try {
      await run("pnpm", ["install", "--no-frozen-lockfile", ...common], { cwd, env });
      if (options.refresh.length > 0) {
        // `update` without --latest stays inside declared ranges; --no-save keeps manifests untouched.
        // --recursive is needed to reach workspace importers, but pnpm 10 silently updates nothing
        // when it is passed outside a workspace, so it is only added for multi-importer lockfiles.
        const recursive = (await importerCount(join(dir, project.lockfile))) > 1 ? ["--recursive"] : [];
        await run("pnpm", ["update", ...recursive, "--depth", "Infinity", "--no-save", ...common, ...options.refresh], { cwd, env });
      }
    } finally {
      if (store) await rm(store, { recursive: true, force: true });
    }
  }

  async removeOverride(project: Project, dir: string, entry: OverrideEntry): Promise<void> {
    const path = join(dir, entry.file);
    if (entry.file.endsWith("package.json")) {
      const doc = await readJsonDocument(path);
      const pnpm = doc.data.pnpm;
      if (isRecord(pnpm) && isRecord(pnpm.overrides)) {
        delete pnpm.overrides[entry.keyPath.at(-1)!];
        if (Object.keys(pnpm.overrides).length === 0) delete pnpm.overrides;
        if (Object.keys(pnpm).length === 0) delete doc.data.pnpm;
      }
      await writeJsonDocument(path, doc);
      return;
    }
    const doc = parseDocument(await readFile(path, "utf8"));
    doc.deleteIn(["overrides", entry.keyPath.at(-1)!]);
    const overrides = doc.get("overrides") as { items?: unknown[] } | undefined;
    if (overrides && Array.isArray(overrides.items) && overrides.items.length === 0) doc.delete("overrides");
    const text = String(doc);
    if (text.trim() === "" || text.trim() === "{}") await unlink(path);
    else await writeFile(path, text);
  }

  overrideCapabilities(): OverrideCapabilities {
    return { parentScope: true, versionSelector: true };
  }

  async writeOverride(project: Project, dir: string, write: OverrideWrite): Promise<{ file: string; selector: string }> {
    const key = write.replaces?.keyPath.at(-1) ?? this.selectorFor(write.target, write.scope);
    const file = write.replaces?.file ?? (await this.writeLocation(project, dir));
    const path = join(dir, file);
    if (file.endsWith("package.json")) {
      const doc = await readJsonDocument(path);
      if (!isRecord(doc.data.pnpm)) doc.data.pnpm = {};
      const pnpm = doc.data.pnpm as Record<string, unknown>;
      if (!isRecord(pnpm.overrides)) pnpm.overrides = {};
      (pnpm.overrides as Record<string, unknown>)[key] = write.value;
      await writeJsonDocument(path, doc);
    } else {
      const text = await readFile(path, "utf8").catch(() => "");
      const doc = parseDocument(text);
      doc.setIn(["overrides", key], write.value);
      await writeFile(path, String(doc));
    }
    return { file, selector: key };
  }

  /** Adds to whichever honored file already has overrides; otherwise the one this pnpm version prefers. */
  private async writeLocation(project: Project, dir: string): Promise<string> {
    const honored = honoredLocations(this.version(project));
    for (const location of honored) {
      const file = projectPath(project.dir, location);
      if ((await readOverridesAt(join(dir, file), location)) !== undefined) return file;
    }
    return projectPath(project.dir, honored[0]!);
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
  return projectPath(project.dir, importer === "" || importer === "." ? "package.json" : posix.join(importer, "package.json"));
}

async function readOverridesAt(path: string, location: Location): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  if (location === "package.json") {
    const data = JSON.parse(text) as Record<string, unknown>;
    return isRecord(data.pnpm) && isRecord(data.pnpm.overrides) ? data.pnpm.overrides : undefined;
  }
  const data = parseYaml(text) as unknown;
  return isRecord(data) && isRecord(data.overrides) ? data.overrides : undefined;
}

async function importerCount(lockfile: string): Promise<number> {
  const lock = parseYaml(await readFile(lockfile, "utf8")) as unknown;
  return isRecord(lock) && isRecord(lock.importers) ? Object.keys(lock.importers).length : 1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `name@1.2.3(peer@2.0.0)` → name `name`, version `1.2.3`. */
export function splitSnapshotKey(key: string): { name: string; version: string } {
  const base = key.includes("(") ? key.slice(0, key.indexOf("(")) : key;
  const at = base.lastIndexOf("@");
  if (at <= 0) return { name: base, version: "0.0.0" };
  return { name: base.slice(0, at), version: base.slice(at + 1) };
}

/** Turns a lockfile dependency reference into a node key. */
function refToKey(name: string, ref: string, importerId: string): string {
  if (ref.startsWith("link:")) {
    const target = posix.normalize(posix.join(importerId === "." ? "" : importerId, ref.slice(5))) || ".";
    return `importer:${target === "" ? "." : target}`;
  }
  // Aliases are recorded as the real `name@version`.
  if (/^(@[^/]+\/)?[^@(]+@/.test(ref) && !/^\d/.test(ref)) return ref;
  return `${name}@${ref}`;
}
