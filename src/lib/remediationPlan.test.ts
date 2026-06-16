import { describe, expect, test } from 'bun:test';
import type { LlmMessage } from '../api/llm/types';
import { buildPlanPrompt, defaultPlanTitle, generatePlan, MAX_FILE_CHARS, stripOuterFence } from './remediationPlan';

describe('buildPlanPrompt', () => {
  test('includes data JSON, app, instructions, and attached files', () => {
    const msgs = buildPlanPrompt({
      title: 'Q2 plan',
      app: 'billing-svc',
      instructions: 'focus on SCA',
      data: { critical: 3, high: 5 },
      files: [{ name: 'scan.txt', text: 'CVE-2024-0001 in lodash' }],
    });
    expect(msgs[0].role).toBe('system');
    const user = msgs[1].content;
    expect(user).toContain('billing-svc');
    expect(user).toContain('focus on SCA');
    expect(user).toContain('"critical": 3');
    expect(user).toContain('Attached report: scan.txt');
    expect(user).toContain('CVE-2024-0001 in lodash');
  });

  test('truncates an oversized attached file', () => {
    const big = 'x'.repeat(MAX_FILE_CHARS + 5000);
    const user = buildPlanPrompt({ files: [{ name: 'huge.txt', text: big }] })[1].content;
    expect(user).toContain('…(truncated)');
    expect(user.length).toBeLessThan(big.length);
  });

  test('falls back to a generic prompt when given nothing', () => {
    const user = buildPlanPrompt({})[1].content;
    expect(user).toContain('no data provided');
  });
});

describe('stripOuterFence', () => {
  test('removes a ```markdown fence wrapping the whole doc', () => {
    expect(stripOuterFence('```markdown\n# Plan\n- do x\n```')).toBe('# Plan\n- do x');
    expect(stripOuterFence('```\n# Plan\n```')).toBe('# Plan');
  });
  test('leaves inner code fences alone', () => {
    const md = '# Plan\n\n```bash\nnpm audit fix\n```';
    expect(stripOuterFence(md)).toBe(md);
  });
});

describe('defaultPlanTitle', () => {
  test('prefers title, then app, then a generic', () => {
    expect(defaultPlanTitle({ title: 'T' })).toBe('T');
    expect(defaultPlanTitle({ app: 'svc' })).toBe('Remediation plan — svc');
    expect(defaultPlanTitle({})).toBe('Remediation plan');
  });
});

describe('generatePlan', () => {
  test("returns the model's markdown (fence-stripped)", async () => {
    const ai = async (_m: LlmMessage[]) => '```markdown\n# Remediate\n1. patch\n```';
    expect(await generatePlan(ai, { app: 'x' })).toBe('# Remediate\n1. patch');
  });
  test('throws on an empty plan', async () => {
    const ai = async () => '   ';
    await expect(generatePlan(ai, {})).rejects.toThrow(/empty/i);
  });
});
