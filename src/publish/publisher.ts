import type { ExternalChange } from "../engine/context.ts";
import type { Report } from "../engine/report.ts";

export interface PublishOutcome {
  identity: string;
  kind: "pull-request" | "issue";
  action: "created" | "updated" | "unchanged" | "skipped" | "closed" | "failed";
  url?: string;
  message?: string;
}

/**
 * Turns a report into host-side changes. The engine and CLI never talk to a code host directly;
 * a publisher does, so other hosts only need another implementation of this interface.
 */
export interface Publisher {
  /** Open PRs from Dependabot, Renovate and similar bots, so fixes can be deferred to them. */
  externalChanges(): Promise<ExternalChange[]>;
  /** Creates or updates PRs and issues idempotently. `repo` is the local clone the report came from. */
  publish(report: Report, repo: string): Promise<PublishOutcome[]>;
}
