# retire-overrides

retire-overrides keeps dependency overrides honest. When an advisory hits a transitive dependency, it tries a normal fix first. It adds an override only when nothing else works. Later, once the parent package has caught up, it proves the override is no longer needed and opens a PR to remove it.

There is no ledger to maintain, and no LLM runs at any point. Everything it decides comes from your manifests, lockfiles, git history, registry metadata and advisory data. Give it the same inputs and it makes the same decision.

It ships as three things that share one engine:

- a **standalone CLI** that has nothing to do with GitHub (`retire-overrides check`)
- a **GitHub Action** (`Sumedhbhat/retire-overrides@vX.Y.Z`): one step that runs daily, after lockfile changes, on demand, and as a read-only check on PRs
- a **reusable workflow** around the same action, for repositories that want PR jobs to never see the token

## Support

| Ecosystem | Status | Mechanism inspected |
|---|---|---|
| npm | **Implemented** | `overrides` in the root package.json: global, nested/parent-scoped, version-selected keys, `.` entries, `$name` references |
| pnpm | **Implemented** | `overrides` in pnpm-workspace.yaml (pnpm 10+) or `pnpm.overrides` in package.json (pnpm ≤ 10), chosen by the pinned pnpm version |
| Bun | **Implemented** | `overrides`/`resolutions` in package.json with bun.lock. Bun 1.4+ honors parent-scoped and version-selected keys; Bun 1.3 honors only global keys |
| Yarn | **Implemented** | `resolutions` in package.json with yarn.lock. Classic (1.x) matches keys as whole-path globs; Yarn 2+ honors only `pkg`, `pkg@range` and `parent/pkg` |
| Python / uv | Planned | `override-dependencies`, `constraint-dependencies` |
| Rust / Cargo | Planned | `[patch]`, `[replace]` |
| Go | Planned | `replace`, raised `require` |
| Gradle | Planned | constraints, strict/forced versions, resolution rules |
| Maven | Planned | `<dependencyManagement>`, explicit transitive declarations |
| .NET / NuGet | Planned | `PackageVersion`, `VersionOverride`, transitive pinning |

Planned adapters are not quiet about what they skip. If one finds its native mechanism in your repository, the report lists it under **unsupported**, so nothing looks evaluated when it wasn't. [docs/adapters.md](docs/adapters.md) has the exact support boundaries, the design for each planned adapter, and how to write a new one.

## Install in a repository

You need one workflow file and one credential.

**1. Add the workflow** as `.github/workflows/retire-overrides.yml` (from [examples/retire-overrides.yml](examples/retire-overrides.yml)):

```yaml
name: retire-overrides
on:
  schedule:
    - cron: "23 5 * * *"
  push:
    branches: [main]
    paths: ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/pnpm-workspace.yaml", "**/bun.lock", ".github/retire-overrides.yml"]
  pull_request:
    paths: ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/pnpm-workspace.yaml", "**/bun.lock", ".github/retire-overrides.yml"]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  retire-overrides:
    runs-on: ubuntu-latest
    concurrency: retire-overrides   # one run at a time
    steps:
      - uses: Sumedhbhat/retire-overrides@v0.3.0
        with:
          token: ${{ secrets.RETIRE_OVERRIDES_TOKEN }}
          # bun-version: 1.3.0      # Bun projects: the version your CI uses
```

That single step checks out the repository with full history, sets up Node (and Bun when `bun-version` is set), and then:

| Trigger | Mode | What happens |
|---|---|---|
| `pull_request` | `check` | Read-only evaluation, posted as a job summary. The token is never passed to it. Fails on `BLOCKED` by default (`fail-on` input). |
| `schedule`, `push` or `workflow_dispatch` on the default branch, with a token | `publish` | Opens, updates or closes PRs and issues. |
| anything else, or no token | `check` | Read-only. |

The JSON report is uploaded as an artifact. Set `mode: check` to keep it read-only everywhere (shadow mode). [action.yml](action.yml) lists every input.

Pin a release tag (`vX.Y.Z`) to stay exactly where you are, or the release branch (`release/X.Y`) to pick up patch releases.

**2. Create the credential.** Use either of these:

- **A GitHub App** (recommended): give it repository permissions **Contents: Read and write**, **Pull requests: Read and write**, **Issues: Read and write** and **Metadata: Read**, then install it on the repository. Store the App ID as variable `RETIRE_OVERRIDES_APP_ID` and the private key as secret `RETIRE_OVERRIDES_APP_PRIVATE_KEY`, and use [examples/retire-overrides-app.yml](examples/retire-overrides-app.yml).
- **A fine-grained personal access token** scoped to the repository, with the same permissions. Store it as the Actions secret `RETIRE_OVERRIDES_TOKEN`.

Optionally, also grant **Dependabot alerts: Read**. With it, the tool links each fix to the open Dependabot alerts it addresses ("Fixes Dependabot alert #N" in the PR), and lists any alert it didn't act on, with the reason (unsupported ecosystem, not in the lockfile, not flagged by the advisory data, project blocked). Without it, the run still works and the report says the alerts couldn't be read; it never treats that as "no alerts". retire-overrides never dismisses an alert.

`GITHUB_TOKEN` won't work. GitHub doesn't start workflows for PRs opened with `GITHUB_TOKEN`, so your CI would never run on generated PRs and auto-merge would never fire. A PR opened with an App or a personal token triggers `pull_request` CI the same way a human's PR does. If your changes ever need to touch `.github/workflows/`, the credential would also need **Workflows** permission, but retire-overrides only edits manifests and lockfiles.

**3. Let auto-merge work** (optional, but recommended):

- Turn on **Allow auto-merge** in the repository settings.
- Protect the default branch with a ruleset or branch protection that **requires your CI checks**. If no checks are required, retire-overrides leaves auto-merge off, because a PR with nothing required would merge untested.

Configuration is optional. To change a default, add `.github/retire-overrides.yml` ([example](examples/retire-overrides.config.yml)).

### Action or reusable workflow

The action above is the short way. The repository also ships a reusable workflow built on the same action, for stricter isolation:

```yaml
jobs:
  retire-overrides:
    uses: Sumedhbhat/retire-overrides/.github/workflows/retire-overrides.yml@v0.3.0
    secrets:
      token: ${{ secrets.RETIRE_OVERRIDES_TOKEN }}
```

GitHub requires that longer reference for any reusable workflow; there is no short form. What you get for it:

- **The token never enters a pull-request job.** With the action, a PR from a branch of the same repository still receives the secret as a step input. The action doesn't use it in `check` mode and keeps it out of everything it runs, but it exists on the runner. The reusable workflow runs PRs in a separate job that isn't given the secret at all.
- **Runs on the default branch are serialized** for you. With the action, add the `concurrency` line shown above.

Untrusted PR code never runs with write credentials either way, and resolution never runs install scripts.

## What it does

For each project it finds (a manifest plus the lockfile its package manager owns), it does two things.

**Fixes new advisories.** It audits every resolved version. For each vulnerable package it tries these strategies in order, and proves each attempt works before using it:

1. **override-update**: if an existing override governs the vulnerable copy, it moves that override to a fixed version. This only happens when a new advisory affects the pinned version. It never bumps an override just to keep it current.
2. **lockfile-refresh**: the parents' declared ranges already allow a fixed release, so only the lockfile changes.
3. **parent-update**: a newer parent release depends on a fixed version. It walks up the dependency chain, refreshing parents inside their own ranges, or bumping a direct dependency to the smallest release that fixes it.
4. **override**: the last resort. It writes the narrowest override the package manager supports. That's scoped to each vulnerable copy's parent (`bundler-kit > tar-lite`, `bundler-kit>tar-lite`), or version-selected (`tar-lite@3`) when there are too many parents. The value is an exact version that sits outside every affected range of every known advisory. It prefers the newest release on the current line that is at least 14 days old, and if nothing that old exists, the lowest fixed release (security fixes skip the wait).

If Dependabot or Renovate already has an open PR touching the package, the fix is `DEFERRED` to that PR. A fix that needs a major-version change still gets a PR right away, labeled `security-major`, with auto-merge withheld.

**Retires overrides.** It removes each override **on its own**, in a scratch git worktree. It resolves again *without trusting the lockfile*, so locked copies are re-resolved from their declared ranges. Then it checks every resolved copy and every parent constraint the override governed, audits the whole graph, and applies the release-age policy. Each override gets one status:

| Status | Meaning | What the tool does |
|---|---|---|
| `NEEDED` | Without it, a governed copy would be vulnerable, a parent's range would still permit a known vulnerable version, or the audit would gain a finding. | Keeps it. After 90 days, opens one tracking issue with paths and upstream context. |
| `WAITING` | Removal is safe, but it would pull in a release younger than 14 days. | Keeps it and checks again on the next run. |
| `REMOVABLE` | Every check passed. | Opens a removal PR and enables auto-merge behind required CI. |
| `REVIEW_NEEDED` | Technically removable or waiting, but retire-overrides didn't create it and it isn't opted in through `manage`. | Reports it. Never removes it automatically. |
| `BLOCKED` | Metadata or advisory data was unavailable, resolution failed, the package manager doesn't match the pinned version, or a constraint couldn't be read. | Keeps the override. Reports exactly what blocked it. A failure never counts as clean. |

Overrides on the `keep` list are reported as kept and never evaluated.

Advisory data comes from the npm registry's bulk advisory endpoint by default. `advisoryProviders` can add [OSV](https://osv.dev) (`osv`, which covers every ecosystem) and the GitHub Advisory Database (`github`). When several are configured, their answers are merged by advisory ID and the affected ranges are combined, so a disagreement counts as vulnerable. If any configured source fails, the run is BLOCKED rather than clean.

[docs/how-it-works.md](docs/how-it-works.md) covers the exact rules, the evidence each status records, and the JSON report.

### No ledger

The tool works out what each override is for from what's already in the repository:

- **Overrides** are read from the native files of the package-manager version you pin.
- **Dependency paths** come from the resolved graph.
- **Dates and authors** come from git: the trailer commit for overrides the tool created, `git blame` for the rest. The reusable workflow checks out full history; for local runs, make sure your clone isn't shallow.
- **Advisory IDs and rationale** are recorded in every generated commit as trailers (`Retire-Overrides-Id`, `-Action`, `-Selector`, `-Advisory`), and also in the PR description. The trailers survive squash merges either way: auto-merge passes them as the squash commit body, and a "PR title and description" squash setting keeps them too. If you merge by hand, keep the trailer lines.
- **Advisory ranges** come from the advisory data itself, with every affected branch included. The tool never assumes an override's lower bound was the fix.

So the tool knows which overrides it created. Anything else counts as unknown intent until you add it to `manage` (remove it automatically when safe) or `keep` (leave it alone).

## Standalone CLI

```sh
curl -fsSL https://raw.githubusercontent.com/Sumedhbhat/retire-overrides/main/scripts/install.sh | bash -s -- stable   # or nightly, or v0.1.0
retire-overrides check                       # dry run of HEAD in the current repository
retire-overrides check --json report.json    # machine-readable report
retire-overrides check --fail-on BLOCKED,REVIEW_NEEDED
retire-overrides publish --github            # GH_TOKEN or GITHUB_TOKEN; GITHUB_REPOSITORY or the origin remote
retire-overrides publish --out-dir changes/  # patches + metadata for any other host
retire-overrides adapters                    # support matrix
retire-overrides --version
```

It needs Node.js 22.18 or later, git, and the package managers your projects use. It evaluates the committed `HEAD` and ignores uncommitted changes. Resolution runs `npm install --package-lock-only --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts`, `bun install --lockfile-only --ignore-scripts` and `yarn install --mode=update-lockfile` (scripts disabled), so nothing is installed and no lifecycle scripts run. Yarn Classic is the exception: it has no lockfile-only mode, so it downloads and extracts packages into a throwaway folder, still without running scripts. Your application tests still belong in your CI, which runs on the generated PRs.

### Reproducing a decision

A decision depends on the repository commit, the package-manager versions, the registry and advisory metadata, the configuration, and the evaluation time. The CLI can pin all of them:

```sh
retire-overrides check --now 2026-03-21T00:00:00Z --record-metadata snapshot.json --json live.json
retire-overrides check --now 2026-03-21T00:00:00Z --metadata snapshot.json --json replay.json   # same decisions, offline
retire-overrides serve-metadata snapshot.json --now 2026-03-21T00:00:00Z                        # registry for manual npm/pnpm runs
```

The report records the tool version, the package-manager versions, the commit, the configuration and the evaluation time. `publish` won't accept `--metadata`, because a replayed lockfile points at the local snapshot registry.

### Other hosts

The CLI never talks to GitHub. Publishing goes through a `Publisher` interface. `publish --out-dir` writes one `.patch` and one `.json` for each change (branch, title, body, labels, commit message with trailers, base commit, auto-merge eligibility), plus a Markdown file for each issue. [docs/other-hosts.md](docs/other-hosts.md) shows a GitLab pipeline built on that output.

## Policy this implements

- Security fixes skip the 14-day release-age wait. Ordinary upgrades wait, and that includes incidental upgrades pulled in during a removal.
- Major-version security fixes get PRs immediately, but they need human review.
- Security changes stay separate. The exception is one change that necessarily fixes several advisories (identical patches), which becomes a single PR.
- Auto-merge needs the configured required checks.
- Overrides are a last resort. An existing override changes only to address a new advisory.
- Alerts are never dismissed, and every blocker is reported.

PRs and issues are idempotent. Each one carries a stable identity built from the ecosystem, manifest, package, scope and advisories. A rerun updates the existing PR, or does nothing if nothing changed. A PR that a human closed without merging is never reopened. A newer change for the same packages supersedes and closes the older one, and stale-override issues close themselves once the override is gone.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test            # unit tests + fixture repositories resolved by real npm and pnpm against a snapshot registry
npm run build       # regenerate dist/cli.mjs (committed; CI checks it matches src/)
```

The fixture tests build real git repositories, lock them with real npm and pnpm against an in-process snapshot registry, and evaluate them with an explicit clock. They cover additions, normal fixes, every removal status, stale lockfiles, multiple resolved copies, scoped overrides, workspaces, conflicting advisories, missing metadata and failed resolution.

Releases follow [docs/releases.md](docs/releases.md): nightlies from `main`, stable releases from `release/X.Y`.

## License

MIT
