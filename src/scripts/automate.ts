/**
 * rubato-automate — run a saved Playwright automation headless from the terminal.
 *
 * Automations are built in the web UI (rubato-serve → Automations) and stored as
 * JSON under ~/.rubato/automations/. This runs one by id or name, printing each
 * step's result, and records the run alongside the UI's history. Needs `node` on
 * PATH; drives your installed Google Chrome, or Playwright's bundled Chromium if
 * present (`bunx playwright install chromium`).
 */

import { getAutomation, listAutomations, slugify } from '../lib/automations';
import { runAutomationHeadless } from '../server/engine';
import { subscribe } from '../server/events';

async function resolveAutomation(arg: string) {
  const direct = (await getAutomation(arg)) ?? (await getAutomation(slugify(arg)));
  if (direct) return direct;
  const all = await listAutomations();
  return all.find((a) => a.name.toLowerCase() === arg.toLowerCase()) ?? null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));

  if (!name || args.includes('--list')) {
    const all = await listAutomations();
    if (all.length === 0) {
      console.log('No automations yet — build one in the web UI (rubato-serve → Automations).');
    } else {
      console.log('Saved automations:');
      for (const a of all) console.log(`  ${a.id}  —  ${a.name} (${a.steps.length} steps)`);
    }
    return;
  }

  const automation = await resolveAutomation(name);
  if (!automation) {
    console.error(`No automation matching "${name}". Try: rubato-automate --list`);
    process.exit(1);
  }

  const headless = !args.includes('--headed');
  console.log(`Running "${automation.name}"${headless ? '' : ' (headed)'}…\n`);

  const unsub = subscribe((e) => {
    if (e.type !== 'automation:step' || e.result.status === 'running') return;
    const r = e.result;
    const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '·';
    const sel = r.selector ? `  ${r.selector}` : '';
    const scraped = r.scraped ? `  → ${r.scraped.name}=${JSON.stringify(r.scraped.value)}` : '';
    const err = r.error ? `  — ${r.error}` : '';
    console.log(`${mark} [${r.index}] ${r.action}${sel}${scraped}${err}`);
  });

  const run = await runAutomationHeadless(automation, { headless });
  unsub();

  console.log(`\n${run.status === 'passed' ? 'PASSED' : 'FAILED'} in ${run.durationMs}ms`);
  if (Object.keys(run.scraped).length > 0) console.log('Scraped:', JSON.stringify(run.scraped, null, 2));
  process.exit(run.status === 'passed' ? 0 : 1);
}

if (import.meta.main) main();
