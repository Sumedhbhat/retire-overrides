import { schemeFor } from "../schemes.ts";
import type { ImplementedAdapter, OverrideWrite, Project } from "../adapters/adapter.ts";
import { tail } from "../exec.ts";
import { diffWorktree, withScratch } from "../git.ts";
import { addedVersions, type Edge, formatPath, incomingEdges, instancesOf } from "../graph.ts";
import { declaredRangeIn } from "../registry/registry.ts";
import type { Advisory, EcosystemId, Instance, OverrideEntry, PackageMetadata, PackageSelector, Reason, ResolvedGraph } from "../types.ts";
import {
  affectingAdvisories,
  ageInDays,
  availableVersions,
  bumpSpec,
  chooseFixedVersion,
  compatibleLine,
  isAffectedBy,
  isMajorChange,
  maxSatisfying,
  parseSpec,
} from "../versions.ts";
import { alertRef, alertsFor } from "./alerts.ts";
import { buildFixChange } from "./changes.ts";
import { advisoryRefs, type EngineContext, errorMessage, type ExternalChange, type Finding, findingKey } from "./context.ts";
import { fixGroupKey, fixIdentity, selectorKey } from "./identity.ts";
import { registryOption } from "./removal.ts";
import type { FixAttempt, FixStrategy, PlannedChange, VersionEvidence, VulnerabilityReport } from "./report.ts";

const MAX_PARENT_DEPTH = 4;

interface Group {
  name: string;
  findings: Finding[];
}

export interface FixResult {
  report: VulnerabilityReport;
  change?: PlannedChange;
  /** What the change does, kept so identical changes for several packages can be merged. */
  plan?: { summary: string; manifest: string };
  conclusive: string[];
}

/** Plans one change per vulnerable package, trying the smallest fix first and verifying each attempt. */
export async function planFixes(
  ctx: EngineContext,
  adapter: ImplementedAdapter,
  project: Project,
  locked: ResolvedGraph,
  findings: Finding[],
  base: ResolvedGraph,
  entries: OverrideEntry[],
): Promise<FixResult[]> {
  const groups = new Map<string, Group>();
  for (const f of findings) {
    const g = groups.get(f.name) ?? { name: f.name, findings: [] };
    g.findings.push(f);
    groups.set(f.name, g);
  }
  const results: FixResult[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    ctx.log(`  fix: ${group.name}`);
    results.push(await planGroup(ctx, adapter, project, locked, findings, base, entries, group));
  }
  return mergeIdenticalChanges(ctx, results);
}

async function planGroup(
  ctx: EngineContext,
  adapter: ImplementedAdapter,
  project: Project,
  locked: ResolvedGraph,
  lockedFindings: Finding[],
  base: ResolvedGraph,
  entries: OverrideEntry[],
  group: Group,
): Promise<FixResult> {
  const advisoryIds = [...new Set(group.findings.map((f) => f.advisory))].sort();
  const identity = fixIdentity(project.ecosystem, project.manifest, [group.name], advisoryIds);
  const groupKey = fixGroupKey(project.ecosystem, project.manifest, [group.name]);
  const sch = schemeFor(project.ecosystem);
  const vulnerable = instancesOf(locked, group.name).filter((i) => group.findings.some((f) => f.version === i.version));
  const report: VulnerabilityReport = {
    identity,
    ecosystem: project.ecosystem,
    project: project.dir,
    package: group.name,
    advisories: [],
    instances: vulnerable.map((i) => ({
      version: i.version,
      affectedBy: group.findings.filter((f) => f.version === i.version).map((f) => f.advisory),
      paths: i.paths.map(formatPath),
      pathsTruncated: i.pathsTruncated,
    })),
    status: "BLOCKED",
    attempts: [],
    reasons: [],
  };

  let advisories: Advisory[];
  let meta: PackageMetadata;
  try {
    meta = await ctx.package(group.name);
    advisories = await ctx.allAdvisories(project.ecosystem, group.name);
  } catch (error) {
    report.reasons.push({ code: "metadata-unavailable", message: errorMessage(error) });
    return { report, conclusive: [] };
  }
  report.advisories = advisoryRefs(advisories.filter((a) => advisoryIds.includes(a.id)));
  if (ctx.options.alerts?.status === "available") {
    const matched = alertsFor(ctx.options.alerts.alerts, ctx.projects, project.ecosystem, project.dir, group.name, advisoryIds);
    if (matched.length > 0) report.alerts = matched.map(alertRef).sort((a, b) => a.number - b.number);
  }

  const deferral = matchExternal(ctx.options.externalChanges ?? [], group.name);
  if (deferral) {
    report.status = "DEFERRED";
    report.deferredTo = deferral.url;
    report.reasons.push({ code: "existing-pr", message: `${deferral.author} already has an open PR touching ${group.name}: ${deferral.url}` });
    return { report, conclusive: [] };
  }

  if (!vulnerable.some((i) => chooseFixedVersion({ metadata: meta, advisories, current: i.version, now: ctx.now, minAgeDays: 0, scheme: sch }) !== null)) {
    report.reasons.push({
      code: "no-fixed-version",
      message: `no published ${group.name} release is outside every known affected range; an override cannot help — replace the package or assess reachability`,
    });
    return { report, conclusive: [groupKey] };
  }

  const plain = (version: string) => !advisories.some((a) => isAffectedBy(version, a, sch));
  const verifyInput = { ctx, adapter, project, lockedFindings, base, name: group.name, advisories };
  const planner: Planner = { ctx, adapter, project };
  const strategies: Array<[FixStrategy, () => Promise<Candidate | Reason>]> = [
    ["override-update", () => overrideUpdate(planner, entries, vulnerable, meta, advisories)],
    ["lockfile-refresh", () => normalFix(planner, locked, vulnerable, group.name, plain, true)],
    ["parent-update", () => normalFix(planner, locked, vulnerable, group.name, plain, false)],
    ["override", () => addOverride(planner, locked, vulnerable, meta, advisories)],
  ];
  for (const [strategy, plan] of strategies) {
    let candidate: Candidate | Reason;
    try {
      candidate = await plan();
    } catch (error) {
      candidate = { code: "planning-failed", message: errorMessage(error) };
    }
    if ("code" in candidate) {
      report.attempts.push({ strategy, outcome: "not-applicable", reasons: [candidate] });
      if (strategy === "override-update" && candidate.code !== "no-governing-override") break;
      continue;
    }
    const verdict = await verify(verifyInput, candidate);
    report.attempts.push({ strategy, outcome: verdict.ok ? "fixed" : "failed", reasons: verdict.reasons });
    if (!verdict.ok) {
      if (strategy === "override-update") break;
      continue;
    }
    report.status = verdict.blockers.length > 0 ? "REVIEW_NEEDED" : "PROPOSED";
    report.strategy = strategy;
    const change = buildFixChange(ctx, {
      kind: candidate.kind,
      identity,
      groupKey,
      vulnerabilities: [report],
      summary: candidate.summary,
      details: candidate.details,
      selectors: candidate.selectors,
      changedVersions: verdict.changed,
      autoMergeBlockers: verdict.blockers,
      major: verdict.major,
      patch: verdict.patch,
      files: verdict.files,
    });
    report.change = change.identity;
    return { report, change, plan: { summary: candidate.summary, manifest: project.manifest }, conclusive: [groupKey] };
  }
  report.reasons.push({ code: "no-working-fix", message: "every strategy failed verification; see attempts" });
  return { report, conclusive: [] };
}

interface Planner {
  ctx: EngineContext;
  adapter: ImplementedAdapter;
  project: Project;
}

interface Candidate {
  kind: "update-override" | "lockfile-refresh" | "parent-update" | "add-override";
  summary: string;
  details: string[];
  selectors: string[];
  /** Packages whose bumps are part of the security fix (exempt from the release-age wait). */
  intended: string[];
  apply(dir: string): Promise<string[]>;
  major: boolean;
}

interface VerifyInput {
  ctx: EngineContext;
  adapter: ImplementedAdapter;
  project: Project;
  lockedFindings: Finding[];
  base: ResolvedGraph;
  name: string;
  advisories: Advisory[];
}

interface Verdict {
  ok: boolean;
  reasons: Reason[];
  blockers: string[];
  changed: VersionEvidence[];
  major: boolean;
  patch: string;
  files: string[];
}

/** Applies a candidate in a scratch worktree, resolves, and checks every copy, the audit, and release ages. */
async function verify(input: VerifyInput, candidate: Candidate): Promise<Verdict> {
  const { ctx, adapter, project } = input;
  const verdict: Verdict = { ok: false, reasons: [], blockers: [], changed: [], major: candidate.major, patch: "", files: [] };
  const outcome = await withScratch(ctx.options.repo, ctx.options.commit, async (dir) => {
    try {
      const refresh = await candidate.apply(dir);
      await adapter.resolve(project, dir, { refresh, fullRefreshAllowed: true, ...registryOption(ctx) });
      const graph = await adapter.readGraph(project, dir);
      return { graph, ...(await diffWorktree(dir)) };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });
  if (outcome instanceof Error) {
    verdict.reasons.push({ code: "resolution-failed", message: tail(outcome.message, 6) });
    return verdict;
  }
  ctx.seen(outcome.graph);
  const still = instancesOf(outcome.graph, input.name).filter((i) => affectingAdvisories(i.version, input.advisories, schemeFor(project.ecosystem)).length > 0);
  for (const i of still) {
    verdict.reasons.push({
      code: "still-vulnerable",
      message: `${input.name}@${i.version} remains via ${i.paths.slice(0, 3).map(formatPath).join("; ")}`,
    });
  }
  try {
    const before = new Set(input.lockedFindings.map(findingKey));
    const introduced = (await ctx.audit(project.ecosystem, outcome.graph)).filter((f) => !before.has(findingKey(f)));
    for (const f of introduced) verdict.reasons.push({ code: "introduces-vulnerability", message: findingKey(f) });
  } catch (error) {
    verdict.reasons.push({ code: "advisory-data-unavailable", message: errorMessage(error) });
  }
  for (const { name, version } of addedVersions(input.base, outcome.graph)) {
    const evidence: VersionEvidence = { name, version };
    const published = await ctx.package(name).then((m) => m.time[version]).catch(() => undefined);
    if (published === undefined) {
      verdict.blockers.push(`release date of ${name}@${version} is unknown`);
    } else {
      evidence.published = published;
      evidence.ageDays = Math.floor(ageInDays(published, ctx.now) * 10) / 10;
      // Security fixes skip the release-age wait; anything else pulled in incidentally does not.
      if (!candidate.intended.includes(name) && ageInDays(published, ctx.now) < ctx.config.minimumReleaseAgeDays) {
        verdict.blockers.push(`incidental upgrade ${name}@${version} is only ${evidence.ageDays} days old`);
      }
    }
    verdict.changed.push(evidence);
    const previous = [...input.base.nodes.values()].filter((n) => n.name === name && n.importer === undefined).map((n) => n.version);
    if (previous.length > 0 && previous.every((p) => isMajorChange(p, version, schemeFor(project.ecosystem)))) verdict.major = true;
  }
  if (verdict.major) verdict.blockers.push("major-version change: needs human review before merging");
  if (outcome.files.length === 0) verdict.reasons.push({ code: "no-change", message: "the candidate produced no file changes" });
  verdict.ok = verdict.reasons.length === 0;
  verdict.patch = outcome.patch;
  verdict.files = outcome.files;
  return verdict;
}

/** An existing override governs the vulnerable copy: move it to a fixed version (allowed for new advisories). */
async function overrideUpdate(
  { ctx, adapter, project }: Planner,
  entries: OverrideEntry[],
  vulnerable: Instance[],
  meta: PackageMetadata,
  advisories: Advisory[],
): Promise<Candidate | Reason> {
  const governing = entries.filter((e) => vulnerable.some((i) => i.paths.some((p) => adapter.overrideApplies(e, p))));
  if (governing.length === 0) return { code: "no-governing-override", message: "no existing override governs the vulnerable copies" };
  const writes: Array<{ entry: OverrideEntry; value: string; major: boolean }> = [];
  for (const entry of governing) {
    const current = vulnerable.find((i) => i.paths.some((p) => adapter.overrideApplies(entry, p)))!.version;
    const choice = chooseFixedVersion({ metadata: meta, advisories, current, now: ctx.now, minAgeDays: ctx.config.minimumReleaseAgeDays, scheme: schemeFor(project.ecosystem) });
    if (choice === null) return { code: "no-fixed-version", message: `no fixed release above ${current} for override ${entry.selector}` };
    writes.push({ entry, value: choice.version, major: choice.major });
  }
  return {
    kind: "update-override",
    summary: `update override for ${meta.name} to ${[...new Set(writes.map((w) => w.value))].join(", ")}`,
    details: writes.map((w) => `\`${w.entry.selector}\` in ${w.entry.file}: \`${w.entry.value}\` → \`${w.value}\` (a newer advisory affects the pinned version)`),
    selectors: writes.map((w) => selectorKey(w.entry.ecosystem, w.entry.file, w.entry.selector)),
    intended: [meta.name],
    major: writes.some((w) => w.major),
    async apply(dir) {
      for (const w of writes) await adapter.writeOverride(project, dir, { target: w.entry.target, scope: w.entry.scope, value: w.value, replaces: w.entry });
      return [meta.name];
    },
  };
}

interface Step {
  refresh?: string;
  bump?: { importer: string; name: string; from: string; to: string };
}

/**
 * Finds the smallest normal fix by walking up from each vulnerable copy: refresh within the parent's
 * existing range when that suffices, else move the parent (refreshing it inside its own parent's range,
 * or bumping it when it is a direct dependency), up to MAX_PARENT_DEPTH levels.
 */
async function normalFix(
  { ctx, adapter, project }: Planner,
  graph: ResolvedGraph,
  vulnerable: Instance[],
  name: string,
  plain: (v: string) => boolean,
  refreshOnly: boolean,
): Promise<Candidate | Reason> {
  const steps: Step[] = [];
  for (const instance of vulnerable) {
    for (const edge of incomingEdges(graph, instance.nodeKey)) {
      const found = await fixEdge(ctx, project.ecosystem, graph, edge, async (v) => plain(v), 0);
      if (found === null) return { code: "no-normal-fix", message: `no in-range refresh or parent release fixes ${edgeLabel(edge)}` };
      steps.push(...found);
    }
  }
  const bumps = dedupe(steps.flatMap((s) => (s.bump ? [s.bump] : [])), (b) => `${b.importer}\0${b.name}`);
  const refresh = [...new Set([name, ...steps.flatMap((s) => (s.refresh ? [s.refresh] : []))])].sort();
  if (refreshOnly && bumps.length > 0) return { code: "needs-parent-update", message: "a refresh within existing ranges is not enough" };
  if (!refreshOnly && bumps.length === 0 && refresh.length === 1) return { code: "refresh-suffices", message: "covered by lockfile-refresh" };
  const major = bumps.some((b) => isMajorChange(b.from, b.to, schemeFor(project.ecosystem)));
  if (bumps.length === 0) {
    return {
      kind: "lockfile-refresh",
      summary: `refresh ${refresh.join(", ")} within existing ranges`,
      details: [`Re-resolve ${refresh.join(", ")}; the parents' declared ranges already allow fixed releases, so no manifest changes are needed.`],
      selectors: [],
      intended: refresh,
      major: false,
      async apply() {
        return refresh;
      },
    };
  }
  return {
    kind: "parent-update",
    summary: `bump ${bumps.map((b) => `${b.name} to ${b.to}`).join(", ")}`,
    details: [
      ...bumps.map((b) => `${b.importer || "root"}: \`${b.name}\` ${b.from} → ${b.to}, whose dependency range resolves ${name} to a fixed release`),
      ...(refresh.length > 1 ? [`Refreshes ${refresh.join(", ")} inside their declared ranges.`] : []),
    ],
    selectors: [],
    intended: [...new Set([...refresh, ...bumps.map((b) => b.name)])],
    major,
    async apply(dir) {
      for (const b of bumps) {
        const spec = (await adapter.directSpec(project, dir, b.importer, b.name)) ?? `^${b.from}`;
        await adapter.setDependencySpec(project, dir, b.importer, b.name, bumpSpec(spec, b.to));
      }
      return [...new Set([...refresh, ...bumps.map((b) => b.name)])];
    },
  };
}

async function fixEdge(
  ctx: EngineContext,
  ecosystem: EcosystemId,
  graph: ResolvedGraph,
  edge: Edge,
  wanted: (version: string) => Promise<boolean>,
  depth: number,
): Promise<Step[] | null> {
  const childMeta = await ctx.package(edge.child.name);
  // A replacement parent must not bring its own known vulnerability.
  const childAdvisories = await ctx.allAdvisories(ecosystem, edge.child.name);
  const sch = schemeFor(ecosystem);
  const ok = async (v: string) => !childAdvisories.some((a) => isAffectedBy(v, a, sch)) && (await wanted(v));
  const declared = await ctx.declaredRange(edge.parent, edge.as);
  const spec = declared === undefined ? null : parseSpec(edge.as, declared, sch);
  if (spec !== null) {
    const best = maxSatisfying(childMeta, spec.range, ctx.now, sch);
    if (best !== null && (await ok(best))) return [{ refresh: edge.child.name }];
  }
  if (edge.parent.importer !== undefined) {
    // Direct dependency: the smallest release that fixes it, preferring the current line.
    const candidates = availableVersions(childMeta, ctx.now, sch).filter(
      (v) => !sch.isPrerelease(v) && !childMeta.versions[v]?.deprecated && sch.compare(v, edge.child.version) > 0,
    );
    const line = compatibleLine(edge.child.version, sch);
    const ordered = [...candidates.filter((v) => compatibleLine(v, sch) === line), ...candidates.filter((v) => compatibleLine(v, sch) !== line)];
    for (const v of ordered) {
      if (await ok(v)) {
        return [{ bump: { importer: edge.parent.importer, name: edge.as, from: edge.child.version, to: v } }];
      }
    }
    return null;
  }
  if (depth >= MAX_PARENT_DEPTH) return null;
  const parentMeta = await ctx.package(edge.parent.name);
  const parentOk = async (pv: string): Promise<boolean> => {
    const range = declaredRangeIn(parentMeta.versions[pv], edge.as);
    if (range === undefined) return true;
    const s = parseSpec(edge.as, range, sch);
    if (s === null) return false;
    const best = maxSatisfying(childMeta, s.range, ctx.now, sch);
    return best !== null && (await ok(best));
  };
  const steps: Step[] = [];
  const parents = incomingEdges(graph, edge.parent.key);
  if (parents.length === 0) return null;
  for (const up of parents) {
    const found = await fixEdge(ctx, ecosystem, graph, up, parentOk, depth + 1);
    if (found === null) return null;
    steps.push(...found);
  }
  steps.push({ refresh: edge.child.name });
  return steps;
}

/** Adds the narrowest override: scoped to each vulnerable copy's parent, or version-selected when there are too many parents. */
async function addOverride(
  { ctx, adapter, project }: Planner,
  graph: ResolvedGraph,
  vulnerable: Instance[],
  meta: PackageMetadata,
  advisories: Advisory[],
): Promise<Candidate | Reason> {
  const choices = new Map<string, { version: string; major: boolean }>();
  for (const instance of vulnerable) {
    const choice = chooseFixedVersion({ metadata: meta, advisories, current: instance.version, now: ctx.now, minAgeDays: ctx.config.minimumReleaseAgeDays, scheme: schemeFor(project.ecosystem) });
    if (choice === null) return { code: "no-fixed-version", message: `no fixed release at or above ${meta.name}@${instance.version}` };
    choices.set(instance.nodeKey, choice);
  }
  const parentScopes = new Map<string, { scope: PackageSelector; value: string; major: boolean }>();
  for (const instance of vulnerable) {
    const choice = choices.get(instance.nodeKey)!;
    for (const edge of incomingEdges(graph, instance.nodeKey)) {
      if (edge.parent.importer !== undefined) {
        return { code: "direct-dependency", message: `${meta.name} is a direct dependency of ${edge.parent.importer || "the root"}; bump it instead of overriding` };
      }
      const key = edge.parent.name;
      const existing = parentScopes.get(key);
      if (existing && existing.value !== choice.version) {
        // Same parent name, different fixed versions: select the parent by version too.
        parentScopes.set(`${key}@${edge.parent.version}`, { scope: { name: key, range: edge.parent.version }, value: choice.version, major: choice.major });
      } else if (!existing) {
        parentScopes.set(key, { scope: { name: key }, value: choice.version, major: choice.major });
      }
    }
  }
  const caps = adapter.overrideCapabilities(project);
  const needsParentVersion = [...parentScopes.values()].some((p) => p.scope.range !== undefined);
  let writes: OverrideWrite[];
  if (caps.parentScope && parentScopes.size <= ctx.config.maxScopedParents && (caps.versionSelector || !needsParentVersion)) {
    writes = [...parentScopes.values()].map((p) => ({ target: { name: meta.name }, scope: [p.scope], value: p.value }));
  } else {
    const byLine = new Map<string, string>();
    for (const instance of vulnerable) byLine.set(compatibleLine(instance.version, schemeFor(project.ecosystem)), choices.get(instance.nodeKey)!.version);
    if (caps.versionSelector) {
      writes = [...byLine].map(([line, value]) => ({ target: { name: meta.name, range: line }, scope: [], value }));
    } else if (byLine.size === 1) {
      // Only global overrides are honored: the pin applies to every copy, so verification checks them all.
      writes = [{ target: { name: meta.name }, scope: [], value: [...byLine.values()][0]! }];
    } else {
      return {
        code: "unsupported-scope",
        message: `${project.packageManager.name} ${project.packageManager.pinned ?? project.packageManager.installed} only honors global overrides, but vulnerable copies of ${meta.name} are on several release lines (${[...byLine.keys()].join(", ")}); one global pin cannot fix them all`,
      };
    }
  }
  const major = [...choices.values()].some((c) => c.major);
  const selectors: string[] = [];
  return {
    kind: "add-override",
    summary: `override ${meta.name} to ${[...new Set(writes.map((w) => w.value))].join(", ")}`,
    details: [
      "No parent release fixes this inside existing ranges, so an override is the last resort.",
      ...writes.map((w) => `\`${adapter.selectorFor(w.target, w.scope)}\`: \`${w.value}\` (exact pin: outside every affected range, removed again once upstream catches up)`),
    ],
    // Filled in by apply() with the files and selectors actually written, so trailers match the entries.
    selectors,
    intended: [meta.name],
    major,
    async apply(dir) {
      selectors.length = 0;
      for (const w of writes) {
        const written = await adapter.writeOverride(project, dir, w);
        selectors.push(selectorKey(project.ecosystem, written.file, written.selector));
      }
      return [meta.name];
    },
  };
}

function edgeLabel(edge: Edge): string {
  const parent = edge.parent.importer !== undefined ? edge.parent.importer || "(root)" : `${edge.parent.name}@${edge.parent.version}`;
  return `${parent} > ${edge.child.name}@${edge.child.version}`;
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

/** Dependabot/Renovate PR that touches the package: let it fix the vulnerability instead of competing. */
export function matchExternal(changes: ExternalChange[], name: string): ExternalChange | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[\\s/\`'"(])${escaped}([\\s@\`'")]|-\\d|$)`, "i");
  return changes.find((c) => pattern.test(c.title) || pattern.test(c.branch));
}

/** One change that necessarily fixes several advisories (identical patches) becomes one PR. */
function mergeIdenticalChanges(ctx: EngineContext, results: FixResult[]): FixResult[] {
  const byPatch = new Map<string, FixResult[]>();
  for (const r of results) {
    if (!r.change) continue;
    const list = byPatch.get(r.change.patch) ?? [];
    list.push(r);
    byPatch.set(r.change.patch, list);
  }
  for (const list of byPatch.values()) {
    if (list.length < 2) continue;
    const first = list[0]!.change!;
    const reports = list.map((r) => r.report);
    const packages = reports.map((r) => r.package).sort();
    const advisories = [...new Set(reports.flatMap((r) => r.advisories.map((a) => a.id)))].sort();
    const plan = list[0]!.plan!;
    const identity = fixIdentity(first.ecosystem, plan.manifest, packages, advisories);
    const groupKey = fixGroupKey(first.ecosystem, plan.manifest, packages);
    const merged = buildFixChange(ctx, {
      kind: first.kind as Exclude<typeof first.kind, "remove-override">,
      identity,
      groupKey,
      vulnerabilities: reports,
      summary: plan.summary,
      details: [`One change necessarily fixes ${packages.join(", ")}.`, ...list.map((r) => r.plan!.summary)],
      selectors: first.selectors,
      changedVersions: first.changedVersions,
      autoMergeBlockers: first.autoMergeBlockers,
      major: first.labels.includes("security-major"),
      patch: first.patch,
      files: first.files,
    });
    list.forEach((r, i) => {
      r.report.change = merged.identity;
      r.conclusive.push(groupKey);
      if (i === 0) r.change = merged;
      else delete r.change;
    });
  }
  return results;
}
