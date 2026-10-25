import type { EcosystemAdapter } from "./adapter.ts";
import { NpmAdapter } from "./npm/npm.ts";
import { plannedAdapters } from "./planned.ts";
import { PnpmAdapter } from "./pnpm/pnpm.ts";

export function allAdapters(): EcosystemAdapter[] {
  return [new NpmAdapter(), new PnpmAdapter(), ...plannedAdapters];
}
