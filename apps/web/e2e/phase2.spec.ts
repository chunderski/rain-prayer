import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockApi } from "./mock-api";
import { AREA_ID, ASSESSMENT_ID, createFieldMock, SEEDED_ASSESSMENT, type FieldMockOptions } from "./mock-field";
import { expectNoSeriousA11yViolations, screenshotOnPixel, setPinFromPrompt, signIn } from "./helpers";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "door.jpg");
const Q = {
  fence: "Is the perimeter fence continuous with no gaps or damage?",
  gap: "Largest gap under the fence measured at grade",
  lit: "Are all entrances lit well enough to identify a face at night?",
  even: "How even is the lighting across the approaches?",
  shrubs: "Do shrubs and trees leave clear sight lines to entrances?",
};
const LIGHTING = "Exterior lighting covers approaches and entrances";

async function setup(page: Page, opts: FieldMockOptions = {}) {
  const field = createFieldMock(opts);
  const api = await mockApi(page, { seedAssessments: [SEEDED_ASSESSMENT], extra: field.handle });
  await signIn(page);
  const network = async (on: boolean) => {
    api.offline = !on;
    await page.context().setOffline(!on);
  };
  return Object.assign(field, { network });
}

const group = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const status = (page: Page) => page.getByTestId("sync-status");

async function openArea(page: Page, area = "Loading dock") {
  await page.getByRole("link", { name: /Warehouse night survey/ }).click();
  await page.getByRole("link", { name: /Start walkthrough|Continue walkthrough/ }).click();
  await expect(page.getByRole("heading", { name: "Walkthrough", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: new RegExp(area) }).click();
  await expect(page.getByRole("heading", { name: area, level: 1 })).toBeVisible();
}

/** From the lighting control: capture the fixture photo and save its tags. */
async function captureAndTag(page: Page) {
  await page.getByLabel("Take photo").setInputFiles(FIXTURE);
  await expect(page.getByRole("heading", { name: "Tag photo", level: 1 })).toBeVisible();
  await page.getByRole("group", { name: "Severity" }).getByRole("button", { name: "High" }).click();
  await page.getByLabel("Asset type").selectOption("door");
  await page.getByLabel("Notes").fill("Dock door light is out.");
}

test.describe("Phase 2 offline", () => {
  // The app shell must come from the service worker for the offline reload.
  test.use({ serviceWorkers: "allow" });

  test("walkthrough, photo, offline reload, and sync", async ({ page }, testInfo) => {
    const field = await setup(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // R2-5: cached work opens offline only behind the local PIN.
    await setPinFromPrompt(page);
    await openArea(page);

    // Section 1, control 1: perimeter fence.
    await expect(page.getByRole("heading", { name: "Perimeter fence is intact", level: 2 })).toBeVisible();
    await expect(page.getByText("Section 1 of 2: Perimeter and lighting")).toBeVisible();
    await expect(page.getByText("Physical security: SA-PER-1")).toBeVisible();
    await group(page, Q.fence).getByRole("button", { name: "Yes" }).click();
    for (const k of ["1", "Decimal point", "5"]) await page.getByRole("group", { name: `Keypad for ${Q.gap}` }).getByRole("button", { name: k, exact: true }).click();
    await page.getByRole("button", { name: "Save 1.5 in" }).click();
    await expect(page.getByRole("button", { name: "Saved: 1.5 in" })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Control 2: lighting. "No" creates a draft finding and offers a photo.
    await expect(page.getByRole("heading", { name: LIGHTING, level: 2 })).toBeVisible();
    await group(page, Q.lit).getByRole("button", { name: "No" }).click();
    await expect(page.getByText("Draft finding added")).toBeVisible();
    await page.getByText("How to check").first().click();
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "walkthrough.png", false);

    await captureAndTag(page);
    await expect(page.getByLabel("Finding")).toHaveValue(/[0-9a-f-]{36}/); // linked to the draft finding
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "tagging-sheet.png");
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(page.getByRole("heading", { name: LIGHTING, level: 2 })).toBeVisible();

    await expect(status(page)).toHaveText(/All changes saved to server/, { timeout: 15_000 });
    await expect.poll(() => field.state.uploads.length).toBe(1);
    expect(field.state.uploads[0]!.contentType).toBe("image/jpeg");

    // Lose signal, keep working.
    await field.network(false);
    await expect(page.getByText("You are offline")).toBeVisible();
    await group(page, Q.even).getByRole("button", { name: /2\s*Mostly even/ }).click();
    await expect(status(page)).toHaveText(/1 change waiting for signal/);

    // Reload with no signal: the cached profile and data open the same place.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Enter your PIN", level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("PIN", { exact: true }).fill("246810");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("heading", { name: LIGHTING, level: 2 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Working offline as Alex Assessor")).toBeVisible();
    await expect(group(page, Q.even).getByRole("button", { name: /Mostly even/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Section 2 of 2: Site design")).toBeVisible();
    await group(page, Q.shrubs).getByRole("button", { name: "Partial" }).click();
    await expect(status(page)).toHaveText(/2 changes waiting for signal/);

    // Signal returns: everything syncs.
    const pushesBefore = field.state.pushes.length;
    await field.network(true);
    await expect(status(page)).toHaveText(/All changes saved to server/, { timeout: 20_000 });

    const offlinePushes = field.state.pushes.slice(pushesBefore).flatMap((p) => p.ops);
    expect(offlinePushes.map((o) => (o.data as { questionId?: string }).questionId).sort()).toEqual(["Q-ENV-001-01", "Q-LGT-001-02"]);

    const ops = field.state.ops();
    const answers = Object.fromEntries(ops.filter((o) => o.entity === "answer").map((o) => [o.data!.questionId, o.data!]));
    expect(answers).toMatchObject({
      "Q-PER-001-01": { areaId: AREA_ID, assessmentId: ASSESSMENT_ID, value: { kind: "choice", value: "yes" } },
      "Q-PER-001-02": { value: { kind: "number", value: 1.5, unit: "in" } },
      "Q-LGT-001-01": { value: { kind: "choice", value: "no" } },
      "Q-LGT-001-02": { value: { kind: "scale", value: 2 } },
      "Q-ENV-001-01": { value: { kind: "choice", value: "partial" } },
    });
    for (const o of ops) {
      expect(o.opId).toMatch(/^[0-9a-f-]{36}$/);
      expect(o).toHaveProperty("clientUpdatedAt");
    }
    const finding = ops.find((o) => o.entity === "finding")!;
    expect(finding.data).toMatchObject({ controlIds: ["SC-LGT-001"], severity: "high", status: "draft", source: "assessor", areaId: AREA_ID });
    const photo = ops.filter((o) => o.entity === "photo_meta").at(-1)!;
    expect(photo.data).toMatchObject({ areaId: AREA_ID, findingId: finding.id, controlIds: ["SC-LGT-001"], severity: "high", assetType: "door", gps: null, contentType: "image/jpeg", notes: "Dock door light is out." });
    expect((photo.data as { capturedAt: string }).capturedAt).toMatch(/^2026-11-0[45]T/); // EXIF DateTimeOriginal
    // Ordering: the finding reached the server before the photo that references it.
    const firstPhotoPush = field.state.pushes.findIndex((p) => p.ops.some((o) => o.entity === "photo_meta"));
    const firstFindingPush = field.state.pushes.findIndex((p) => p.ops.some((o) => o.entity === "finding"));
    expect(firstFindingPush).toBeLessThanOrEqual(firstPhotoPush);
  });
});

test.describe("Phase 2 field capture", () => {
  test("AI suggestions: accept one draft, reject one, then reject a whole suggestion", async ({ page }, testInfo) => {
    const field = await setup(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await openArea(page);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await captureAndTag(page);
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(status(page)).toHaveText(/All changes saved to server/, { timeout: 15_000 });

    await page.goto(`/assessments/${ASSESSMENT_ID}/photos`);
    await page.getByRole("link", { name: /Loading dock/ }).first().click();
    await expect(page.getByText("Uploaded")).toBeVisible();
    await page.getByRole("button", { name: "Analyze with AI" }).click();

    const review = page.getByRole("article").filter({ hasText: "Suggested tags" });
    await expect(review.getByText("AI suggestion, not final").first()).toBeVisible();
    await expect(page.getByText("Check before accepting")).toBeVisible();
    await expect(page.getByText("The photo contains text that reads like an instruction; it was ignored.")).toBeVisible();
    await expect(page.getByText("Door, confidence High (86%)")).toBeVisible();
    // Model text is plain text: the markup shows literally and creates no element.
    await expect(page.getByRole("heading", { name: "<img src=x onerror=alert(1)>Entrance light not working" })).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    await expect(page.getByText("Confidence Low (32%)")).toBeVisible();
    const save = page.getByRole("button", { name: "Save review" });
    await expect(save).toBeDisabled();
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "suggestion-review.png");

    await page.getByRole("group", { name: /Decision for <img/ }).getByRole("button", { name: "Accept" }).click();
    await expect(save).toBeDisabled();
    await page.getByRole("group", { name: "Decision for Fence line may have a gap" }).getByRole("button", { name: "Reject" }).click();
    await save.click();
    await expect(page.getByText("Saved: 1 finding added, marked AI-assisted.")).toBeVisible();
    expect(field.state.reviews[0]).toEqual({ decision: "accept", findingIndexes: [0], applyTags: false });

    await page.getByRole("button", { name: "Analyze again with AI" }).click();
    await page.getByRole("group", { name: /Decision for <img/ }).getByRole("button", { name: "Reject" }).click();
    await page.getByRole("group", { name: "Decision for Fence line may have a gap" }).getByRole("button", { name: "Reject" }).click();
    await page.getByLabel("Reason for rejecting (optional)").fill("Light was on during the visit");
    await page.getByRole("button", { name: "Save review" }).click();
    await expect(page.getByText("Suggestion rejected and logged.")).toBeVisible();
    expect(field.state.reviews[1]).toEqual({ decision: "reject", reason: "Light was on during the visit" });

    // The accepted finding counts toward every mapped framework.
    await page.goto(`/assessments/${ASSESSMENT_ID}/findings`);
    const item = page.getByTestId("findings-list").getByRole("listitem").filter({ hasText: "Entrance light not working" });
    await expect(item.getByText("AI-assisted, accepted")).toBeVisible();
    await expect(item.getByText("Physical security: SA-LGT-1")).toBeVisible();
    await expect(item.getByText("CPTED: SA-CPTED-NS")).toBeVisible();
    expect(dialogs).toEqual([]);
  });

  test("AI analysis is disabled offline and hidden when the workspace turned it off", async ({ page, context }) => {
    const field = await setup(page);
    await openArea(page);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await captureAndTag(page);
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(status(page)).toHaveText(/All changes saved to server/, { timeout: 15_000 });
    await page.goto(`/assessments/${ASSESSMENT_ID}/photos`);
    await page.getByRole("link", { name: /Loading dock/ }).first().click();
    await field.network(false);
    await expect(page.getByRole("button", { name: "Analyze with AI" })).toBeDisabled();
    await expect(page.getByText("Needs a connection. The photo is saved; analyze it when you are back online.")).toBeVisible();
    await field.network(true);

    const page2 = await context.newPage();
    await setup(page2, { aiPhotoAnalysis: false });
    await page2.goto(`/assessments/${ASSESSMENT_ID}/photos`);
    await expect(page2.getByRole("heading", { name: "Photos", level: 1 })).toBeVisible();
    await expect(page2.getByRole("heading", { name: "AI suggestions" })).toHaveCount(0);
  });

  test("a conflict shows the banner and both copies, and can be resolved", async ({ page }) => {
    await setup(page, { conflictOnce: "finding" });
    await openArea(page);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await group(page, Q.lit).getByRole("button", { name: "No" }).click();
    await expect(status(page)).toHaveText(/Conflict: review \(1\)/, { timeout: 15_000 });
    await status(page).click();
    await expect(page.getByRole("heading", { name: "Conflicts (1)" })).toBeVisible();
    await expect(page.getByText("On the server now")).toBeVisible();
    await expect(page.getByText("Changed on another device")).toBeVisible();
    await expect(page.getByText(`${LIGHTING}: not in place`)).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Keep server copy" }).click();
    await expect(status(page)).toHaveText(/All changes saved to server/);
    await expect(page.getByRole("heading", { name: "Conflicts (0)" })).toBeVisible();
  });

  test("admin: assign assessors and manage areas", async ({ page }) => {
    await setup(page);
    await page.goto(`/assessments/${ASSESSMENT_ID}/assessors`);
    await page.getByRole("checkbox", { name: /Sam Field/ }).check();
    await page.getByRole("button", { name: "Save assessors" }).click();
    await expect(page.getByText("Assessors saved.")).toBeVisible();

    await page.goto(`/assessments/${ASSESSMENT_ID}/areas`);
    await page.getByLabel("Area name").fill("Server room");
    await page.getByRole("button", { name: "IT room" }).click();
    await page.getByRole("button", { name: "Add area" }).click();
    await expect(page.getByRole("button", { name: "Rename Server room" })).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete Loading dock" }).click();
    await expect(page.getByText("This area has answers, findings, or photos, so it cannot be deleted. Rename it instead.")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});
