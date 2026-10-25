import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Project } from "../../src/adapters/adapter.ts";
import { NpmAdapter } from "../../src/adapters/npm/npm.ts";
import { plannedAdapters } from "../../src/adapters/planned.ts";
import { honoredLocations, parseOverrideKey, PnpmAdapter, splitSnapshotKey } from "../../src/adapters/pnpm/pnpm.ts";

const dirs: string[] = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "retire-overrides-unit-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  return dir;
}

const npmProject: Project = {
  ecosystem: "npm",
  dir: "",
  manifest: "package.json",
  lockfile: "package-lock.json",
  packageManager: { name: "npm", installed: "12.2.0" },
};

describe("npm overrides", () => {
  const manifest = {
    name: "app",
    version: "1.0.0",
    dependencies: { react: "^18.2.0" },
    overrides: {
      "tar-lite": "3.1.4",
      "bundler-kit": { ".": "2.4.1", "tar-lite": "3.2.0" },
      "@scope/thing@1": { "deep-dep": { "leaf@^2": "2.0.9" } },
      react: "$react",
      aliased: "npm:other@1.0.0",
      gitdep: "github:owner/repo",
    },
  };

  it("discovers global, parent-scoped, nested, version-selected and reference overrides", async () => {
    const dir = await tempDir({ "package.json": JSON.stringify(manifest, null, 2), "package-lock.json": "{}" });
    const { entries, unsupported } = await new NpmAdapter().readOverrides(npmProject, dir);
    assert.deepEqual(
      entries.map((e) => [e.selector, e.value]),
      [
        ["tar-lite", "3.1.4"],
        ["bundler-kit", "2.4.1"],
        ["bundler-kit > tar-lite", "3.2.0"],
        ["@scope/thing@1 > deep-dep > leaf@^2", "2.0.9"],
        ["react", "$react"],
      ],
    );
    assert.deepEqual(entries[3]!.scope, [{ name: "@scope/thing", range: "1" }, { name: "deep-dep" }]);
    assert.deepEqual(entries[3]!.target, { name: "leaf", range: "^2" });
    assert.deepEqual(unsupported.map((u) => u.selector), ["aliased", "gitdep"]);
  });

  it("removes one entry, prunes empty objects and preserves unrelated entries and indentation", async () => {
    const dir = await tempDir({ "package.json": JSON.stringify(manifest, null, 4) + "\n", "package-lock.json": "{}" });
    const adapter = new NpmAdapter();
    const { entries } = await adapter.readOverrides(npmProject, dir);
    await adapter.removeOverride(npmProject, dir, entries.find((e) => e.selector === "@scope/thing@1 > deep-dep > leaf@^2")!);
    await adapter.removeOverride(npmProject, dir, entries.find((e) => e.selector === "bundler-kit > tar-lite")!);
    const text = await readFile(join(dir, "package.json"), "utf8");
    assert.match(text, /^ {4}"name"/m);
    const data = JSON.parse(text) as { overrides: Record<string, unknown> };
    assert.deepEqual(data.overrides, { "tar-lite": "3.1.4", "bundler-kit": "2.4.1", react: "$react", aliased: "npm:other@1.0.0", gitdep: "github:owner/repo" });
  });

  it("writes a scoped override under an existing string entry for the parent", async () => {
    const dir = await tempDir({ "package.json": JSON.stringify({ name: "a", overrides: { "bundler-kit": "2.4.1" } }), "package-lock.json": "{}" });
    const written = await new NpmAdapter().writeOverride(npmProject, dir, { target: { name: "tar-lite" }, scope: [{ name: "bundler-kit" }], value: "3.2.0" });
    assert.deepEqual(written, { file: "package.json", selector: "bundler-kit > tar-lite" });
    const data = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(data.overrides, { "bundler-kit": { ".": "2.4.1", "tar-lite": "3.2.0" } });
  });

  it("applies nested overrides to descendants of the scope", () => {
    const adapter = new NpmAdapter();
    const entry = { ecosystem: "npm" as const, file: "package.json", project: "", selector: "a > c", keyPath: [], target: { name: "c" }, scope: [{ name: "a" }], value: "1.0.0" };
    const step = (name: string) => ({ name, version: "1.0.0" });
    assert.equal(adapter.overrideApplies(entry, { importer: "", steps: [step("a"), step("b"), step("c")] }), true);
    assert.equal(adapter.overrideApplies(entry, { importer: "", steps: [step("x"), step("c")] }), false);
  });
});

describe("pnpm overrides", () => {
  it("reads overrides from the location the pnpm version honors", () => {
    assert.deepEqual(honoredLocations("9.15.0"), ["package.json"]);
    assert.deepEqual(honoredLocations("10.34.6"), ["pnpm-workspace.yaml", "package.json"]);
    assert.deepEqual(honoredLocations("12.12.0"), ["pnpm-workspace.yaml"]);
  });

  it("parses parent and version selectors the way pnpm does", () => {
    assert.deepEqual(parseOverrideKey("foo"), { target: { name: "foo" }, scope: [] });
    assert.deepEqual(parseOverrideKey("foo@<1.2.3"), { target: { name: "foo", range: "<1.2.3" }, scope: [] });
    assert.deepEqual(parseOverrideKey("foo@>=1 <2"), { target: { name: "foo", range: ">=1 <2" }, scope: [] });
    assert.deepEqual(parseOverrideKey("bar@1>foo"), { target: { name: "foo" }, scope: [{ name: "bar", range: "1" }] });
    assert.deepEqual(parseOverrideKey("@s/bar>@s/foo@^2"), { target: { name: "@s/foo", range: "^2" }, scope: [{ name: "@s/bar" }] });
    assert.equal(parseOverrideKey("a>b>c"), null);
  });

  it("reports overrides the pinned pnpm ignores, removal entries and catalog values", async () => {
    const dir = await tempDir({
      "package.json": JSON.stringify({ name: "a", packageManager: "pnpm@12.12.0", pnpm: { overrides: { foo: "1.0.0" } } }),
      "pnpm-workspace.yaml": "overrides:\n  bar>baz: 2.0.0\n  qux: '-'\n  cat: 'catalog:'\n",
    });
    const project: Project = { ecosystem: "pnpm", dir: "", manifest: "package.json", lockfile: "pnpm-lock.yaml", packageManager: { name: "pnpm", installed: "12.12.0", pinned: "12.12.0" } };
    const { entries, unsupported } = await new PnpmAdapter().readOverrides(project, dir);
    assert.deepEqual(entries.map((e) => e.selector), ["bar>baz"]);
    assert.deepEqual(unsupported.map((u) => u.selector ?? u.file), ["qux", "cat", "package.json"]);
  });

  it("keeps comments and other settings when editing pnpm-workspace.yaml", async () => {
    const dir = await tempDir({ "package.json": "{}", "pnpm-workspace.yaml": "# workspace\npackages:\n  - apps/*\noverrides:\n  bar>baz: 2.0.0 # pinned\n" });
    const project: Project = { ecosystem: "pnpm", dir: "", manifest: "package.json", lockfile: "pnpm-lock.yaml", packageManager: { name: "pnpm", installed: "12.12.0" } };
    const adapter = new PnpmAdapter();
    await adapter.writeOverride(project, dir, { target: { name: "tar-lite" }, scope: [{ name: "bundler-kit" }], value: "3.2.0" });
    let text = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8");
    assert.match(text, /# workspace/);
    assert.match(text, /bundler-kit>tar-lite: 3\.2\.0/);
    const { entries } = await adapter.readOverrides(project, dir);
    for (const e of entries) await adapter.removeOverride(project, dir, e);
    text = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8");
    assert.equal(text, "# workspace\npackages:\n  - apps/*\n");
  });

  it("splits snapshot keys with peer suffixes", () => {
    assert.deepEqual(splitSnapshotKey("@s/a@1.2.3(react@18.2.0)"), { name: "@s/a", version: "1.2.3" });
  });
});

describe("planned adapters", () => {
  it("report native mechanisms explicitly instead of ignoring them", async () => {
    const dir = await tempDir({
      "go.mod": "module x\n\nrequire example.com/a v1.0.0 // indirect\nreplace example.com/a => example.com/b v1.0.1\n",
      "Cargo.toml": "[package]\nname='x'\n\n[patch.crates-io]\nfoo = { git = 'https://x' }\n",
      "pyproject.toml": "[tool.uv]\noverride-dependencies = ['a==1']\nconstraint-dependencies = ['b<2']\n",
      "pom.xml": "<project><dependencyManagement></dependencyManagement></project>",
      "Directory.Packages.props": "<Project><PropertyGroup><CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled></PropertyGroup></Project>",
      "build.gradle.kts": "dependencies { constraints { implementation(\"a:b:1\") } }",
      "package.json": JSON.stringify({ resolutions: { foo: "1.0.0" } }),
      "yarn.lock": "",
    });
    const found = (await Promise.all(plannedAdapters.map((a) => a.detect(dir)))).flatMap((r) => r.unsupported);
    assert.deepEqual(found.map((u) => u.ecosystem).sort(), ["cargo", "go", "gradle", "maven", "nuget", "uv", "uv", "yarn"]);
    assert.ok(found.every((u) => /planned, not implemented/.test(u.message)));
  });
});

describe("bun", () => {
  it("parses bun.lock's trailing commas without touching commas inside strings", async () => {
    const { parseBunLock, splitKey } = await import("../../src/adapters/bun/bun.ts");
    const lock = parseBunLock('{\n  "a": ["x,]", { "b": "c", },],\n  "d": "e\\",}",\n}\n');
    assert.deepEqual(lock, { a: ["x,]", { b: "c" }], d: 'e",}' });
    assert.deepEqual(splitKey("legacy-pack/@s/tar/tar-lite"), ["legacy-pack", "@s/tar", "tar-lite"]);
  });

  it("knows which Bun versions honor scoped overrides", async () => {
    const { bunHonorsScopedOverrides } = await import("../../src/adapters/bun/bun.ts");
    assert.equal(bunHonorsScopedOverrides("1.3.14"), false);
    assert.equal(bunHonorsScopedOverrides("1.4.0"), true);
  });
});
