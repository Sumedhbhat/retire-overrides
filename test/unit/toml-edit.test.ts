import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendToArray, dropEmptyArray, lineOf, removeFromArray, replaceInArray } from "../../src/adapters/uv/toml-edit.ts";

const UV = ["tool", "uv"];
const doc = `[project]
name = "app"
dependencies = ["a>=1", "b[x,y]>=2; python_version < '3.12'"]

# pinned for security
[tool.uv]
override-dependencies = [
    "tar-lite==3.1.4",  # GHSA-2222-3333-4444
    "ms==2.1.1",
]
constraint-dependencies = ["x<2", "y<3"]

[tool.other]
override-dependencies = ["not-this==1"]
`;

describe("TOML array edits", () => {
  it("removes one element from a multi-line array, keeping comments elsewhere", () => {
    const out = removeFromArray(doc, UV, "override-dependencies", "ms==2.1.1");
    assert.match(out, /"tar-lite==3\.1\.4",  # GHSA-2222-3333-4444\n\]/);
    assert.match(out, /# pinned for security/);
    assert.match(out, /\[tool\.other\]\noverride-dependencies = \["not-this==1"\]/);
  });

  it("keeps an element's trailing comment line intact when removing the other one", () => {
    const out = removeFromArray(doc, UV, "override-dependencies", "tar-lite==3.1.4");
    assert.match(out, /override-dependencies = \[\n.*# GHSA-2222-3333-4444\n    "ms==2\.1\.1",\n\]/);
  });

  it("removes from a single-line array and drops the key once empty", () => {
    let out = removeFromArray(doc, UV, "constraint-dependencies", "y<3");
    assert.match(out, /constraint-dependencies = \["x<2"\]/);
    out = dropEmptyArray(removeFromArray(out, UV, "constraint-dependencies", "x<2"), UV, "constraint-dependencies");
    assert.doesNotMatch(out, /constraint-dependencies/);
    assert.match(out, /\[tool\.uv\]\noverride-dependencies/);
  });

  it("appends matching the array's layout, and creates the key or table when missing", () => {
    assert.match(appendToArray(doc, UV, "override-dependencies", "z==1"), /    "ms==2\.1\.1",\n    "z==1",\n\]/);
    assert.match(appendToArray(doc, UV, "constraint-dependencies", "z<1"), /constraint-dependencies = \["x<2", "y<3", "z<1"\]/);
    const bare = '[project]\nname = "app"\n';
    assert.equal(appendToArray(bare, UV, "override-dependencies", "z==1"), '[project]\nname = "app"\n\n[tool.uv]\noverride-dependencies = ["z==1"]\n');
  });

  it("replaces an element with brackets and quotes inside other elements untouched", () => {
    const out = replaceInArray(doc, ["project"], "dependencies", "a>=1", "a>=1.5");
    assert.match(out, /dependencies = \["a>=1\.5", "b\[x,y\]>=2; python_version < '3\.12'"\]/);
  });

  it("refuses edits it cannot verify instead of writing a surprising file", () => {
    assert.throws(() => removeFromArray(doc, UV, "override-dependencies", "missing==1"), /is not in tool\.uv\.override-dependencies/);
  });

  it("finds an element's line for blame", () => {
    assert.equal(lineOf(doc, UV, "override-dependencies", "ms==2.1.1"), 9);
  });
});
