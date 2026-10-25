# Using retire-overrides outside GitHub

The engine and CLI never contact a code host. `publish --github` is one `Publisher` implementation (`src/publish/github.ts`). Any other host can work from the report or the directory output.

## Directory output

```sh
retire-overrides publish --out-dir out/
```

This writes:

- `out/changes/<kind>-<hash>.patch`: the change as `git diff --binary` against `baseCommit`
- `out/changes/<kind>-<hash>.json`: `identity`, `groupKey`, `branch`, `title`, `body`, `commitMessage` (with the `Retire-Overrides-*` trailers), `labels`, `autoMerge`, `autoMergeBlockers`, `baseCommit`, `files`
- `out/issues/stale-<hash>.md` and `.json`: stale-override issues

To publish a change:

1. Check that `baseCommit` is the tip of the target branch. If it isn't, run again; never apply a patch on top of other commits.
2. `git switch --detach <baseCommit> && git apply --index <patch> && git commit -F <(jq -r .commitMessage <json>)`
3. Force-push to `branch`. The branch belongs to the tool and is recreated on every run.
4. Look up an open merge request whose description contains `<!-- retire-overrides:identity=<identity> -->`. Update it if one exists, and create one otherwise. If a merge request with that identity was closed without merging, skip it.
5. Enable merge-when-pipeline-succeeds only when `autoMerge` is true **and** the target branch requires a passing pipeline. Keep the trailers in the merge commit.

## GitLab CI example

```yaml
retire-overrides:
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      changes: ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/pnpm-workspace.yaml"]
  variables:
    GIT_DEPTH: 0
  script:
    - corepack enable
    - curl -fsSL https://raw.githubusercontent.com/Sumedhbhat/retire-overrides/main/scripts/install.sh | bash -s -- v0.1.0
    - ~/.local/bin/retire-overrides publish --out-dir out --json report.json
    - ./ci/open-merge-requests.sh out   # your glue: the steps above, using the GitLab API
  artifacts:
    paths: [report.json, out/]
```

For a read-only check on merge requests, run `retire-overrides check --fail-on BLOCKED --markdown summary.md` without credentials.

## Writing a publisher

Implement `Publisher` (`src/publish/publisher.ts`):

- `externalChanges()` returns open dependency-bot merge requests, so fixes can be deferred to them.
- `publish(report, repo)` creates or updates changes and issues idempotently by identity. `pushChange()` in `src/publish/git-branch.ts` does the host-independent git work: it rebuilds the commit and skips the push when the remote branch already has the same tree on the same base.
