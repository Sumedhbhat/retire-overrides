# Ecosystem adapters

The engine never reads a manifest or lockfile directly. It asks an adapter, and adding an ecosystem means adding an adapter (`src/adapters/`). This page sets out exactly what the implemented adapters support, the design for each planned one, and how to write a new one.

## Support boundaries

### npm (implemented)

| | Supported | Reported as unsupported |
|---|---|---|
| Location | `overrides` in the **root** package.json | `overrides` in workspace package.json files (npm ignores them) |
| Keys | global (`pkg`), version-selected (`pkg@1`, `@scope/pkg@^2`), nested/parent-scoped to any depth (`{ "a": { "b": { "pkg": … } } }`), `.` self-overrides | — |
| Values | semver versions and ranges, `$name` references to root dependencies | `npm:` aliases, git, file, URL and tag values; `$name` that names no root dependency |
| Lockfile | `package-lock.json` / `npm-shrinkwrap.json`, lockfileVersion 2 and 3 | lockfileVersion 1 (BLOCKED: regenerate with npm 7+) |
| Workspaces | paths through every workspace importer; one shared lockfile | — |

Semantics: a nested override applies to the target anywhere **below** its scope, which is how npm propagates override sets. Removal deletes one leaf, prunes objects left empty, and collapses `{ ".": "x" }` back to `"x"`. Unrelated entries, key order and the file's indentation are preserved.

Resolution: `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefer-online`, then `npm update --no-save --package-lock-only <pkgs>` for the packages whose locked versions must not be trusted. Deleting lockfile entries would be the obvious alternative, but npm doesn't repair deleted entries inside workspaces, so `update` is used instead.

### pnpm (implemented)

| | Supported | Reported as unsupported |
|---|---|---|
| Location | chosen by the pinned pnpm version (`packageManager`, `devEngines.packageManager`, else the installed one): pnpm ≤ 9 reads `pnpm.overrides` in package.json; pnpm 10 reads both; pnpm ≥ 11 reads only `overrides` in pnpm-workspace.yaml | overrides in a location the pinned version ignores |
| Keys | `pkg`, `pkg@<range>`, `parent>pkg`, `parent@range>pkg@range` (pnpm's own delimiter rule: a `>` not preceded by space, `\|` or `@`) | multi-level selectors (`a>b>c`) |
| Values | semver versions and ranges, `$name` | `-` (dependency removal), `catalog:`, `link:`, `file:`, `npm:` aliases |
| Lockfile | `pnpm-lock.yaml` lockfileVersion 9.0 (pnpm 9–12) | other lockfile versions (BLOCKED) |
| Workspaces | every importer in the shared lockfile, `link:` edges between workspace packages | `.pnpmfile.cjs` `readPackage` hooks are flagged: results assume they don't touch affected packages |

Semantics: `parent>pkg` applies only when `parent` is the **immediate** parent. Edits to pnpm-workspace.yaml keep comments and other settings, and an emptied file is deleted.

Resolution: `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`, then `pnpm update --recursive --depth Infinity --no-save --lockfile-only <pkgs>`.

### Both

- If the pinned package-manager major differs from the installed one, every override in that project is BLOCKED. Enable Corepack (the action does) or install the pinned version.
- Declared ranges come from the lockfile when it records them (npm), and otherwise from the published manifest in the registry (pnpm).
- Parent constraints count only on paths the override governs. A copy the override never reached is the vulnerability scan's job, not the removal check's.

## Planned adapters

Each planned adapter is already registered. For now it only *detects*: when its mechanism is present, the report lists it as unsupported and evaluates nothing. Here is the design each one must follow. The defining rule is that these mechanisms are not equivalent, and every adapter has to be honest about the difference.

### Yarn: `resolutions`

- **Discovery:** `resolutions` in the root package.json. Branch on the pinned Yarn version. Classic (1.x) uses glob-like patterns (`**/pkg`, `parent/pkg`). Modern Yarn (2+) uses descriptors (`pkg@npm:^1.0.0`, `parent/pkg`).
- **Graph:** Classic `yarn.lock` (custom format) and Berry `yarn.lock` (YAML with `resolution:`/`dependencies:` entries).
- **Resolution:** modern `yarn install --mode=update-lockfile` (no linking, no scripts). Classic has no lockfile-only mode, so it needs `--ignore-scripts --frozen-lockfile=false` in an isolated cache, and it should be marked as a weaker guarantee.
- **Narrowest scope:** `parent/pkg` in both lines.

### Python / uv: `override-dependencies`, `constraint-dependencies`

- **Overrides** replace declared requirements outright. They are the counterpart of npm overrides and can be removed by the same proof.
- **Constraints** only narrow what resolution may choose. A constraint is often ordinary policy. Only tool-created constraints (trailers) or ones opted in through `manage` are candidates. Everything else gets REVIEW_NEEDED, never removal.
- **Resolution:** `uv lock --upgrade-package <pkg>` in the scratch worktree, which never installs. **Graph:** `uv.lock`. **Advisories:** OSV (PyPI ecosystem). **Release dates:** PyPI JSON `upload_time`.

### Rust / Cargo: `[patch]`, `[replace]`

- `[patch]` replaces a **source**. It is not a general way to force a registry version. The adapter should prefer `cargo update -p <pkg> --precise <fixed>` (a lockfile-only change) and suggest a patch only when the fix requires a fork.
- Removing a `[patch]` entry is proven the same way. `[replace]` is deprecated and gets reported.
- **Resolution:** `cargo update -p <pkg>` / `cargo generate-lockfile`, with no build. **Advisories:** RustSec/OSV. **Release dates:** crates.io API.

### Go: `replace`, raised `require`

- `replace` directives are overrides. A `require` raised above what the module graph needs is also one, but only if the tool created it or it is opted in.
- `// indirect` means the dependency is indirect. It **is not** an override marker, and it is never a reason to delete a line.
- **Resolution:** delete or adjust the directive, then `go mod tidy` with `GOFLAGS=-mod=mod`, `GOPROXY` set, and no build. **Graph:** `go mod graph`. **Advisories:** `govulncheck`'s database / OSV. **Release dates:** `go list -m -json <mod>@<v>` (`Time`).

### Gradle: constraints, strict versions, forced versions, resolution rules

- These are often intentional version policy, such as platform alignment or BOMs. Only temporary security fixes the tool can identify are managed: tool-created entries with `because("<GHSA>")` plus trailers, or opt-ins.
- **Graph:** dependency lockfiles (`gradle.lockfile`) or `dependencies --configuration`. Without lockfiles, resolution means running Gradle, which needs a sandboxed build with no tasks beyond resolution. That's the main open design risk.

### Maven: `<dependencyManagement>`, explicit transitive declarations

- These are normal dependency policy as often as they are fixes. Existing ambiguous entries need `manage` opt-in. Entries the tool creates carry trailers and an XML comment naming the advisory.
- **Graph:** `mvn dependency:tree -DoutputType=json` with `-o` against a prepared repository, or an offline resolver. **Advisories:** OSV (Maven).

### .NET / NuGet: `PackageReference`, `PackageVersion`, `VersionOverride`, transitive pinning

- Direct references and central versions are usually real application dependencies. Only identifiable temporary fixes are managed: transitive pins added by the tool under `CentralPackageTransitivePinningEnabled`, or `VersionOverride` entries with trailers.
- **Graph:** `packages.lock.json` (`RestorePackagesWithLockFile`). **Resolution:** `dotnet restore --use-lock-file --force-evaluate` (restore only, no build).

## Writing an adapter

Implement `ImplementedAdapter` in `src/adapters/adapter.ts`:

| Method | Contract |
|---|---|
| `detect(repo)` | Find projects (manifest + lockfile + package-manager version). Report anything you can't evaluate as `UnsupportedForm`. Never skip it silently. |
| `preflight(project)` | Return blockers that make evaluation meaningless, such as a package-manager version mismatch. |
| `readOverrides(project, dir)` | Return each override as an `OverrideEntry` with target, scope, value and key path. Unsupported forms go into `unsupported`. |
| `readGraph(project, dir)` | Parse the lockfile into nodes, edges and importers. Record declared ranges when the lockfile has them. Throw on unsupported lockfile versions. |
| `resolve(project, dir, { refresh, registry })` | Re-resolve **without installing and without lifecycle scripts**. `refresh` names packages whose locked versions must be discarded. Throw on failure; the engine turns that into BLOCKED. |
| `removeOverride`, `writeOverride` | Edit only the one entry. Preserve unrelated entries, comments, order and formatting. |
| `setDependencySpec`, `directSpec` | Read and write a direct dependency's spec in an importer manifest. |
| `overrideApplies(entry, path)` | The package manager's own scoping semantics for one dependency path. |
| `selectorFor(target, scope)` | The native selector text the adapter would write. It is part of PR identities and trailers. |
| `locate(project, dir, entry)` | The line of an entry, for `git blame`. |

Then register the adapter in `src/adapters/index.ts`, add an advisory provider if the ecosystem needs one (`src/advisories/providers.ts`), and add fixture scenarios like those in `test/scenarios/`. Each scenario builds a real repository, resolves it with the real package manager against a snapshot registry, and asserts statuses. An adapter isn't done until every removal status has a fixture.
