import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Advisory, PackageMetadata } from "../../src/types.ts";
import { bumpSpec, chooseFixedVersion, compatibleLine, parseSpec, permittedVulnerableVersions } from "../../src/versions.ts";

function meta(times: Record<string, string>, deprecated: string[] = []): PackageMetadata {
  const versions: PackageMetadata["versions"] = {};
  for (const v of Object.keys(times)) {
    versions[v] = { version: v, dependencies: {}, optionalDependencies: {}, peerDependencies: {}, ...(deprecated.includes(v) ? { deprecated: "no" } : {}) };
  }
  return { name: "pkg", versions, time: times };
}

const adv = (id: string, ...ranges: string[]): Advisory => ({ id, aliases: [], package: "pkg", ranges });
const now = new Date("2026-03-20T00:00:00Z");

describe("chooseFixedVersion", () => {
  const m = meta({
    "1.0.0": "2025-01-01T00:00:00Z",
    "1.2.3": "2026-01-01T00:00:00Z",
    "1.4.0": "2026-02-01T00:00:00Z",
    "1.4.2": "2026-03-15T00:00:00Z",
    "2.0.0": "2026-01-01T00:00:00Z",
  });

  it("never picks a version inside any affected branch, even when a caret range would allow it", () => {
    const choice = chooseFixedVersion({ metadata: m, advisories: [adv("A", "<1.2.3", ">=1.4.0 <1.4.2")], current: "1.0.0", now, minAgeDays: 14 });
    assert.deepEqual(choice, { version: "1.2.3", major: false, mature: true });
  });

  it("prefers the newest mature release on the current line", () => {
    const choice = chooseFixedVersion({ metadata: m, advisories: [adv("A", "<1.2.3")], current: "1.0.0", now, minAgeDays: 14 });
    assert.equal(choice?.version, "1.4.0");
  });

  it("uses a young release when it is the only fix (security fixes skip the wait)", () => {
    const choice = chooseFixedVersion({ metadata: m, advisories: [adv("A", "<1.4.2")], current: "1.0.0", now, minAgeDays: 14 });
    assert.deepEqual(choice, { version: "1.4.2", major: false, mature: false });
  });

  it("flags a major change when no release on the current line is safe", () => {
    const choice = chooseFixedVersion({ metadata: m, advisories: [adv("A", "<2.0.0")], current: "1.0.0", now, minAgeDays: 14 });
    assert.deepEqual(choice, { version: "2.0.0", major: true, mature: true });
  });

  it("accounts for every advisory, not just the one being fixed", () => {
    const choice = chooseFixedVersion({ metadata: m, advisories: [adv("A", "<1.2.3"), adv("B", ">=1.2.0 <2.0.0")], current: "1.0.0", now, minAgeDays: 14 });
    assert.equal(choice?.version, "2.0.0");
  });

  it("skips deprecated releases and never downgrades", () => {
    const d = meta({ "1.0.0": "2025-01-01T00:00:00Z", "1.1.0": "2025-02-01T00:00:00Z", "1.2.0": "2025-03-01T00:00:00Z" }, ["1.2.0"]);
    assert.equal(chooseFixedVersion({ metadata: d, advisories: [adv("A", "<1.1.0")], current: "1.0.0", now, minAgeDays: 14 })?.version, "1.1.0");
    assert.equal(chooseFixedVersion({ metadata: d, advisories: [adv("A", ">=1.1.0")], current: "1.1.0", now, minAgeDays: 14 }), null);
  });

  it("ignores releases published after the evaluation clock", () => {
    const future = meta({ "1.0.0": "2025-01-01T00:00:00Z", "1.0.1": "2026-04-01T00:00:00Z" });
    assert.equal(chooseFixedVersion({ metadata: future, advisories: [adv("A", "<1.0.1")], current: "1.0.0", now, minAgeDays: 0 }), null);
  });
});

describe("version helpers", () => {
  it("treats 0.x minors as separate compatible lines", () => {
    assert.equal(compatibleLine("0.3.4"), "0.3");
    assert.equal(compatibleLine("3.0.5"), "3");
  });

  it("finds published versions a parent range still permits", () => {
    const m = meta({ "3.0.0": "x", "3.0.5": "x", "3.1.4": "x" });
    assert.deepEqual(permittedVulnerableVersions("^3.0.0", m, [adv("A", "<3.1.4")]), ["3.0.0", "3.0.5"]);
    assert.deepEqual(permittedVulnerableVersions("^3.1.4", m, [adv("A", "<3.1.4")]), []);
  });

  it("parses aliases and rejects non-registry specs", () => {
    assert.deepEqual(parseSpec("x", "npm:real@^1.0.0"), { name: "real", range: "^1.0.0" });
    assert.equal(parseSpec("x", "github:o/r"), null);
    assert.equal(parseSpec("x", "file:../x"), null);
    assert.equal(parseSpec("x", "workspace:*"), null);
  });

  it("keeps the operator style when bumping a spec", () => {
    assert.equal(bumpSpec("~2.4.0", "2.5.1"), "~2.5.1");
    assert.equal(bumpSpec("2.4.0", "2.5.0"), "2.5.0");
    assert.equal(bumpSpec(">=1 <3", "2.5.0"), "^2.5.0");
  });
});
