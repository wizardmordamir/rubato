import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SETUP_SCRIPTS_DIR } from '../lib/config';
import {
  deleteSetupScript,
  listSetupScripts,
  readSetupScript,
  resetSetupScript,
  seedSetupScripts,
  writeSetupScript,
} from './setupScripts';

// SETUP_SCRIPTS_DIR derives from the throwaway test RUBATO_HOME (see test/setup.ts),
// so this only ever touches a temp dir. Wipe it around each test for isolation.
const clean = () => rm(SETUP_SCRIPTS_DIR, { recursive: true, force: true });
beforeEach(clean);
afterEach(clean);

describe('setupScripts', () => {
  it('seeds the bundled templates into an empty dir, idempotently', async () => {
    const created = await seedSetupScripts();
    expect(created).toContain('00-reset-all.sh');
    expect(created).toContain('70-cloudflare.sh');
    expect(created).toContain('81-ca-setup.sh');
    expect(created).toContain('README.md');
    // a second seed creates nothing new
    expect(await seedSetupScripts()).toEqual([]);
  });

  it('lists templates in run order with absolute paths + metadata', async () => {
    const list = await listSetupScripts(); // auto-seeds
    expect(list.length).toBeGreaterThanOrEqual(11);
    expect(list[0]?.name).toBe('README.md');

    const ollama = list.find((s) => s.name === '10-ollama.sh');
    expect(ollama?.isTemplate).toBe(true);
    expect(ollama?.label).toBe('Ollama + models');
    expect(ollama?.path).toBe(resolve(SETUP_SCRIPTS_DIR, '10-ollama.sh'));

    const idx = (n: string) => list.findIndex((s) => s.name === n);
    expect(idx('00-reset-all.sh')).toBeLessThan(idx('10-ollama.sh'));
    expect(idx('10-ollama.sh')).toBeLessThan(idx('81-ca-setup.sh'));
  });

  it('reads a seeded script and its content', async () => {
    await seedSetupScripts();
    const doc = await readSetupScript('70-cloudflare.sh');
    expect(doc?.exists).toBe(true);
    expect(doc?.isTemplate).toBe(true);
    expect(doc?.content).toContain('api.cloudflare.com');
  });

  it('never overwrites an edited script when re-seeding', async () => {
    await writeSetupScript('10-ollama.sh', '#!/usr/bin/env bash\n# edited by me\n');
    const created = await seedSetupScripts();
    expect(created).not.toContain('10-ollama.sh');
    expect((await readSetupScript('10-ollama.sh'))?.content).toContain('# edited by me');
  });

  it('writes a new custom script and lists it as non-template', async () => {
    const doc = await writeSetupScript('99-custom.sh', '#!/usr/bin/env bash\necho hi\n');
    expect(doc?.isTemplate).toBe(false);
    expect(doc?.label).toBe('99-custom.sh');
    const list = await listSetupScripts();
    expect(list.find((s) => s.name === '99-custom.sh')?.isTemplate).toBe(false);
  });

  it('deletes a script', async () => {
    await writeSetupScript('99-custom.sh', '#!/usr/bin/env bash\n');
    expect(await deleteSetupScript('99-custom.sh')).toBe(true);
    expect(await readSetupScript('99-custom.sh')).toBeNull();
  });

  it('resets an edited template back to its bundled default', async () => {
    await writeSetupScript('10-ollama.sh', '# trashed\n');
    const doc = await resetSetupScript('10-ollama.sh');
    expect(doc?.content).toContain('ollama pull');
    expect(doc?.content).not.toContain('# trashed');
    // a non-template name has nothing to reset to
    await writeSetupScript('99-custom.sh', 'x');
    expect(await resetSetupScript('99-custom.sh')).toBeNull();
  });

  it('refuses unsafe / non-script names (no path-traversal surface)', async () => {
    expect(await readSetupScript('../../etc/passwd')).toBeNull();
    expect(await writeSetupScript('../escape.sh', 'x')).toBeNull();
    expect(await writeSetupScript('nested/x.sh', 'x')).toBeNull();
    expect(await writeSetupScript('notscript.json', 'x')).toBeNull();
    expect(await deleteSetupScript('../../etc/passwd')).toBe(false);
    expect(await resetSetupScript('../10-ollama.sh')).toBeNull();
  });

  it('rejects content over the size cap', async () => {
    await expect(writeSetupScript('10-ollama.sh', 'x'.repeat(600_000))).rejects.toThrow(/too large/);
  });
});
