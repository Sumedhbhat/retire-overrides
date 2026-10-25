import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Report } from "../../src/engine/report.ts";
import { run } from "../../src/exec.ts";
import { startSnapshotRegistry } from "../../src/metadata/server.ts";
import { type FixtureRepo, fixtureRepo, toolTrailers } from "../helpers/scenario.ts";
import { appManifest, GHSA, universe } from "../helpers/universe.ts";

// RETIRE_OVERRIDES_CLI=dist/cli.mjs runs the same tests against the shipped bundle.
const CLI = process.env.RETIRE_OVERRIDES_CLI ? resolve(process.env.RETIRE_OVERRIDES_CLI) : fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const fixed = { bundlerFixedAt: "2026-03-01T00:00:00Z" };
const NOW = "2026-03-21T00:00:00Z";
let repo: FixtureRepo;
let work: string;

before(async () => {
  repo = await fixtureRepo("npm", { "package.json": appManifest({ "bundler-kit": "^2.5.0" }, { overrides: { "bundler-kit": { "tar-lite": "3.1.4" } } }) });
  await repo.lock(universe(fixed), "2026-03-16T00:00:00Z");
  await repo.commit(toolTrailers("npm", "package.json", "bundler-kit > tar-lite", GHSA), "2026-02-10T00:00:00Z");
  work = await mkdtemp(join(tmpdir(), "retire-overrides-cli-"));
  await writeFile(join(work, "snapshot.json"), JSON.stringify(universe(fixed)));
});
after(async () => {
  await repo.dispose();
  await rm(work, { recursive: true, force: true });
});

function cli(args: string[]) {
  return run("node", [CLI, ...args], { cwd: work, allowFailure: true });
}

function decisions(report: Report) {
  return {
    overrides: report.overrides.map((o) => [o.identity, o.status, o.reasons.map((r) => r.code), o.evidence.changedVersions]),
    vulnerabilities: report.vulnerabilities.map((v) => [v.identity, v.status, v.strategy]),
    changes: report.changes.map((c) => [c.identity, c.branch, c.files, c.autoMerge]),
  };
}

describe("CLI", () => {
  it("prints a dry run, writes JSON, and honors --fail-on", async () => {
    const result = await cli(["check", "--repo", repo.dir, "--metadata", "snapshot.json", "--now", NOW, "--json", "report.json", "--fail-on", "REMOVABLE"]);
    assert.equal(result.code, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /REMOVABLE\s+bundler-kit > tar-lite → 3\.1\.4/);
    assert.match(result.stdout, /chore\(deps\): remove npm override for tar-lite/);
    const report = JSON.parse(await readFile(join(work, "report.json"), "utf8")) as Report;
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.evaluatedAt, NOW.replace("Z", ".000Z"));
    assert.equal(report.metadata.registry, "snapshot");

    const ok = await cli(["check", "--repo", repo.dir, "--metadata", "snapshot.json", "--now", NOW, "--quiet", "--fail-on", "BLOCKED"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^Summary: 0 needed, 0 waiting, 1 removable/);
  });

  it("reproduces the same decisions from recorded metadata", async () => {
    const server = await startSnapshotRegistry(universe(fixed), { now: new Date(NOW) });
    try {
      const live = await cli(["check", "--repo", repo.dir, "--registry", server.url, "--now", NOW, "--json", "live.json", "--record-metadata", "recorded.json"]);
      assert.equal(live.code, 0, live.stderr);
    } finally {
      await server.close();
    }
    const replay = await cli(["check", "--repo", repo.dir, "--metadata", "recorded.json", "--now", NOW, "--json", "replay.json"]);
    assert.equal(replay.code, 0, replay.stderr);
    const a = JSON.parse(await readFile(join(work, "live.json"), "utf8")) as Report;
    const b = JSON.parse(await readFile(join(work, "replay.json"), "utf8")) as Report;
    assert.deepEqual(decisions(b), decisions(a));
    assert.equal(a.changes.length, 1);
  });

  it("writes a Markdown summary and lists adapter support", async () => {
    const md = join(work, "summary.md");
    await cli(["check", "--repo", repo.dir, "--metadata", "snapshot.json", "--now", NOW, "--markdown", md, "--quiet"]);
    assert.match(await readFile(md, "utf8"), /\| REMOVABLE \| `bundler-kit > tar-lite` → `3\.1\.4` \|/);
    const adapters = await cli(["adapters"]);
    assert.match(adapters.stdout, /^npm\s+implemented/m);
    assert.match(adapters.stdout, /^yarn\s+implemented/m);
    assert.match(adapters.stdout, /^uv\s+planned/m);
  });

  it("rejects publishing a replay and bad options with exit code 2", async () => {
    const replay = await cli(["publish", "--repo", repo.dir, "--metadata", "snapshot.json", "--out-dir", "out"]);
    assert.equal(replay.code, 2);
    assert.match(replay.stderr, /cannot use --metadata/);
    const bad = await cli(["check", "--repo", repo.dir, "--now", "yesterday"]);
    assert.equal(bad.code, 2);
  });
});
