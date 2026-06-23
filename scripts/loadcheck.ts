#!/usr/bin/env bun
/**
 * `bun run loadcheck` — the FAST "does localhost actually load?" gate.
 *
 * Boots ru the way the OWNER runs it (the vite DEV server + API together, `bun run
 * dev`) on an isolated home + free ports, drives a HEADLESS browser at home + every
 * top-nav surface, and asserts each route MOUNTS ITS REAL CONTENT — a text landmark
 * unique to that page. That catches the three ways "localhost is broken" that a green
 * `tsc` + `bun test` MISS:
 *   1. a white screen (React root never mounts — a missing export, a bad import),
 *   2. a dev-only vite import-analysis / failed-to-resolve error on a lazy route,
 *   3. an ERROR BOUNDARY ("Failed to load") — the root mounts, but the page didn't.
 * The landmark assertion is what distinguishes (3) from a healthy load: a boundary has
 * children + often no console error, so "root is non-empty" is not enough.
 *
 * Wired into `bun run done` (runs BEFORE the slow functional/e2e suites — it's the
 * cheapest, highest-signal check) and runnable standalone anywhere we need to prove
 * localhost works, so a worker can never report "done" while the site is broken.
 *
 * The engine is the shared cwip/site-smoke `runSiteSmoke` — the SAME core the
 * promotion gate + main-health watchdog use, so a worker's local check and the gate
 * agree on what "loads" means.
 *
 *   bun run loadcheck            # boot + check (default)
 *   bun run loadcheck --strict   # treat INCONCLUSIVE (no browser) as a failure too
 *
 * Exit: 0 = every route loaded clean (or inconclusive — no browser, not a failure
 * unless --strict), 1 = a route white-screened / errored / is missing its landmark.
 */
import { pickFreePort, planSiteSmoke, runSiteSmoke, type SiteRoute, siteSmokeHomeDir } from "cwip/site-smoke";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Canonical ru route set: home + every top-nav hub + the orchestration dashboard, each
 * with a text landmark from that page's own body. ru lazy-loads pages, so NAVIGATING a
 * route forces vite to transform + evaluate its chunk on demand — the per-route import
 * gate. Keep this in sync with the watchdog's ru siteSmoke spec (single source of the
 * routes; exported so the gate can import it once promoted).
 */
export const RU_ROUTES: SiteRoute[] = [
  { path: "/", label: "home (apps)", landmark: "text=Repo tools" },
  { path: "/data", label: "data hub", landmark: "text=Queries, integrations, and API requests." },
  {
    path: "/automation",
    label: "automation hub",
    landmark: "text=Commands, scripts, browser, and pipeline automation.",
  },
  { path: "/results", label: "results hub", landmark: "text=Run history, archives, and output files." },
  { path: "/security", label: "security hub", landmark: "text=Vulnerability scans and remediation plans." },
  { path: "/docs", label: "docs hub", landmark: "text=Project docs, editable system files, and your rubato config." },
  { path: "/taskq", label: "orchestration dashboard", landmark: "text=Findings" },
];

/** Build the ru site-smoke spec: one DEV service (api + vite) navigated on its vite port. */
export async function buildRubatoSiteSpec() {
  const navPort = await pickFreePort();
  const apiPort = await pickFreePort();
  return planSiteSmoke({
    repo: "ru",
    cwd: ROOT,
    services: [
      {
        name: "dev",
        cmd: ["bun", "run", "dev"], // boots api + vite together, the way the owner runs ru
        cwd: ROOT,
        port: navPort, // the vite dev-server port the browser navigates
        portEnvVar: "VITE_PORT",
        homeEnvVar: "RUBATO_HOME",
        homeDir: siteSmokeHomeDir("ru", `${process.pid}-${navPort}`),
        readyPath: "/",
        timeoutMs: 120_000, // a cold ru dev boot (server + vite)
        extraEnv: { RUBATO_PORT: String(apiPort) }, // the API port the vite proxy targets
      },
    ],
    navService: "dev",
    routes: RU_ROUTES,
  });
}

export async function runLoadCheck(strict: boolean): Promise<number> {
  const res = await runSiteSmoke(await buildRubatoSiteSpec());
  for (const v of res.verdict?.routes ?? []) {
    console.log(`${v.ok ? "✓" : "✗"} ${v.label ?? v.path}${v.ok ? "" : ` — ${v.reason ?? "failed"}: ${v.detail ?? ""}`}`);
  }
  if (!res.ran) {
    console.warn(`⚠ loadcheck INCONCLUSIVE — ${res.detail}`);
    return strict ? 1 : 0;
  }
  console.log(`\n${res.ok ? "✅" : "❌"} loadcheck ${res.ok ? "GREEN" : "RED"} — ${res.detail} (${res.durationMs}ms)`);
  if (!res.ok && res.logTail) console.log(`\n--- service output ---\n${res.logTail}`);
  return res.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await runLoadCheck(process.argv.includes("--strict")));
