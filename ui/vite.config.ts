import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, loadEnv } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// React StrictMode double-mounts effects in dev, so our /ws client (useLive.ts)
// opens then immediately closes a socket on every page load. Tearing down that
// short-lived socket makes Vite's ws proxy log a benign `write EPIPE` (or
// ECONNRESET) with a full multi-line stack. The connection recovers fine, so
// collapse just that error to a one-line warning instead of dumping the stack.
const logger = createLogger();
const baseError = logger.error;
logger.error = (msg, opts) => {
  if (opts?.error && /ws proxy socket error/.test(msg)) {
    logger.warn(`ws proxy socket error: ${opts.error.message}`, { timestamp: true });
    return;
  }
  baseError(msg, opts);
};

// Bun's internal HTTP upgrade socket (the client side of a /ws proxy connection)
// does not implement the legacy net.Socket#destroySoon method that Vite's bundled
// http-proxy calls when the proxied WS connection errors or the upstream returns a
// non-101 response and ends — which happens whenever the rubato API on :4747 is
// down, restarting, or something else has grabbed the port. The call throws
// `socket.destroySoon is not a function`, and because it fires from a stream
// 'end'/'error' emit it surfaces as an UNCAUGHT exception that kills the whole dev
// server. Patching the missing method onto each incoming proxy socket turns "flaky
// or absent upstream" into a dropped connection instead of a crash, so we can keep
// developing while the backend cycles. (Bun 1.3.x — drop if Bun adds destroySoon.)
const ensureDestroySoon = (socket: any) => {
  if (socket && typeof socket.destroySoon !== "function") {
    socket.destroySoon = function destroySoon() {
      try {
        this.end();
      } catch {
        try {
          this.destroy();
        } catch {
          /* socket already gone — nothing to do */
        }
      }
    };
  }
};

// Belt-and-suspenders for the gap above: rather than rely on the per-proxy
// `configure` hook catching every socket (it doesn't — some internal http-proxy
// paths reach for destroySoon on a socket the hook never saw), patch EVERY socket
// the dev server accepts the instant it arrives — both ordinary HTTP connections
// (the /api proxy) and WS upgrade sockets (the /ws proxy). After this, destroySoon
// always exists by the time any proxy code path calls it.
//
// Last line of defence: even with the socket patched, a cycling/flaky upstream can
// still make Vite's bundled http-proxy throw from a stream 'end'/'error' emit (a
// late ECONNRESET/EPIPE, or another Bun missing-method TypeError). Because that
// fires off the event loop it surfaces as an UNCAUGHT exception, whose default
// disposition is to kill the dev server outright. In dev we'd far rather log it and
// keep serving, so install process-level guards that swallow the known network/
// proxy noise (one-line warning) and, for anything unexpected, still log the full
// stack but keep the process alive. Installed once per process; a re-evaluation of
// this config is a no-op, and they're scoped to `dev` (configureServer) so a
// production `build` never silently swallows a real failure.
const BENIGN_NET = /destroySoon|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ERR_STREAM/;
const installDevGuards = () => {
  const g = globalThis as any;
  if (g.__rubatoDevGuards) return;
  g.__rubatoDevGuards = true;
  process.on("uncaughtException", (err: any) => {
    const detail = `${err?.code ?? ""} ${err?.message ?? err}`;
    if (BENIGN_NET.test(detail)) {
      logger.warn(`dev proxy: ignored ${err?.name ?? "error"} (${err?.code ?? err?.message})`, { timestamp: true });
      return;
    }
    logger.error(`uncaught exception (dev server kept alive):\n${err?.stack ?? detail}`, { timestamp: true, error: err });
  });
  process.on("unhandledRejection", (reason: any) => {
    const detail = `${reason?.code ?? ""} ${reason?.message ?? reason}`;
    if (BENIGN_NET.test(detail)) {
      logger.warn(`dev proxy: ignored unhandled rejection (${reason?.code ?? reason?.message})`, { timestamp: true });
      return;
    }
    logger.error(`unhandled rejection (dev server kept alive):\n${reason?.stack ?? detail}`, { timestamp: true });
  });
};

// Dev-only plugin: install the process guards and patch every accepted socket.
const devProxyResilience = {
  name: "rubato:dev-proxy-resilience",
  configureServer(server: any) {
    installDevGuards();
    server.httpServer?.on("connection", ensureDestroySoon);
    server.httpServer?.on("upgrade", (_req: any, socket: any) => ensureDestroySoon(socket));
  },
};

// rubato UI: React + Tailwind. In dev, Vite proxies /api to the rubato server
// (rubato-serve, default :4747). Wire types are imported from the repo's
// src/shared via the @shared alias (no symlink needed).
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
  // The dev API port — same source the rubato server uses (RUBATO_PORT or 4747).
  // Drives both the /api proxy target and the WS URL injected for the client.
  const apiPort = env.RUBATO_PORT && Number(env.RUBATO_PORT) > 0 ? env.RUBATO_PORT : "4747";
  return {
    customLogger: logger,
    plugins: [react(), tailwindcss(), devProxyResilience],
    // The live socket connects straight to the API in dev (Vite's /ws proxy hangs
    // the upgrade under Vite 8/rolldown). See ui/src/useLive.ts.
    define: { __RUBATO_DEV_WS_URL__: JSON.stringify(`ws://localhost:${apiPort}/ws`) },
    resolve: {
      alias: { "@shared": resolve(here, "../src/shared") },
      // Force single instances of context-bearing libs. `cwip` is bun-linked and
      // ships its own React (and @tanstack/react-query) under its node_modules, so
      // without deduping Vite bundles a SECOND copy for cwip/react — two Reacts means
      // hooks read a null dispatcher and the app white-screens; two query clients
      // means cwip's useApiMutation can't see the app's QueryClientProvider.
      // recharts lives in ru-ui's node_modules; dedupe so cursedbelt's chart source
      // (resolved from the repo-root cursedbelt) bundles the single ui-local copy.
      // zustand/lucide-react: cursedbelt ships its own — force one copy each.
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@tanstack/react-query",
        "recharts",
        "@glideapps/glide-data-grid",
        "zustand",
        "lucide-react",
      ],
      // Consume cursedbelt as SOURCE in dev/build (its `source` export condition
      // -> ./src) so a one-line cursedbelt edit appears with no rebuild; tsc's
      // customConditions:["source"] (ui/tsconfig.json + tsconfig.lib.json) matches.
      conditions: ["source", "import", "module", "browser", "default"],
    },
    server: {
      port: env.PORT ? Number(env.VITE_PORT) : 5175,
      fs: { allow: [resolve(here, ".."), here] },
      // Only /api is proxied. The live socket (/ws) is NOT — the client opens it
      // straight against the API in dev (see ui/src/useLive.ts), because Vite 8's
      // WS proxy hangs the upgrade and live streaming never starts.
      proxy: {
        "/api": `http://localhost:${apiPort}`,
      },
    },
    build: { outDir: "dist", emptyOutDir: true },
  }
});
