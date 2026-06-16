#!/usr/bin/env bun
/**
 * svc — call a configured service API from the terminal.
 *
 * Reads the same registry as the web "Services" tab (src/lib/serviceCatalog), so
 * any catalogued service/operation works here too. Prints the result as JSON.
 *
 * Usage:
 *   svc                              # list services + their operations
 *   svc <service>                    # list one service's operations + params
 *   svc <service> <operation> [k=v]  # run an operation; params as key=value
 *
 * Examples:
 *   svc datadog searchLogs query="service:api status:error" from=now-1h
 *   svc github getRepo repo=owner/my-app
 *   svc rancher getClusters
 */

import { listServices, runServiceOperation, SERVICE_CATALOG } from '../lib/serviceCatalog';

/** Parse `key=value` argv tokens into a params object (values may contain `=`). */
function parseParams(tokens: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq === -1) {
      console.error(`Ignoring "${tok}" — params must be key=value.`);
      continue;
    }
    params[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return params;
}

async function listAll(): Promise<void> {
  const services = await listServices();
  console.log('Services (✓ = configured):\n');
  for (const s of services) {
    console.log(`  ${s.configured ? '✓' : '·'} ${s.name}`);
    for (const op of s.operations) {
      const ps = op.params.map((p) => (p.required ? `${p.name}*` : p.name)).join(' ');
      console.log(`      ${op.key}${ps ? `  (${ps})` : ''}`);
    }
    if (!s.configured) console.log(`      ↳ set ${s.envHint}`);
  }
  console.log('\nRun:  svc <service> <operation> key=value …');
}

function listService(name: string): void {
  const svc = SERVICE_CATALOG.find((s) => s.name === name);
  if (!svc) {
    console.error(`Unknown service: ${name}. Try \`svc\` to list them.`);
    process.exit(1);
  }
  console.log(`${svc.label} operations:\n`);
  for (const op of svc.operations) {
    console.log(`  ${op.key}`);
    for (const p of op.params) {
      console.log(
        `      ${p.name}${p.required ? ' (required)' : ''}${p.placeholder ? ` — e.g. ${p.placeholder}` : ''}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const [service, operation, ...rest] = process.argv.slice(2);

  if (!service) return listAll();
  if (!operation) return listService(service);

  try {
    const result = await runServiceOperation(service, operation, parseParams(rest));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
