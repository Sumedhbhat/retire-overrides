import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventsToRanges, OsvAdvisoryProvider } from "../../src/advisories/osv.ts";
import { AdvisoryDataUnavailableError } from "../../src/advisories/providers.ts";
import { SEMVER } from "../../src/schemes.ts";

const vuln = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  aliases: ["CVE-2026-1"],
  summary: `summary of ${id}`,
  affected: [{ package: { ecosystem: "npm", name: "tar-lite" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "3.1.4" }] }] }],
  ...extra,
});

/** A minimal osv.dev: answers querybatch, query and vulns/{id} from a fixed set of records. */
function fakeOsv(records: Array<ReturnType<typeof vuln>>, calls: string[] = []) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    if (url.pathname === "/v1/querybatch") {
      return Response.json({ results: body.queries.map(() => ({ vulns: records.map((r) => ({ id: r.id })) })) });
    }
    if (url.pathname === "/v1/query") return Response.json({ vulns: records });
    const id = decodeURIComponent(url.pathname.replace("/v1/vulns/", ""));
    const record = records.find((r) => r.id === id);
    return record ? Response.json(record) : new Response("not found", { status: 404 });
  };
}

describe("OSV", () => {
  it("turns events into one range per affected branch", () => {
    assert.deepEqual(
      eventsToRanges([{ introduced: "0" }, { fixed: "2.4.1" }, { introduced: "3.0.0" }, { fixed: "3.1.4" }, { introduced: "4.0.0" }], SEMVER),
      ["<2.4.1", ">=3.0.0 <3.1.4", ">=4.0.0"],
    );
    assert.deepEqual(eventsToRanges([{ introduced: "1.0.0" }, { last_affected: "1.2.0" }], SEMVER), [">=1.0.0 <=1.2.0"]);
  });

  it("prefers the GHSA alias as the ID, batches small queries and fetches each record once", async () => {
    const calls: string[] = [];
    const provider = new OsvAdvisoryProvider({ fetch: fakeOsv([vuln("PYSEC-1", { aliases: ["GHSA-jf85-cpcp-j695"] })], calls) });
    const result = await provider.advisoriesFor("npm", new Map([["tar-lite", ["3.0.5", "3.0.0"]]]));
    const [a] = result.get("tar-lite")!;
    assert.equal(a!.id, "GHSA-jf85-cpcp-j695");
    assert.deepEqual(a!.aliases, ["PYSEC-1"]);
    assert.deepEqual(a!.ranges, ["<3.1.4"]);
    assert.deepEqual(calls, ["/v1/querybatch", "/v1/vulns/PYSEC-1"]);
  });

  it("merges a record and its GHSA alias into one advisory", async () => {
    const provider = new OsvAdvisoryProvider({
      fetch: fakeOsv([vuln("PYSEC-2026-1", { aliases: ["GHSA-jf85-cpcp-j695"] }), vuln("GHSA-jf85-cpcp-j695", { aliases: ["PYSEC-2026-1"] })]),
    });
    const list = (await provider.advisoriesFor("npm", new Map([["tar-lite", ["3.0.5"]]]))).get("tar-lite")!;
    assert.deepEqual(list.map((a) => a.id), ["GHSA-jf85-cpcp-j695"]);
  });

  it("uses one package-wide query when asked about every version, however few", async () => {
    const calls: string[] = [];
    const provider = new OsvAdvisoryProvider({ fetch: fakeOsv([vuln("GHSA-aaaa-bbbb-cccc")], calls) });
    const result = await provider.advisoriesFor("pnpm", new Map([["tar-lite", ["3.0.0", "3.0.5"]]]), { allVersions: true });
    assert.equal(result.get("tar-lite")!.length, 1);
    assert.deepEqual(calls, ["/v1/query"]);
    calls.length = 0;
    const many = Array.from({ length: 80 }, (_, i) => `3.0.${i}`);
    await provider.advisoriesFor("pnpm", new Map([["tar-lite", many]]));
    assert.deepEqual(calls, ["/v1/query"]);
  });

  it("treats explicitly listed versions as affected alongside ranges", async () => {
    const record = vuln("GHSA-aaaa-bbbb-cccc", {
      affected: [{ package: { ecosystem: "npm", name: "tar-lite" }, ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "2.0.0" }] }], versions: ["3.0.0"] }],
    });
    const provider = new OsvAdvisoryProvider({ fetch: fakeOsv([record]) });
    const [a] = (await provider.advisoriesFor("npm", new Map([["tar-lite", ["3.0.0"]]]))).get("tar-lite")!;
    assert.deepEqual(a!.ranges, [">=1.0.0 <2.0.0", "3.0.0"]);
  });

  it("skips withdrawn records and refuses records with only git ranges", async () => {
    const withdrawn = new OsvAdvisoryProvider({ fetch: fakeOsv([vuln("GHSA-aaaa-bbbb-cccc", { withdrawn: "2026-01-01" })]) });
    assert.deepEqual((await withdrawn.advisoriesFor("npm", new Map([["tar-lite", ["3.0.5"]]]))).get("tar-lite"), []);
    const gitOnly = new OsvAdvisoryProvider({
      fetch: fakeOsv([vuln("GHSA-aaaa-bbbb-cccc", { affected: [{ package: { ecosystem: "npm", name: "tar-lite" }, ranges: [{ type: "GIT", events: [] }] }] })]),
    });
    await assert.rejects(gitOnly.advisoriesFor("npm", new Map([["tar-lite", ["3.0.5"]]])), AdvisoryDataUnavailableError);
  });

  it("fails loudly when osv.dev is down", async () => {
    const provider = new OsvAdvisoryProvider({ fetch: async () => new Response("down", { status: 503 }) });
    await assert.rejects(provider.advisoriesFor("npm", new Map([["x", ["1.0.0"]]])), AdvisoryDataUnavailableError);
  });
});
