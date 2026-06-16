import { describe, expect, test } from 'bun:test';
import { buildJenkinsDeployAutomation, jenkinsBuildFormUrl, jenkinsParamValueSelector } from './jenkinsDeploy';

describe('jenkinsBuildFormUrl', () => {
  test('appends the build-with-parameters form path, trimming trailing slashes', () => {
    expect(jenkinsBuildFormUrl('https://jenkins/job/Deploys/job/my-app')).toBe(
      'https://jenkins/job/Deploys/job/my-app/build?delay=0sec',
    );
    expect(jenkinsBuildFormUrl('https://jenkins/job/my-app/')).toBe('https://jenkins/job/my-app/build?delay=0sec');
  });
});

describe('jenkinsParamValueSelector', () => {
  test('anchors the value input on its sibling name input', () => {
    expect(jenkinsParamValueSelector('VERSION')).toBe('input[name="name"][value="VERSION"] ~ input[name="value"]');
  });
  test('escapes quotes/backslashes in the param name', () => {
    expect(jenkinsParamValueSelector('a"b')).toBe('input[name="name"][value="a\\"b"] ~ input[name="value"]');
  });
});

describe('buildJenkinsDeployAutomation', () => {
  const automation = buildJenkinsDeployAutomation({
    jobUrl: 'https://jenkins/job/Deploys/job/my-app',
    params: [
      { name: 'VERSION', value: '${VERSION}' },
      { name: 'SHA', value: '${SHA}' },
      { name: 'PIPELINE_TYPE', value: 'deploy' },
    ],
    now: 1000,
  });

  test('starts at the build form and derives a name/id from the job', () => {
    expect(automation.startUrl).toBe('https://jenkins/job/Deploys/job/my-app/build?delay=0sec');
    expect(automation.name).toBe('Deploy my-app');
    expect(automation.id).toBe('deploy-my-app');
    expect(automation.createdAt).toBe(1000);
  });

  test('emits one fill step per param (css target + value passthrough) then a submit click', () => {
    const fills = automation.steps.filter((s) => s.action === 'fill');
    expect(fills).toHaveLength(3);
    expect(fills[0].target).toEqual({
      kind: 'css',
      value: 'input[name="name"][value="VERSION"] ~ input[name="value"]',
    });
    expect(fills[0].params?.value).toBe('${VERSION}'); // ${VAR} passthrough — composes with extract-text / matrix rows
    expect(fills[2].params?.value).toBe('deploy');

    const last = automation.steps.at(-1);
    expect(last?.action).toBe('click');
    expect(last?.target).toEqual({ kind: 'role', value: 'button', name: 'Build' });
  });

  test('honors overrides (name, submitLabel, selectorFor)', () => {
    const a = buildJenkinsDeployAutomation({
      jobUrl: 'https://jenkins/job/x',
      params: [{ name: 'P', value: 'v' }],
      name: 'Custom',
      submitLabel: 'Build Now',
      selectorFor: (p) => `xpath=//input[@data-param='${p}']`,
    });
    expect(a.name).toBe('Custom');
    expect(a.steps[0].target?.value).toBe("xpath=//input[@data-param='P']");
    expect(a.steps.at(-1)?.target?.name).toBe('Build Now');
  });
});
