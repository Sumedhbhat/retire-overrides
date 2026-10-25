import { createHash } from "node:crypto";
import type { EcosystemId } from "../types.ts";
import type { ChangeKind } from "./report.ts";

export const BRANCH_PREFIX = "retire-overrides/";

export function removalIdentity(ecosystem: EcosystemId, file: string, selector: string): string {
  return ["remove-override", ecosystem, file, selector].join("|");
}

export function fixGroupKey(ecosystem: EcosystemId, manifest: string, packages: string[]): string {
  return ["security-fix", ecosystem, manifest, [...packages].sort().join("+")].join("|");
}

export function fixIdentity(ecosystem: EcosystemId, manifest: string, packages: string[], advisories: string[]): string {
  return [fixGroupKey(ecosystem, manifest, packages), [...advisories].sort().join("+")].join("|");
}

export function staleIdentity(ecosystem: EcosystemId, file: string, selector: string): string {
  return ["stale-override", ecosystem, file, selector].join("|");
}

/** The selector trailer value that ties a commit to one override. */
export function selectorKey(ecosystem: EcosystemId, file: string, selector: string): string {
  return `${ecosystem}:${file}:${selector}`;
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

export function branchFor(kind: ChangeKind, packages: string[], identity: string): string {
  const slug = packages
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${BRANCH_PREFIX}${kind}/${slug}-${shortHash(identity)}`;
}

export function marker(identity: string): string {
  return `<!-- retire-overrides:identity=${identity} -->`;
}

export function groupMarker(groupKey: string): string {
  return `<!-- retire-overrides:group=${groupKey} -->`;
}

export function readMarker(body: string | null | undefined, kind: "identity" | "group"): string | undefined {
  if (!body) return undefined;
  const m = new RegExp(`<!-- retire-overrides:${kind}=(.+?) -->`).exec(body);
  return m?.[1];
}
