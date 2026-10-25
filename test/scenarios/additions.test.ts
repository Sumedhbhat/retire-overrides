import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { type FixtureRepo, fixtureRepo, type Manager } from "../helpers/scenario.ts";
import { appManifest, GHSA, universe } from "../helpers/universe.ts";

const repos: FixtureRepo[] = [];
after(() => Promise.all(repos.map((r) => r.dispose())));

async function vulnerableApp(manager: Manager, deps: Record<string, string>, options: Parameters<typeof universe>[0] = {}) {
  const repo = await fixtureRepo(manager, { "package.json": appManifest(deps) });
  repos.push(repo);
  // Locked before the advisory or any fix existed.
  await repo.lock(universe(options), "2025-12-15T00:00:00Z");
  await repo.commit("initial", "2025-12-15T00:00:00Z");
  return repo;
}

for (const manager of ["npm", "pnpm"] as const) {
  describe(`${manager}: fixes for new advisories`, () => {
    it("adds the narrowest override when no parent release fixes the vulnerability", async () => {
      const repo = await vulnerableApp(manager, { "bundler-kit": "^2.4.0" });
      const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");

      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite");
      assert.ok(vuln, "tar-lite is reported vulnerable");
      assert.equal(vuln.status, "PROPOSED");
      assert.equal(vuln.strategy, "override");
      assert.deepEqual(
        vuln.attempts.map((a) => [a.strategy, a.outcome]),
        [
          ["override-update", "not-applicable"],
          ["lockfile-refresh", "not-applicable"],
          ["parent-update", "not-applicable"],
          ["override", "fixed"],
        ],
      );
      const change = report.changes.find((c) => c.identity === vuln.change);
      assert.ok(change);
      assert.equal(change.kind, "add-override");
      assert.deepEqual(change.advisories, [GHSA]);
      assert.equal(change.autoMerge, true);
      // Newest mature release on the 3.x line, pinned exactly; never 4.0.0 and never "latest".
      assert.match(change.title, /override tar-lite to 3\.2\.0 for GHSA-2222-3333-4444/);
      if (manager === "npm") {
        assert.match(change.patch, /\+\s+"bundler-kit": \{\n\+\s+"tar-lite": "3\.2\.0"/);
        assert.deepEqual(change.selectors, ["npm:package.json:bundler-kit > tar-lite"]);
      } else {
        assert.match(change.patch, /bundler-kit>tar-lite: 3\.2\.0/);
      }
      assert.match(change.commitMessage, /^Retire-Overrides-Action: add-override$/m);
      assert.match(change.commitMessage, new RegExp(`^Retire-Overrides-Advisory: ${GHSA}$`, "m"));
      assert.match(change.body, /<!-- retire-overrides:identity=security-fix\|/);
    });

    it("prefers refreshing the lockfile when the parent's range already allows a fix", async () => {
      const repo = await vulnerableApp(manager, { "bundler-kit": "^2.4.0" }, { bundlerOldRange: "^3.0.0" });
      const report = await repo.evaluate(universe({ bundlerOldRange: "^3.0.0" }), "2026-03-20T00:00:00Z");
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.equal(vuln.status, "PROPOSED");
      assert.equal(vuln.strategy, "lockfile-refresh");
      const change = report.changes.find((c) => c.identity === vuln.change)!;
      assert.equal(change.kind, "lockfile-refresh");
      assert.deepEqual(change.files, [manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"]);
    });

    it("bumps a direct parent when a newer parent release fixes it", async () => {
      // 2.5.0 is only 10 days old: security fixes skip the release-age wait.
      const options = { bundlerFixedAt: "2026-03-10T00:00:00Z" };
      const repo = await vulnerableApp(manager, { "bundler-kit": "2.4.0" }, options);
      const report = await repo.evaluate(universe(options), "2026-03-20T00:00:00Z");
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.equal(vuln.strategy, "parent-update");
      const change = report.changes.find((c) => c.identity === vuln.change)!;
      assert.equal(change.kind, "parent-update");
      assert.match(change.patch, /-\s+"bundler-kit": "2\.4\.0"\n\+\s+"bundler-kit": "2\.5\.0"/);
      assert.equal(change.autoMerge, true, change.autoMergeBlockers.join("; "));
    });

    it("defers to an open Dependabot PR instead of competing with it", async () => {
      const repo = await vulnerableApp(manager, { "bundler-kit": "^2.4.0" });
      const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z", {}, [
        { url: "https://example.test/pr/7", title: "Bump tar-lite from 3.0.5 to 3.1.4", branch: "dependabot/npm_and_yarn/tar-lite-3.1.4", author: "dependabot[bot]" },
      ]);
      const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
      assert.equal(vuln.status, "DEFERRED");
      assert.equal(vuln.deferredTo, "https://example.test/pr/7");
      assert.equal(report.changes.length, 0);
    });
  });
}
