/**
 * Dashboard iteration 3: per-app "latest published image" (deployed version + sha)
 * for the status board, built on the deploy-collection engine (`collectApps`) and
 * the soft-gated service clients (`buildDeployClients`). Credential-gated: with no
 * creds, no client is built and every app reports `available:false` — the board
 * never errors. Scaffolding that lights up once `~/.rubato/.env` has the creds.
 */

import type { AppConfig } from '../lib/apps';
import { buildDeployClients } from '../lib/deploy/clients';
import { type CollectedRecord, collectApps, type DeployClients } from '../lib/deploy/collect';
import type { DashboardDeploy } from '../shared/dashboard';

/** Pure: a collected record → the dashboard's deploy cell. */
export function toDashboardDeploy(rec: CollectedRecord, env?: string): DashboardDeploy {
  const version = rec.quay?.version;
  const imageSha = rec.quay?.sha256 ?? undefined;
  const buildNumber = rec.jenkins?.number;
  const commit = rec.jenkins?.commit ?? undefined;
  const ts = rec.jenkins?.build.timestamp;
  return {
    available: Boolean(version || imageSha || typeof buildNumber === 'number'),
    version,
    imageSha,
    imageDigest: rec.quay?.tag.manifest_digest ?? undefined,
    commit,
    buildNumber,
    publishedAt: typeof ts === 'number' && ts > 0 ? new Date(ts).toISOString() : undefined,
    env: env || undefined,
    error: rec.errors[0],
  };
}

/**
 * Collect deploy info for every app. `configured` is false when no service client
 * could be built (missing creds / no app declares the service) — the caller then
 * shows a "configure creds" hint instead of empty rows. `injectedClients` lets
 * tests pass stub clients (the live path builds them from config + env).
 */
export async function collectDeploy(
  apps: AppConfig[],
  injectedClients?: DeployClients,
  env?: string,
): Promise<{ configured: boolean; byApp: Map<string, DashboardDeploy> }> {
  const clients =
    injectedClients ??
    (await buildDeployClients(apps, { jenkins: true, quay: true }).catch(() => ({}) as DeployClients));
  const configured = Boolean(clients.jenkins || clients.quay);
  const byApp = new Map<string, DashboardDeploy>();
  if (!configured) return { configured, byApp };
  // env selects the per-environment Jenkins job (collectApps → getLatestBuildForApp).
  for (const rec of await collectApps(apps, clients, { env })) {
    byApp.set(rec.app.name, toDashboardDeploy(rec, env));
  }
  return { configured, byApp };
}
