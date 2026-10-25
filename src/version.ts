import { readFileSync } from "node:fs";

declare const __RETIRE_OVERRIDES_VERSION__: string | undefined;

/**
 * The tool's version. Bundles get it from package.json at build time; release builds append the
 * nightly suffix. The action ref (when run as an action or reusable workflow) is appended so users
 * can always see exactly what ran.
 */
export function toolVersion(): string {
  const base =
    typeof __RETIRE_OVERRIDES_VERSION__ === "string"
      ? __RETIRE_OVERRIDES_VERSION__
      : (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const ref = process.env.RETIRE_OVERRIDES_REF;
  return ref ? `${base} (${ref})` : base;
}
