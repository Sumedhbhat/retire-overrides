# How decisions are made

This page describes what the code does (`src/engine/`). The tests in `test/` pin each rule down.

## One run

1. Create a detached scratch worktree at the evaluated commit. Detect projects with every adapter. Planned adapters only contribute unsupported forms.
2. For each project:
   - run the adapter's preflight (package-manager version check);
   - read overrides and the committed lockfile graph;
   - resolve the unchanged commit again in a fresh scratch worktree. The result is the **baseline**. If it differs from the committed lockfile, the lockfile is **stale**, and that is recorded.
   - audit the baseline.
3. Evaluate each override for removal in its own scratch worktree.
4. Audit the committed lockfile graph and plan a fix for each vulnerable package, also in scratch worktrees.
5. Return a report. Publishing is a separate step.

## Removal checks

The override comes out in isolation, and the affected packages are re-resolved from declared ranges. The locked versions are not trusted. Then:

| Check | Failure means |
|---|---|
| Every resolved copy of the target that the override governed is outside every affected range of every advisory for the package | `NEEDED` (`vulnerable-without-override`) |
| For every edge into those copies, the parent's declared range permits no *published* version an advisory affects | `NEEDED` (`parent-permits-vulnerable`) |
| Auditing the whole new graph turns up no finding the baseline lacked | `NEEDED` (`introduces-vulnerability`) |
| Every version that is new relative to the baseline has a known publish time | `BLOCKED` (`release-date-unknown`) |
| Every such version is at least `minimumReleaseAgeDays` old | `WAITING` (`release-too-new`) |
| Metadata, advisory data, resolution and constraint parsing all succeed | `BLOCKED` |

When several apply, NEEDED wins (the override is definitely still needed), then BLOCKED, then WAITING. Statuses REMOVABLE and WAITING turn into `REVIEW_NEEDED` unless the tool created the override (trailers) or `manage` opts it in. A version change that leaves a compatible line (major, or minor for 0.x) withholds auto-merge.

## Fix planning

The strategies are tried in order: override-update → lockfile-refresh → parent-update → override. Each candidate is applied in a scratch worktree, resolved, and verified:

- no copy of the package remains in any affected range;
- the audit gains no finding;
- every newly resolved version has a known release date. If a version is not part of the fix itself and is younger than the release-age wait, auto-merge is withheld;
- the change actually changes files.

The fixed version is chosen with every advisory for the package in mind, across all affected branches. It must not be a downgrade, a prerelease, or deprecated. Within the current compatible line, the newest release older than the wait wins; otherwise the lowest fixed release is used (security exemption). If no release on the line is safe, the lowest fixed release on a later line is used, and the fix is marked major.

If no published release escapes every advisory, the vulnerability is `BLOCKED` (`no-fixed-version`), and nothing is changed or dismissed.

## Identities

| Object | Identity |
|---|---|
| Removal PR | `remove-override\|<ecosystem>\|<file>\|<selector>` |
| Fix PR | `security-fix\|<ecosystem>\|<manifest>\|<packages>\|<advisories>` (group key: the same without advisories) |
| Stale issue | `stale-override\|<ecosystem>\|<file>\|<selector>` |

The branch is `retire-overrides/<kind>/<package-slug>-<sha256(identity)[:10]>`. PR and issue bodies carry `<!-- retire-overrides:identity=… -->` and `<!-- retire-overrides:group=… -->` markers. The publisher only trusts PRs whose head branch lives in the repository itself. A fork can't impersonate one.

## Report (`--json`)

`schemaVersion: 1`. Top-level fields:

- `tool`, `evaluatedAt`, `repository` (`commit`, `dirty`, `shallow`), `config`, `metadata`
- `projects[]`: manifest, lockfile, package manager (installed and pinned), `blockers`, `lockfileStale`
- `overrides[]`: `identity`, `selector`, `target`, `scope`, `value`, `intent` (`tool`/`managed`/`keep`/`unknown`), `provenance` (commit, author, date, source), `status`, `technicalStatus`, `reasons[]` (`code`, `message`), and `evidence` (advisories with ranges, copies with paths, parent constraints, introduced findings, changed versions with ages, upstream context)
- `kept[]`: overrides on the keep list
- `vulnerabilities[]`: `status` (`PROPOSED`/`DEFERRED`/`REVIEW_NEEDED`/`BLOCKED`), `strategy`, `attempts[]`, `advisories`, `instances`
- `changes[]`: everything needed to open a PR on any host: `branch`, `title`, `body`, `commitMessage`, `labels`, `autoMerge`, `autoMergeBlockers`, `baseCommit`, `files`, `patch`
- `issues[]`, `unsupported[]`, `conclusive[]` (group keys evaluated without blockers; publishers close their own stale PRs and issues only for these), `summary`
