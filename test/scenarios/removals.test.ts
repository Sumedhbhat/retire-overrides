import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { OverrideReport } from "../../src/engine/report.ts";
import { bunHonorsScopedOverrides } from "../../src/adapters/bun/bun.ts";
import { yarnLine } from "../../src/adapters/yarn/yarn.ts";
import { type FixtureRepo, fixtureRepo, installedVersion, type Manager, toolTrailers } from "../helpers/scenario.ts";
import { appManifest, GHSA, GHSA_LATE, universe, type UniverseOptions } from "../helpers/universe.ts";

const repos: FixtureRepo[] = [];
after(() => Promise.all(repos.map((r) => r.dispose())));

const ADDED_AT = "2026-02-10T00:00:00Z";

// Bun 1.3.x only honors global overrides, so its fixtures use one.
const bunGlobal = !bunHonorsScopedOverrides(await installedVersion("bun"));
// Yarn Classic matches keys against the whole path from the root, so a parent scope needs `**/`.
const yarnKey = yarnLine(await installedVersion("yarn")) === "classic" ? "**/bundler-kit/tar-lite" : "bundler-kit/tar-lite";

function overrideFiles(manager: Manager, deps: Record<string, string>, value = "3.1.4", global = false): Record<string, string | object> {
  if (manager === "yarn") return { "package.json": appManifest(deps, { resolutions: { [global ? "tar-lite" : yarnKey]: value } }) };
  if (global && manager === "pnpm") return { "package.json": appManifest(deps), "pnpm-workspace.yaml": `overrides:\n  tar-lite: ${value}\n` };
  if ((manager === "bun" && bunGlobal) || global) return { "package.json": appManifest(deps, { overrides: { "tar-lite": value } }) };
  if (manager === "npm" || manager === "bun") return { "package.json": appManifest(deps, { overrides: { "bundler-kit": { "tar-lite": value } } }) };
  return { "package.json": appManifest(deps), "pnpm-workspace.yaml": `overrides:\n  bundler-kit>tar-lite: ${value}\n` };
}

function selector(manager: Manager, global = false): { file: string; selector: string } {
  if (global) return { file: manager === "pnpm" ? "pnpm-workspace.yaml" : "package.json", selector: "tar-lite" };
  if (manager === "bun") return { file: "package.json", selector: bunGlobal ? "tar-lite" : "bundler-kit > tar-lite" };
  if (manager === "yarn") return { file: "package.json", selector: yarnKey };
  return manager === "npm"
    ? { file: "package.json", selector: "bundler-kit > tar-lite" }
    : { file: "pnpm-workspace.yaml", selector: "bundler-kit>tar-lite" };
}

/**
 * A repository where retire-overrides added `tar-lite` 3.1.4 under bundler-kit on ADDED_AT. When
 * `bumpParentAt` is set, a Dependabot-style commit later moves bundler-kit to ^2.5.0.
 */
async function overriddenApp(
  manager: Manager,
  options: UniverseOptions & { bumpParentAt?: string; byTool?: boolean; value?: string; extraDeps?: Record<string, string>; global?: boolean },
): Promise<FixtureRepo> {
  const repo = await fixtureRepo(manager, overrideFiles(manager, { "bundler-kit": "^2.4.0", ...options.extraDeps }, options.value, options.global));
  repos.push(repo);
  await repo.lock(universe(options), ADDED_AT);
  const { file, selector: sel } = selector(manager, options.global);
  await repo.commit(options.byTool === false ? "pin tar-lite" : toolTrailers(manager, file, sel, GHSA), ADDED_AT);
  if (options.bumpParentAt) {
    const manifest = await repo.readJson("package.json");
    (manifest.dependencies as Record<string, string>)["bundler-kit"] = "^2.5.0";
    await repo.write({ "package.json": manifest });
    await repo.lock(universe(options), options.bumpParentAt);
    await repo.commit("build(deps): bump bundler-kit from 2.4.0 to 2.5.0", options.bumpParentAt);
  }
  return repo;
}

function only(report: { overrides: OverrideReport[] }): OverrideReport {
  assert.equal(report.overrides.length, 1, JSON.stringify(report.overrides.map((o) => o.selector)));
  return report.overrides[0]!;
}

function codes(o: OverrideReport): string[] {
  return o.reasons.map((r) => r.code);
}

const fixed = { bundlerFixedAt: "2026-03-01T00:00:00Z", bumpParentAt: "2026-03-16T00:00:00Z" };

for (const manager of ["npm", "pnpm", "bun", "yarn"] as const) {
  describe(`${manager}: override removal`, () => {
    it("NEEDED while the parent still pins a vulnerable range, with one stale issue after 90 days", async () => {
      const repo = await overriddenApp(manager, {});
      const report = await repo.evaluate(universe(), "2026-06-01T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "NEEDED");
      assert.ok(codes(o).includes("vulnerable-without-override"));
      assert.ok(codes(o).includes("parent-permits-vulnerable"));
      assert.equal(o.intent.kind, "tool");
      assert.equal(o.evidence.instancesWithoutOverride?.[0]?.version, "3.0.5");
      assert.deepEqual(o.evidence.instancesWithoutOverride?.[0]?.paths, ["(root) > bundler-kit@2.4.0 > tar-lite@3.0.5"]);
      assert.equal(report.changes.filter((c) => c.kind === "remove-override").length, 0);
      assert.equal(report.issues.length, 1);
      assert.match(report.issues[0]!.title, /Stale dependency override: tar-lite/);
      assert.match(report.issues[0]!.body, /latest bundler-kit@2\.4\.0 .*declares tar-lite@~3\.0\.0/);
      // No new vulnerability was introduced and the override still protects: nothing to fix.
      assert.equal(report.vulnerabilities.length, 0);
    });

    it("REMOVABLE once the parent caught up and everything new is at least 14 days old", async () => {
      const repo = await overriddenApp(manager, fixed);
      const report = await repo.evaluate(universe(fixed), "2026-03-21T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "REMOVABLE", JSON.stringify(o.reasons));
      assert.ok(o.evidence.parentConstraints?.every((c) => c.permitsVulnerable.length === 0));
      const change = report.changes.find((c) => c.identity === o.change)!;
      assert.equal(change.kind, "remove-override");
      assert.equal(change.autoMerge, true);
      assert.match(change.commitMessage, /^Retire-Overrides-Action: remove-override$/m);
      assert.ok(change.branch.startsWith("retire-overrides/remove-override/tar-lite-"));
      if (manager !== "pnpm") assert.doesNotMatch(change.patch, /^\+.*(overrides|resolutions)/m);
      else assert.match(change.patch, /deleted file mode/);
    });

    it("REMOVABLE even when a plugin accepts any version as a peer", async () => {
      const repo = await overriddenApp(manager, { ...fixed, global: true, extraDeps: { "peer-plugin": "^1.0.0" } });
      const report = await repo.evaluate(universe(fixed), "2026-03-21T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "REMOVABLE", JSON.stringify(o.reasons));
      const peer = o.evidence.parentConstraints?.find((c) => c.parent.startsWith("peer-plugin@"));
      if (manager === "yarn" && yarnKey.startsWith("**/")) {
        // Yarn Classic never installs peers, so the lockfile has no peer edge to judge.
        assert.equal(peer, undefined);
        return;
      }
      assert.ok(peer, JSON.stringify(o.evidence.parentConstraints));
      assert.equal(peer.peer, true);
      assert.deepEqual(peer.permitsVulnerable, []);
    });

    it("WAITING when removal would pull in a release younger than 14 days", async () => {
      const options = { ...fixed, tarExtra: { "3.2.1": "2026-03-18T00:00:00Z" } };
      const repo = await overriddenApp(manager, options);
      const report = await repo.evaluate(universe(options), "2026-03-21T00:00:00Z");
      const o = only(report);
      if (manager === "bun" && bunGlobal) {
        // Bun 1.3 can't refresh one package, so the locked 3.1.4 stays and nothing young is pulled in.
        assert.equal(o.status, "REMOVABLE", JSON.stringify(o.reasons));
        assert.match(o.evidence.refreshLimitation ?? "", /cannot refresh single packages/);
        return;
      }
      assert.equal(o.status, "WAITING");
      assert.ok(codes(o).includes("release-too-new"));
      assert.equal(report.changes.length, 0);
      // Two weeks later the same repository is removable.
      const later = await repo.evaluate(universe(options), "2026-04-02T00:00:00Z");
      assert.equal(only(later).status, "REMOVABLE");
    });

    it("REVIEW_NEEDED for an override of unknown origin, REMOVABLE once opted in via manage", async () => {
      const repo = await overriddenApp(manager, { ...fixed, byTool: false });
      const report = await repo.evaluate(universe(fixed), "2026-03-21T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "REVIEW_NEEDED");
      assert.equal(o.technicalStatus, "REMOVABLE");
      assert.equal(o.intent.kind, "unknown");
      assert.equal(o.provenance.source, "blame");
      assert.equal(o.provenance.date, ADDED_AT.replace("Z", ".000Z"));
      assert.equal(report.changes.length, 0);

      const managed = await repo.evaluate(universe(fixed), "2026-03-21T00:00:00Z", { manage: [{ package: "tar-lite" }] });
      assert.equal(only(managed).status, "REMOVABLE");
    });

    it("never evaluates kept overrides", async () => {
      const repo = await overriddenApp(manager, fixed);
      const report = await repo.evaluate(universe(fixed), "2026-03-21T00:00:00Z", {
        keep: [{ package: "tar-lite", reason: "we rely on 3.1 behavior" }],
      });
      assert.equal(report.overrides.length, 0);
      assert.equal(report.kept.length, 1);
      assert.equal(report.changes.length, 0);
    });

    it("BLOCKED, not clean, when advisory data is unavailable", async () => {
      const repo = await overriddenApp(manager, fixed);
      const report = await repo.evaluate(universe({ ...fixed, failures: { advisories: true } }), "2026-03-21T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "BLOCKED");
      assert.match(o.reasons.map((r) => r.message).join(" "), /advisory data unavailable/);
      assert.equal(report.changes.length, 0);
      assert.ok(report.projects[0]!.blockers.some((b) => /vulnerability detection failed/.test(b)));
    });

    it("BLOCKED when a release date is missing", async () => {
      const options = { ...fixed, tarMissingTime: ["3.2.0"] };
      const repo = await overriddenApp(manager, fixed);
      const report = await repo.evaluate(universe(options), "2026-03-21T00:00:00Z");
      const o = only(report);
      if ((manager === "bun" && bunGlobal) || (manager === "yarn" && yarnKey === "bundler-kit/tar-lite")) {
        // No new version is resolved on Bun 1.3 (see refreshLimitation), and Yarn 2+ never resolves a
        // version without a publish time, so no release date is needed.
        assert.equal(o.status, "REMOVABLE", JSON.stringify(o.reasons));
        assert.deepEqual(o.evidence.changedVersions, []);
        return;
      }
      assert.equal(o.status, "BLOCKED");
      assert.ok(codes(o).includes("release-date-unknown"));
    });

    it("BLOCKED when resolution without the override fails", async () => {
      // The parent now asks for a tar-lite major that was never published.
      const options = { ...fixed, bundlerNewRange: "^9.0.0" };
      const repo = await overriddenApp(manager, { ...options, bumpParentAt: undefined });
      const manifest = await repo.readJson("package.json");
      (manifest.dependencies as Record<string, string>)["bundler-kit"] = "^2.5.0";
      await repo.write({ "package.json": manifest });
      await repo.lock(universe(options), "2026-03-16T00:00:00Z");
      await repo.commit("bump bundler-kit", "2026-03-16T00:00:00Z");
      const report = await repo.evaluate(universe(options), "2026-03-21T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "BLOCKED");
      assert.ok(codes(o).includes("resolution-failed"), JSON.stringify(o.reasons));
    });

    it("NEEDED when the parent's new range still permits vulnerable versions, even if it resolves safely", async () => {
      const options = { ...fixed, bundlerNewRange: ">=3.0.0" };
      const repo = await overriddenApp(manager, options);
      const report = await repo.evaluate(universe(options), "2026-03-21T00:00:00Z");
      const o = only(report);
      assert.equal(o.status, "NEEDED");
      assert.deepEqual(codes(o), ["parent-permits-vulnerable"]);
      assert.ok(o.evidence.instancesWithoutOverride?.every((i) => i.affectedBy.length === 0));
    });

    it("updates an existing override when a new advisory affects its pinned version", async () => {
      const advisories = [
        { id: GHSA, package: "tar-lite", ranges: ["<3.1.4"], published: "2026-02-01T00:00:00Z" },
        { id: GHSA_LATE, package: "tar-lite", ranges: [">=3.1.0 <3.2.0"], published: "2026-03-05T00:00:00Z" },
      ];
      const repo = await overriddenApp(manager, { advisories });
      const report = await repo.evaluate(universe({ advisories }), "2026-03-20T00:00:00Z");
      assert.equal(only(report).status, "NEEDED");
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.equal(vuln.strategy, "override-update");
      assert.deepEqual(vuln.advisories.map((a) => a.id), [GHSA_LATE]);
      const change = report.changes.find((c) => c.identity === vuln.change)!;
      assert.equal(change.kind, "update-override");
      assert.match(change.patch, /3\.2\.0/);
    });
  });
}

describe("stale lockfiles", () => {
  it("re-resolves instead of trusting a lockfile that no longer matches the manifest", async () => {
    const repo = await overriddenApp("npm", { bundlerFixedAt: "2026-03-01T00:00:00Z" });
    const manifest = await repo.readJson("package.json");
    (manifest.dependencies as Record<string, string>)["bundler-kit"] = "^2.5.0";
    await repo.write({ "package.json": manifest });
    await repo.commit("bump bundler-kit without relocking", "2026-03-16T00:00:00Z");
    const report = await repo.evaluate(universe({ bundlerFixedAt: "2026-03-01T00:00:00Z" }), "2026-03-21T00:00:00Z");
    assert.equal(report.projects[0]!.lockfileStale, true);
    const o = only(report);
    assert.equal(o.evidence.lockfileStale, true);
    assert.equal(o.status, "REMOVABLE", JSON.stringify(o.reasons));
  });
});
