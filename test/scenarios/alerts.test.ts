import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { HostAlert } from "../../src/engine/alerts.ts";
import { renderMarkdown } from "../../src/render/summary.ts";
import { type FixtureRepo, fixtureRepo } from "../helpers/scenario.ts";
import { appManifest, GHSA, universe } from "../helpers/universe.ts";

let repo: FixtureRepo;
before(async () => {
  repo = await fixtureRepo("npm", { "package.json": appManifest({ "bundler-kit": "^2.4.0" }) });
  await repo.lock(universe(), "2025-12-15T00:00:00Z");
  await repo.commit("initial", "2025-12-15T00:00:00Z");
});
after(() => repo.dispose());

const alert = (number: number, pkg: string, extra: Partial<HostAlert> = {}): HostAlert => ({
  number,
  url: `https://github.test/owner/repo/security/dependabot/${number}`,
  state: "open",
  advisory: GHSA,
  package: pkg,
  hostEcosystem: "npm",
  manifest: "package-lock.json",
  vulnerableRange: "< 3.1.4",
  ...extra,
});

describe("Dependabot alerts as input", () => {
  it("cross-references alerts in the report and the generated PR, and explains the rest", async () => {
    const alerts = [alert(7, "tar-lite"), alert(8, "left-pad"), alert(9, "requests", { hostEcosystem: "pip", manifest: "uv.lock" })];
    const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z", {}, [], { status: "available", alerts });
    const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
    assert.deepEqual(vuln.alerts, [{ number: 7, url: alerts[0]!.url, advisory: GHSA }]);
    const change = report.changes.find((c) => c.identity === vuln.change)!;
    assert.match(change.body, /Fixes Dependabot alert \[#7\]\(https:\/\/github\.test\/owner\/repo\/security\/dependabot\/7\)/);
    assert.deepEqual(report.alerts, { source: "github-dependabot", status: "available", open: 3 });
    assert.deepEqual(report.coverage?.map((c) => [c.alert.number, c.reason]), [
      [8, "not-in-graph"],
      [9, "unsupported-ecosystem"],
    ]);
    assert.match(renderMarkdown(report), /Dependabot alerts not acted on/);
  });

  it("says plainly when alerts couldn't be read", async () => {
    const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z", {}, [], {
      status: "unavailable",
      reason: 'the token cannot read Dependabot alerts (needs "Dependabot alerts: Read")',
    });
    assert.equal(report.alerts?.status, "unavailable");
    assert.match(report.alerts?.note ?? "", /Dependabot alerts: Read/);
    assert.deepEqual(report.coverage, []);
    assert.match(renderMarkdown(report), /Dependabot alerts unavailable/);
    // The rest of the evaluation is unaffected.
    assert.equal(report.vulnerabilities.find((v) => v.package === "tar-lite")?.status, "PROPOSED");
  });

  it("leaves host-independent runs without an alerts section", async () => {
    const report = await repo.evaluate(universe(), "2026-03-20T00:00:00Z");
    assert.equal(report.alerts, undefined);
    assert.equal(report.coverage, undefined);
  });
});
