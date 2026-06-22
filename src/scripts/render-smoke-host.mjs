/**
 * Lightweight, one-shot Node Playwright host for the render smoke (anti-white-screen).
 *
 * Playwright does NOT work under Bun's native runtime (chromium.launch hangs — see
 * `browser-host.mjs`), so the render check runs here in `node`, driven NOT by the full
 * stdio automation protocol but by simple CLI args, because this is a single load-and-
 * report probe, not an interactive session:
 *
 *   node render-smoke-host.mjs --url <url> [--root '#root'] [--timeout 20000]
 *
 * It launches a headless browser, navigates to `--url`, waits for the React root to
 * MOUNT (become non-empty), collects every console-error + uncaught page exception, then
 * prints EXACTLY one machine-readable line and exits:
 *
 *   RENDER_SMOKE_PROBE:{"launched":true,"navigated":true,"rootFound":true,
 *                       "rootHtmlLength":12345,"consoleErrors":[...],"pageErrors":[...]}
 *
 * The Bun side (`renderSmoke.ts` → `parseProbe`) reads that one line. The host NEVER
 * exits non-zero on a white screen / nav failure — that's data, not a crash — it only
 * reports `launched:false` (with an `error`) when a browser can't even start, so the gate
 * can treat "couldn't run" as inconclusive rather than as a failed render.
 *
 * Plain `.mjs` (no TypeScript) so `node` runs it with no loader/build step.
 */

function parseArgs(argv) {
  const get = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] != null ? argv[i + 1] : dflt;
  };
  return {
    url: get('url', ''),
    root: get('root', '#root'),
    timeout: Number(get('timeout', '20000')) || 20000,
  };
}

/** Print the single result line the Bun side parses, then exit 0 (a white screen is data). */
function emit(probe) {
  const full = {
    launched: false,
    navigated: false,
    rootFound: false,
    rootHtmlLength: 0,
    consoleErrors: [],
    pageErrors: [],
    ...probe,
  };
  process.stdout.write(`\nRENDER_SMOKE_PROBE:${JSON.stringify(full)}\n`);
}

/**
 * Launch a headless browser. Prefer the user's installed Google Chrome (`channel:chrome`,
 * matching the e2e suite + browser-host.mjs), fall back to Playwright's bundled Chromium.
 * Returns `null` if neither is available so the caller reports an inconclusive probe.
 */
async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    /* no system Chrome — try the bundled browser */
  }
  return chromium.launch({ headless: true });
}

async function main() {
  const { url, root, timeout } = parseArgs(process.argv.slice(2));
  if (!url) {
    emit({ launched: false, error: 'no --url given' });
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    emit({ launched: false, error: `playwright not installed: ${e?.message ?? e}` });
    return;
  }

  let browser;
  try {
    browser = await launchBrowser(chromium);
  } catch (e) {
    emit({ launched: false, error: `could not launch a browser: ${e?.message ?? e}` });
    return;
  }

  const consoleErrors = [];
  const pageErrors = [];
  let navigated = false;
  let rootFound = false;
  let rootHtmlLength = 0;
  let navError;

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err?.message ?? String(err)));

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      navigated = true;
    } catch (e) {
      navError = e?.message ?? String(e);
    }

    if (navigated) {
      // Wait (bounded) for the React root to MOUNT — become non-empty. A white screen
      // leaves it empty, so this times out and we read the still-empty state below.
      try {
        await page.waitForFunction(
          (sel) => {
            const el = document.querySelector(sel);
            return !!el && el.innerHTML.trim().length > 0;
          },
          root,
          { timeout: Math.min(timeout, 10000) },
        );
      } catch {
        /* never mounted within the bound — captured as rootHtmlLength:0 below */
      }
      // Read the final mount state (whether or not the wait succeeded).
      try {
        const state = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return { found: !!el, len: el ? el.innerHTML.trim().length : 0 };
        }, root);
        rootFound = state.found;
        rootHtmlLength = state.len;
      } catch (e) {
        navError = navError ?? `evaluate failed: ${e?.message ?? e}`;
      }
    }

    emit({ launched: true, navigated, rootFound, rootHtmlLength, consoleErrors, pageErrors, error: navError });
  } catch (e) {
    emit({ launched: true, navigated, rootFound, rootHtmlLength, consoleErrors, pageErrors, error: e?.message ?? String(e) });
  } finally {
    try {
      await browser.close();
    } catch {
      /* best-effort */
    }
  }
}

main().catch((e) => {
  emit({ launched: false, error: `render host crashed: ${e?.message ?? e}` });
});
