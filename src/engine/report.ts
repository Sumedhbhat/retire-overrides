import type {
  EcosystemId,
  FixStatus,
  OverrideIntent,
  OverrideStatus,
  PackageSelector,
  Provenance,
  Reason,
  UnsupportedForm,
} from "../types.ts";
import type { PackageManagerInfo } from "../adapters/adapter.ts";
import type { AlertRef, AlertsSummary, CoverageEntry } from "./alerts.ts";

export const REPORT_SCHEMA_VERSION = 1;

export interface AdvisoryRef {
  id: string;
  ranges: string[];
  severity?: string;
  title?: string;
  url?: string;
}

export interface InstanceEvidence {
  version: string;
  affectedBy: string[];
  paths: string[];
  pathsTruncated: boolean;
}

export interface ConstraintEvidence {
  parent: string;
  dependency: string;
  range: string;
  /** Published versions the range allows that an advisory affects. Empty means the constraint is safe. */
  permitsVulnerable: string[];
  /** A peer range: judged by the version auto-install would pick, not by everything it allows. */
  peer?: boolean;
}

export interface VersionEvidence {
  name: string;
  version: string;
  published?: string;
  ageDays?: number;
}

export interface OverrideReport {
  identity: string;
  ecosystem: EcosystemId;
  project: string;
  file: string;
  selector: string;
  target: PackageSelector;
  scope: PackageSelector[];
  value: string;
  intent: OverrideIntent;
  provenance: Provenance;
  status: OverrideStatus;
  /** Status before the intent check, when the intent check changed it. */
  technicalStatus?: OverrideStatus;
  reasons: Reason[];
  evidence: {
    advisories: AdvisoryRef[];
    instancesWithoutOverride?: InstanceEvidence[];
    parentConstraints?: ConstraintEvidence[];
    introducedVulnerabilities?: string[];
    changedVersions?: VersionEvidence[];
    lockfileStale?: boolean;
    /** Set when the package manager could not refresh the package selectively. */
    refreshLimitation?: string;
    overrideAgeDays?: number;
    upstream?: string[];
  };
  change?: string;
  issue?: string;
}

export type FixStrategy = "override-update" | "lockfile-refresh" | "parent-update" | "override";

export interface FixAttempt {
  strategy: FixStrategy;
  outcome: "fixed" | "failed" | "not-applicable";
  reasons: Reason[];
}

export interface VulnerabilityReport {
  identity: string;
  ecosystem: EcosystemId;
  project: string;
  package: string;
  advisories: AdvisoryRef[];
  instances: InstanceEvidence[];
  status: FixStatus;
  strategy?: FixStrategy;
  attempts: FixAttempt[];
  reasons: Reason[];
  change?: string;
  deferredTo?: string;
  /** Open host alerts (Dependabot) this vulnerability corresponds to. */
  alerts?: AlertRef[];
}

export type ChangeKind = "remove-override" | "add-override" | "update-override" | "parent-update" | "lockfile-refresh";

export interface PlannedChange {
  /** Stable identity: ecosystem, manifest, package, scope and advisories where relevant. */
  identity: string;
  /** Identity without advisories. Changes sharing a group key supersede each other. */
  groupKey: string;
  kind: ChangeKind;
  ecosystem: EcosystemId;
  project: string;
  packages: string[];
  advisories: string[];
  selectors: string[];
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  labels: string[];
  autoMerge: boolean;
  autoMergeBlockers: string[];
  baseCommit: string;
  changedVersions: VersionEvidence[];
  files: string[];
  /** `git diff --binary` against baseCommit. */
  patch: string;
}

export interface PlannedIssue {
  identity: string;
  groupKey: string;
  title: string;
  body: string;
  labels: string[];
}

export interface ProjectReport {
  ecosystem: EcosystemId;
  dir: string;
  manifest: string;
  lockfile: string;
  packageManager: PackageManagerInfo;
  blockers: string[];
  lockfileStale?: boolean;
}

export interface Report {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  tool: { name: "retire-overrides"; version: string };
  evaluatedAt: string;
  repository: { commit: string; dirty: boolean; shallow: boolean };
  config: { path?: string; minimumReleaseAgeDays: number; staleAfterDays: number; advisoryProviders: string[] };
  metadata: { registry: string; snapshot?: string };
  projects: ProjectReport[];
  overrides: OverrideReport[];
  kept: OverrideReport[];
  vulnerabilities: VulnerabilityReport[];
  unsupported: UnsupportedForm[];
  /** Host alert input (Dependabot), when a publisher supplied it. Absent for host-independent runs. */
  alerts?: AlertsSummary;
  /** Open alerts no vulnerability report accounts for, with the reason. Never silently dropped. */
  coverage?: CoverageEntry[];
  changes: PlannedChange[];
  issues: PlannedIssue[];
  /** Group keys whose evaluation finished without blockers; publishers may close stale PRs/issues for these. */
  conclusive: string[];
  summary: Record<OverrideStatus, number> & { vulnerabilities: number; changes: number; issues: number; unsupported: number };
}

const SEVERITY: Record<OverrideStatus, number> = { REMOVABLE: 0, WAITING: 1, REVIEW_NEEDED: 2, BLOCKED: 3, NEEDED: 4 };

/** Combines statuses: a definitive NEEDED wins, then BLOCKED, then WAITING, then REMOVABLE. */
export function worst(a: OverrideStatus, b: OverrideStatus): OverrideStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
