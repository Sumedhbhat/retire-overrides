import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DirectoryPublisher } from "../../src/publish/directory.ts";
import { GitHubPublisher } from "../../src/publish/github.ts";
import type { Report } from "../../src/engine/report.ts";
import { run } from "../../src/exec.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { type FixtureRepo, fixtureRepo, toolTrailers } from "../helpers/scenario.ts";
import { appManifest, GHSA, universe } from "../helpers/universe.ts";

const fixed = { bundlerFixedAt: "2026-03-01T00:00:00Z" };
let repo: FixtureRepo;
let report: Report;
let server: string;

before(async () => {
  repo = await fixtureRepo("npm", { "package.json": appManifest({ "bundler-kit": "^2.4.0" }, { overrides: { "bundler-kit": { "tar-lite": "3.1.4" } } }) });
  await repo.lock(universe(fixed), "2026-02-10T00:00:00Z");
  await repo.commit(toolTrailers("npm", "package.json", "bundler-kit > tar-lite", GHSA), "2026-02-10T00:00:00Z");
  const manifest = await repo.readJson("package.json");
  (manifest.dependencies as Record<string, string>)["bundler-kit"] = "^2.5.0";
  await repo.write({ "package.json": manifest });
  await repo.lock(universe(fixed), "2026-03-16T00:00:00Z");
  await repo.commit("bump bundler-kit", "2026-03-16T00:00:00Z");
  report = await repo.evaluate(universe(fixed), "2026-03-21T00:00:00Z");
  assert.equal(report.changes.length, 1);

  server = await mkdtemp(join(tmpdir(), "retire-overrides-remote-"));
  await mkdir(join(server, "owner"));
  await run("git", ["init", "--quiet", "--bare", join(server, "owner", "repo.git")], { cwd: server });
});
after(async () => {
  await repo.dispose();
  await rm(server, { recursive: true, force: true });
});

function publisher(fake: FakeGitHub, autoMerge = true) {
  return new GitHubPublisher({
    token: "test-token",
    repository: fake.repository,
    serverUrl: `file://${server}`,
    apiUrl: "https://api.github.test",
    autoMerge,
    mergeMethod: "squash",
    fetch: fake.fetch,
  });
}

describe("GitHub publishing", () => {
  it("creates the PR once, enables auto-merge behind required checks, and is idempotent on rerun", async () => {
    const fake = new FakeGitHub(report.repository.commit);
    const first = await publisher(fake).publish(report, repo.dir);
    assert.deepEqual(first.map((o) => o.action), ["created"]);
    assert.equal(fake.pulls.length, 1);
    const pr = fake.pulls[0]!;
    assert.equal(pr.head.ref, report.changes[0]!.branch);
    assert.ok(pr.labels.some((l) => l.name === "retire-overrides"));
    assert.equal(fake.autoMerge.length, 1);
    assert.match(fake.autoMerge[0]!.body, /^Retire-Overrides-Action: remove-override$/m);

    // The branch really exists in the remote with the trailers in the commit.
    const log = await run("git", ["--git-dir", join(server, "owner", "repo.git"), "log", "-1", "--format=%B", pr.head.ref], { cwd: server });
    assert.match(log.stdout, /Retire-Overrides-Selector: npm:package.json:bundler-kit > tar-lite/);

    const second = await publisher(fake).publish(report, repo.dir);
    assert.equal(fake.pulls.length, 1, "no duplicate PR");
    assert.equal(second[0]!.action, "unchanged");
    assert.match(second[0]!.message ?? "", /branch unchanged/);
  });

  it("does not reopen a change a human closed without merging", async () => {
    const fake = new FakeGitHub(report.repository.commit);
    await publisher(fake).publish(report, repo.dir);
    fake.pulls[0]!.state = "closed";
    const again = await publisher(fake).publish(report, repo.dir);
    assert.equal(again[0]!.action, "skipped");
    assert.equal(fake.pulls.length, 1);
  });

  it("withholds auto-merge when the base branch requires no checks", async () => {
    const fake = new FakeGitHub(report.repository.commit);
    fake.requiredChecks = [];
    const outcome = await publisher(fake).publish(report, repo.dir);
    assert.match(outcome[0]!.message ?? "", /no required status checks/);
    assert.equal(fake.autoMerge.length, 0);
  });

  it("closes its own PR when a newer change for the same packages supersedes it", async () => {
    const fake = new FakeGitHub(report.repository.commit);
    const change = report.changes[0]!;
    const stale = fake.addPull({
      title: "old",
      body: `<!-- retire-overrides:identity=${change.identity}|old -->\n<!-- retire-overrides:group=${change.groupKey} -->`,
      head: { ref: "retire-overrides/remove-override/tar-lite-old", repo: { full_name: fake.repository } },
    });
    await publisher(fake).publish(report, repo.dir);
    assert.equal(stale.state, "closed");
    assert.ok(fake.comments.some((c) => c.number === stale.number && /Superseded/.test(c.body)));
  });

  it("refuses to publish a report that is not based on the tip of the base branch", async () => {
    const fake = new FakeGitHub("0".repeat(40));
    await assert.rejects(publisher(fake).publish(report, repo.dir), /re-run on the tip of main/);
  });

  it("ignores PR branches from forks that merely look like ours", async () => {
    const fake = new FakeGitHub(report.repository.commit);
    const change = report.changes[0]!;
    fake.addPull({ title: "spoof", body: `<!-- retire-overrides:identity=${change.identity} -->`, head: { ref: change.branch, repo: { full_name: "evil/fork" } } });
    const outcome = await publisher(fake).publish(report, repo.dir);
    assert.equal(outcome[0]!.action, "created");
  });
});

describe("directory publishing for other hosts", () => {
  it("writes a patch that applies cleanly on the evaluated commit", async () => {
    const out = await mkdtemp(join(tmpdir(), "retire-overrides-out-"));
    try {
      await new DirectoryPublisher(out).publish(report);
      const files = (await readdir(join(out, "changes"))).sort();
      assert.equal(files.length, 2);
      const meta = JSON.parse(await readFile(join(out, "changes", files.find((f) => f.endsWith(".json"))!), "utf8")) as { baseCommit: string; branch: string };
      assert.equal(meta.baseCommit, report.repository.commit);
      const patchFile = join(out, "changes", files.find((f) => f.endsWith(".patch"))!);
      await run("git", ["apply", "--check", patchFile], { cwd: repo.dir });
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
