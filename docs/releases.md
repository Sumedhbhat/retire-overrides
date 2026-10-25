# Releases

| Channel | Branch | Version | GitHub release |
|---|---|---|---|
| Nightly | `main` | `<package.json version>-nightly.<run number>` | prerelease `v0.1.0-nightly.57`, one per push to `main` |
| Stable | `release/X.Y` | the package.json version, `X.Y.Z` | `vX.Y.Z`, published when that version first lands on the branch |

- package.json is the only place the version is written. CI appends the nightly suffix and never edits the manifest.
- `retire-overrides --version` prints the version. When it runs as the action or reusable workflow, the ref it ran from is printed too. Release archives contain a `VERSION` file, and the release title names the version.
- Published tags and assets are permanent. There are no moving tags like `v0`. Pin `vX.Y.Z` for an exact version, or `release/X.Y` to follow a release line's patches.
- `main` always carries the next minor version.

The action and reusable workflow run the committed `dist/cli.mjs` at the ref you pin. CI fails if that bundle doesn't match `src/`.

## Cut a stable release

1. Check that package.json on `main` says `X.Y.0`.
2. `git switch -c release/X.Y main && git push -u origin release/X.Y`. CI publishes `vX.Y.0`.
3. Open a PR on `main` that bumps package.json to `X.(Y+1).0`.

## Fix a released version

1. `git switch -c fix/<topic> origin/release/X.Y`
2. Make the fix and bump package.json to `X.Y.(Z+1)` in the same PR (run `npm run build` so `dist/` matches).
3. Open the PR against `release/X.Y`. Merging it publishes `vX.Y.(Z+1)`.
4. If `main` has the same bug, cherry-pick the fix in a separate PR. Never merge a release branch back into `main`.

## Installer channels

`scripts/install.sh stable` installs the latest stable release, `nightly` the newest prerelease, and `vX.Y.Z` a specific tag. It verifies `SHA256SUMS` before installing.
