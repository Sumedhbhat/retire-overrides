import { git } from "../git.ts";
import type { AlertsInput, HostAlert } from "../engine/alerts.ts";
import type { ExternalChange } from "../engine/context.ts";
import { BRANCH_PREFIX, readMarker } from "../engine/identity.ts";
import type { PlannedChange, PlannedIssue, Report } from "../engine/report.ts";
import { MAJOR_LABEL, TOOL_LABEL } from "../engine/changes.ts";
import type { FetchLike } from "../registry/registry.ts";
import { type CommitIdentity, DEFAULT_COMMITTER, type GitRemote, pushChange } from "./git-branch.ts";
import type { Publisher, PublishOutcome } from "./publisher.ts";

export interface GitHubOptions {
  token: string;
  /** `owner/name`. */
  repository: string;
  apiUrl?: string;
  serverUrl?: string;
  /** Base branch; defaults to the repository's default branch. */
  base?: string;
  autoMerge: boolean;
  mergeMethod: "squash" | "merge" | "rebase";
  committer?: CommitIdentity;
  fetch?: FetchLike;
  log?: (message: string) => void;
}

interface PullRequest {
  number: number;
  node_id: string;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  title: string;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
}

interface Issue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

const BOT_AUTHORS = new Set(["dependabot[bot]", "renovate[bot]", "app/dependabot", "app/renovate"]);
const LABEL_COLORS: Record<string, string> = { [MAJOR_LABEL]: "B60205", [TOOL_LABEL]: "5319E7", security: "D93F0B", dependencies: "0366D6" };

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Publishes a report as GitHub pull requests and issues. The only module that talks to GitHub. */
export class GitHubPublisher implements Publisher {
  private readonly options: GitHubOptions;
  private readonly apiUrl: string;
  private readonly serverUrl: string;
  private readonly fetchImpl: FetchLike;
  private openPulls: Promise<PullRequest[]> | undefined;

  constructor(options: GitHubOptions) {
    this.options = options;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.serverUrl = (options.serverUrl ?? "https://github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.apiUrl}${path}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new GitHubApiError(response.status, `${method} ${path} → HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async paginate<T>(path: string, max = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; out.length < max; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  private repoPath(suffix = ""): string {
    return `/repos/${this.options.repository}${suffix}`;
  }

  private pulls(): Promise<PullRequest[]> {
    this.openPulls ??= this.paginate<PullRequest>(this.repoPath("/pulls?state=open"));
    return this.openPulls;
  }

  async externalChanges(): Promise<ExternalChange[]> {
    return (await this.pulls())
      .filter((pr) => pr.user !== null && (BOT_AUTHORS.has(pr.user.login) || /^(dependabot|renovate)\//.test(pr.head.ref)))
      .map((pr) => ({ url: pr.html_url, title: pr.title, branch: pr.head.ref, author: pr.user?.login ?? "bot" }));
  }

  /**
   * Open Dependabot alerts. Needs "Dependabot alerts: Read". A token without it (403), or a repository
   * with alerts turned off (404), yields `unavailable` with the reason: never an empty, clean-looking list.
   */
  async openAlerts(): Promise<AlertsInput> {
    const alerts: HostAlert[] = [];
    let url: string | null = `${this.apiUrl}${this.repoPath("/dependabot/alerts?state=open&per_page=100")}`;
    try {
      while (url !== null) {
        const response = await this.fetchImpl(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.options.token}`,
            "x-github-api-version": "2022-11-28",
          },
        });
        if (response.status === 403 || response.status === 404) {
          const detail = (await response.text()).slice(0, 200);
          return {
            status: "unavailable",
            reason:
              response.status === 403
                ? `the token cannot read Dependabot alerts (needs "Dependabot alerts: Read"): ${detail}`
                : `Dependabot alerts are not enabled for ${this.options.repository}: ${detail}`,
          };
        }
        if (!response.ok) return { status: "unavailable", reason: `listing Dependabot alerts returned HTTP ${response.status}` };
        for (const raw of (await response.json()) as RawAlert[]) alerts.push(toHostAlert(raw));
        url = nextPage(response.headers.get("link"));
      }
    } catch (error) {
      return { status: "unavailable", reason: `listing Dependabot alerts failed: ${String(error)}` };
    }
    return { status: "available", alerts };
  }

  /** Branch rules or classic protection requiring status checks on the base. Auto-merge is only safe with them. */
  async requiredChecks(branch: string): Promise<string[]> {
    const checks = new Set<string>();
    try {
      const rules = await this.request<Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }>>(
        "GET",
        this.repoPath(`/rules/branches/${encodeURIComponent(branch)}`),
      );
      for (const rule of rules) {
        if (rule.type !== "required_status_checks") continue;
        for (const c of rule.parameters?.required_status_checks ?? []) checks.add(c.context);
      }
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    }
    try {
      const info = await this.request<{ protection?: { required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> } } }>(
        "GET",
        this.repoPath(`/branches/${encodeURIComponent(branch)}`),
      );
      const rsc = info.protection?.required_status_checks;
      for (const c of rsc?.contexts ?? []) checks.add(c);
      for (const c of rsc?.checks ?? []) checks.add(c.context);
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
    }
    return [...checks].sort();
  }

  async publish(report: Report, repo: string): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    const info = await this.request<{ default_branch: string }>("GET", this.repoPath());
    const base = this.options.base ?? info.default_branch;
    const baseRef = await this.request<{ object: { sha: string } }>("GET", this.repoPath(`/git/ref/heads/${encodeURIComponent(base)}`));
    if (baseRef.object.sha !== report.repository.commit) {
      throw new Error(
        `the report evaluated ${report.repository.commit.slice(0, 12)}, but ${base} is at ${baseRef.object.sha.slice(0, 12)}; re-run on the tip of ${base} so PRs never include unreviewed commits`,
      );
    }
    const required = await this.requiredChecks(base);
    const all = await this.paginate<PullRequest>(this.repoPath("/pulls?state=all&sort=updated&direction=desc"), 500);
    const ours = all.filter((pr) => pr.head.ref.startsWith(BRANCH_PREFIX) && pr.head.repo?.full_name === this.options.repository);
    const remote = this.remote();
    const planned = new Set(report.changes.map((c) => c.identity));

    for (const change of report.changes) {
      try {
        outcomes.push(await this.publishChange(repo, change, ours, remote, base, required));
      } catch (error) {
        outcomes.push({ identity: change.identity, kind: "pull-request", action: "failed", message: String(error) });
      }
    }

    // Close our own PRs that a newer change supersedes, or whose subject is conclusively resolved.
    const conclusive = new Set(report.conclusive);
    for (const pr of ours.filter((p) => p.state === "open")) {
      const identity = readMarker(pr.body, "identity");
      const group = readMarker(pr.body, "group");
      if (!identity || !group || planned.has(identity)) continue;
      const replacement = report.changes.find((c) => c.groupKey === group);
      if (!replacement && !conclusive.has(group)) continue;
      const reason = replacement
        ? `Superseded by a newer change for the same packages (\`${replacement.branch}\`).`
        : "The latest evaluation no longer calls for this change (fixed upstream, resolved by another PR, or no longer removable).";
      try {
        await this.request("POST", this.repoPath(`/issues/${pr.number}/comments`), { body: `${reason} Closing automatically.` });
        await this.request("PATCH", this.repoPath(`/pulls/${pr.number}`), { state: "closed" });
        outcomes.push({ identity, kind: "pull-request", action: "closed", url: pr.html_url, message: reason });
      } catch (error) {
        outcomes.push({ identity, kind: "pull-request", action: "failed", url: pr.html_url, message: String(error) });
      }
    }

    // A stale-override issue whose override no longer exists in a cleanly evaluated project is resolved too.
    const present = new Set(report.overrides.concat(report.kept).map((o) => `${o.ecosystem}|${o.file}|${o.selector}`));
    const isGone = (identity: string): boolean => {
      const [kind, ecosystem, file, ...rest] = identity.split("|");
      if (kind !== "stale-override" || !ecosystem || !file) return false;
      const project = report.projects.find(
        (p) => p.ecosystem === ecosystem && p.blockers.length === 0 && (p.dir === "" || file.startsWith(`${p.dir}/`)),
      );
      return project !== undefined && !present.has(`${ecosystem}|${file}|${rest.join("|")}`);
    };

    outcomes.push(...(await this.publishIssues(report.issues, conclusive, isGone)));
    return outcomes;
  }

  private remote(): GitRemote {
    const basic = Buffer.from(`x-access-token:${this.options.token}`).toString("base64");
    return {
      url: `${this.serverUrl}/${this.options.repository}.git`,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${this.serverUrl}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
        GIT_TERMINAL_PROMPT: "0",
      },
    };
  }

  private async publishChange(
    repo: string,
    change: PlannedChange,
    ours: PullRequest[],
    remote: GitRemote,
    base: string,
    required: string[],
  ): Promise<PublishOutcome> {
    const mine = ours.filter((pr) => readMarker(pr.body, "identity") === change.identity);
    const open = mine.find((pr) => pr.state === "open");
    const closedByHuman = mine.find((pr) => pr.state === "closed" && pr.merged_at === null);
    if (!open && closedByHuman) {
      return {
        identity: change.identity,
        kind: "pull-request",
        action: "skipped",
        url: closedByHuman.html_url,
        message: "an identical change was closed without merging; not reopening it",
      };
    }
    if (!open && (await this.foreignBranchExists(change.branch))) {
      return { identity: change.identity, kind: "pull-request", action: "skipped", message: `branch ${change.branch} exists without a matching PR; not overwriting it` };
    }
    const pushed = await pushChange(repo, change, remote, this.options.committer ?? DEFAULT_COMMITTER);
    let pr: PullRequest;
    let action: PublishOutcome["action"];
    if (open) {
      pr = open;
      const changed = stripVolatile(open.body ?? "") !== stripVolatile(change.body) || open.title !== change.title;
      if (changed) {
        pr = await this.request<PullRequest>("PATCH", this.repoPath(`/pulls/${open.number}`), { title: change.title, body: change.body });
      }
      action = changed || pushed === "pushed" ? "updated" : "unchanged";
    } else {
      pr = await this.request<PullRequest>("POST", this.repoPath("/pulls"), {
        title: change.title,
        body: change.body,
        head: change.branch,
        base,
        maintainer_can_modify: true,
      });
      action = "created";
    }
    await this.ensureLabels(pr.number, change.labels, pr.labels?.map((l) => l.name) ?? []);
    const notes: string[] = [`branch ${pushed}`];
    if (!change.autoMerge) {
      notes.push(`auto-merge withheld: ${change.autoMergeBlockers.join("; ")}`);
    } else if (!this.options.autoMerge) {
      notes.push("auto-merge disabled by configuration");
    } else if (required.length === 0) {
      notes.push(`auto-merge withheld: ${base} has no required status checks`);
    } else {
      try {
        await this.enableAutoMerge(pr.node_id, change);
        notes.push(`auto-merge enabled after ${required.join(", ")}`);
      } catch (error) {
        notes.push(`auto-merge could not be enabled: ${String(error)}`);
      }
    }
    this.log(`${action}: ${pr.html_url} (${notes.join("; ")})`);
    return { identity: change.identity, kind: "pull-request", action, url: pr.html_url, message: notes.join("; ") };
  }

  private async foreignBranchExists(branch: string): Promise<boolean> {
    try {
      await this.request("GET", this.repoPath(`/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`));
      return true;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return false;
      throw error;
    }
  }

  private async ensureLabels(number: number, labels: string[], present: string[]): Promise<void> {
    const missing = labels.filter((l) => !present.includes(l));
    if (missing.length === 0) return;
    for (const name of missing) {
      try {
        await this.request("POST", this.repoPath("/labels"), { name, color: LABEL_COLORS[name] ?? "EDEDED" });
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      }
    }
    await this.request("POST", this.repoPath(`/issues/${number}/labels`), { labels: missing });
  }

  private async enableAutoMerge(pullRequestId: string, change: PlannedChange): Promise<void> {
    const trailers = change.commitMessage.split("\n").filter((l) => l.startsWith("Retire-Overrides-")).join("\n");
    const result = await this.request<{ errors?: Array<{ message: string }> }>("POST", "/graphql", {
      query: `mutation($id: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, commitHeadline: $headline, commitBody: $body }) { clientMutationId }
      }`,
      variables: { id: pullRequestId, method: this.options.mergeMethod.toUpperCase(), headline: change.title, body: trailers },
    });
    if (result.errors && result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("; "));
  }

  private async publishIssues(
    issues: PlannedIssue[],
    conclusive: Set<string>,
    isGone: (identity: string) => boolean,
  ): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    let existing: Issue[];
    try {
      existing = (await this.paginate<Issue>(this.repoPath(`/issues?state=open&labels=${encodeURIComponent(TOOL_LABEL)}`))).filter(
        (i) => i.pull_request === undefined,
      );
    } catch (error) {
      return issues.map((i) => ({ identity: i.identity, kind: "issue", action: "failed", message: String(error) }));
    }
    const planned = new Set(issues.map((i) => i.identity));
    for (const issue of issues) {
      try {
        const match = existing.find((e) => readMarker(e.body, "identity") === issue.identity);
        if (match) {
          if (stripVolatile(match.body ?? "") !== stripVolatile(issue.body)) {
            await this.request("PATCH", this.repoPath(`/issues/${match.number}`), { title: issue.title, body: issue.body });
            outcomes.push({ identity: issue.identity, kind: "issue", action: "updated", url: match.html_url });
          } else {
            outcomes.push({ identity: issue.identity, kind: "issue", action: "unchanged", url: match.html_url });
          }
          continue;
        }
        for (const name of issue.labels) {
          await this.request("POST", this.repoPath("/labels"), { name, color: LABEL_COLORS[name] ?? "EDEDED" }).catch(() => undefined);
        }
        const created = await this.request<Issue>("POST", this.repoPath("/issues"), { title: issue.title, body: issue.body, labels: issue.labels });
        outcomes.push({ identity: issue.identity, kind: "issue", action: "created", url: created.html_url });
      } catch (error) {
        outcomes.push({ identity: issue.identity, kind: "issue", action: "failed", message: String(error) });
      }
    }
    for (const issue of existing) {
      const identity = readMarker(issue.body, "identity");
      if (!identity || planned.has(identity) || !(conclusive.has(identity) || isGone(identity))) continue;
      await this.request("POST", this.repoPath(`/issues/${issue.number}/comments`), {
        body: "The override is no longer stale (removed, or no longer needed). Closing automatically.",
      });
      await this.request("PATCH", this.repoPath(`/issues/${issue.number}`), { state: "closed", state_reason: "completed" });
      outcomes.push({ identity, kind: "issue", action: "closed", url: issue.html_url });
    }
    return outcomes;
  }
}

/** Ignores the per-run footer line (evaluation time, commit) so reruns don't edit PRs needlessly. */
function stripVolatile(body: string): string {
  return body
    .split("\n")
    .filter((l) => !l.startsWith("Generated by [retire-overrides]") && !l.startsWith("Reproduce with"))
    .join("\n")
    .trim();
}

/** Resolves `owner/name` from a git remote URL, for local runs outside Actions. */
export async function repositoryFromRemote(repo: string): Promise<string | undefined> {
  const url = (await git(repo, ["remote", "get-url", "origin"], { allowFailure: true })).trim();
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return m?.[1];
}

interface RawAlert {
  number: number;
  html_url: string;
  state: string;
  dependency?: { package?: { ecosystem?: string; name?: string }; manifest_path?: string };
  security_advisory?: { ghsa_id?: string; severity?: string };
  security_vulnerability?: { vulnerable_version_range?: string; first_patched_version?: { identifier?: string } | null };
}

function toHostAlert(raw: RawAlert): HostAlert {
  const alert: HostAlert = {
    number: raw.number,
    url: raw.html_url,
    state: raw.state,
    advisory: raw.security_advisory?.ghsa_id ?? "unknown",
    package: raw.dependency?.package?.name ?? "unknown",
    hostEcosystem: raw.dependency?.package?.ecosystem ?? "unknown",
    manifest: raw.dependency?.manifest_path ?? "",
  };
  const range = raw.security_vulnerability?.vulnerable_version_range;
  if (range) alert.vulnerableRange = range;
  const patched = raw.security_vulnerability?.first_patched_version?.identifier;
  if (patched) alert.firstPatched = patched;
  if (raw.security_advisory?.severity) alert.severity = raw.security_advisory.severity;
  return alert;
}

/** The Dependabot alerts endpoint paginates by cursor, so follow `Link: rel="next"`. */
function nextPage(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}
