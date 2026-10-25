import { posix } from "node:path";
import type { EcosystemId, ResolvedGraph } from "../types.ts";
import type { VulnerabilityReport } from "./report.ts";

/**
 * An open security alert from the code host (on GitHub, a Dependabot alert). Alerts are an extra
 * input: they are cross-referenced and checked for coverage, and never dismissed by this tool.
 */
export interface HostAlert {
  number: number;
  url: string;
  state: string;
  /** GHSA ID of the advisory. */
  advisory: string;
  package: string;
  /** The host's ecosystem name, e.g. `npm`, `pip`, `rust`. */
  hostEcosystem: string;
  /** Repository-relative manifest or lockfile the alert was raised for. */
  manifest: string;
  vulnerableRange?: string;
  firstPatched?: string;
  severity?: string;
}

/** Either the alerts, or why they couldn't be read. A failure is never the same as "no alerts". */
export type AlertsInput = { status: "available"; alerts: HostAlert[] } | { status: "unavailable"; reason: string };

export interface AlertRef {
  number: number;
  url: string;
  advisory: string;
}

export type CoverageReason =
  /** The alert's manifest belongs to an ecosystem this tool doesn't implement, or no project was found for it. */
  | "unsupported-ecosystem"
  /** The project couldn't be evaluated (see projects[].blockers). */
  | "project-blocked"
  /** The package isn't in the resolved graph, e.g. the alert is stale or the lockfile changed. */
  | "not-in-graph"
  /** The package is resolved, but the advisory data used here doesn't flag it for this advisory. */
  | "not-flagged";

export interface CoverageEntry {
  alert: AlertRef & { package: string; manifest: string; vulnerableRange?: string };
  reason: CoverageReason;
  message: string;
}

export interface AlertsSummary {
  source: string;
  status: "available" | "unavailable";
  /** Why alerts couldn't be read, when unavailable. */
  note?: string;
  open: number;
}

/** GitHub alert ecosystems mapped to the adapters that can own them. */
const HOST_ECOSYSTEMS: Record<string, EcosystemId[]> = {
  npm: ["npm", "pnpm", "bun", "yarn"],
  pip: ["uv"],
  rust: ["cargo"],
  go: ["go"],
  maven: ["maven", "gradle"],
  nuget: ["nuget"],
};

export function alertRef(a: HostAlert): AlertRef {
  return { number: a.number, url: a.url, advisory: a.advisory };
}

/** Project directory an alert's manifest path belongs to (`""` for the root). */
function alertDir(manifest: string): string {
  const dir = posix.dirname(manifest);
  return dir === "." ? "" : dir;
}

/** Open alerts for this package and advisory set in this project. */
export function alertsFor(
  alerts: HostAlert[],
  ecosystem: EcosystemId,
  projectDir: string,
  pkg: string,
  advisories: string[],
): HostAlert[] {
  const ids = new Set(advisories.map((a) => a.toLowerCase()));
  return alerts.filter(
    (a) =>
      (HOST_ECOSYSTEMS[a.hostEcosystem] ?? []).includes(ecosystem) &&
      alertDir(a.manifest) === projectDir &&
      a.package === pkg &&
      ids.has(a.advisory.toLowerCase()),
  );
}

export interface EvaluatedProject {
  ecosystem: EcosystemId;
  dir: string;
  blocked: boolean;
  graph?: ResolvedGraph;
}

/**
 * Every open alert must be accounted for: either a vulnerability report references it, or a coverage
 * entry says why this run didn't act on it.
 */
export function coverage(alerts: HostAlert[], projects: EvaluatedProject[], vulnerabilities: VulnerabilityReport[]): CoverageEntry[] {
  // Link alerts to every vulnerability report for the same package and advisory, including ones that
  // ended early (blocked, deferred) and so never reached the PR-building step.
  const referenced = new Set<number>();
  for (const v of vulnerabilities) {
    const ids = [...v.advisories.map((a) => a.id), ...v.instances.flatMap((i) => i.affectedBy)];
    const matched = alertsFor(alerts, v.ecosystem, v.project, v.package, ids);
    if (matched.length > 0 && !v.alerts) v.alerts = matched.map(alertRef).sort((x, y) => x.number - y.number);
    for (const a of matched) referenced.add(a.number);
  }
  const out: CoverageEntry[] = [];
  for (const alert of alerts) {
    if (referenced.has(alert.number)) continue;
    const ref = {
      ...alertRef(alert),
      package: alert.package,
      manifest: alert.manifest,
      ...(alert.vulnerableRange ? { vulnerableRange: alert.vulnerableRange } : {}),
    };
    const owners = HOST_ECOSYSTEMS[alert.hostEcosystem] ?? [];
    const project = projects.find((p) => owners.includes(p.ecosystem) && p.dir === alertDir(alert.manifest));
    if (!project) {
      out.push({ alert: ref, reason: "unsupported-ecosystem", message: `no implemented ${alert.hostEcosystem} project at ${alert.manifest}; this alert was not evaluated` });
    } else if (project.blocked || !project.graph) {
      out.push({ alert: ref, reason: "project-blocked", message: `the ${project.ecosystem} project at ${project.dir || "(root)"} could not be evaluated; see its blockers` });
    } else {
      const versions = [...project.graph.nodes.values()].filter((n) => n.name === alert.package && n.importer === undefined).map((n) => n.version);
      if (versions.length === 0) {
        out.push({ alert: ref, reason: "not-in-graph", message: `${alert.package} is not in the resolved lockfile; the alert may be stale until the host rescans` });
      } else {
        const list = [...new Set(versions)].sort().join(", ");
        out.push({
          alert: ref,
          reason: "not-flagged",
          message: `${alert.package} resolves to ${list}, which the configured advisory data does not flag for ${alert.advisory}${alert.vulnerableRange ? ` (alert range ${alert.vulnerableRange})` : ""}; check for an override or provider disagreement`,
        });
      }
    }
  }
  return out;
}
