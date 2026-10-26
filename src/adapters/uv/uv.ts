import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { parse } from "smol-toml";
import { run } from "../../exec.ts";
import { normalizeName, PEP440, parseRequirement } from "../../pep440.ts";
import type { DependencyPath, GraphNode, OverrideEntry, PackageSelector, ResolvedGraph, UnsupportedForm } from "../../types.ts";
import type { ImplementedAdapter, OverrideCapabilities, OverrideWrite, Project, ResolveOptions } from "../adapter.ts";
import { findFiles, isRecord, projectPath } from "../node-common.ts";
import { UnsupportedLockfileError } from "../npm/npm.ts";
import { appendToArray, arrayValues, dropEmptyArray, lineOf, removeFromArray, replaceInArray } from "./toml-edit.ts";

const UV_TABLE = ["tool", "uv"];
const OVERRIDES = "override-dependencies";
const CONSTRAINTS = "constraint-dependencies";
const CONSTRAINT_SUFFIX = " (constraint)";

/**
 * uv: `override-dependencies` and `constraint-dependencies` under [tool.uv] in pyproject.toml, resolved
 * through uv.lock. Overrides replace every requirement on a package; constraints only narrow what
 * resolution may pick. Both are global: uv has no parent-scoped form.
 */
export class UvAdapter implements ImplementedAdapter {
  readonly id = "uv" as const;
  readonly support = "implemented" as const;
  readonly mechanisms = "`override-dependencies` and `constraint-dependencies` under [tool.uv] in pyproject.toml, with uv.lock";
  readonly limitations =
    "Overrides and constraints are global (uv has no parent scope); entries with environment markers, URL requirements, build-constraint-dependencies and custom package indexes are reported, not evaluated. Ordinary constraints are never removed unless retire-overrides created them or `manage` opts them in.";

  async detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }> {
    const projects: Project[] = [];
    const unsupported: UnsupportedForm[] = [];
    const locks = new Set(await findFiles(repo, new Set(["uv.lock"])));
    for (const lockfile of locks) {
      const dir = posix.dirname(lockfile) === "." ? "" : posix.dirname(lockfile);
      const manifest = projectPath(dir, "pyproject.toml");
      const installed = (await uvVersion(join(repo, dir))) ?? "0.0.0";
      let pinned: string | undefined;
      try {
        const doc = parse(await readFile(join(repo, manifest), "utf8"));
        const required = isRecord(doc.tool) && isRecord(doc.tool.uv) ? doc.tool.uv["required-version"] : undefined;
        if (typeof required === "string") pinned = required;
      } catch {
        unsupported.push({ ecosystem: "uv", file: lockfile, message: "uv.lock has no readable pyproject.toml beside it" });
        continue;
      }
      projects.push({ ecosystem: "uv", dir, manifest, lockfile, packageManager: { name: "uv", installed, ...(pinned ? { pinned } : {}) } });
    }
    // Overrides without a lockfile can't be evaluated; say so instead of skipping them.
    for (const manifest of await findFiles(repo, new Set(["pyproject.toml"]))) {
      const dir = posix.dirname(manifest) === "." ? "" : posix.dirname(manifest);
      if (locks.has(projectPath(dir, "uv.lock"))) continue;
      const text = await readFile(join(repo, manifest), "utf8").catch(() => "");
      if (/^\s*(override|constraint)-dependencies\s*=/m.test(text) && !(await isWorkspaceMember(repo, dir, locks))) {
        unsupported.push({ ecosystem: "uv", file: manifest, message: "uv overrides or constraints found without a uv.lock; run `uv lock` so they can be evaluated" });
      }
    }
    return { projects, unsupported };
  }

  preflight(project: Project): string[] {
    const { installed, pinned } = project.packageManager;
    if (installed === "0.0.0") return ["uv is not installed"];
    if (pinned && !PEP440.satisfies(installed, pinned)) {
      return [`[tool.uv] required-version is ${pinned} but uv ${installed} is installed`];
    }
    return [];
  }

  overrideCapabilities(): OverrideCapabilities {
    return { parentScope: false, versionSelector: false };
  }

  async readOverrides(project: Project, dir: string) {
    const entries: OverrideEntry[] = [];
    const unsupported: UnsupportedForm[] = [];
    const file = project.manifest;
    const text = await readFile(join(dir, file), "utf8");
    const doc = parse(text);
    const uv = isRecord(doc.tool) && isRecord(doc.tool.uv) ? doc.tool.uv : {};
    // Metadata is read from PyPI; resolving against another index would compare different worlds.
    if (uv.index !== undefined || uv["index-url"] !== undefined || uv["extra-index-url"] !== undefined) {
      throw new Error("custom package indexes ([[tool.uv.index]], index-url, extra-index-url) are not supported yet; results would not match what uv resolves");
    }
    if (uv["build-constraint-dependencies"] !== undefined) {
      unsupported.push({ ecosystem: "uv", file, selector: "build-constraint-dependencies", message: "build constraints affect build environments only and are not evaluated" });
    }
    for (const key of [OVERRIDES, CONSTRAINTS] as const) {
      for (const raw of arrayValues(text, UV_TABLE, key) ?? []) {
        const req = parseRequirement(raw);
        const label = key === OVERRIDES ? "override" : "constraint";
        if (req === null) {
          unsupported.push({ ecosystem: "uv", file, selector: raw, message: `${label} "${raw}" is not a version requirement (URL and path requirements are not evaluated)` });
          continue;
        }
        if (req.marker) {
          unsupported.push({ ecosystem: "uv", file, selector: raw, message: `${label} "${raw}" applies only under an environment marker, which is not evaluated` });
          continue;
        }
        const selector = key === OVERRIDES ? req.name : `${req.name}${CONSTRAINT_SUFFIX}`;
        entries.push({
          ecosystem: "uv",
          file,
          project: project.dir,
          selector,
          keyPath: [...UV_TABLE, key, raw],
          target: { name: req.name },
          scope: [],
          value: req.specifier,
        });
      }
    }
    return { entries, unsupported };
  }

  selectorFor(target: PackageSelector): string {
    return normalizeName(target.name);
  }

  overrideApplies(entry: OverrideEntry, path: DependencyPath): boolean {
    const last = path.steps.at(-1);
    return last !== undefined && normalizeName(last.name) === normalizeName(entry.target.name);
  }

  async readGraph(project: Project, dir: string): Promise<ResolvedGraph> {
    const lock = parse(await readFile(join(dir, project.lockfile), "utf8"));
    if (lock.version !== 1 || !Array.isArray(lock.package)) {
      throw new UnsupportedLockfileError(`${project.lockfile} has version ${String(lock.version)}; only uv.lock version 1 is supported`);
    }
    const nodes = new Map<string, GraphNode>();
    const importers: string[] = [];
    const byName = new Map<string, string[]>();
    const raws = (lock.package as unknown[]).filter(isRecord);
    for (const raw of raws) {
      const name = normalizeName(String(raw.name));
      const version = typeof raw.version === "string" ? raw.version : "0.0.0";
      const source = isRecord(raw.source) ? raw.source : {};
      const local = (["virtual", "editable", "directory"] as const).find((k) => typeof source[k] === "string");
      const node: GraphNode = { key: `${name}@${version}`, name, version, children: new Map() };
      if (local) {
        const path = posix.normalize(String(source[local]));
        node.importer = path === "." ? "" : path;
        node.key = `importer:${node.importer}`;
        node.declared = requiresDist(raw);
        importers.push(node.key);
      }
      nodes.set(node.key, node);
      byName.set(name, [...(byName.get(name) ?? []), node.key]);
    }
    for (const raw of raws) {
      const name = normalizeName(String(raw.name));
      const version = typeof raw.version === "string" ? raw.version : "0.0.0";
      const node = [...nodes.values()].find((n) => n.name === name && (n.version === version || n.importer !== undefined));
      if (!node) continue;
      const deps = [
        ...(Array.isArray(raw.dependencies) ? raw.dependencies : []),
        ...Object.values(isRecord(raw["optional-dependencies"]) ? raw["optional-dependencies"] : {}).flat(),
        ...Object.values(isRecord(raw["dev-dependencies"]) ? raw["dev-dependencies"] : {}).flat(),
      ].filter(isRecord);
      for (const dep of deps) {
        const depName = normalizeName(String(dep.name));
        const candidates = byName.get(depName) ?? [];
        const target =
          typeof dep.version === "string" ? candidates.find((k) => nodes.get(k)!.version === dep.version) : candidates.length === 1 ? candidates[0] : undefined;
        if (target) node.children.set(depName, target);
      }
    }
    return { nodes, importers };
  }

  async resolve(project: Project, dir: string, options: ResolveOptions): Promise<void> {
    const cwd = join(dir, project.dir);
    // --no-build: resolve from published metadata only, never building (and so running) a package.
    const args = ["lock", "--no-build", "--no-progress", ...options.refresh.flatMap((p) => ["--upgrade-package", p])];
    const cache = options.registry ? await mkdtemp(join(tmpdir(), "retire-overrides-uv-cache-")) : undefined;
    const env: Record<string, string | undefined> = { UV_NO_PROGRESS: "1" };
    if (options.registry) {
      args.push("--default-index", `${options.registry.replace(/\/+$/, "")}/simple`);
      env.UV_CACHE_DIR = cache;
    }
    try {
      await run("uv", args, { cwd, env });
    } finally {
      if (cache) await rm(cache, { recursive: true, force: true });
    }
  }

  async removeOverride(_project: Project, dir: string, entry: OverrideEntry): Promise<void> {
    const path = join(dir, entry.file);
    const key = entry.keyPath[2]!;
    let text = removeFromArray(await readFile(path, "utf8"), UV_TABLE, key, entry.keyPath[3]!);
    text = dropEmptyArray(text, UV_TABLE, key);
    await writeFile(path, text);
  }

  async writeOverride(project: Project, dir: string, write: OverrideWrite): Promise<{ file: string; selector: string }> {
    const name = normalizeName(write.target.name);
    const spec = PEP440.valid(write.value) ? `==${write.value}` : write.value;
    const path = join(dir, write.replaces?.file ?? project.manifest);
    const text = await readFile(path, "utf8");
    if (write.replaces) {
      const key = write.replaces.keyPath[2]!;
      await writeFile(path, replaceInArray(text, UV_TABLE, key, write.replaces.keyPath[3]!, `${name}${spec}`));
      return { file: write.replaces.file, selector: write.replaces.selector };
    }
    await writeFile(path, appendToArray(text, UV_TABLE, OVERRIDES, `${name}${spec}`));
    return { file: project.manifest, selector: name };
  }

  async directSpec(project: Project, dir: string, importer: string, name: string): Promise<string | undefined> {
    const text = await readFile(join(dir, importerManifest(project, importer)), "utf8");
    const raw = (arrayValues(text, ["project"], "dependencies") ?? []).find((r) => parseRequirement(r)?.name === normalizeName(name));
    return raw === undefined ? undefined : parseRequirement(raw)!.specifier;
  }

  async setDependencySpec(project: Project, dir: string, importer: string, name: string, spec: string): Promise<void> {
    const path = join(dir, importerManifest(project, importer));
    const text = await readFile(path, "utf8");
    const raw = (arrayValues(text, ["project"], "dependencies") ?? []).find((r) => parseRequirement(r)?.name === normalizeName(name));
    if (raw === undefined) throw new Error(`${name} is not a [project] dependency of ${importer || "the root project"}`);
    const req = parseRequirement(raw)!;
    // Keep the name as written, its extras and its marker; change only the version specifier.
    const written = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(raw)![1]!;
    const extras = req.extras.length > 0 ? `[${req.extras.join(",")}]` : "";
    const updated = `${written}${extras}${spec}${req.marker ? `; ${req.marker}` : ""}`;
    await writeFile(path, replaceInArray(text, ["project"], "dependencies", raw, updated));
  }

  async locate(_project: Project, dir: string, entry: OverrideEntry): Promise<number | undefined> {
    return lineOf(await readFile(join(dir, entry.file), "utf8"), UV_TABLE, entry.keyPath[2]!, entry.keyPath[3]!);
  }
}

function importerManifest(project: Project, importer: string): string {
  return projectPath(project.dir, importer === "" ? "pyproject.toml" : posix.join(importer, "pyproject.toml"));
}

/** An importer's declared ranges from `[package.metadata]`, keyed by normalized name; alternatives are unions. */
function requiresDist(raw: Record<string, unknown>): Record<string, string> {
  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const lists = [
    ...(Array.isArray(meta["requires-dist"]) ? meta["requires-dist"] : []),
    ...Object.values(isRecord(meta["requires-dev"]) ? meta["requires-dev"] : {}).flat(),
  ].filter(isRecord);
  const alternatives = new Map<string, string[]>();
  for (const r of lists) {
    const name = normalizeName(String(r.name));
    const list = alternatives.get(name) ?? [];
    list.push(typeof r.specifier === "string" && r.specifier !== "" ? r.specifier : ">=0");
    alternatives.set(name, list);
  }
  return Object.fromEntries([...alternatives].map(([n, l]) => [n, [...new Set(l)].join(" || ")]));
}

async function uvVersion(cwd: string): Promise<string | undefined> {
  try {
    const result = await run("uv", ["--version"], { cwd, allowFailure: true });
    return result.code === 0 ? /uv (\S+)/.exec(result.stdout)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Workspace members share the root's uv.lock; they are not projects of their own. */
async function isWorkspaceMember(repo: string, dir: string, locks: Set<string>): Promise<boolean> {
  let parent = dir;
  while (parent !== "") {
    parent = posix.dirname(parent) === "." ? "" : posix.dirname(parent);
    if (locks.has(projectPath(parent, "uv.lock"))) return true;
  }
  return false;
}
