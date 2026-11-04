import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { PASSWORD } from "./mock-api";

export async function signIn(page: Page, email = "assessor@acme.test") {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Assessments", level: 1 })).toBeVisible();
}

/** Fails on any serious or critical axe violation (WCAG 2.1 A and AA rules). */
export async function expectNoSeriousA11yViolations(page: Page) {
  // @axe-core/playwright is typed against a newer playwright-core; the runtime API is the same.
  const results = await new AxeBuilder({ page } as unknown as ConstructorParameters<typeof AxeBuilder>[0]).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual([]);
}

/** Screenshots are kept for the Pixel 7 project only. */
export async function screenshotOnPixel(page: Page, testInfo: TestInfo, name: string) {
  if (testInfo.project.name !== "pixel-7") return;
  await page.screenshot({ path: path.resolve(testInfo.project.testDir, "..", "screenshots", name), fullPage: true });
}
