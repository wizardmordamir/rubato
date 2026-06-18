#!/usr/bin/env bun
/**
 * scans  (installed as a shell function)
 *
 * Download a Jenkins build's archived artifacts (SAST/SCA reports, etc.) to a
 * local folder. Defaults to the latest successful build for the app/env.
 *
 * Note: only Jenkins-*archived* artifacts are fetched here. Scans that a pipeline
 * publishes as HTML pages rather than artifacts need a separate (Playwright)
 * retrieval — a planned follow-up.
 *
 * Artifacts save to `--out <dir>` if given, else `<outputDir>/scans/<app>-<build>`
 * (so the web UI "Files" tab shows them).
 *
 * Usage (after rubato-setup):
 *   scans <app> [env] [--build <n>] [--out <dir>]
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveAppJenkins } from '../api/jenkins';
import { startDiagnostics } from '../lib/diagnostics';
import { ensureOutputDir } from '../lib/runStore';

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const buildArg = getOpt(args, 'build');
  const outArg = getOpt(args, 'out');
  const positional = args.filter((a) => !a.startsWith('--') && a !== buildArg && a !== outArg);
  const [query, env] = positional;

  if (!query) {
    console.error('usage: scans <app> [env] [--build <n>] [--out <dir>]');
    process.exit(1);
  }

  const startedAt = Date.now();
  const diag = startDiagnostics({ activity: 'scans', intent: `download scan artifacts for ${query}`, console: false });

  const { app, jenkins, client } = await resolveAppJenkins(query);
  const jobPath = client.resolveJobPath(jenkins, { env });

  // Resolve the build number: explicit, else the latest successful build.
  let buildNumber: number;
  if (buildArg) {
    buildNumber = Number(buildArg);
    if (!Number.isInteger(buildNumber)) {
      console.error(`scans: --build must be a number, got "${buildArg}"`);
      process.exit(1);
    }
  } else {
    const build = await client.getLatestBuild(jobPath, { status: 'success' });
    if (!build) {
      console.error(`scans: no successful build for ${app.name}${env ? ` (env ${env})` : ''}.`);
      diag.error(`no successful build for ${app.name}`, { env: env ?? '(default)', jobPath });
      await diag.finish('error');
      process.exit(1);
    }
    buildNumber = build.number;
  }
  diag.step('resolved build', { app: app.name, build: buildNumber, jobPath });

  const artifacts = await client.getArtifacts(jobPath, buildNumber);
  if (artifacts.length === 0) {
    console.log(`No artifacts on ${app.name} build #${buildNumber}.`);
    diag.info('no artifacts', { app: app.name, build: buildNumber });
    await diag.finish('ok');
    return;
  }

  const outDir = outArg ? resolve(outArg) : join(await ensureOutputDir(), 'scans', `${app.name}-${buildNumber}`);
  await mkdir(outDir, { recursive: true });

  let saved = 0;
  const failed: string[] = [];
  for (const artifact of artifacts) {
    const stream = await client.downloadArtifact(jobPath, buildNumber, artifact.relativePath);
    if (!stream) {
      console.error(`  failed: ${artifact.relativePath}`);
      failed.push(artifact.relativePath);
      continue;
    }
    const dest = join(outDir, artifact.relativePath);
    await mkdir(join(dest, '..'), { recursive: true });
    await Bun.write(dest, new Response(stream));
    console.log(`  saved ${artifact.relativePath}`);
    saved++;
  }
  if (failed.length) diag.warn('some artifacts failed to download', { failed });

  // An overview sibling so a shared scans/ dir explains what was fetched + missed.
  await Bun.write(
    join(outDir, 'report.json'),
    `${JSON.stringify(
      {
        correlationId: diag.correlationId,
        generatedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        app: app.name,
        env: env ?? '(default)',
        build: buildNumber,
        counts: { artifacts: artifacts.length, saved, failed: failed.length },
        failed,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`✅ Saved ${saved}/${artifacts.length} artifact(s) from ${app.name} #${buildNumber} → ${outDir}`);
  await diag.finish(failed.length ? 'warn' : 'ok');
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
