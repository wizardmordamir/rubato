/**
 * A fake upstream HTTP server for integration tests. It impersonates the
 * inaccessible external APIs (Splunk, Jenkins, Quay, GitLab, GitHub, Datadog,
 * Dynatrace, Rancher, Harness, and an OpenAI-style LLM) so the REAL rubato
 * clients can talk to it over real HTTP — nothing in the app is stubbed, only the
 * network upstream is replaced.
 *
 * Each service is reached under a `/<service>/…` prefix (the seeded config points
 * `config.<svc>.baseUrl` at `http://localhost:<port>/<service>`); the real client
 * then appends its real sub-path. The server returns minimal-but-valid payloads
 * matching each client's parser. Defaults cover the happy path; a test can install
 * its own `handler` to override a response (e.g. force a 404 or a specific digest)
 * and inspect `requests` to assert what the app actually sent.
 */

import { clearApiResponseCaches } from '../api/responseCaches';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** A recorded inbound request, for assertions. */
export interface RecordedRequest {
  service: string;
  method: string;
  /** Path after the `/<service>` prefix, e.g. "api/v1/repository/team/app/tag/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Raw request body text (empty for GET). */
  body: string;
  /** Parsed body when JSON or form-encoded, else undefined. */
  parsed?: unknown;
}

/** Context passed to an override handler. */
export interface FakeContext extends RecordedRequest {
  json: (data: unknown, status?: number) => Response;
  text: (body: string, status?: number, contentType?: string) => Response;
}

export interface FakeUpstream {
  url: string;
  port: number;
  /** Every request received, in order. Cleared by `reset()`. */
  requests: RecordedRequest[];
  /**
   * Optional override. Return a Response to short-circuit a default, or undefined
   * to fall through to the built-in default for that service/path.
   */
  handler: ((ctx: FakeContext) => Response | undefined) | null;
  reset(): void;
  stop(): Promise<void>;
}

const text = (body: string, status = 200, contentType = 'text/plain'): Response =>
  new Response(body, { status, headers: { 'content-type': contentType } });

/** Default per-service responses keyed loosely by the sub-path. */
function defaultResponse(ctx: RecordedRequest): Response {
  const { service, path } = ctx;
  switch (service) {
    case 'splunk':
      // POST services/search/jobs/export → ndjson rows.
      return text(
        `${JSON.stringify({ result: { _time: '2026-01-01T00:00:00Z', status: '200', host: 'web-01' }, preview: false })}\n` +
          `${JSON.stringify({ result: { _time: '2026-01-01T00:01:00Z', status: '500', host: 'web-02' }, preview: false })}\n`,
      );

    case 'quay':
      if (path.includes('/manifest/') && path.endsWith('/security')) {
        return json({
          status: 'scanned',
          data: { Layer: { Features: [{ Name: 'openssl', Version: '1.1', Vulnerabilities: [] }] } },
        });
      }
      // api/v1/repository/<repo>/tag/ — echo the requested tag name so the
      // version→tag resolver (matches name === version) finds it.
      return json({
        tags: [{ name: ctx.query.specificTag ?? '1.2.3', manifest_digest: 'sha256:deadbeef', start_ts: 1735689600 }],
      });

    case 'jenkins':
      if (path.includes('/build')) return new Response(null, { status: 201, headers: { Location: '/queue/item/9/' } });
      // .../api/json — return a job or a build list depending on tree/path.
      if (path.includes('lastBuild') || /\/\d+\/api\/json$/.test(path)) {
        return json({
          number: 42,
          result: 'SUCCESS',
          building: false,
          timestamp: 1735689600000,
          displayName: '#42',
          fullDisplayName: 'Deploys » svc » #42',
          actions: [{ lastBuiltRevision: { SHA1: 'abc123' } }],
          changeSets: [],
          artifacts: [],
        });
      }
      return json({
        name: 'svc',
        fullName: 'Deploys/svc',
        url: 'http://jenkins/job/Deploys/job/svc/',
        lastBuild: { number: 42, url: 'http://jenkins/job/Deploys/job/svc/42/' },
        lastSuccessfulBuild: { number: 42, url: 'http://jenkins/job/Deploys/job/svc/42/' },
        lastFailedBuild: null,
        builds: [
          {
            number: 42,
            url: 'http://jenkins/job/Deploys/job/svc/42/',
            result: 'SUCCESS',
            building: false,
            timestamp: 1735689600000,
            displayName: '1.2.3.41',
            fullDisplayName: 'Deploys » svc » 1.2.3.41',
            actions: [{ parameters: [{ name: 'VERSION', value: '1.2.3' }], lastBuiltRevision: { SHA1: 'abc123' } }],
            changeSets: [{ items: [{ commitId: 'abc123', msg: 'fix: bug', author: { fullName: 'Alice' } }] }],
            artifacts: [],
          },
        ],
      });

    case 'gitlab':
      if (/\/repository\/commits\/[^/]+$/.test(path)) {
        return json({
          id: 'abc123',
          short_id: 'abc123',
          title: 'fix: bug',
          message: 'fix: bug',
          author_name: 'Alice',
          created_at: '2026-01-01T00:00:00Z',
        });
      }
      if (path.endsWith('/repository/commits')) {
        return json([
          {
            id: 'abc123',
            short_id: 'abc123',
            title: 'fix: bug',
            message: 'fix: bug',
            author_name: 'Alice',
            created_at: '2026-01-01T00:00:00Z',
          },
        ]);
      }
      if (path.endsWith('/repository/branches')) {
        return json([
          { name: 'main', default: true, protected: true, merged: false, commit: { id: 'abc123', short_id: 'abc123' } },
        ]);
      }
      // api/v4/projects/<encoded>
      return json({
        id: 1,
        name: 'app',
        path_with_namespace: 'team/app',
        web_url: 'https://gitlab/team/app',
        default_branch: 'main',
      });

    case 'github':
      if (path.endsWith('/actions/runs')) {
        return json({
          workflow_runs: [
            {
              id: 9,
              name: 'CI',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github/owner/app/actions/runs/9',
            },
          ],
        });
      }
      if (path.endsWith('/commits')) {
        return json([
          {
            sha: 'abc123',
            html_url: 'https://github/owner/app/commit/abc123',
            commit: { message: 'fix: bug', author: { name: 'Alice', email: 'a@x.io', date: '2026-01-01T00:00:00Z' } },
          },
        ]);
      }
      if (path.endsWith('/pulls')) {
        return json([
          { id: 1, number: 1, title: 'Add feature', state: 'open', html_url: 'https://github/owner/app/pull/1' },
        ]);
      }
      // repos/<owner>/<repo>
      return json({
        id: 123,
        name: 'app',
        full_name: 'owner/app',
        html_url: 'https://github/owner/app',
        default_branch: 'main',
      });

    case 'datadog':
      if (path.endsWith('/validate')) return json({ valid: true });
      if (path.endsWith('/logs/events/search')) {
        return json({
          data: [{ id: 'log-1', type: 'log', attributes: { message: 'error occurred', status: 'error' } }],
        });
      }
      // api/v1/query
      return json({ series: [{ metric: 'system.cpu.user', pointlist: [[1735689600, 50.5]], scope: 'host:web-1' }] });

    case 'dynatrace':
      if (path.endsWith('/problems')) {
        return json({
          problems: [
            {
              problemId: 'p-1',
              displayId: 'P-1',
              title: 'High CPU',
              status: 'OPEN',
              severityLevel: 'RESOURCE_CONTENTION',
            },
          ],
        });
      }
      if (path.endsWith('/metrics/query')) {
        return json({
          result: [{ metricId: 'builtin:host.cpu.usage', data: [{ timestamps: [1735689600], values: [50.5] }] }],
        });
      }
      // api/v2/entities
      return json({ entities: [{ entityId: 'HOST-1', displayName: 'web-01', type: 'HOST' }] });

    case 'rancher':
      if (path.includes('/workloads'))
        return json({ data: [{ id: 'deployment:default:web', name: 'web', state: 'active' }] });
      if (path.endsWith('/nodes')) return json({ data: [{ id: 'm-1', name: 'node-1', state: 'active' }] });
      if (path.endsWith('/projects')) return json({ data: [{ id: 'c-1:p-1', name: 'Default', state: 'active' }] });
      // v3/clusters
      return json({ data: [{ id: 'c-1', name: 'production', state: 'active' }] });

    case 'harness':
      if (path.endsWith('/servicesV2'))
        return json({ data: { content: [{ identifier: 'svc-1', name: 'Web Service' }] } });
      if (path.endsWith('/execution/summary'))
        return json({ data: { content: [{ identifier: 'exec-1', name: 'run #1' }] } });
      // pipeline/api/pipelines/list
      return json({ data: { content: [{ identifier: 'pipe-1', name: 'Deploy Pipeline' }] } });

    case 'llm': {
      // chat/completions → OpenAI-style SSE stream.
      const sse =
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
        'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    case 'embeddings':
      // OpenAI-style /embeddings → a fixed small vector per input.
      return json({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: 'fake' });

    default:
      return json({ error: `fake upstream: unknown service "${service}"` }, 404);
  }
}

/** Start the fake upstream on an ephemeral port. Remember to `stop()` in afterAll. */
export function startFakeUpstream(): FakeUpstream {
  const state: Pick<FakeUpstream, 'requests' | 'handler'> = { requests: [], handler: null };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const segments = url.pathname.replace(/^\/+/, '').split('/');
      const service = segments[0] ?? '';
      const path = segments.slice(1).join('/');
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      let parsed: unknown;
      const ct = headers['content-type'] ?? '';
      if (body) {
        try {
          if (ct.includes('json')) parsed = JSON.parse(body);
          else if (ct.includes('x-www-form-urlencoded')) parsed = Object.fromEntries(new URLSearchParams(body));
        } catch {
          // leave parsed undefined
        }
      }

      const record: RecordedRequest = { service, method: req.method, path, query, headers, body, parsed };
      state.requests.push(record);

      if (state.handler) {
        const override = state.handler({ ...record, json, text });
        if (override) return override;
      }
      return defaultResponse(record);
    },
  });

  const port = server.port ?? 0; // always a real port after serve(); satisfies the typing
  return {
    url: `http://localhost:${port}`,
    port,
    get requests() {
      return state.requests;
    },
    get handler() {
      return state.handler;
    },
    set handler(h) {
      state.handler = h;
    },
    reset() {
      state.requests.length = 0;
      state.handler = null;
      // Resetting the scenario must invalidate any client response cache of the
      // previous upstream state, or a cached read would mask the new handler.
      clearApiResponseCaches();
    },
    async stop() {
      await server.stop(true);
    },
  };
}
