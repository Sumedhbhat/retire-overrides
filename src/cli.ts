#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters } from "./adapters/index.ts";
import {
  type AdvisoryProvider,
  CombinedAdvisoryProvider,
  GitHubAdvisoryProvider,
  NpmBulkAdvisoryProvider,
} from "./advisories/providers.ts";
import { OsvAdvisoryProvider } from "./advisories/osv.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { Report } from "./engine/report.ts";
import { evaluate } from "./engine/run.ts";
import { headCommit } from "./git.ts";
import { startSnapshotRegistry, type SnapshotRegistry } from "./metadata/server.ts";
import { readSnapshot, Recorder } from "./metadata/snapshot.ts";
import { DirectoryPublisher } from "./publish/directory.ts";
import { GitHubPublisher, repositoryFromRemote } from "./publish/github.ts";
import type { Publisher, PublishOutcome } from "./publish/publisher.ts";
import { NpmRegistryClient } from "./registry/registry.ts";
import { renderMarkdown, renderText } from "./render/summary.ts";
import type { OverrideStatus } from "./types.ts";
import { toolVersion } from "./version.ts";

const USAGE = `retire-overrides — add security overrides only when nothing else works, and remove them once upstream catches up.

Usage:
  retire-overrides check   [options]   Evaluate and print what would change (dry run). Never writes to a host.
  retire-overrides publish [options]   Evaluate, then open/update PRs and issues (--github or --out-dir).
  retire-overrides adapters            Show implemented and planned ecosystem support.
  retire-overrides serve-metadata <snapshot.json> [--now <iso>] [--port <n>]
                                       Serve a metadata snapshot as an npm registry, for reproduction.

Options:
  --repo <dir>              Repository to evaluate (default: current directory). HEAD is evaluated.
  --config <path>           Config file relative to the repo (default: .github/retire-overrides.yml if present).
  --now <iso-8601>          Evaluation time (default: current time). Use for reproducible decisions.
  --metadata <file>         Replay a saved metadata snapshot (registry + advisories) instead of the network.
  --record-metadata <file>  Save every piece of metadata read during the run as a snapshot.
  --registry <url>          npm-compatible registry for metadata and resolution (default: npm_config_registry or registry.npmjs.org).
  --json <file|->           Write the machine-readable report.
  --markdown <file>         Write a Markdown summary (for example $GITHUB_STEP_SUMMARY; appended).
  --fail-on <statuses>      Exit 1 if any override has one of these statuses (comma-separated, e.g. BLOCKED,REVIEW_NEEDED),
                            or if any vulnerability fix is BLOCKED when VULN_BLOCKED is listed.
  --quiet                   Only print the summary line.
  --from-report <file>      publish: publish an existing report instead of evaluating again.
  --github                  publish: open PRs/issues on GitHub. Token from GH_TOKEN or GITHUB_TOKEN.
  --github-repo <owner/name> publish: target repository (default: GITHUB_REPOSITORY or the origin remote).
  --base <branch>           publish: base branch (default: the repository's default branch).
  --out-dir <dir>           publish: write patches and metadata for other hosts instead.
  --version, --help
`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      config: { type: "string" },
      now: { type: "string" },
      metadata: { type: "string" },
      "record-metadata": { type: "string" },
      registry: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      "fail-on": { type: "string" },
      quiet: { type: "boolean" },
      "from-report": { type: "string" },
      github: { type: "boolean" },
      "github-repo": { type: "string" },
      base: { type: "string" },
      "out-dir": { type: "string" },
      port: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.version) {
    process.stdout.write(`retire-overrides ${toolVersion()}\n`);
    return 0;
  }
  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const now = values.now ? parseNow(values.now) : new Date();

  if (command === "adapters") {
    for (const a of allAdapters()) {
      process.stdout.write(`${a.id.padEnd(7)} ${a.support.padEnd(12)} ${a.mechanisms}\n${" ".repeat(21)}${a.limitations}\n`);
    }
    return 0;
  }
  if (command === "serve-metadata") {
    const file = positionals[1];
    if (!file) throw new UsageError("serve-metadata needs a snapshot file");
    const server = await startSnapshotRegistry(await readSnapshot(file), { now, ...(values.port ? { port: Number(values.port) } : {}) });
    process.stdout.write(`${server.url}\n`);
    await new Promise(() => undefined);
    return 0;
  }
  if (command !== "check" && command !== "publish") throw new UsageError(`unknown command "${command}"`);

  const repo = resolve(values.repo ?? ".");
  try {
    await headCommit(repo);
  } catch {
    throw new UsageError(`${repo} is not a git repository with at least one commit`);
  }
  const failOn = parseFailOn(values["fail-on"]);
  let publisher: Publisher | undefined;
  const { config, path: configPath } = await loadConfig(repo, values.config);
  if (command === "publish") {
    if (values.metadata) throw new UsageError("publish cannot use --metadata: replayed lockfiles point at the local snapshot registry");
    if (values.github === Boolean(values["out-dir"])) throw new UsageError("publish needs exactly one of --github or --out-dir");
    if (values.github) {
      const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      if (!token) throw new UsageError("--github needs a token in GH_TOKEN or GITHUB_TOKEN");
      const repository = values["github-repo"] ?? process.env.GITHUB_REPOSITORY ?? (await repositoryFromRemote(repo));
      if (!repository) throw new UsageError("cannot tell which GitHub repository to use; pass --github-repo owner/name");
      publisher = new GitHubPublisher({
        token,
        repository,
        ...(process.env.GITHUB_API_URL ? { apiUrl: process.env.GITHUB_API_URL } : {}),
        ...(process.env.GITHUB_SERVER_URL ? { serverUrl: process.env.GITHUB_SERVER_URL } : {}),
        ...(values.base ? { base: values.base } : {}),
        autoMerge: config.autoMerge,
        mergeMethod: config.mergeMethod,
        log,
      });
    } else {
      publisher = new DirectoryPublisher(resolve(values["out-dir"]!));
    }
  }

  let report: Report;
  if (values["from-report"]) {
    if (command !== "publish") throw new UsageError("--from-report only applies to publish");
    report = JSON.parse(await readFile(values["from-report"], "utf8")) as Report;
  } else {
    report = await runEvaluation({ repo, now, config, configPath, values, publisher, log });
  }

  if (values.json) {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.json === "-") process.stdout.write(json);
    else await writeFile(values.json, json);
  }
  if (values.markdown) await appendFile(values.markdown, renderMarkdown(report));
  if (values.json !== "-") {
    const text = renderText(report);
    process.stdout.write(values.quiet ? text.split("\n").filter((l) => l.startsWith("Summary:")).join("\n") + "\n" : text);
  }

  if (publisher) {
    const outcomes = await publisher.publish(report, repo);
    printOutcomes(outcomes);
    if (outcomes.some((o) => o.action === "failed")) return 3;
  }
  return failOn(report) ? 1 : 0;
}

async function runEvaluation(input: {
  repo: string;
  now: Date;
  config: Awaited<ReturnType<typeof loadConfig>>["config"];
  configPath: string | undefined;
  values: Record<string, string | boolean | undefined>;
  publisher: Publisher | undefined;
  log: (m: string) => void;
}): Promise<Report> {
  const { repo, now, config, values, publisher, log } = input;
  const recorder = values["record-metadata"] ? new Recorder() : undefined;
  let snapshotServer: SnapshotRegistry | undefined;
  let registryUrl = (values.registry as string | undefined) ?? process.env.npm_config_registry ?? "https://registry.npmjs.org/";
  let packageManagerRegistry = values.registry as string | undefined;
  if (values.metadata) {
    snapshotServer = await startSnapshotRegistry(await readSnapshot(values.metadata as string), { now });
    registryUrl = snapshotServer.url;
    packageManagerRegistry = snapshotServer.url;
  }
  try {
    const registry = new NpmRegistryClient(registryUrl, recorder ? { recorder } : {});
    const providers: AdvisoryProvider[] = config.advisoryProviders.map((id) => {
      if (id === "osv" && !values.metadata) {
        return new OsvAdvisoryProvider(recorder ? { recorder } : {});
      }
      if (id === "github" && !values.metadata) {
        const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
        return new GitHubAdvisoryProvider({
          ...(token ? { token } : {}),
          ...(process.env.GITHUB_API_URL ? { apiUrl: process.env.GITHUB_API_URL } : {}),
          ...(recorder ? { recorder } : {}),
        });
      }
      // Snapshots always replay through the registry's bulk endpoint, whatever recorded them.
      return new NpmBulkAdvisoryProvider(registryUrl, recorder ? { recorder } : {});
    });
    const seenNames = new Set<string>();
    const report = await evaluate({
      repo,
      commit: await headCommit(repo),
      now,
      config,
      registry,
      advisories: providers.length === 1 ? providers[0]! : new CombinedAdvisoryProvider(providers),
      adapters: allAdapters(),
      ...(packageManagerRegistry ? { packageManagerRegistry } : {}),
      externalChanges: publisher ? await publisher.externalChanges() : [],
      log,
      onGraph: (graph) => {
        for (const node of graph.nodes.values()) if (node.importer === undefined) seenNames.add(node.name);
      },
      ...(input.configPath ? { configPath: input.configPath } : {}),
      registryLabel: values.metadata ? "snapshot" : registryUrl,
      ...(values.metadata ? { snapshotPath: values.metadata as string } : {}),
    });
    if (recorder) {
      // Package managers read metadata the engine never asked for; capture it so replay can resolve.
      for (const name of seenNames) await registry.getPackage(name).catch(() => undefined);
      await recorder.save(values["record-metadata"] as string, now);
    }
    return report;
  } finally {
    await snapshotServer?.close();
  }
}

function parseNow(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new UsageError(`--now: "${text}" is not an ISO-8601 time`);
  return date;
}

function parseFailOn(text: string | undefined): (report: Report) => boolean {
  if (!text) return () => false;
  const wanted = new Set(text.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s !== ""));
  const valid = new Set(["NEEDED", "WAITING", "REMOVABLE", "REVIEW_NEEDED", "BLOCKED", "VULN_BLOCKED", "UNSUPPORTED"]);
  for (const w of wanted) if (!valid.has(w)) throw new UsageError(`--fail-on: unknown status ${w}`);
  return (report) =>
    report.overrides.some((o) => wanted.has(o.status as OverrideStatus)) ||
    (wanted.has("BLOCKED") && report.projects.some((p) => p.blockers.length > 0)) ||
    (wanted.has("VULN_BLOCKED") && report.vulnerabilities.some((v) => v.status === "BLOCKED")) ||
    (wanted.has("UNSUPPORTED") && report.unsupported.length > 0);
}

function printOutcomes(outcomes: PublishOutcome[]): void {
  for (const o of outcomes) {
    process.stdout.write(`${o.action.padEnd(9)} ${o.kind} ${o.url ?? ""} ${o.message ?? ""}\n`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError || error instanceof ConfigError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 3;
    }
  },
);
