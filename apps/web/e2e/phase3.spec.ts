import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./mock-api";
import { createFieldMock, SEEDED_ASSESSMENT } from "./mock-field";
import { createPhase3Mock, SECOND_ASSESSMENT, type Phase3Options } from "./mock-phase3";
import { expectNoSeriousA11yViolations, screenshotOnPixel, setPinFromPrompt, signIn } from "./helpers";

async function setup(page: Page, opts: Phase3Options = {}) {
  const field = createFieldMock();
  const p3 = createPhase3Mock(opts);
  const api = await mockApi(page, {
    seedAssessments: [SEEDED_ASSESSMENT, SECOND_ASSESSMENT],
    extra: async (...args) => (await p3.handle(...args)) || field.handle(...args),
  });
  await signIn(page);
  const network = async (on: boolean) => {
    api.offline = !on;
    await page.context().setOffline(!on);
  };
  return { p3, field, network };
}

const card = (page: Page, name: string) => page.getByRole("article", { name });
const openAssessment = (page: Page) => page.getByRole("link", { name: /Warehouse night survey/ }).click();

async function score(page: Page, scenario: string, likelihood: RegExp, impact: RegExp) {
  const c = card(page, scenario);
  await c.getByRole("group", { name: /^Likelihood/ }).getByRole("button", { name: likelihood }).click();
  await c.getByRole("group", { name: /^Impact/ }).getByRole("button", { name: impact }).click();
}

test.describe("Phase 3 risk", () => {
  test("risk inputs to explained results", async ({ page }, testInfo) => {
    const { p3 } = await setup(page);
    await openAssessment(page);
    await page.getByRole("link", { name: "Risk inputs" }).click();
    await expect(page.getByRole("heading", { name: "Risk inputs", level: 1 })).toBeVisible();

    await score(page, "Forced entry after hours", /4\s*Likely/, /5\s*Severe/);
    const forced = card(page, "Forced entry after hours");
    await expect(forced.getByText("Inherent risk: 4 × 5 = 20 of 25")).toBeVisible();
    await expect(forced.getByTestId("sc-forced-entry-lik-anchor")).toHaveText(/^Likely: Expected within the next year/);
    await card(page, "Tailgating into staff areas").getByRole("button", { name: "Not applicable" }).click();
    await score(page, "Ransomware on site systems", /3\s*Possible/, /4\s*Major/);
    await card(page, "Ransomware on site systems").getByLabel("Rationale (optional)").fill("Cameras run on the office network.");
    await expect(page.getByTestId("risk-save-status")).toHaveText("All risk inputs saved to server.", { timeout: 10_000 });
    await expect.poll(() => p3.state.inputs.find((i) => i.scenarioId === "ransomware")?.rationale).toBe("Cameras run on the office network.");
    expect(p3.state.inputs.find((i) => i.scenarioId === "forced-entry")).toMatchObject({ likelihood: 4, impact: 5, excluded: false });
    expect(p3.state.inputs.find((i) => i.scenarioId === "tailgating")).toMatchObject({ excluded: true });

    await page.getByRole("link", { name: "See results" }).click();
    await expect(page.getByRole("heading", { name: "Risk results", level: 1 })).toBeVisible();
    const cards = page.getByRole("article");
    await expect(cards.first()).toHaveAccessibleName("Forced entry after hours");
    const f = card(page, "Forced entry after hours");
    await expect(f.getByTestId("before-after")).toContainText("Very high20");
    await expect(f.getByTestId("before-after")).toContainText("Medium12");
    await expect(f.getByTestId("explanation")).toContainText("Inherent risk is 20 of 25 (very high): likelihood 4 times impact 5.");
    await expect(f.getByText("Medium confidence")).toBeVisible();
    await f.getByText(/How was this calculated\?/).click();
    await expect(f.getByRole("link", { name: "SC-PER-001: Perimeter fence is intact" })).toHaveAttribute("href", "/library/SC-PER-001");
    await expect(f.getByRole("link", { name: /^Finding:/ })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "risk-results.png");
  });

  test("results show Not scored yet before any inputs", async ({ page }) => {
    await setup(page);
    await openAssessment(page);
    await page.getByRole("link", { name: "Risk results" }).click();
    await expect(page.getByText("Not scored yet")).toBeVisible();
    await expect(page.getByText("3 scenarios have no likelihood and impact yet")).toBeVisible();
  });

  test("admin dashboard", async ({ page }, testInfo) => {
    await setup(page);
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await expect(page.getByTestId("count-in_progress")).toHaveText("3");
    await expect(page.getByTestId("count-critical")).toHaveText("1");
    await expect(page.getByTestId("open-high")).toHaveText("6 open high or critical findings");
    const top = page.getByRole("link", { name: /Forced entry after hours/ });
    await expect(top).toContainText("High16");
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "dashboard.png");
    await top.click();
    await expect(page.getByRole("heading", { name: "Risk results", level: 1 })).toBeVisible();
  });

  test("site comparison with caveats", async ({ page }, testInfo) => {
    const { p3 } = await setup(page);
    Object.assign(p3.state.inputs[0]!, { likelihood: 4, impact: 5 });
    Object.assign(p3.state.inputs[2]!, { likelihood: 2, impact: 3 });
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Compare" }).click();
    await page.getByRole("checkbox", { name: /Warehouse night survey/ }).check();
    await page.getByRole("button", { name: "Compare 1 assessment" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Choose 2 to 20 assessments." })).toBeVisible();
    await page.getByRole("checkbox", { name: /Head office review/ }).check();
    await page.getByRole("button", { name: "Compare 2 assessments" }).click();
    await expect(page.getByTestId("caveats")).toContainText("The sites use different frameworks");
    const row = page.getByRole("row", { name: /Ransomware on site systems/ });
    await expect(row).toContainText("Very low 3.6");
    await expect(row).toContainText("High 16");
    await expect(page.getByRole("row", { name: /Tailgating/ })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /critical/i })).toContainText("1");
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "comparison.png");
  });
});

test.describe("Phase 3 report", () => {
  test("narrative: an unapproved AI draft stays out of the preview until approved", async ({ page }) => {
    const { p3 } = await setup(page);
    await openAssessment(page);
    await page.getByRole("link", { name: "Report and export" }).click();
    const exec = page.getByTestId("narrative-executive_summary");
    await exec.getByRole("button", { name: "Draft with AI" }).click();
    await expect(exec.getByText("AI draft: not in the report until you edit or approve it")).toBeVisible();
    await expect(exec.getByLabel("Executive summary text")).toHaveValue(/AI DRAFT/);
    const preview = page.frameLocator('[data-testid="report-preview"]');
    await expect(page.getByTestId("report-preview")).toHaveAttribute("sandbox", "");
    await expect(preview.getByRole("heading", { name: "Risk summary" })).toBeVisible();
    await expect(preview.getByText(/AI DRAFT/)).toHaveCount(0);

    await exec.getByLabel("Executive summary text").fill("Reviewed: the perimeter has two gaps and the dock light is out.");
    await exec.getByRole("button", { name: "Approve" }).click();
    await expect(exec.getByText("Approved: in the report")).toBeVisible();
    await expect(preview.getByText("Reviewed: the perimeter has two gaps")).toBeVisible();
    expect([...p3.state.narratives.values()][0]).toMatchObject({ status: "approved" });
  });

  test("export job: start, poll, and show links", async ({ page }) => {
    const { p3 } = await setup(page);
    await openAssessment(page);
    await page.getByRole("link", { name: "Report and export" }).click();
    await page.getByRole("checkbox", { name: /Google Drive/ }).uncheck();
    await page.getByRole("button", { name: "Start export" }).click();
    await expect(page.getByText("Export finished")).toBeVisible({ timeout: 10_000 });
    expect(p3.state.exports[0]!.body).toEqual({ targets: ["docs", "sheets"] });
    expect(p3.state.polls).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("link", { name: /Open Google Doc/ })).toHaveAttribute("href", "https://docs.google.com/document/d/mock-doc");
    await expect(page.getByRole("link", { name: /Open Google Sheet/ })).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("Google not configured: clear message in export and settings", async ({ page }) => {
    await setup(page, { googleConfigured: false });
    await openAssessment(page);
    await page.getByRole("link", { name: "Report and export" }).click();
    await page.getByRole("button", { name: "Start export" }).click();
    await expect(page.getByText("Google export is not set up on this server.")).toBeVisible();
    await page.getByRole("link", { name: "Open Settings, Integrations" }).click();
    await expect(page.getByText("Not configured on this server")).toBeVisible();
  });

  test("Google disconnect in settings", async ({ page }) => {
    await setup(page, { googleConnected: true });
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText("As ops@acme.test")).toBeVisible();
    await page.getByRole("button", { name: "Disconnect Google" }).click();
    await page.getByRole("button", { name: "Yes, disconnect" }).click();
    await expect(page.getByRole("button", { name: "Connect Google" })).toBeVisible();
  });
});

test.describe("Phase 3 lock", () => {
  test("complete locks field screens; admin reopens with a reason", async ({ page }) => {
    const { p3 } = await setup(page);
    await openAssessment(page);
    await page.getByRole("button", { name: "Complete assessment" }).click();
    await expect(page.getByText("Complete this assessment?")).toBeVisible();
    await page.getByRole("button", { name: "Yes, complete and lock" }).click();
    await expect(page.getByText("Assessment completed and locked.")).toBeVisible();
    expect(p3.state.patches).toEqual([{ status: "in_review" }, { status: "complete" }]);
    await expect(page.getByTestId("locked-banner")).toContainText("Assessment complete: locked");

    await page.getByRole("link", { name: "Risk inputs" }).click();
    await expect(page.getByTestId("locked-banner")).toBeVisible();
    await expect(card(page, "Forced entry after hours").getByRole("button", { name: "Not applicable" })).toBeDisabled();
    await page.getByRole("link", { name: "An admin can reopen it" }).click();

    await page.getByRole("button", { name: "Reopen" }).click();
    await page.getByRole("button", { name: "Reopen assessment" }).click();
    await expect(page.getByText("Give a reason for reopening")).toBeVisible();
    await page.getByLabel("Reason for reopening").fill("Client asked to add the loading dock");
    await page.getByRole("button", { name: "Reopen assessment" }).click();
    await expect(page.getByText("Assessment reopened.", { exact: false })).toBeVisible();
    expect(p3.state.reopenReasons).toEqual(["Client asked to add the loading dock"]);
    await expect(page.getByRole("button", { name: "Complete assessment" })).toBeVisible();
  });

  test("a change refused with assessment_locked is explained", async ({ page }) => {
    const { p3 } = await setup(page);
    await openAssessment(page);
    await page.getByRole("link", { name: /Start walkthrough/ }).click();
    await page.getByRole("link", { name: /Loading dock/ }).click();
    p3.state.status = "complete"; // completed on another device meanwhile
    await page.getByRole("group", { name: "Is the perimeter fence continuous with no gaps or damage?", exact: true }).getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText("1 change was not saved: the assessment is locked")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page.getByText("This assessment is complete and locked, so the change was not saved.")).toBeVisible();
  });
});

test.describe("Phase 3 local PIN", () => {
  test.use({ serviceWorkers: "allow" });

  test("set a PIN, unlock offline after reload, and Forgot PIN wipes", async ({ page }) => {
    const { network } = await setup(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.getByRole("button", { name: "Set PIN" }).click();
    await page.getByLabel("New PIN").fill("12");
    await page.getByRole("button", { name: "Save PIN" }).click();
    await expect(page.getByText("Use 4 to 8 digits.")).toBeVisible();
    await page.getByRole("button", { name: "Not now" }).click();
    await setPinFromPromptAfterReload(page);
    await openAssessment(page);
    await expect(page.getByRole("heading", { name: "Warehouse night survey", level: 1 })).toBeVisible();

    await network(false);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Enter your PIN", level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Warehouse night survey")).toHaveCount(0);
    await page.getByLabel("PIN", { exact: true }).fill("0000");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("Wrong PIN. 4 attempts left")).toBeVisible();
    await page.getByLabel("PIN", { exact: true }).fill("246810");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("heading", { name: "Warehouse night survey", level: 1 })).toBeVisible();
    await expect(page.getByText("Working offline as Alex Assessor")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Enter your PIN", level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Forgot PIN" }).click();
    await page.getByRole("button", { name: "Sign out and delete" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText(/work saved on this device was deleted/)).toBeVisible();
    // The cached profile is gone: a reload offline cannot open anything.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
  });
});

/** "Not now" hides the prompt for this page load only; it is offered again after a reload. */
async function setPinFromPromptAfterReload(page: Page) {
  await expect(page.getByRole("region", { name: "Set a PIN for offline work" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await setPinFromPrompt(page);
}
