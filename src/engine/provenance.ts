import type { ImplementedAdapter, Project } from "../adapters/adapter.ts";
import { findMatch } from "../config.ts";
import { blameLine, type CommitInfo, toolCommits, TRAILER } from "../git.ts";
import type { OverrideEntry, OverrideIntent, Provenance } from "../types.ts";
import type { EngineContext } from "./context.ts";
import { selectorKey } from "./identity.ts";

const commitCache = new Map<string, Promise<CommitInfo[]>>();

/**
 * Works out why an override exists without a ledger: the keep list first, then commits this tool made
 * (identified by trailers), then the explicit `manage` opt-in. Anything else has unknown intent.
 */
export async function intentAndProvenance(
  ctx: EngineContext,
  adapter: ImplementedAdapter,
  project: Project,
  dir: string,
  entry: OverrideEntry,
): Promise<{ intent: OverrideIntent; provenance: Provenance }> {
  const repo = ctx.options.repo;
  const cacheKey = `${repo}\0${ctx.options.commit}\0${entry.file}`;
  let commits = commitCache.get(cacheKey);
  if (commits === undefined) {
    commits = toolCommits(repo, entry.file);
    commitCache.set(cacheKey, commits);
  }
  const key = selectorKey(entry.ecosystem, entry.file, entry.selector);
  let added: CommitInfo | undefined;
  let latestAction: string | undefined;
  for (const commit of await commits) {
    if (!(commit.trailers.get(TRAILER.selector) ?? []).includes(key)) continue;
    const action = commit.trailers.get(TRAILER.action)?.[0];
    latestAction ??= action;
    if (action === "remove-override") break;
    if (action === "add-override" || action === "update-override") added = commit;
  }

  let provenance: Provenance;
  if (added && latestAction !== "remove-override") {
    provenance = { source: "trailer", commit: added.sha, author: added.author, date: added.date };
  } else {
    const line = await adapter.locate(project, dir, entry).catch(() => undefined);
    const blame = line === undefined ? undefined : await blameLine(repo, entry.file, line);
    provenance = blame ? { source: "blame", ...blame } : { source: "unavailable" };
  }

  const keep = findMatch(ctx.config.keep, entry);
  if (keep) return { intent: keep.reason ? { kind: "keep", reason: keep.reason } : { kind: "keep" }, provenance };
  if (added && latestAction !== "remove-override") {
    const advisories = [...(await commits)]
      .filter((c) => (c.trailers.get(TRAILER.selector) ?? []).includes(key))
      .flatMap((c) => c.trailers.get(TRAILER.advisory) ?? []);
    return {
      intent: { kind: "tool", commit: added.sha, advisories: [...new Set(advisories)].sort(), date: added.date },
      provenance,
    };
  }
  if (findMatch(ctx.config.manage, entry)) return { intent: { kind: "managed", source: "config" }, provenance };
  return { intent: { kind: "unknown" }, provenance };
}
