import { expect, test } from "@playwright/test";
import { mockJenkinsBuildPage } from "../src/lib/jenkinsDeploy.fixture";
import { buildJenkinsDeployAutomation, jenkinsParamValueSelector } from "../src/lib/jenkinsDeploy";

/**
 * Validates the Jenkins deploy-automation generator's selectors against a faithful
 * mock "Build with Parameters" page in REAL Google Chrome (channel: "chrome", per
 * playwright.config.ts) — no rubato server needed (we `setContent` the mock). This
 * is the headless proof that each param's `jenkinsParamValueSelector` resolves to
 * exactly its own value input; only the live per-Jenkins selector verification
 * (real instance markup) is left.
 */

const PARAMS = ["VERSION", "SHA", "TASK", "PIPELINE_TYPE"];

test("each param selector resolves to exactly its own value input, and fills it", async ({ page }) => {
  await page.setContent(mockJenkinsBuildPage(PARAMS));

  // Every param's selector matches exactly one element.
  for (const p of PARAMS) {
    await expect(page.locator(jenkinsParamValueSelector(p))).toHaveCount(1);
  }

  // Filling each by its selector lands the value in the right input — no cross-talk.
  for (const p of PARAMS) {
    await page.locator(jenkinsParamValueSelector(p)).fill(`val-${p}`);
  }
  for (const p of PARAMS) {
    await expect(page.locator(jenkinsParamValueSelector(p))).toHaveValue(`val-${p}`);
  }

  // The generator's submit target (role button "Build") resolves too.
  await expect(page.getByRole("button", { name: "Build" })).toHaveCount(1);
});

test("running the generated automation's fill targets drives the form", async ({ page }) => {
  await page.setContent(mockJenkinsBuildPage(PARAMS));
  const automation = buildJenkinsDeployAutomation({
    jobUrl: "https://jenkins/job/Deploys/job/my-app",
    params: PARAMS.map((name) => ({ name, value: `resolved-${name}` })),
  });

  // Drive exactly what the interpreter would: each css fill target, then the submit click.
  for (const step of automation.steps) {
    if (step.action === "fill" && step.target?.kind === "css") {
      await page.locator(step.target.value).fill(step.params?.value ?? "");
    }
  }
  for (const p of PARAMS) {
    await expect(page.locator(jenkinsParamValueSelector(p))).toHaveValue(`resolved-${p}`);
  }
  const submit = automation.steps.at(-1);
  expect(submit?.action).toBe("click");
  await expect(page.getByRole("button", { name: submit?.target?.name ?? "" })).toBeVisible();
});
