import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { MetadataSnapshot, SnapshotPackage } from "../../src/metadata/snapshot.ts";
import { type FixtureRepo, fixtureRepo, toolTrailers } from "../helpers/scenario.ts";
import { GHSA } from "../helpers/universe.ts";

// The npm universe's story on PyPI: bundler-kit 2.4.0 pins tar-lite ~=3.0.0, and the advisory
// affects tar-lite <3.1.4. bundler-kit 2.5.0 (when published) requires tar-lite >=3.1.4.
const t = (d: string) => `${d}T00:00:00Z`;

function pypiUniverse(o: { bundlerFixedAt?: string; bundlerOldRange?: string; advisoriesDown?: boolean } = {}): MetadataSnapshot {
  const bundler: SnapshotPackage = {
    versions: { "2.4.0": { dependencies: { "tar-lite": o.bundlerOldRange ?? "~=3.0.0" } } },
    time: { "2.4.0": t("2025-12-01") },
  };
  if (o.bundlerFixedAt) {
    bundler.versions["2.5.0"] = { dependencies: { "tar-lite": ">=3.1.4" } };
    bundler.time["2.5.0"] = o.bundlerFixedAt;
  }
  const tarTimes: Record<string, string> = {
    "2.3.0": t("2024-06-01"),
    "2.4.1": t("2026-02-01"),
    "3.0.0": t("2025-01-01"),
    "3.0.5": t("2025-06-01"),
    "3.1.4": t("2026-02-01"),
    "3.2.0": t("2026-03-01"),
    "4.0.0": t("2026-04-01"),
  };
  const snapshot: MetadataSnapshot = {
    schemaVersion: 1,
    packages: {},
    pypi: {
      "bundler-kit": bundler,
      "tar-lite": { versions: Object.fromEntries(Object.keys(tarTimes).map((v) => [v, {}])), time: tarTimes },
      "legacy-pack": { versions: { "1.0.0": { dependencies: { "tar-lite": ">=2,<3" } } }, time: { "1.0.0": t("2024-07-01") } },
    },
    advisories: [{ id: GHSA, package: "tar-lite", ecosystem: "PyPI", ranges: ["<3.1.4"], published: t("2026-02-01") }],
  };
  if (o.advisoriesDown) snapshot.failures = { advisories: true };
  return snapshot;
}

function pyproject(deps: string[], uv = ""): string {
  return [
    "[project]",
    'name = "app"',
    'version = "0.1.0"',
    'requires-python = ">=3.10"',
    `dependencies = [${deps.map((d) => JSON.stringify(d)).join(", ")}]`,
    "",
    ...(uv ? ["# Settings for uv.", "[tool.uv]", uv, ""] : []),
  ].join("\n");
}

const repos: FixtureRepo[] = [];
after(() => Promise.all(repos.map((r) => r.dispose())));

async function uvRepo(files: Record<string, string>, universe: MetadataSnapshot, at: string, message = "initial"): Promise<FixtureRepo> {
  const repo = await fixtureRepo("uv", files);
  repos.push(repo);
  await repo.lock(universe, at);
  await repo.commit(message, at);
  return repo;
}

const OVERRIDE = '# tar-lite 3.0.x has a path traversal bug\noverride-dependencies = [\n    "tar-lite==3.1.4",\n]';

describe("uv: fixes for new advisories", () => {
  it("adds a global override pin when no parent release fixes it", async () => {
    const repo = await uvRepo({ "pyproject.toml": pyproject(["bundler-kit>=2.4"]) }, pypiUniverse(), t("2025-12-15"));
    const report = await repo.evaluate(pypiUniverse(), t("2026-03-20"));
    const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
    assert.equal(vuln.strategy, "override", JSON.stringify(vuln.attempts));
    const change = report.changes.find((c) => c.identity === vuln.change)!;
    assert.match(change.patch, /\+\[tool\.uv\]\n\+override-dependencies = \["tar-lite==3\.2\.0"\]/);
    assert.deepEqual(change.selectors, ["uv:pyproject.toml:tar-lite"]);
    assert.deepEqual(change.files, ["pyproject.toml", "uv.lock"]);
  });

  it("refreshes the lockfile when the parent's range already allows a fix", async () => {
    const universe = pypiUniverse({ bundlerOldRange: ">=3.0.0" });
    const repo = await uvRepo({ "pyproject.toml": pyproject(["bundler-kit>=2.4"]) }, universe, t("2025-12-15"));
    const report = await repo.evaluate(universe, t("2026-03-20"));
    const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
    assert.equal(vuln.strategy, "lockfile-refresh", JSON.stringify(vuln.attempts));
    assert.deepEqual(report.changes[0]!.files, ["uv.lock"]);
  });

  it("bumps a pinned direct dependency, keeping its operator", async () => {
    const universe = pypiUniverse({ bundlerFixedAt: t("2026-03-10") });
    const repo = await uvRepo({ "pyproject.toml": pyproject(["bundler-kit==2.4.0"]) }, universe, t("2025-12-15"));
    const report = await repo.evaluate(universe, t("2026-03-20"));
    const vuln = report.vulnerabilities.find((v) => v.package === "tar-lite")!;
    assert.equal(vuln.strategy, "parent-update", JSON.stringify(vuln.attempts));
    assert.match(report.changes[0]!.patch, /-dependencies = \["bundler-kit==2\.4\.0"\]\n\+dependencies = \["bundler-kit==2\.5\.0"\]/);
  });
});

describe("uv: override removal", () => {
  it("NEEDED while the parent still pins a vulnerable range", async () => {
    const files = { "pyproject.toml": pyproject(["bundler-kit>=2.4"], OVERRIDE) };
    const repo = await uvRepo(files, pypiUniverse(), t("2026-02-10"), toolTrailers("uv", "pyproject.toml", "tar-lite", GHSA));
    const report = await repo.evaluate(pypiUniverse(), t("2026-03-20"));
    const o = report.overrides[0]!;
    assert.equal(o.status, "NEEDED");
    assert.ok(o.reasons.some((r) => r.code === "parent-permits-vulnerable" && /bundler-kit@2\.4\.0 declares tar-lite@~=3\.0\.0/.test(r.message)));
    assert.equal(o.intent.kind, "tool");
  });

  it("REMOVABLE once the parent caught up, and the removal keeps comments and layout", async () => {
    const universe = pypiUniverse({ bundlerFixedAt: t("2026-03-01") });
    const files = { "pyproject.toml": pyproject(["bundler-kit>=2.5"], OVERRIDE) };
    const repo = await uvRepo(files, universe, t("2026-03-16"), toolTrailers("uv", "pyproject.toml", "tar-lite", GHSA));
    const report = await repo.evaluate(universe, t("2026-03-21"));
    const o = report.overrides[0]!;
    assert.equal(o.status, "REMOVABLE", JSON.stringify(o.reasons));
    const change = report.changes.find((c) => c.identity === o.change)!;
    // The array and its now-empty key go; the table header and the unrelated comment stay.
    assert.match(change.patch, /-override-dependencies = \[\n-    "tar-lite==3\.1\.4",\n-\]/);
    assert.doesNotMatch(change.patch, /^-# Settings for uv\.$/m);
  });

  it("REVIEW_NEEDED for a constraint of unknown origin: ordinary constraints are never removed blindly", async () => {
    const universe = pypiUniverse({ bundlerFixedAt: t("2026-03-01") });
    const files = { "pyproject.toml": pyproject(["bundler-kit>=2.5"], 'constraint-dependencies = ["tar-lite>=3.1.4"]') };
    const repo = await uvRepo(files, universe, t("2026-03-16"));
    const report = await repo.evaluate(universe, t("2026-03-21"));
    const o = report.overrides[0]!;
    assert.equal(o.selector, "tar-lite (constraint)");
    assert.equal(o.status, "REVIEW_NEEDED");
    assert.equal(report.changes.length, 0);
  });

  it("BLOCKED, not clean, when advisory data is unavailable", async () => {
    const universe = pypiUniverse({ bundlerFixedAt: t("2026-03-01") });
    const files = { "pyproject.toml": pyproject(["bundler-kit>=2.5"], OVERRIDE) };
    const repo = await uvRepo(files, universe, t("2026-03-16"), toolTrailers("uv", "pyproject.toml", "tar-lite", GHSA));
    const report = await repo.evaluate(pypiUniverse({ bundlerFixedAt: t("2026-03-01"), advisoriesDown: true }), t("2026-03-21"));
    assert.equal(report.overrides[0]!.status, "BLOCKED");
    assert.equal(report.changes.length, 0);
  });

  it("BLOCKED on a custom package index instead of comparing it with PyPI", async () => {
    const universe = pypiUniverse({ bundlerFixedAt: t("2026-03-01") });
    const uv = `${OVERRIDE}\n\n[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"`;
    const repo = await fixtureRepo("uv", { "pyproject.toml": pyproject(["bundler-kit>=2.5"], uv) });
    repos.push(repo);
    await repo.commit("initial", t("2026-03-16"));
    await repo.write({ "uv.lock": 'version = 1\nrevision = 5\nrequires-python = ">=3.10"\n' });
    await repo.commit("lock", t("2026-03-16"));
    const report = await repo.evaluate(universe, t("2026-03-21"));
    assert.ok(report.projects[0]!.blockers.some((b) => /custom package indexes/.test(b)), JSON.stringify(report.projects));
    assert.equal(report.changes.length, 0);
  });

  it("reports marker-scoped and URL overrides instead of evaluating them", async () => {
    const uv = 'override-dependencies = ["tar-lite==3.1.4; python_version < \'3.11\'", "legacy-pack @ https://example.com/legacy.whl"]';
    const repo = await fixtureRepo("uv", { "pyproject.toml": pyproject(["bundler-kit>=2.4"], uv) });
    repos.push(repo);
    await repo.commit("initial", t("2026-02-10"));
    const { UvAdapter } = await import("../../src/adapters/uv/uv.ts");
    const project = { ecosystem: "uv" as const, dir: "", manifest: "pyproject.toml", lockfile: "uv.lock", packageManager: { name: "uv", installed: "0.13.0" } };
    const { entries, unsupported } = await new UvAdapter().readOverrides(project, repo.dir);
    assert.equal(entries.length, 0);
    assert.equal(unsupported.length, 2);
    assert.match(unsupported[0]!.message, /environment marker/);
    assert.match(unsupported[1]!.message, /not a version requirement/);
  });
});
