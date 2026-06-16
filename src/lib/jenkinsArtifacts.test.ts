import { describe, expect, test } from 'bun:test';
import type { JenkinsArtifact, JenkinsBuild } from '../api/jenkins/types';
import { fetchJenkinsArtifacts, type JenkinsArtifactSource, parseBuildSelector } from './jenkinsArtifacts';

const build = (number: number): JenkinsBuild => ({ number }) as JenkinsBuild;
const artifact = (fileName: string, relativePath = fileName): JenkinsArtifact => ({ fileName, relativePath });
const streamOf = (text: string): ReadableStream<Uint8Array> => new Response(text).body as ReadableStream<Uint8Array>;

/** A fake Jenkins source returning canned builds/artifacts; records downloads. */
function fakeSource(artifacts: JenkinsArtifact[], bodies: Record<string, string> = {}): JenkinsArtifactSource {
  return {
    getBuild: async (_job, selector) => build(typeof selector === 'number' ? selector : 42),
    getArtifacts: async () => artifacts,
    downloadArtifact: async (_job, _num, rel) => (rel in bodies ? streamOf(bodies[rel]) : streamOf(`bytes:${rel}`)),
  };
}

describe('parseBuildSelector', () => {
  test('numeric strings → numbers; selectors pass through; default lastSuccessfulBuild', () => {
    expect(parseBuildSelector('57')).toBe(57);
    expect(parseBuildSelector(57)).toBe(57);
    expect(parseBuildSelector('lastBuild')).toBe('lastBuild');
    expect(parseBuildSelector(undefined)).toBe('lastSuccessfulBuild');
    expect(parseBuildSelector('')).toBe('lastSuccessfulBuild');
  });
});

describe('fetchJenkinsArtifacts', () => {
  test('downloads only artifacts matching the pattern (default = PDFs) and writes them', async () => {
    const src = fakeSource([
      artifact('scan-sast.pdf', 'reports/scan-sast.pdf'),
      artifact('scan-sca.pdf', 'reports/scan-sca.pdf'),
      artifact('build.log'),
      artifact('summary.txt'),
    ]);
    const writes: Record<string, string> = {};
    const result = await fetchJenkinsArtifacts(src, {
      jobPath: 'job/app',
      build: 'lastSuccessfulBuild',
      write: async (name, bytes) => {
        writes[name] = new TextDecoder().decode(bytes);
      },
    });
    expect(result.buildNumber).toBe(42);
    expect(result.written.sort()).toEqual(['scan-sast.pdf', 'scan-sca.pdf']);
    expect(Object.keys(writes).sort()).toEqual(['scan-sast.pdf', 'scan-sca.pdf']);
    expect(writes['scan-sast.pdf']).toBe('bytes:reports/scan-sast.pdf');
  });

  test('a custom match pattern selects other artifacts', async () => {
    const src = fakeSource([artifact('report.xlsx'), artifact('report.pdf')]);
    const result = await fetchJenkinsArtifacts(src, {
      jobPath: 'job/app',
      match: '\\.xlsx$',
      write: async () => {},
    });
    expect(result.written).toEqual(['report.xlsx']);
  });

  test('flattens nested paths to base names and de-dupes collisions', async () => {
    const src = fakeSource([artifact('report.pdf', 'sast/report.pdf'), artifact('report.pdf', 'dast/report.pdf')]);
    const names: string[] = [];
    const result = await fetchJenkinsArtifacts(src, {
      jobPath: 'job/app',
      write: async (name) => {
        names.push(name);
      },
    });
    expect(result.written).toEqual(['report.pdf', 'report-2.pdf']);
    expect(names).toEqual(['report.pdf', 'report-2.pdf']);
  });

  test('a matched artifact with no downloadable stream is skipped', async () => {
    const src: JenkinsArtifactSource = {
      getBuild: async () => build(7),
      getArtifacts: async () => [artifact('a.pdf'), artifact('b.pdf')],
      downloadArtifact: async (_j, _n, rel) => (rel === 'a.pdf' ? streamOf('ok') : null),
    };
    const result = await fetchJenkinsArtifacts(src, { jobPath: 'j', write: async () => {} });
    expect(result.written).toEqual(['a.pdf']);
  });
});
