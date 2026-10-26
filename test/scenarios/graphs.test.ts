import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { bunHonorsScopedOverrides } from "../../src/adapters/bun/bun.ts";
import { yarnLine } from "../../src/adapters/yarn/yarn.ts";
import { type FixtureRepo, fixtureRepo, installedVersion, type Manager } from "../helpers/scenario.ts";
import { appManifest, GHSA, GHSA_TWO_BRANCH, universe } from "../helpers/universe.ts";

const repos: FixtureRepo[] = [];
const bunScoped = bunHonorsScopedOverrides(await installedVersion("bun"));
const yarnClassic = yarnLine(await installedVersion("yarn")) === "classic";
after(() => Promise.all(repos.map((r) => r.dispose())));

async function repoWith(
  manager: Manager,
  files: Record<string, string | object>,
  options: Parameters<typeof universe>[0] = {},
  at = "2025-12-15T00:00:00Z",
) {
  const repo = await fixtureRepo(manager, files);
  repos.push(repo);
  await repo.lock(universe(options), at);
  await repo.commit("initial", at);
  return repo;
}

// One advisory with two affected branches: tar-lite 2.x below 2.4.1 and 3.x below 3.1.4.
const twoBranches = [
  { id: GHSA_TWO_BRANCH, package: "tar-lite", ranges: [">=2.0.0 <2.4.1", ">=3.0.0 <3.1.4"], published: "2026-02-01T00:00:00Z" },
];

for (const manager of ["npm", "pnpm", "bun", "yarn"] as const) {
  describe(`${manager}: graphs`, () => {
    it("fixes every resolved copy on its own release line when one advisory has several affected branches", async () => {
      const repo = await repoWith(manager, { "package.json": appManifest({ "bundler-kit": "^2.4.0", "legacy-pack": "^1.0.0" }) }, { advisories: twoBranches });
      const report = await repo.evaluate(universe({ advisories: twoBranches }), "2026-03-20T00:00:00Z");
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.deepEqual(vuln.instances.map((i) => i.version), ["2.3.0", "3.0.5"]);
      if (manager === "bun" && !bunScoped) {
        // One global pin would force both lines onto one version, so Bun 1.3 gets an explicit blocker.
        assert.equal(vuln.status, "BLOCKED");
        assert.match(vuln.attempts.at(-1)!.reasons[0]!.message, /only honors global overrides.*several release lines \(2, 3\)/);
        assert.equal(report.changes.length, 0);
        return;
      }
      assert.equal(vuln.strategy, "override", JSON.stringify(vuln.attempts));
      const change = report.changes.find((c) => c.identity === vuln.change)!;
      // 2.x stays on 2.x (2.4.1), 3.x stays on 3.x (3.2.0): never one blanket version.
      if (manager === "yarn") {
        const prefix = yarnClassic ? "**/" : "";
        assert.ok(change.patch.includes(`"${prefix}legacy-pack/tar-lite": "2.4.1"`), change.patch);
        assert.ok(change.patch.includes(`"${prefix}bundler-kit/tar-lite": "3.2.0"`), change.patch);
      } else {
        const json = manager !== "pnpm";
        assert.match(change.patch, json ? /"legacy-pack": \{\n\+\s+"tar-lite": "2\.4\.1"/ : /legacy-pack>tar-lite: 2\.4\.1/);
        assert.match(change.patch, json ? /"bundler-kit": \{\n\+\s+"tar-lite": "3\.2\.0"/ : /bundler-kit>tar-lite: 3\.2\.0/);
      }
      assert.doesNotMatch(change.patch, /4\.0\.0/);
      assert.equal(change.autoMerge, true);
    });

    it("needs human review when only a new major line is outside every advisory", async () => {
      // Two advisories that together cover all of 3.x.
      const advisories = [
        { id: GHSA, package: "tar-lite", ranges: ["<3.1.4"], published: "2026-02-01T00:00:00Z" },
        { id: "GHSA-cccc-dddd-ffff", package: "tar-lite", ranges: [">=3.1.0 <4.0.0"], published: "2026-04-02T00:00:00Z" },
      ];
      const repo = await repoWith(manager, { "package.json": appManifest({ "bundler-kit": "^2.4.0" }) }, { advisories });
      const report = await repo.evaluate(universe({ advisories }), "2026-04-20T00:00:00Z");
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.equal(vuln.status, "REVIEW_NEEDED");
      const change = report.changes.find((c) => c.identity === vuln.change)!;
      assert.match(change.title, /override tar-lite to 4\.0\.0/);
      assert.equal(change.autoMerge, false);
      assert.ok(change.labels.includes("security-major"));
      // Only the advisory affecting the installed copy is fixed by this change; the other constrained the choice.
      assert.deepEqual(change.advisories, [GHSA]);
    });

    it("reports BLOCKED, and keeps protection, when no fixed release exists", async () => {
      const advisories = [{ id: GHSA, package: "tar-lite", ranges: ["*"], published: "2026-02-01T00:00:00Z" }];
      const repo = await repoWith(manager, { "package.json": appManifest({ "bundler-kit": "^2.4.0" }) }, { advisories });
      const report = await repo.evaluate(universe({ advisories }), "2026-03-20T00:00:00Z");
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.equal(vuln.status, "BLOCKED");
      assert.equal(vuln.reasons[0]!.code, "no-fixed-version");
      assert.equal(report.changes.length, 0);
    });
  });
}

describe("npm workspaces", () => {
  it("follows paths through workspace packages and reports overrides npm ignores", async () => {
    const repo = await repoWith("npm", {
      "package.json": appManifest({}, { workspaces: ["packages/*"], overrides: { "bundler-kit": { "tar-lite": "3.1.4" } } }),
      "packages/web/package.json": { name: "web", version: "1.0.0", dependencies: { "bundler-kit": "^2.4.0" }, overrides: { "left-pad": "1.3.0" } },
    }, {}, "2026-02-10T00:00:00Z");
    const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");
    const o = report.overrides[0]!;
    assert.equal(o.status, "NEEDED");
    assert.deepEqual(o.evidence.instancesWithoutOverride?.[0]?.paths, ["packages/web > bundler-kit@2.4.0 > tar-lite@3.0.5"]);
    assert.ok(report.unsupported.some((u) => u.file === "packages/web/package.json" && /only honors overrides in the root/.test(u.message)));
  });
});

describe("pnpm workspaces", () => {
  it("evaluates a shared lockfile across importers", async () => {
    const pnpm = await installedVersion("pnpm");
    const major = Number(pnpm.split(".")[0]);
    const overridesFile = major >= 10 ? "pnpm-workspace.yaml" : "package.json";
    const repo = await repoWith("pnpm", {
      "package.json": appManifest({}, major >= 10 ? {} : { pnpm: { overrides: { "bundler-kit>tar-lite": "3.1.4" } } }),
      "pnpm-workspace.yaml": `packages:\n  - packages/*\n${major >= 10 ? "overrides:\n  bundler-kit>tar-lite: 3.1.4\n" : ""}`,
      "packages/web/package.json": { name: "web", version: "1.0.0", dependencies: { "bundler-kit": "^2.4.0" } },
      "packages/api/package.json": { name: "api", version: "1.0.0", dependencies: { "legacy-pack": "^1.0.0" } },
    }, {}, "2026-02-10T00:00:00Z");
    const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");
    const o = report.overrides[0]!;
    assert.equal(o.file, overridesFile);
    const paths = o.evidence.instancesWithoutOverride?.flatMap((i) => i.paths) ?? [];
    assert.ok(paths.includes("packages/web > bundler-kit@2.4.0 > tar-lite@3.0.5"), paths.join("\n"));
    assert.ok(paths.includes("packages/api > legacy-pack@1.0.0 > tar-lite@2.4.1"), paths.join("\n"));
    assert.equal(o.status, "NEEDED");
  });
});

describe("bun specifics", () => {
  it("reports overrides the installed Bun ignores, and follows workspace paths", async () => {
    const repo = await repoWith(
      "bun",
      {
        "package.json": appManifest({}, {
          workspaces: ["packages/*"],
          overrides: { "tar-lite": "3.1.4", "legacy-pack": { "tar-lite": "2.4.1" }, "left-pad@1": "1.3.0", "$ref": "$x" },
        }),
        "packages/web/package.json": { name: "web", version: "1.0.0", dependencies: { "bundler-kit": "^2.4.0" } },
      },
      {},
      "2026-02-10T00:00:00Z",
    );
    const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");
    const global = report.overrides.find((o) => o.selector === "tar-lite")!;
    assert.equal(global.status, "NEEDED");
    assert.ok(global.evidence.instancesWithoutOverride?.some((i) => i.paths.includes("packages/web > bundler-kit@2.4.0 > tar-lite@3.0.5")));
    const ignored = report.unsupported.filter((u) => u.ecosystem === "bun").map((u) => u.selector);
    if (bunScoped) {
      assert.deepEqual(report.overrides.map((o) => o.selector).sort(), ["left-pad@1", "legacy-pack > tar-lite", "tar-lite"]);
      assert.deepEqual(ignored, ["$ref"]);
    } else {
      assert.deepEqual(report.overrides.map((o) => o.selector), ["tar-lite"]);
      assert.deepEqual(ignored.sort(), ["$ref", "left-pad@1", "legacy-pack"]);
    }
  });
});

describe("yarn specifics", () => {
  it("reports keys the installed Yarn ignores or rejects, and follows workspace paths", async () => {
    const repo = await repoWith(
      "yarn",
      {
        "package.json": appManifest({}, { workspaces: ["packages/*"], resolutions: { "tar-lite": "3.1.4" } }),
        "packages/web/package.json": { name: "web", version: "1.0.0", dependencies: { "bundler-kit": "^2.4.0" } },
      },
      {},
      "2026-02-10T00:00:00Z",
    );
    // Added after locking: each line rejects or ignores one of these, which must surface as unsupported.
    const manifest = await repo.readJson("package.json");
    manifest.resolutions = { "tar-lite": "3.1.4", "**/legacy-pack/tar-lite": "2.4.1", "left-pad@^1.0.0": "1.3.0", "x/y": "patch:x@1#./p.patch" };
    await repo.write({ "package.json": manifest });
    await repo.commit("more resolutions", "2026-02-10T00:00:00Z");
    let report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");
    const ignored = report.unsupported.filter((u) => u.ecosystem === "yarn").map((u) => u.selector).sort();
    if (yarnClassic) {
      assert.deepEqual(ignored, ["left-pad@^1.0.0", "x/y"]);
      // Classic aborts the whole install on a version-selected key: blocked, with Yarn's own error.
      const blocked = report.overrides.find((o) => o.selector === "tar-lite")!;
      assert.equal(blocked.status, "BLOCKED");
      assert.match(blocked.reasons[0]!.message, /left-pad/);
      delete (manifest.resolutions as Record<string, string>)["left-pad@^1.0.0"];
      await repo.write({ "package.json": manifest });
      await repo.commit("drop the key Classic rejects", "2026-02-11T00:00:00Z");
      report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");
    } else {
      // Yarn 2+ ignores globs; descriptor keys match requested ranges, which paths don't record.
      assert.deepEqual(ignored, ["**/legacy-pack/tar-lite", "left-pad@^1.0.0", "x/y"]);
    }
    const global = report.overrides.find((o) => o.selector === "tar-lite");
    assert.ok(global, JSON.stringify(report.overrides.map((o) => [o.selector, o.status, o.reasons])));
    const paths = global.evidence.instancesWithoutOverride?.flatMap((i) => i.paths) ?? [];
    assert.ok(paths.includes("packages/web > bundler-kit@2.4.0 > tar-lite@3.0.5"), JSON.stringify(global));
  });
});
