import { expect, test } from 'bun:test';
import type { Automation, Step } from '../shared/automation';
import { collectAutomationVars } from './automationVars';

function automation(steps: Step[], startUrl?: string): Automation {
  return { id: 'a', name: 'A', startUrl, steps, createdAt: 0, updatedAt: 0 };
}

test('collects ${VAR} from value, url and path', () => {
  const a = automation([
    { id: '1', action: 'fill', params: { value: '${TOKEN}' } },
    { id: '2', action: 'goto', params: { url: 'https://x/${HOST}' } },
    { id: '3', action: 'saveFile', params: { path: '${OUT}/report.csv' } },
  ]);
  expect(collectAutomationVars(a).map((v) => v.name)).toEqual(['HOST', 'OUT', 'TOKEN']);
});

test('collects valueMode:env names as env-mode', () => {
  const a = automation([{ id: '1', action: 'fill', params: { value: 'API_TOKEN', valueMode: 'env' } }]);
  expect(collectAutomationVars(a)).toEqual([{ name: 'API_TOKEN', sources: ['env-mode'] }]);
});

test('excludes scraped.* and run.dir channels', () => {
  const a = automation([
    { id: '1', action: 'fill', params: { value: '${scraped.user} in ${run.dir}' } },
    { id: '2', action: 'fill', params: { value: '${REAL}' } },
  ]);
  expect(collectAutomationVars(a).map((v) => v.name)).toEqual(['REAL']);
});

test('walks nested then/else branches and dedupes with merged sources', () => {
  const a = automation([
    {
      id: 'if',
      action: 'if',
      condition: { kind: 'url-matches', value: 'x' },
      thenSteps: [{ id: 't', action: 'fill', params: { value: '${SHARED}' } }],
      elseSteps: [{ id: 'e', action: 'fill', params: { value: 'SHARED', valueMode: 'env' } }],
    },
  ]);
  expect(collectAutomationVars(a)).toEqual([{ name: 'SHARED', sources: ['env-mode', 'interpolation'] }]);
});

test('includes startUrl placeholders and sorts results', () => {
  const a = automation([{ id: '1', action: 'fill', params: { value: '${ZED}' } }], 'https://${BASE}/login');
  expect(collectAutomationVars(a).map((v) => v.name)).toEqual(['BASE', 'ZED']);
});

test('empty automation yields no variables', () => {
  expect(collectAutomationVars(automation([]))).toEqual([]);
});
