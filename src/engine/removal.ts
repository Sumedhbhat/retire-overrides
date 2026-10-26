import type { ImplementedAdapter, Project } from "../adapters/adapter.ts";
import { diffWorktree, withScratch } from "../git.ts";
import { addedVersions, formatPath, incomingEdges, instancesOf } from "../graph.ts";
import { schemeFor } from "../schemes.ts";
import type { Advisory, EcosystemId, OverrideEntry, PackageMetadata, Reason, ResolvedGraph } from "../types.ts";
import {
  affectingAdvisories,
  ageInDays,
  availableVersions,
  isMajorChange,
  maxSatisfying,
  parseSpec,
  permittedVulnerableVersions,
} from "../versions.ts";
import { advisoryRefs, type EngineContext, errorMessage, type Finding, findingKey } from "./context.ts";
import { removalIdentity, staleIdentity } from "./identity.ts";
import { intentAndProvenance } from "./provenance.ts";
import { buildRemovalChange, buildStaleIssue } from "./changes.ts";
import type {
  ConstraintEvidence,
  InstanceEvidence,
  OverrideReport,
  PlannedChange,
  PlannedIssue,
  VersionEvidence,
} from "./report.ts";
import { worst } from "./report.ts";
import { tail } from "../exec.ts";

export interface Baseline {
  /** Graph from the committed lockfile. */
  locked: ResolvedGraph;
  /** Graph after resolving the unchanged commit again; an Error if that failed. */
  resolved: ResolvedGraph | Error;
  findings: Finding[] | Error;
  lockfileStale: boolean;
}

export interface RemovalResult {
  report: OverrideReport;
  kept: boolean;
  change?: PlannedChange;
  issue?: PlannedIssue;
  conclusive: string[];
}

/** Removes one override in isolation, resolves again without trusting the lockfile, and judges the result. */
export async function evaluateRemoval(
  ctx: EngineContext,
  adapter: ImplementedAdapter,
  project: Project,
  baseDir: string,
  entry: OverrideEntry,
  baseline: Baseline,
  projectBlockers: string[],
): Promise<RemovalResult> {
  const identity = removalIdentity(entry.ecosystem, entry.file, entry.selector);
  const sch = schemeFor(entry.ecosystem);
  const { intent, provenance } = await intentAndProvenance(ctx, adapter, project, baseDir, entry);
  const report: OverrideReport = {
    identity,
    ecosystem: entry.ecosystem,
    project: project.dir,
    file: entry.file,
    selector: entry.selector,
    target: entry.target,
    scope: entry.scope,
    value: entry.value,
    intent,
    provenance,
    status: "REMOVABLE",
    reasons: [],
    evidence: { advisories: [], lockfileStale: baseline.lockfileStale },
  };
  if (provenance.date) report.evidence.overrideAgeDays = Math.floor(ageInDays(provenance.date, ctx.now));
  if (intent.kind === "keep") {
    report.reasons.push({ code: "keep-list", message: `kept by configuration${intent.reason ? `: ${intent.reason}` : ""}` });
    return { report, kept: true, conclusive: [] };
  }

  const block = (code: string, message: string) => {
    report.status = worst(report.status, "BLOCKED");
    report.reasons.push({ code, message });
  };
  const need = (code: string, message: string) => {
    report.status = worst(report.status, "NEEDED");
    report.reasons.push({ code, message });
  };

  for (const blocker of projectBlockers) block("project-blocked", blocker);
  if (report.status === "BLOCKED") return { report, kept: false, conclusive: [] };

  let advisories: Advisory[];
  let targetMeta: PackageMetadata;
  try {
    targetMeta = await ctx.package(entry.ecosystem, entry.target.name);
    advisories = await ctx.allAdvisories(entry.ecosystem, entry.target.name);
  } catch (error) {
    block("metadata-unavailable", errorMessage(error));
    return { report, kept: false, conclusive: [] };
  }
  report.evidence.advisories = advisoryRefs(advisories);
  if (baseline.resolved instanceof Error) {
    block("baseline-resolution-failed", `resolving the unchanged commit failed: ${baseline.resolved.message}`);
    return { report, kept: false, conclusive: [] };
  }
  if (baseline.findings instanceof Error) {
    block("advisory-data-unavailable", baseline.findings.message);
    return { report, kept: false, conclusive: [] };
  }
  const before = baseline.resolved;
  const beforeFindings = new Set(baseline.findings.map(findingKey));

  let result: { graph: ResolvedGraph; patch: string; files: string[] } | Error;
  result = await withScratch(ctx.options.repo, ctx.options.commit, async (dir) => {
    try {
      await adapter.removeOverride(project, dir, entry);
      const options = { refresh: [entry.target.name], ...registryOption(ctx) };
      await adapter.resolve(project, dir, options);
      const graph = await adapter.readGraph(project, dir);
      return { graph, ...(await diffWorktree(dir)) };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });
  if (result instanceof Error) {
    block("resolution-failed", `resolving without the override failed: ${tail(result.message, 6)}`);
    return { report, kept: false, conclusive: [] };
  }
  const after = result.graph;
  ctx.seen(after, entry.ecosystem);

  // 1. Every resolved copy of the package that the override governed, on every path, must be outside
  //    all affected ranges. Copies the override never reached are judged by the vulnerability scan.
  const instances: InstanceEvidence[] = [];
  const governedParents = new Map<string, Set<string> | "all">();
  for (const instance of instancesOf(after, entry.target.name)) {
    const governed = instance.paths.filter((p) => adapter.overrideApplies(entry, p));
    const parents: Set<string> | "all" = instance.pathsTruncated
      ? "all"
      : new Set(governed.map((p) => parentKey(p.steps.at(-2), p.importer)));
    governedParents.set(instance.nodeKey, parents);
    const hits = affectingAdvisories(instance.version, advisories, sch).map((a) => a.id);
    instances.push({
      version: instance.version,
      affectedBy: hits,
      paths: instance.paths.map(formatPath),
      pathsTruncated: instance.pathsTruncated,
    });
    if (hits.length > 0 && (parents === "all" || parents.size > 0)) {
      need("vulnerable-without-override", `${entry.target.name}@${instance.version} would be installed, affected by ${hits.join(", ")}`);
    }
  }
  report.evidence.instancesWithoutOverride = instances;

  // 2. Parent constraints on governed paths must no longer permit any known vulnerable version.
  const constraints: ConstraintEvidence[] = [];
  const upstream: string[] = [];
  for (const node of [...after.nodes.values()].filter((n) => n.name === entry.target.name && n.importer === undefined)) {
    const parents = governedParents.get(node.key) ?? "all";
    for (const edge of incomingEdges(after, node.key)) {
      const key = edge.parent.importer !== undefined ? `importer:${edge.parent.importer}` : `${edge.parent.name}@${edge.parent.version}`;
      if (parents !== "all" && !parents.has(key)) continue;
      const parentLabel = edge.parent.importer !== undefined ? `${edge.parent.importer || "(root)"} (direct)` : `${edge.parent.name}@${edge.parent.version}`;
      let declared: string | undefined;
      try {
        declared = await ctx.declaredRange(entry.ecosystem, edge.parent, edge.as);
      } catch (error) {
        block("metadata-unavailable", `cannot read ${parentLabel}'s declared range for ${edge.as}: ${errorMessage(error)}`);
        continue;
      }
      if (declared === undefined) {
        block("constraint-unknown", `${parentLabel} has no recorded range for ${edge.as}`);
        continue;
      }
      const spec = parseSpec(edge.as, declared, sch);
      if (spec === null) {
        block("constraint-unparseable", `${parentLabel} declares ${edge.as}@"${declared}", which is not a registry range`);
        continue;
      }
      // A peer range doesn't pick a version: the copy comes from another edge (checked on its own) or
      // from auto-install, which takes the highest satisfying release. Judge peers by that pick.
      const peer = await ctx.isPeerEdge(entry.ecosystem, edge.parent, edge.as).catch(() => false);
      let permits = permittedVulnerableVersions(spec.range, targetMeta, advisories, sch);
      if (peer) {
        const pick = maxSatisfying(targetMeta, spec.range, ctx.now, sch);
        permits = pick !== null && permits.includes(pick) ? [pick] : [];
      }
      constraints.push({ parent: parentLabel, dependency: edge.as, range: declared, permitsVulnerable: permits, ...(peer ? { peer: true } : {}) });
      if (permits.length > 0) {
        need(
          "parent-permits-vulnerable",
          `${parentLabel} declares ${edge.as}@${declared}, which still permits vulnerable ${summarizeVersions(permits)}`,
        );
        if (edge.parent.importer === undefined) {
          const context = await upstreamContext(ctx, entry.ecosystem, edge.parent.name, edge.as).catch(() => undefined);
          if (context) upstream.push(context);
        }
      }
    }
  }
  report.evidence.parentConstraints = constraints;
  if (upstream.length > 0) report.evidence.upstream = [...new Set(upstream)];

  // 3. The whole resolved graph must not gain any known vulnerability.
  try {
    const afterFindings = await ctx.audit(entry.ecosystem, after);
    const introduced = afterFindings.filter((f) => !beforeFindings.has(findingKey(f)));
    report.evidence.introducedVulnerabilities = introduced.map(findingKey);
    if (introduced.length > 0) {
      need("introduces-vulnerability", `removal would introduce ${introduced.map(findingKey).join(", ")}`);
    }
  } catch (error) {
    block("advisory-data-unavailable", `audit after removal failed: ${errorMessage(error)}`);
  }

  // 4. Anything newly resolved is an ordinary upgrade and must respect the release-age wait.
  const changed: VersionEvidence[] = [];
  const blockers: string[] = [];
  const added = addedVersions(before, after);
  const young: string[] = [];
  for (const { name, version } of added) {
    const evidence: VersionEvidence = { name, version };
    try {
      const meta = await ctx.package(entry.ecosystem, name);
      const published = meta.time[version];
      if (published === undefined) {
        block("release-date-unknown", `no publish time for ${name}@${version}`);
      } else {
        evidence.published = published;
        evidence.ageDays = Math.floor(ageInDays(published, ctx.now) * 10) / 10;
        if (ageInDays(published, ctx.now) < ctx.config.minimumReleaseAgeDays) {
          report.status = worst(report.status, "WAITING");
          young.push(`${name}@${version} (${evidence.ageDays} days)`);
        }
      }
    } catch (error) {
      block("metadata-unavailable", `cannot read release date for ${name}@${version}: ${errorMessage(error)}`);
    }
    changed.push(evidence);
    const previous = [...before.nodes.values()].filter((n) => n.name === name && n.importer === undefined).map((n) => n.version);
    if (previous.length > 0 && previous.every((p) => isMajorChange(p, version, sch))) {
      blockers.push(`${name} moves from ${[...new Set(previous)].join(", ")} to ${version}, a major-version change`);
    }
  }
  report.evidence.changedVersions = changed;
  if (young.length > 0) {
    // One reason for all of them; the full list with ages is in evidence.changedVersions.
    const shown = young.slice(0, 5).join(", ");
    report.reasons.push({
      code: "release-too-new",
      message: `${young.length} newly resolved version${young.length === 1 ? " is" : "s are"} younger than ${ctx.config.minimumReleaseAgeDays} days: ${shown}${young.length > 5 ? ` and ${young.length - 5} more` : ""}`,
    });
  }
  const limitation = adapter.refreshLimitation?.(project);
  if (limitation) report.evidence.refreshLimitation = limitation;

  // Unknown intent never leads to an automatic removal.
  if ((report.status === "REMOVABLE" || report.status === "WAITING") && intent.kind === "unknown") {
    report.technicalStatus = report.status;
    report.status = "REVIEW_NEEDED";
    report.reasons.push(intentReason(report.technicalStatus));
  }

  const out: RemovalResult = { report, kept: false, conclusive: [] };
  if (report.status !== "BLOCKED") out.conclusive.push(identity, staleIdentity(entry.ecosystem, entry.file, entry.selector));
  if (report.status === "REMOVABLE") {
    out.change = buildRemovalChange(ctx, report, result.patch, result.files, blockers);
    report.change = out.change.identity;
  }
  const ageDays = report.evidence.overrideAgeDays;
  if (report.status === "NEEDED" && ageDays !== undefined && ageDays >= ctx.config.staleAfterDays) {
    out.issue = buildStaleIssue(ctx, report);
    report.issue = out.issue.identity;
  }
  return out;
}

function parentKey(step: { name: string; version: string } | undefined, importer: string): string {
  return step === undefined ? `importer:${importer}` : `${step.name}@${step.version}`;
}

function intentReason(technical: string): Reason {
  return {
    code: "intent-unknown",
    message: `technically ${technical}, but this override was not created by retire-overrides and is not opted in via \`manage\`; review it, then add it to \`manage\` or \`keep\``,
  };
}

export function registryOption(ctx: EngineContext): { registry?: string } {
  return ctx.options.packageManagerRegistry ? { registry: ctx.options.packageManagerRegistry } : {};
}

function summarizeVersions(versions: string[]): string {
  const shown = versions.slice(0, 5).join(", ");
  return versions.length > 5 ? `${shown} and ${versions.length - 5} more` : shown;
}

/** What the newest release of a parent declares for the dependency, for stale-override issues. */
async function upstreamContext(ctx: EngineContext, ecosystem: EcosystemId, parent: string, dep: string): Promise<string> {
  const meta = await ctx.package(ecosystem, parent);
  const sch = schemeFor(ecosystem);
  const latest = availableVersions(meta, ctx.now, sch).filter((v) => !sch.isPrerelease(v)).at(-1);
  if (latest === undefined) return `${parent}: no published release found`;
  const v = await ctx.versionMeta(ecosystem, parent, latest);
  const range = v?.dependencies[dep] ?? v?.optionalDependencies[dep] ?? v?.peerDependencies[dep];
  const published = meta.time[latest] ? ` (published ${meta.time[latest]!.slice(0, 10)})` : "";
  const repo = meta.repository ? `; source: ${meta.repository}` : "";
  return range === undefined
    ? `latest ${parent}@${latest}${published} no longer depends on ${dep}${repo}`
    : `latest ${parent}@${latest}${published} declares ${dep}@${range}${repo}`;
}
