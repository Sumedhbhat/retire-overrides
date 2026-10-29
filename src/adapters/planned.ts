import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EcosystemId, UnsupportedForm } from "../types.ts";
import type { EcosystemAdapter, Project } from "./adapter.ts";
import { findFiles } from "./node-common.ts";

interface Probe {
  files: string[];
  /** Pattern that marks a native override mechanism in a matching file. */
  pattern: RegExp;
  mechanism: string;
  /** Only probe files that have this sibling (for example yarn.lock next to package.json). */
  sibling?: string;
}

/**
 * An ecosystem whose adapter is designed (see docs/adapters.md) but not built yet. It never evaluates
 * anything: it only reports the native mechanisms it finds, so unsupported forms are visible.
 */
class PlannedAdapter implements EcosystemAdapter {
  readonly support = "planned" as const;
  readonly id: EcosystemId;
  readonly mechanisms: string;
  readonly limitations: string;
  private readonly probes: Probe[];

  constructor(id: EcosystemId, mechanisms: string, limitations: string, probes: Probe[]) {
    this.id = id;
    this.mechanisms = mechanisms;
    this.limitations = limitations;
    this.probes = probes;
  }

  async detect(repo: string): Promise<{ projects: Project[]; unsupported: UnsupportedForm[] }> {
    const unsupported: UnsupportedForm[] = [];
    for (const probe of this.probes) {
      for (const file of await findFiles(repo, new Set(probe.files))) {
        if (probe.sibling) {
          const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
          if ((await readFile(join(repo, dir + probe.sibling), "utf8").catch(() => undefined)) === undefined) continue;
        }
        const text = await readFile(join(repo, file), "utf8").catch(() => "");
        if (probe.pattern.test(text)) {
          unsupported.push({
            ecosystem: this.id,
            file,
            message: `${probe.mechanism} found; the ${this.id} adapter is planned, not implemented, so this was not evaluated`,
          });
        }
      }
    }
    return { projects: [], unsupported };
  }
}

export const plannedAdapters: EcosystemAdapter[] = [
  new PlannedAdapter(
    "cargo",
    "[patch.*] and [replace] in Cargo.toml, plus dependency version requirements",
    "[patch] replaces a source; it is not a general way to force a registry version, so a plain lockfile update is preferred.",
    [{ files: ["Cargo.toml"], pattern: /^\s*\[(patch\.|replace\])/m, mechanism: "Cargo `[patch]`/`[replace]`" }],
  ),
  new PlannedAdapter(
    "go",
    "`replace` directives and raised `require` versions in go.mod",
    "`// indirect` marks an indirect dependency, not an override, and is never deleted on that basis.",
    [{ files: ["go.mod"], pattern: /^\s*replace\b/m, mechanism: "Go `replace`" }],
  ),
  new PlannedAdapter(
    "gradle",
    "dependency constraints, strict versions, forced versions and resolution rules",
    "Constraints and strict versions are often intentional version policy; only identifiable temporary security fixes are managed.",
    [
      {
        files: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
        pattern: /\b(constraints\s*\{|strictly\s*\(|force\s*\(|resolutionStrategy)/,
        mechanism: "Gradle constraints/strict/forced versions",
      },
    ],
  ),
  new PlannedAdapter(
    "maven",
    "<dependencyManagement> and explicit declarations of transitive dependencies in pom.xml",
    "These are frequently normal dependency policy; existing ambiguous entries need explicit opt-in.",
    [{ files: ["pom.xml"], pattern: /<dependencyManagement>/, mechanism: "Maven `<dependencyManagement>`" }],
  ),
  new PlannedAdapter(
    "nuget",
    "PackageReference, PackageVersion, VersionOverride and CentralPackageTransitivePinningEnabled",
    "Direct references and central versions are usually legitimate application dependencies; only identifiable temporary fixes are managed.",
    [
      {
        files: ["Directory.Packages.props"],
        pattern: /(VersionOverride|CentralPackageTransitivePinningEnabled|<PackageVersion\b)/,
        mechanism: "NuGet central package management",
      },
    ],
  ),
];
