import type { EcosystemAdapter } from "./adapter.ts";
import { BunAdapter } from "./bun/bun.ts";
import { NpmAdapter } from "./npm/npm.ts";
import { plannedAdapters } from "./planned.ts";
import { PnpmAdapter } from "./pnpm/pnpm.ts";
import { UvAdapter } from "./uv/uv.ts";
import { YarnAdapter } from "./yarn/yarn.ts";

export function allAdapters(): EcosystemAdapter[] {
  return [new NpmAdapter(), new PnpmAdapter(), new BunAdapter(), new YarnAdapter(), new UvAdapter(), ...plannedAdapters];
}
