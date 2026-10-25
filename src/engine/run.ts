import { isImplemented } from "../adapters/adapter.ts";
import { createScratch, isDirty, isShallow, withScratch } from "../git.ts";
import { sameResolution } from "../graph.ts";
import type { ResolvedGraph } from "../types.ts";
import { EngineContext, type EngineOptions, errorMessage, type Finding } from "./context.ts";
import { planFixes } from "./fixes.ts";
import { type Baseline, evaluateRemoval, registryOption } from "./removal.ts";
import { REPORT_SCHEMA_VERSION, type Report } from "./report.ts";
import { toolVersion } from "../version.ts";

export interface EvaluateOptions extends EngineOptions {
  configPath?: string;
  registryLabel: string;
  snapshotPath?: string;
}

/**
 * Evaluates a repository at one commit: every override is checked for removal in isolation, and every
 * vulnerable package gets the smallest verified fix. Nothing is published; the report says what to do.
 */
export async function evaluate(options: EvaluateOptions): Promise<Report> {
  const ctx = new EngineContext(options);
  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "retire-overrides", version: toolVersion() },
    evaluatedAt: options.now.toISOString(),
    repository: {
      commit: options.commit,
      dirty: await isDirty(options.repo),
      shallow: await isShallow(options.repo),
    },
    config: {
      ...(options.configPath ? { path: options.configPath } : {}),
      minimumReleaseAgeDays: options.config.minimumReleaseAgeDays,
      staleAfterDays: options.config.staleAfterDays,
      advisoryProviders: options.config.advisoryProviders,
    },
    metadata: { registry: options.registryLabel, ...(options.snapshotPath ? { snapshot: options.snapshotPath } : {}) },
    projects: [],
    overrides: [],
    kept: [],
    vulnerabilities: [],
    unsupported: [],
    changes: [],
    issues: [],
    conclusive: [],
    summary: { NEEDED: 0, WAITING: 0, REMOVABLE: 0, REVIEW_NEEDED: 0, BLOCKED: 0, vulnerabilities: 0, changes: 0, issues: 0, unsupported: 0 },
  };
  if (report.repository.shallow) {
    ctx.log("warning: shallow clone; override history (dates, tool-created markers) may be incomplete. Use fetch-depth: 0.");
  }

  const base = await createScratch(options.repo, options.commit);
  try {
    for (const adapter of options.adapters) {
      if (options.config.ecosystems && !options.config.ecosystems.includes(adapter.id)) continue;
      const detected = await adapter.detect(base.dir);
      report.unsupported.push(...detected.unsupported);
      if (!isImplemented(adapter)) continue;

      for (const project of detected.projects) {
        ctx.log(`${adapter.id}: ${project.manifest} (${project.packageManager.name} ${project.packageManager.installed})`);
        const blockers = adapter.preflight(project);
        let entries: Awaited<ReturnType<typeof adapter.readOverrides>>["entries"] = [];
        try {
          const found = await adapter.readOverrides(project, base.dir);
          entries = found.entries;
          report.unsupported.push(...found.unsupported);
        } catch (error) {
          blockers.push(`cannot read overrides: ${errorMessage(error)}`);
        }
        let locked: ResolvedGraph | undefined;
        try {
          locked = await adapter.readGraph(project, base.dir);
          ctx.seen(locked);
        } catch (error) {
          blockers.push(errorMessage(error));
        }

        let resolved: ResolvedGraph | Error = new Error(blockers[0] ?? "not resolved");
        if (blockers.length === 0) {
          resolved = await withScratch(options.repo, options.commit, async (dir) => {
            try {
              await adapter.resolve(project, dir, { refresh: [], ...registryOption(ctx) });
              return await adapter.readGraph(project, dir);
            } catch (error) {
              return error instanceof Error ? error : new Error(String(error));
            }
          });
        }
        if (!(resolved instanceof Error)) ctx.seen(resolved);
        const lockfileStale = locked !== undefined && !(resolved instanceof Error) && !sameResolution(locked, resolved);
        let baselineFindings: Finding[] | Error = new Error("baseline unavailable");
        if (!(resolved instanceof Error)) {
          baselineFindings = await ctx.audit(project.ecosystem, resolved).catch((e: unknown) => new Error(errorMessage(e)));
        }
        report.projects.push({
          ecosystem: project.ecosystem,
          dir: project.dir,
          manifest: project.manifest,
          lockfile: project.lockfile,
          packageManager: project.packageManager,
          blockers: [...blockers],
          lockfileStale,
        });
        const projectReport = report.projects.at(-1)!;

        if (locked !== undefined) {
          const baseline: Baseline = { locked, resolved, findings: baselineFindings, lockfileStale };
          for (const entry of entries) {
            ctx.log(`  override: ${entry.selector}`);
            const result = await evaluateRemoval(ctx, adapter, project, base.dir, entry, baseline, blockers);
            (result.kept ? report.kept : report.overrides).push(result.report);
            if (result.change) report.changes.push(result.change);
            if (result.issue) report.issues.push(result.issue);
            report.conclusive.push(...result.conclusive);
          }
        } else {
          for (const entry of entries) {
            const result = await evaluateRemoval(ctx, adapter, project, base.dir, entry, emptyBaseline(), blockers);
            (result.kept ? report.kept : report.overrides).push(result.report);
          }
        }

        if (locked === undefined || blockers.length > 0) continue;
        let findings: Finding[];
        try {
          findings = await ctx.audit(project.ecosystem, locked);
        } catch (error) {
          projectReport.blockers.push(`vulnerability detection failed: ${errorMessage(error)}`);
          continue;
        }
        const fixes = await planFixes(ctx, adapter, project, locked, findings, resolved instanceof Error ? locked : resolved, entries);
        for (const fix of fixes) {
          report.vulnerabilities.push(fix.report);
          if (fix.change) report.changes.push(fix.change);
          report.conclusive.push(...fix.conclusive);
        }
      }
    }
  } finally {
    await base.dispose();
  }

  for (const o of report.overrides) report.summary[o.status]++;
  report.summary.vulnerabilities = report.vulnerabilities.length;
  report.summary.changes = report.changes.length;
  report.summary.issues = report.issues.length;
  report.summary.unsupported = report.unsupported.length;
  report.conclusive = [...new Set(report.conclusive)].sort();
  return report;
}

function emptyBaseline(): Baseline {
  return {
    locked: { nodes: new Map(), importers: [] },
    resolved: new Error("lockfile could not be read"),
    findings: new Error("lockfile could not be read"),
    lockfileStale: false,
  };
}
