/**
 * Seed the e2e RUBATO_HOME with a test app registry, reusing the SAME
 * provisioning the `rubato-sandbox` CLI and the integration/functional testkit
 * use. Run under Bun (it touches Bun-only APIs) — invoked by e2e/global-setup.ts,
 * which runs in Playwright's Node runtime and shells out here.
 */

import { resolve } from "node:path";
import { provisionSandbox, type SandboxPaths } from "../src/scripts/sandbox";

const rubato = resolve(import.meta.dir, ".rubato-home.ignore");
const root = resolve(import.meta.dir, ".e2e-sandbox.ignore");
const paths: SandboxPaths = {
  root,
  rubato,
  code: resolve(root, "code"),
  shellDir: resolve(root, "shell"),
};

await provisionSandbox(paths, { apps: ["api", "web", "cli"] });
console.log(`seeded e2e registry at ${rubato}`);
