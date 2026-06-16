/**
 * rubato-export — export a saved automation as a standalone @playwright/test spec.
 *
 * Automations are built in the web UI and stored under ~/.rubato/automations/.
 * This renders one to Playwright test source (src/lib/exportSpec.ts) so another
 * app can drop it straight into its own e2e suite — no rubato runtime dependency.
 * By default it writes <id>.spec.ts in the current dir; --stdout prints instead.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { getAutomation, listAutomations, slugify } from '../lib/automations';
import { automationToSpec } from '../lib/exportSpec';

async function resolveAutomation(arg: string) {
  const direct = (await getAutomation(arg)) ?? (await getAutomation(slugify(arg)));
  if (direct) return direct;
  const all = await listAutomations();
  return all.find((a) => a.name.toLowerCase() === arg.toLowerCase()) ?? null;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--') && a !== flagValue(args, '--out'));

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
    console.error(`No automation matching "${name}". Try: rubato-export --list`);
    process.exit(1);
  }

  const spec = automationToSpec(automation);

  if (args.includes('--stdout')) {
    process.stdout.write(spec);
    return;
  }

  const outArg = flagValue(args, '--out');
  const out = outArg
    ? isAbsolute(outArg)
      ? outArg
      : resolve(process.cwd(), outArg)
    : resolve(process.cwd(), `${automation.id}.spec.ts`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, spec);
  console.log(`Wrote ${out}`);
}

if (import.meta.main) main();
