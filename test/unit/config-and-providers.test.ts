import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  AdvisoryDataUnavailableError,
  type AdvisoryProvider,
  CombinedAdvisoryProvider,
  GitHubAdvisoryProvider,
  NpmBulkAdvisoryProvider,
} from "../../src/advisories/providers.ts";
import { ConfigError, DEFAULT_CONFIG, parseConfig } from "../../src/config.ts";
import { branchFor, fixIdentity, readMarker, marker, removalIdentity } from "../../src/engine/identity.ts";
import { matchExternal } from "../../src/engine/fixes.ts";
import type { Advisory } from "../../src/types.ts";

describe("config", () => {
  it("defaults to the 14-day wait, 90-day staleness and npm advisories", () => {
    assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
    assert.equal(DEFAULT_CONFIG.minimumReleaseAgeDays, 14);
    assert.equal(DEFAULT_CONFIG.staleAfterDays, 90);
  });

  it("accepts keep and manage lists in short and long form", () => {
    const config = parseConfig({ version: 1, keep: ["left-pad", { package: "tar-lite", ecosystem: "npm", reason: "policy" }], manage: [{ package: "ms" }] });
    assert.deepEqual(config.keep, [{ package: "left-pad" }, { package: "tar-lite", ecosystem: "npm", reason: "policy" }]);
    assert.deepEqual(config.manage, [{ package: "ms" }]);
  });

  it("rejects unknown keys and bad values instead of guessing", () => {
    assert.throws(() => parseConfig({ minimumReleaseAge: 3 }), ConfigError);
    assert.throws(() => parseConfig({ minimumReleaseAgeDays: -1 }), ConfigError);
    assert.throws(() => parseConfig({ advisoryProviders: ["osv"] }), ConfigError);
    assert.throws(() => parseConfig({ keep: [{ name: "x" }] }), ConfigError);
  });
});

describe("advisory providers", () => {
  it("reads the npm bulk endpoint, normalizes GHSA IDs and splits affected branches", async () => {
    let sent: unknown;
    const provider = new NpmBulkAdvisoryProvider("https://registry.test/", {
      fetch: async (_url, init) => {
        sent = JSON.parse(gunzipSync(init!.body as Buffer).toString());
        return Response.json({
          "tar-lite": [{ id: 1, url: "https://github.com/advisories/GHSA-JF85-CPCP-J695", vulnerable_versions: ">=2.0.0 <2.4.1 || >=3.0.0 <3.1.4", severity: "high" }],
        });
      },
    });
    const result = await provider.advisoriesFor("npm", new Map([["tar-lite", ["3.0.5"]]]));
    assert.deepEqual(sent, { "tar-lite": ["3.0.5"] });
    assert.deepEqual(result.get("tar-lite")![0]!.ranges, [">=2.0.0 <2.4.1", ">=3.0.0 <3.1.4"]);
    assert.equal(result.get("tar-lite")![0]!.id, "GHSA-jf85-cpcp-j695");
  });

  it("fails loudly instead of returning an empty, clean-looking answer", async () => {
    const provider = new NpmBulkAdvisoryProvider("https://registry.test/", { fetch: async () => new Response("down", { status: 503 }) });
    await assert.rejects(provider.advisoriesFor("npm", new Map([["x", ["1.0.0"]]])), AdvisoryDataUnavailableError);
  });

  it("reads GitHub advisories, skipping withdrawn ones and other packages' ranges", async () => {
    const provider = new GitHubAdvisoryProvider({
      token: "t",
      fetch: async () =>
        Response.json([
          { ghsa_id: "GHSA-aaaa-bbbb-cccc", cve_id: "CVE-1", withdrawn_at: null, vulnerabilities: [
            { package: { ecosystem: "npm", name: "tar-lite" }, vulnerable_version_range: ">= 3.0.0, < 3.1.4" },
            { package: { ecosystem: "npm", name: "tar-lite" }, vulnerable_version_range: "< 2.4.1" },
            { package: { ecosystem: "npm", name: "other" }, vulnerable_version_range: "< 9" },
          ] },
          { ghsa_id: "GHSA-dddd-eeee-ffff", withdrawn_at: "2026-01-01", vulnerabilities: [{ package: { ecosystem: "npm", name: "tar-lite" }, vulnerable_version_range: "< 9" }] },
        ]),
    });
    const list = (await provider.advisoriesFor("npm", new Map([["tar-lite", []]]))).get("tar-lite")!;
    assert.deepEqual(list.map((a) => [a.id, a.ranges]), [["GHSA-aaaa-bbbb-cccc", [">= 3.0.0 < 3.1.4", "< 2.4.1"]]]);
  });

  it("merges providers conservatively when they disagree about affected ranges", async () => {
    const fixed = (ranges: string[]): AdvisoryProvider => ({
      id: "x",
      supports: () => true,
      advisoriesFor: async () => new Map<string, Advisory[]>([["p", [{ id: "GHSA-aaaa-bbbb-cccc", aliases: [], package: "p", ranges }]]]),
    });
    const merged = await new CombinedAdvisoryProvider([fixed(["<1.2.0"]), fixed(["<1.3.0"])]).advisoriesFor("npm", new Map([["p", ["1.0.0"]]]));
    assert.deepEqual(merged.get("p")![0]!.ranges, ["<1.2.0", "<1.3.0"]);
  });
});

describe("identities", () => {
  it("are stable and incorporate ecosystem, manifest, package, scope and advisories", () => {
    const a = fixIdentity("npm", "package.json", ["tar-lite"], ["GHSA-b", "GHSA-a"]);
    assert.equal(a, "security-fix|npm|package.json|tar-lite|GHSA-a+GHSA-b");
    assert.equal(branchFor("add-override", ["tar-lite"], a), branchFor("add-override", ["tar-lite"], a));
    assert.notEqual(branchFor("add-override", ["tar-lite"], a), branchFor("add-override", ["tar-lite"], `${a}+GHSA-c`));
    const r = removalIdentity("pnpm", "pnpm-workspace.yaml", "bundler-kit>tar-lite");
    assert.equal(readMarker(`text\n${marker(r)}\n`, "identity"), r);
  });

  it("matches Dependabot and Renovate PRs by package name without false positives", () => {
    const pr = (title: string, branch: string) => ({ url: "u", title, branch, author: "bot" });
    assert.ok(matchExternal([pr("Bump tar-lite from 3.0.5 to 3.1.4", "dependabot/npm_and_yarn/tar-lite-3.1.4")], "tar-lite"));
    assert.ok(matchExternal([pr("Update dependency @scope/pkg to v2", "renovate/scope-pkg-2.x")], "@scope/pkg"));
    assert.equal(matchExternal([pr("Bump tar-lite-extra from 1 to 2", "dependabot/npm_and_yarn/tar-lite-extra-2")], "tar-lite"), undefined);
  });
});
