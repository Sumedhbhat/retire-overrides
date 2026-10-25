import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alertsFor, coverage, type HostAlert } from "../../src/engine/alerts.ts";
import type { VulnerabilityReport } from "../../src/engine/report.ts";
import { GitHubPublisher } from "../../src/publish/github.ts";
import type { GraphNode, ResolvedGraph } from "../../src/types.ts";
import { FakeGitHub, rawAlert } from "../helpers/fake-github.ts";

function publisher(fake: FakeGitHub) {
  return new GitHubPublisher({ token: "t", repository: fake.repository, apiUrl: "https://api.github.test", autoMerge: true, mergeMethod: "squash", fetch: fake.fetch });
}

const alert = (number: number, pkg: string, extra: Partial<HostAlert> = {}): HostAlert => ({
  number,
  url: `https://github.test/a/${number}`,
  state: "open",
  advisory: "GHSA-2222-3333-4444",
  package: pkg,
  hostEcosystem: "npm",
  manifest: "package-lock.json",
  ...extra,
});

function graph(...pkgs: Array<[string, string]>): ResolvedGraph {
  const nodes = new Map<string, GraphNode>();
  nodes.set("", { key: "", name: "app", version: "1.0.0", children: new Map(), importer: "" });
  for (const [name, version] of pkgs) nodes.set(`node_modules/${name}`, { key: `node_modules/${name}`, name, version, children: new Map() });
  return { nodes, importers: [""] };
}

describe("GitHub Dependabot alerts", () => {
  it("reads every page of open alerts and normalizes them", async () => {
    const fake = new FakeGitHub("x");
    fake.alerts = [rawAlert(1, "tar-lite", "GHSA-2222-3333-4444"), rawAlert(2, "ms", "GHSA-w9mr-4mfr-499f", "packages/web/package.json", "< 2.0.0")];
    fake.alertsPageSize = 1;
    const result = await publisher(fake).openAlerts();
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.deepEqual(
      result.alerts.map((a) => [a.number, a.package, a.manifest, a.vulnerableRange, a.firstPatched]),
      [
        [1, "tar-lite", "package-lock.json", "< 3.1.4", "3.1.4"],
        [2, "ms", "packages/web/package.json", "< 2.0.0", "3.1.4"],
      ],
    );
  });

  it("reports missing permission or disabled alerts as unavailable, never as an empty list", async () => {
    const fake = new FakeGitHub("x");
    fake.alertsStatus = 403;
    const denied = await publisher(fake).openAlerts();
    assert.equal(denied.status, "unavailable");
    assert.match(denied.status === "unavailable" ? denied.reason : "", /Dependabot alerts: Read/);
    fake.alertsStatus = 404;
    const off = await publisher(fake).openAlerts();
    assert.match(off.status === "unavailable" ? off.reason : "", /not enabled/);
  });
});

describe("alert coverage", () => {
  it("matches alerts by ecosystem family, project directory, package and advisory", () => {
    const alerts = [alert(1, "tar-lite"), alert(2, "tar-lite", { manifest: "packages/web/package-lock.json" }), alert(3, "tar-lite", { advisory: "GHSA-other" })];
    assert.deepEqual(alertsFor(alerts, "pnpm", "", "tar-lite", ["ghsa-2222-3333-4444"]).map((a) => a.number), [1]);
    assert.deepEqual(alertsFor(alerts, "npm", "packages/web", "tar-lite", ["GHSA-2222-3333-4444"]).map((a) => a.number), [2]);
  });

  it("accounts for every alert: linked to a vulnerability or explained", () => {
    const vulnerable: VulnerabilityReport = {
      identity: "x",
      ecosystem: "npm",
      project: "",
      package: "tar-lite",
      advisories: [],
      instances: [{ version: "3.0.5", affectedBy: ["GHSA-2222-3333-4444"], paths: [], pathsTruncated: false }],
      status: "BLOCKED",
      attempts: [],
      reasons: [],
    };
    const alerts = [
      alert(1, "tar-lite"),
      alert(2, "left-pad"),
      alert(3, "ms"),
      alert(4, "requests", { hostEcosystem: "pip", manifest: "uv.lock" }),
      alert(5, "x", { manifest: "blocked/package-lock.json" }),
    ];
    const entries = coverage(
      alerts,
      [
        { ecosystem: "npm", dir: "", blocked: false, graph: graph(["tar-lite", "3.0.5"], ["ms", "2.1.3"]) },
        { ecosystem: "npm", dir: "blocked", blocked: true },
      ],
      [vulnerable],
    );
    assert.deepEqual(vulnerable.alerts?.map((a) => a.number), [1], "a blocked vulnerability still gets its alert");
    assert.deepEqual(
      entries.map((e) => [e.alert.number, e.reason]),
      [
        [2, "not-in-graph"],
        [3, "not-flagged"],
        [4, "unsupported-ecosystem"],
        [5, "project-blocked"],
      ],
    );
  });
});
