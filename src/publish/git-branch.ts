import { run } from "../exec.ts";
import { git, withScratch } from "../git.ts";
import type { PlannedChange } from "../engine/report.ts";

export interface GitRemote {
  url: string;
  /** Environment for git commands, e.g. GIT_CONFIG_* carrying an auth header. Kept out of argv so errors never show it. */
  env: Record<string, string>;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export const DEFAULT_COMMITTER: CommitIdentity = {
  name: "retire-overrides",
  email: "retire-overrides@users.noreply.github.com",
};

/**
 * Builds the change's commit on its base and pushes it to the change's branch. Pushing is skipped
 * when the branch already holds the same tree on the same base, so reruns are idempotent.
 */
export async function pushChange(
  repo: string,
  change: PlannedChange,
  remote: GitRemote,
  committer: CommitIdentity = DEFAULT_COMMITTER,
): Promise<"pushed" | "unchanged"> {
  return withScratch(repo, change.baseCommit, async (dir) => {
    await run("git", ["apply", "--index", "--binary", "--whitespace=nowarn", "-"], { cwd: dir, input: change.patch });
    await run(
      "git",
      ["-c", `user.name=${committer.name}`, "-c", `user.email=${committer.email}`, "commit", "--quiet", "--no-verify", "-F", "-"],
      { cwd: dir, input: change.commitMessage },
    );
    const tree = (await git(dir, ["rev-parse", "HEAD^{tree}"])).trim();
    const listed = await run("git", ["ls-remote", remote.url, `refs/heads/${change.branch}`], { cwd: dir, env: remote.env });
    const remoteSha = listed.stdout.split(/\s+/)[0];
    if (remoteSha) {
      const fetched = await run("git", ["fetch", "--quiet", "--depth=2", remote.url, remoteSha], {
        cwd: dir,
        env: remote.env,
        allowFailure: true,
      });
      if (fetched.code === 0) {
        const remoteTree = (await git(dir, ["rev-parse", `${remoteSha}^{tree}`], { allowFailure: true })).trim();
        const remoteParent = (await git(dir, ["rev-parse", `${remoteSha}^`], { allowFailure: true })).trim();
        if (remoteTree === tree && remoteParent === change.baseCommit) return "unchanged";
      }
    }
    await run("git", ["push", "--quiet", "--force", remote.url, `HEAD:refs/heads/${change.branch}`], { cwd: dir, env: remote.env });
    return "pushed";
  });
}
