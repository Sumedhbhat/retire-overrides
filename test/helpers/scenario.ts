// Builds throwaway fixture repositories: real git history, real npm/pnpm lockfiles resolved against a
// snapshot registry, and an evaluation clock. Every scenario test goes through here.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NpmBulkAdvisoryProvider } from "../../src/advisories/providers.ts";
import { allAdapters } from "../../src/adapters/index.ts";
import type { ImplementedAdapter, Project } from "../../src/adapters/adapter.ts";
import { BunAdapter } from "../../src/adapters/bun/bun.ts";
import { NpmAdapter } from "../../src/adapters/npm/npm.ts";
import { PnpmAdapter } from "../../src/adapters/pnpm/pnpm.ts";
import { type Config, DEFAULT_CONFIG } from "../../src/config.ts";
import type { AlertsInput } from "../../src/engine/alerts.ts";
import type { ExternalChange } from "../../src/engine/context.ts";
import type { Report } from "../../src/engine/report.ts";
import { evaluate } from "../../src/engine/run.ts";
import { run } from "../../src/exec.ts";
import { startSnapshotRegistry } from "../../src/metadata/server.ts";
import type { MetadataSnapshot } from "../../src/metadata/snapshot.ts";
import { NpmRegistryClient } from "../../src/registry/registry.ts";

export type Manager = "npm" | "pnpm" | "bun";

export interface FixtureRepo {
  dir: string;
  manager: Manager;
  write(files: Record<string, string | object>): Promise<void>;
  read(path: string): Promise<string>;
  readJson(path: string): Promise<Record<string, unknown>>;
  /** Re-resolves the lockfile against the snapshot as it looked at `at`. */
  lock(snapshot: MetadataSnapshot, at: string, refresh?: string[]): Promise<void>;
  commit(message: string, at: string): Promise<string>;
  evaluate(snapshot: MetadataSnapshot, now: string, config?: Partial<Config>, external?: ExternalChange[], alerts?: AlertsInput): Promise<Report>;
  dispose(): Promise<void>;
}

export async function fixtureRepo(manager: Manager, files: Record<string, string | object>): Promise<FixtureRepo> {
  const dir = await mkdtemp(join(tmpdir(), "retire-overrides-fixture-"));
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  await run("git", ["config", "user.name", "Fixture Author"], { cwd: dir });
  await run("git", ["config", "user.email", "fixture@example.com"], { cwd: dir });
  await run("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  const repo: FixtureRepo = {
    dir,
    manager,
    async write(more) {
      for (const [path, content] of Object.entries(more)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
      }
    },
    read: (path) => readFile(join(dir, path), "utf8"),
    async readJson(path) {
      return JSON.parse(await readFile(join(dir, path), "utf8")) as Record<string, unknown>;
    },
    async lock(snapshot, at, refresh = []) {
      const server = await startSnapshotRegistry(snapshot, { now: new Date(at) });
      try {
        const adapter: ImplementedAdapter = manager === "npm" ? new NpmAdapter() : manager === "pnpm" ? new PnpmAdapter() : new BunAdapter();
        const project = await detectProject(adapter, dir);
        await adapter.resolve(project, dir, { refresh, registry: server.url });
      } finally {
        await server.close();
      }
    },
    async commit(message, at) {
      await run("git", ["add", "--all"], { cwd: dir });
      await run("git", ["commit", "--quiet", "--allow-empty", "-F", "-"], {
        cwd: dir,
        input: message,
        env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      });
      return (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    },
    async evaluate(snapshot, now, config = {}, external = [], alerts) {
      const clock = new Date(now);
      const server = await startSnapshotRegistry(snapshot, { now: clock });
      try {
        const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
        return await evaluate({
          repo: dir,
          commit,
          now: clock,
          config: { ...DEFAULT_CONFIG, ...config },
          registry: new NpmRegistryClient(server.url),
          advisories: new NpmBulkAdvisoryProvider(server.url),
          adapters: allAdapters(),
          packageManagerRegistry: server.url,
          externalChanges: external,
          ...(alerts ? { alerts } : {}),
          registryLabel: "snapshot",
        });
      } finally {
        await server.close();
      }
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
  await repo.write(files);
  return repo;
}

async function detectProject(adapter: ImplementedAdapter, dir: string): Promise<Project> {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const installed = (await run(adapter.id, ["--version"], { cwd: dir, env: { npm_config_registry: undefined } })).stdout.trim().split("\n").at(-1)!;
  const pinned = typeof manifest.packageManager === "string" ? /@([^+]+)/.exec(manifest.packageManager)?.[1] : undefined;
  return {
    ecosystem: adapter.id,
    dir: "",
    manifest: "package.json",
    lockfile: { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", bun: "bun.lock" }[adapter.id as Manager],
    packageManager: { name: adapter.id, installed, ...(pinned ? { pinned } : {}) },
  };
}

/** Commit message trailers the tool writes when it adds an override, for simulating its history. */
export function toolTrailers(ecosystem: string, file: string, selector: string, advisory: string): string {
  return [
    "fix(deps): override for security",
    "",
    `Retire-Overrides-Id: security-fix|${ecosystem}|package.json|x|${advisory}`,
    "Retire-Overrides-Action: add-override",
    `Retire-Overrides-Selector: ${ecosystem}:${file}:${selector}`,
    `Retire-Overrides-Advisory: ${advisory}`,
  ].join("\n");
}

export async function installedVersion(command: Manager): Promise<string> {
  return (await run(command, ["--version"], { cwd: tmpdir(), env: { npm_config_registry: undefined } })).stdout.trim().split("\n").at(-1)!;
}

export { allAdapters };

export const LOCKFILES: Record<Manager, string> = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", bun: "bun.lock" };
