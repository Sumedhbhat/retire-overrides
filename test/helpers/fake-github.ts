// An in-memory stand-in for the parts of the GitHub REST/GraphQL API the publisher uses.
export interface FakePull {
  number: number;
  node_id: string;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  title: string;
  body: string;
  user: { login: string };
  head: { ref: string; repo: { full_name: string } };
  labels: Array<{ name: string }>;
  base: string;
}

export interface FakeIssue {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
}

export class FakeGitHub {
  readonly repository = "owner/repo";
  baseSha: string;
  requiredChecks: string[] = ["ci"];
  pulls: FakePull[] = [];
  issues: FakeIssue[] = [];
  branches = new Set<string>();
  autoMerge: Array<{ id: string; body: string }> = [];
  comments: Array<{ number: number; body: string }> = [];
  calls: string[] = [];
  /** Raw Dependabot alerts served by the alerts endpoint; `alertsStatus` simulates 403/404. */
  alerts: unknown[] = [];
  alertsStatus = 200;
  /** Alerts per page, to exercise cursor pagination. */
  alertsPageSize = 100;
  private next = 1;

  constructor(baseSha: string) {
    this.baseSha = baseSha;
  }

  addPull(p: Partial<FakePull> & { head: FakePull["head"] }): FakePull {
    const n = this.next++;
    const pull: FakePull = {
      number: n,
      node_id: `PR_${n}`,
      html_url: `https://github.test/owner/repo/pull/${n}`,
      state: "open",
      merged_at: null,
      title: "",
      body: "",
      user: { login: "retire-overrides[bot]" },
      labels: [],
      base: "main",
      ...p,
    };
    this.pulls.push(pull);
    return pull;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.pathname.replace(/^\/repos\/owner\/repo/, "");
    this.calls.push(`${method} ${path}`);
    const json = (status: number, data: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (method === "POST" && url.pathname === "/graphql") {
      const vars = body.variables as { id: string; body: string };
      this.autoMerge.push({ id: vars.id, body: vars.body });
      return json(200, { data: {} });
    }
    if (method === "GET" && path === "/dependabot/alerts") {
      if (this.alertsStatus !== 200) return json(this.alertsStatus, { message: "Resource not accessible by integration" });
      const after = Number(url.searchParams.get("after") ?? "0");
      const page = this.alerts.slice(after, after + this.alertsPageSize);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (after + this.alertsPageSize < this.alerts.length) {
        headers.link = `<https://api.github.test/repos/owner/repo/dependabot/alerts?state=open&after=${after + this.alertsPageSize}>; rel="next"`;
      }
      return new Response(JSON.stringify(page), { status: 200, headers });
    }
    if (method === "GET" && path === "") return json(200, { default_branch: "main" });
    if (method === "GET" && path === "/git/ref/heads/main") return json(200, { object: { sha: this.baseSha } });
    if (method === "GET" && path.startsWith("/git/ref/heads/")) {
      const branch = decodeURIComponent(path.slice("/git/ref/heads/".length));
      return this.branches.has(branch) ? json(200, { object: { sha: "x" } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && path === "/rules/branches/main") {
      return json(200, this.requiredChecks.length ? [{ type: "required_status_checks", parameters: { required_status_checks: this.requiredChecks.map((context) => ({ context })) } }] : []);
    }
    if (method === "GET" && path === "/branches/main") return json(200, { protection: {} });
    if (method === "GET" && path === "/pulls") {
      const state = url.searchParams.get("state");
      const page = Number(url.searchParams.get("page") ?? "1");
      const list = this.pulls.filter((p) => state === "all" || p.state === state);
      return json(200, page === 1 ? list : []);
    }
    if (method === "POST" && path === "/pulls") {
      this.branches.add(String(body.head));
      const pull = this.addPull({ title: String(body.title), body: String(body.body), head: { ref: String(body.head), repo: { full_name: this.repository } } });
      return json(201, pull);
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(path);
    if (pullMatch && method === "PATCH") {
      const pull = this.pulls.find((p) => p.number === Number(pullMatch[1]))!;
      Object.assign(pull, body);
      return json(200, pull);
    }
    if (method === "POST" && path === "/labels") return json(201, {});
    const labelMatch = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (labelMatch && method === "POST") {
      const n = Number(labelMatch[1]);
      const target = this.pulls.find((p) => p.number === n) ?? this.issues.find((i) => i.number === n);
      for (const name of body.labels as string[]) target?.labels.push({ name });
      return json(200, []);
    }
    const commentMatch = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (commentMatch && method === "POST") {
      this.comments.push({ number: Number(commentMatch[1]), body: String(body.body) });
      return json(201, {});
    }
    if (method === "GET" && path === "/issues") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(200, page === 1 ? this.issues.filter((i) => i.state === "open") : []);
    }
    if (method === "POST" && path === "/issues") {
      const n = this.next++;
      const issue: FakeIssue = {
        number: n,
        html_url: `https://github.test/owner/repo/issues/${n}`,
        title: String(body.title),
        body: String(body.body),
        state: "open",
        labels: (body.labels as string[]).map((name) => ({ name })),
      };
      this.issues.push(issue);
      return json(201, issue);
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(path);
    if (issueMatch && method === "PATCH") {
      const issue = this.issues.find((i) => i.number === Number(issueMatch[1]))!;
      Object.assign(issue, body);
      return json(200, issue);
    }
    return json(404, { message: `fake GitHub has no route for ${method} ${url.pathname}` });
  };
}

/** A Dependabot alert as the REST API returns it. */
export function rawAlert(number: number, pkg: string, ghsa: string, manifest = "package-lock.json", range = "< 3.1.4"): unknown {
  return {
    number,
    html_url: `https://github.test/owner/repo/security/dependabot/${number}`,
    state: "open",
    dependency: { package: { ecosystem: "npm", name: pkg }, manifest_path: manifest },
    security_advisory: { ghsa_id: ghsa, severity: "high" },
    security_vulnerability: { vulnerable_version_range: range, first_patched_version: { identifier: "3.1.4" } },
  };
}
