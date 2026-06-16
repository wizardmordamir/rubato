import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Seed the e2e RUBATO_HOME before the suite runs. Playwright's runner is Node,
 * but the seeding (`provisionSandbox`) uses Bun-only APIs — so this shells out to
 * `e2e/seed-home.ts` under Bun. That reuses the SAME provisioning the sandbox CLI
 * and the integration/functional testkit use, so every layer stands up an app
 * registry the same way. Output dirs are gitignored (`*.ignore`).
 */
export default function globalSetup(): void {
  execFileSync("bun", ["run", resolve(import.meta.dirname, "seed-home.ts")], { stdio: "inherit" });
}
