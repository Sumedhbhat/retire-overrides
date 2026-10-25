import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";

export const TRAILER = {
  id: "Retire-Overrides-Id",
  action: "Retire-Overrides-Action",
  selector: "Retire-Overrides-Selector",
  advisory: "Retire-Overrides-Advisory",
} as const;

export async function git(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<string> {
  const result = await run("git", args, { cwd, allowFailure: options.allowFailure ?? false });
  return result.stdout;
}

export async function headCommit(repo: string): Promise<string> {
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

export async function isDirty(repo: string): Promise<boolean> {
  return (await git(repo, ["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
}

/** A detached scratch worktree at a commit. Always dispose it, even after failures. */
export interface Scratch {
  dir: string;
  dispose(): Promise<void>;
}

export async function createScratch(repo: string, commit: string): Promise<Scratch> {
  const parent = await mkdtemp(join(tmpdir(), "retire-overrides-"));
  const dir = join(parent, "wt");
  await git(repo, ["worktree", "add", "--quiet", "--detach", dir, commit]);
  return {
    dir,
    async dispose() {
      await git(repo, ["worktree", "remove", "--force", dir], { allowFailure: true });
      await rm(parent, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"], { allowFailure: true });
    },
  };
}

export async function withScratch<T>(repo: string, commit: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const scratch = await createScratch(repo, commit);
  try {
    return await fn(scratch.dir);
  } finally {
    await scratch.dispose();
  }
}

/** Binary-safe diff of the scratch worktree against its commit. Empty when nothing changed. */
export async function diffWorktree(dir: string): Promise<{ patch: string; files: string[] }> {
  await git(dir, ["add", "--all"]);
  const patch = await git(dir, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff"]);
  const files = (await git(dir, ["diff", "--cached", "--name-only"])).split("\n").filter((f) => f !== "");
  return { patch, files };
}

export interface CommitInfo {
  sha: string;
  date: string;
  author: string;
  trailers: Map<string, string[]>;
}

export function parseTrailers(message: string): Map<string, string[]> {
  const trailers = new Map<string, string[]>();
  for (const line of message.split("\n")) {
    const m = /^(Retire-Overrides-[A-Za-z]+):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const list = trailers.get(m[1]!) ?? [];
    list.push(m[2]!);
    trailers.set(m[1]!, list);
  }
  return trailers;
}

/** Commits touching a file that carry retire-overrides trailers, newest first. */
export async function toolCommits(repo: string, file: string): Promise<CommitInfo[]> {
  const out = await git(
    repo,
    ["log", "--format=%H%x1f%aI%x1f%an <%ae>%x1f%B%x1e", `--grep=^${TRAILER.selector}:`, "--", file],
    { allowFailure: true },
  );
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter((r) => r !== "")
    .map((record) => {
      const [sha, date, author, body] = record.split("\x1f") as [string, string, string, string];
      return { sha, date, author, trailers: parseTrailers(body ?? "") };
    });
}

/** Who last introduced a line, via blame. Undefined when git cannot tell (shallow clone, new file). */
export async function blameLine(
  repo: string,
  file: string,
  line: number,
): Promise<{ commit: string; author: string; date: string } | undefined> {
  const out = await git(repo, ["blame", "--porcelain", "-L", `${line},${line}`, "HEAD", "--", file], {
    allowFailure: true,
  });
  const sha = /^([0-9a-f]{40})/.exec(out)?.[1];
  const author = /^author (.+)$/m.exec(out)?.[1];
  const time = /^author-time (\d+)$/m.exec(out)?.[1];
  if (!sha || !time || /^0+$/.test(sha)) return undefined;
  return { commit: sha, author: author ?? "unknown", date: new Date(Number(time) * 1000).toISOString() };
}

export async function isShallow(repo: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--is-shallow-repository"], { allowFailure: true })).trim() === "true";
}
