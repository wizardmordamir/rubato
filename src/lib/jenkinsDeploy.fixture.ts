/**
 * A faithful mock of a Jenkins "Build with Parameters" page, used by both the
 * unit test (jenkinsDeploy.test.ts) and the Chrome e2e spec
 * (e2e/jenkins-deploy.spec.ts) to validate that the generator's per-parameter
 * selectors resolve to the right value input.
 *
 * Mirrors classic Stapler markup: each parameter is a table row whose
 * `td.setting-main` holds a hidden `<input name="name" value="PARAM">` paired with
 * the value `<input name="value">`, plus a single submit button labelled "Build".
 */
export function mockJenkinsBuildPage(paramNames: string[]): string {
  const rows = paramNames
    .map(
      (p) => `
      <tr>
        <td class="setting-leftspace"></td>
        <td class="setting-name">${p}</td>
        <td class="setting-main">
          <input type="hidden" name="name" value="${p}" />
          <input class="setting-input" name="value" type="text" value="" />
        </td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>my-app — Build with Parameters</title></head>
  <body>
    <form name="parameters" action="build?delay=0sec" method="post">
      <table class="parameters">${rows}
      </table>
      <button type="submit" name="Submit">Build</button>
    </form>
  </body>
</html>`;
}
