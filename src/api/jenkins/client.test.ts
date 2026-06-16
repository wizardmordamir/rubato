import { describe, expect, test } from 'bun:test';
import { createJenkinsClient } from './client';
import type { JenkinsAppApi } from './types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A routing fake Jenkins: responds by URL shape and records calls. */
function fakeJenkins(routes: { builds?: unknown[]; configXml?: string } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const u = new URL(url);
    calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: (init.headers as Record<string, string>) ?? {},
    });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (u.pathname.endsWith('/crumbIssuer/api/json')) return json({ crumbRequestField: 'Jenkins-Crumb', crumb: 'xyz' });
    if (u.pathname.endsWith('/config.xml'))
      return new Response(routes.configXml ?? '<x/>', { headers: { 'content-type': 'application/xml' } });
    if (u.pathname.includes('/buildWithParameters') || u.pathname.endsWith('/build'))
      return new Response(null, { status: 201, headers: { Location: 'https://jenkins.test/queue/item/42/' } });
    if (u.pathname.includes('/artifact/')) return new Response('BINARY', { status: 200 });
    if (u.pathname.endsWith('/api/json')) {
      const tree = u.searchParams.get('tree') ?? '';
      if (tree.includes('builds[')) return json({ builds: routes.builds ?? [] });
      if (tree.includes('artifacts['))
        return json({ artifacts: [{ fileName: 'scan.json', relativePath: 'out/scan.json' }] });
      return json({ name: 'svc', url: 'https://jenkins.test/job/svc', lastBuild: { number: 7, url: '' } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;

  const client = createJenkinsClient({ baseUrl: 'https://jenkins.test', username: 'u', token: 't', fetch: fakeFetch });
  return { client, calls };
}

describe('read endpoints', () => {
  test('getJob requests the job api with a tree', async () => {
    const { client, calls } = fakeJenkins();
    const job = await client.getJob('job/svc');
    expect(job.name).toBe('svc');
    expect(calls[0].url).toContain('/job/svc/api/json');
    expect(calls[0].headers.Authorization).toBe(`Basic ${btoa('u:t')}`);
  });

  test('getBuilds returns the builds array and encodes the limit', async () => {
    const { client, calls } = fakeJenkins({
      builds: [{ number: 9, result: 'SUCCESS', building: false, timestamp: 1, url: '' }],
    });
    const builds = await client.getBuilds('job/svc', { limit: 5 });
    expect(builds).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toContain('{0,5}');
  });

  test('getLatestBuild applies a filter and returns newest-first', async () => {
    const { client } = fakeJenkins({
      builds: [
        { number: 3, result: 'FAILURE', building: false, timestamp: 3, url: '' },
        { number: 2, result: 'SUCCESS', building: false, timestamp: 2, url: '' },
      ],
    });
    const latest = await client.getLatestBuild('job/svc', { status: 'success' });
    expect(latest?.number).toBe(2);
  });

  test('getJobBranch parses config.xml', async () => {
    const { client } = fakeJenkins({
      configXml: '<hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec>',
    });
    expect(await client.getJobBranch('job/svc')).toBe('main');
  });

  test('getArtifacts reads the artifacts tree', async () => {
    const { client } = fakeJenkins();
    const artifacts = await client.getArtifacts('job/svc', 7);
    expect(artifacts[0].relativePath).toBe('out/scan.json');
  });
});

describe('triggering', () => {
  test('triggerBuild with no params hits /build, fetches a crumb, returns the queue url', async () => {
    const { client, calls } = fakeJenkins();
    const res = await client.triggerBuild('job/svc');
    expect(res.status).toBe(201);
    expect(res.queueUrl).toBe('https://jenkins.test/queue/item/42/');
    expect(calls.some((c) => c.url.endsWith('/crumbIssuer/api/json'))).toBe(true);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/job/svc/build');
    expect(post?.headers['Jenkins-Crumb']).toBe('xyz');
  });

  test('triggerBuild with params hits /buildWithParameters and passes them as query', async () => {
    const { client, calls } = fakeJenkins();
    await client.triggerBuild('job/svc', { ENV: 'stage', DRY: true });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/buildWithParameters');
    expect(post?.url).toContain('ENV=stage');
    expect(post?.url).toContain('DRY=true');
  });

  test('triggerDeployment resolves the job path from app config', async () => {
    const { client, calls } = fakeJenkins();
    const app: JenkinsAppApi = {
      name: 'jenkins',
      project: 'Deploys/svc',
      multibranch: true,
      envs: [{ envName: 'stage', branch: 'main' }],
    };
    await client.triggerDeployment(app, { env: 'stage' });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('/job/Deploys/job/svc/job/main/build');
  });
});
