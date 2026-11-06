import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { quoteTotals } from "@sentinel/shared";
import { mockApi, PASSWORD } from "./mock-api";
import { ASSESSMENT_ID, createFieldMock, SEEDED_ASSESSMENT } from "./mock-field";
import { createPhase3Mock, SECOND_ASSESSMENT } from "./mock-phase3";
import { createPhase4Mock, USERS } from "./mock-phase4";
import { expectNoSeriousA11yViolations, screenshotOnPixel } from "./helpers";

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

async function setup(page: Page, opts: { plan?: "standard" | "partner"; complete?: boolean } = {}) {
  const field = createFieldMock();
  const p3 = createPhase3Mock();
  if (opts.complete) p3.state.status = "complete";
  for (const [i, l, im] of [[0, 4, 5], [1, 3, 3], [2, 2, 4]] as const) Object.assign(p3.state.inputs[i]!, { likelihood: l, impact: im });
  const p4 = createPhase4Mock({ plan: opts.plan, assessmentStatus: () => p3.state.status, risk: () => p3.result() });
  const api = await mockApi(page, {
    seedAssessments: [SEEDED_ASSESSMENT, SECOND_ASSESSMENT],
    users: Object.values(USERS),
    publicExtra: (route, req, url, reply) => p4.publicHandle(route, req, url, reply),
    extra: async (...args) => (await p4.handle(...args)) || (await p3.handle(...args)) || field.handle(...args),
  });
  p4.bind(api);
  // These specs are not about the PIN prompt; keep it out of the way for the session.
  await page.addInitScript(() => sessionStorage.setItem("sa.pinPromptDismissed", "1"));
  return { p3, p4, api };
}

async function signInAs(page: Page, email: string, landing: RegExp = /^(Dashboard|Assessments)$/) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: landing, level: 1 })).toBeVisible();
}

async function signOut(page: Page) {
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

const PORTAL_HOME = /^Your security assessments$/;

test.describe("Phase 4 branding and members", () => {
  test("branding: contrast check, logo, plan rule, applied app-wide", async ({ page }, testInfo) => {
    const { p4 } = await setup(page);
    await signInAs(page, USERS.admin.email);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Branding" }).click();
    await expect(page.getByRole("heading", { name: "Branding", level: 1 })).toBeVisible();

    await page.getByLabel("Display name").fill("Bluefield Security");
    await page.getByLabel("Primary color code").fill("#ffd700");
    await expect(page.getByTestId("contrast-check")).toContainText("Needs 4.5:1");
    await page.getByRole("button", { name: "Save branding" }).click();
    await expect(page.getByText(/White text on the primary color must reach 4.5:1/)).toBeVisible();
    await page.getByRole("button", { name: /^Use #/ }).click();
    await expect(page.getByTestId("contrast-check")).toContainText("Passes");
    const chosen = await page.getByLabel("Primary color code").inputValue();

    const powered = page.getByRole("checkbox", { name: /Powered by Sentinel Assess/ });
    await expect(powered).toBeDisabled();
    await expect(page.getByText(/standard plan, which always shows this credit/)).toBeVisible();

    await page.getByLabel("Logo file").setInputFiles(path.join(testInfo.project.testDir, "fixtures", "door.jpg"));
    await expect(page.getByTestId("logo-preview")).toBeVisible();
    await page.getByRole("button", { name: "Upload logo" }).click();
    await expect(page.getByText(/Logo uploaded/)).toBeVisible();
    await expect(page.getByTestId("brand-logo")).toBeVisible();

    await page.getByRole("button", { name: "Save branding" }).click();
    await expect(page.getByText(/Branding saved/)).toBeVisible();
    expect(p4.state.branding).toMatchObject({ displayName: "Bluefield Security", primaryColor: chosen, showPoweredBy: true });
    await expect(page.getByTestId("brand-name")).toHaveText("Bluefield Security");
    const applied = await page.locator("[data-brand]").first().evaluate((el) => (el as HTMLElement).style.getPropertyValue("--sa-primary"));
    expect(applied).toBe(chosen);
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "branding.png");
  });

  test("members: invite a client viewer, share the setup link, set a password", async ({ page }) => {
    const { p4 } = await setup(page, { complete: true });
    await signInAs(page, USERS.admin.email);
    await page.goto("/settings/members");
    await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
    // Admins cannot create owners or admins.
    await expect(page.getByLabel("Role", { exact: true }).locator("option", { hasText: "Owner" })).toHaveCount(0);

    await page.getByLabel("Email").fill("dana@northwind.test");
    await page.getByLabel("Name").fill("Dana Client");
    await page.getByLabel("Role", { exact: true }).selectOption("client_viewer");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByText("Choose the client this person may see.")).toBeVisible();
    await page.getByLabel("Client", { exact: true }).selectOption({ label: "Northwind Logistics" });
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByText("Share this securely")).toBeVisible();
    const link = await page.getByTestId("setup-link").inputValue();
    expect(link).toMatch(/\/setup#token=[0-9a-f]{48}$/);
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByText(/Link copied|Copy is blocked here/)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("member-dana@northwind.test")).toContainText("Invited: setup not finished");
    await expect(page.getByTestId("member-dana@northwind.test")).toContainText("Client: Northwind Logistics");

    await signOut(page);
    await page.goto(new URL(link).pathname + new URL(link).hash);
    await expect(page.getByRole("heading", { name: "Set your password", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/); // token taken out of the address bar (fragment cleared)
    await page.getByLabel("New password").fill("short");
    await page.getByRole("button", { name: "Set password and continue" }).click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await page.getByLabel("New password").fill("a long sentence password");
    await page.getByLabel("Confirm password").fill("a long sentence password");
    await page.getByRole("button", { name: "Set password and continue" }).click();
    await expect(page.getByRole("heading", { name: PORTAL_HOME, level: 1 })).toBeVisible();
    expect(p4.state.tokens.size).toBe(0); // single use
  });

  test("owner: the last active owner cannot be disabled", async ({ page }) => {
    await setup(page);
    await signInAs(page, USERS.owner.email);
    await page.goto("/settings/members");
    const row = page.getByTestId(`member-${USERS.owner.email}`);
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByRole("alert")).toContainText("at least one active owner");
  });
});

test("setup: an existing account joins with its current password; Google-only accounts are told what to do", async ({ page }) => {
  await setup(page);
  await signInAs(page, USERS.owner.email);
  const invite = async (email: string) => {
    await page.goto("/settings/members");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Name").fill("Pat Partner");
    await page.getByLabel("Role", { exact: true }).selectOption("assessor");
    await page.getByRole("button", { name: "Create invite" }).click();
    return page.getByTestId("setup-link").inputValue();
  };
  const google = await invite("gail@google.test");
  const link = await invite("pat@partner.test");
  await signOut(page);

  await page.goto(new URL(google).pathname + new URL(google).hash);
  await page.getByLabel("New password").fill("a long sentence password");
  await page.getByLabel("Confirm password").fill("a long sentence password");
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(page.getByText(/already has an account that signs in another way, such as Google/)).toBeVisible();

  await page.goto(new URL(link).pathname + new URL(link).hash);
  await page.getByLabel("New password").fill("a long sentence password");
  await page.getByLabel("Confirm password").fill("a long sentence password");
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await expect(page.getByText("This email already has a Sentinel Assess account. Enter its current password to join this workspace.")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Yes: use my current password/ })).toBeChecked();
  await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("");
  await page.getByLabel("Current password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Join and continue" }).click();
  await expect(page.getByRole("heading", { name: /^(Dashboard|Assessments)$/, level: 1 })).toBeVisible();
});

test.describe("Phase 4 quotes and portal", () => {
  test.setTimeout(120_000);

  test("quote: create from findings, price, submit below margin, owner approves and sends, client accepts", async ({ page }, testInfo) => {
    const { p4 } = await setup(page, { complete: true });
    await signInAs(page, USERS.estimator.email);
    await page.getByRole("link", { name: /Warehouse night survey/ }).click();
    await page.getByRole("link", { name: "Quotes" }).click();
    await page.getByRole("button", { name: "Create quote" }).click();
    await expect(page.getByRole("heading", { name: "Quote Q-2026-0001", level: 1 })).toBeVisible();

    // Needs pricing blocks submit until the line is priced.
    await expect(page.getByText("Price or remove the 1 line marked Needs pricing before submitting.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Submit/ })).toBeDisabled();
    await expect(page.getByText("This quote uses placeholder prices from the starter price book.")).toBeVisible();
    const np = page.getByTestId("quote-line").filter({ hasText: "Needs pricing" });
    await np.getByLabel("Material cost per unit (USD)").fill("250");
    await expect(page.getByText(/marked Needs pricing/)).toHaveCount(0);

    // Drop the fence repair margin under the 20% minimum.
    const fence = page.getByTestId("quote-line").filter({ hasText: "Chain-link fabric repair" });
    await fence.getByRole("button", { name: /Chain-link fabric repair/ }).click();
    await fence.getByLabel("Margin (%)").fill("5");
    await expect(page.getByText(/The Good tier margin is \d+(\.\d+)?%, under your 20% minimum/)).toBeVisible();
    await expect(page.getByTestId("totals-good")).toContainText("Under your 20% minimum");
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "quote-editor.png");

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText(/an owner must approve it/)).toBeVisible();
    const saved = [...p4.state.quotes.values()][0]!;
    expect(saved.status).toBe("pending_approval");
    expect(saved.lines.find((l) => l.description === "Chain-link fabric repair")?.marginPct).toBe(5);
    // The editor showed exactly what the API stored (both use quoteTotals).
    const expected = quoteTotals(saved);
    await expect(page.getByTestId("price-good")).toHaveText(usd(expected[0]!.price));
    // Estimators cannot approve; the locked quote has no save.
    await expect(page.getByRole("button", { name: "Approve quote" })).toHaveCount(0);
    await expect(page.getByText("This quote is locked because it has been submitted. Revise it to make changes.")).toBeVisible();

    const quoteUrl = new URL(page.url()).pathname;
    await signOut(page);
    await signInAs(page, USERS.owner.email);
    await page.goto(quoteUrl);
    await page.getByRole("button", { name: "Approve quote" }).click();
    await expect(page.getByText("Approved. An admin can now send it to the client.")).toBeVisible();
    await page.getByRole("button", { name: "Send to client" }).click();
    await expect(page.getByText(/Sent. The client can now see it/)).toBeVisible();
    expect(p4.state.quotes.get(saved.id)?.status).toBe("sent");

    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByTestId("quote-preview")).toHaveAttribute("sandbox", "");
    await expect(page.frameLocator('[data-testid="quote-preview"]').getByRole("heading", { name: "Proposal Q-2026-0001" })).toBeVisible();
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    expect((await dl).suggestedFilename()).toBe("Q-2026-0001.csv");

    await signOut(page);
    await signInAs(page, USERS.carmen.email, PORTAL_HOME);
    await page.getByRole("link", { name: /Q-2026-0001/ }).first().click();
    await expect(page.getByRole("heading", { name: "Proposal Q-2026-0001", level: 1 })).toBeVisible();
    await expect(page.getByText(/Margin|Cost/)).toHaveCount(0);
    await page.getByRole("radio", { name: /Better/ }).check();
    await expect(page.getByText(/^Accept the Better option for \$[\d,.]+\? Type your full name to confirm\.$/)).toBeVisible();
    await page.getByRole("button", { name: "Accept proposal" }).click();
    await expect(page.getByText("Type your full name to confirm.").last()).toBeVisible();
    await page.getByLabel("Your full name").fill("Carmen Diaz");
    await page.getByRole("button", { name: "Accept proposal" }).click();
    await expect(page.getByText(/^Accepted by Carmen Diaz on .+, Better option\.$/)).toBeVisible();
    const final = p4.state.quotes.get(saved.id)!;
    expect(final.status).toBe("accepted");
    expect(p4.state.actions.at(-1)).toMatchObject({ body: { action: "accept", tier: "better", name: "Carmen Diaz" }, by: USERS.carmen.email });
  });

  test("client portal: results, findings, report, decline, and no workspace", async ({ page }, testInfo) => {
    const { p4 } = await setup(page, { complete: true });
    const q = p4.seedQuote("sent");
    await signInAs(page, USERS.carmen.email, PORTAL_HOME);
    await expect(page.locator('[data-shell="portal"]')).toBeVisible();
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Set a PIN for offline work" })).toHaveCount(0);
    await expect(page.getByText("Powered by Sentinel Assess")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "client-portal.png");

    await page.getByRole("link", { name: "Warehouse night survey", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Risk summary" })).toBeVisible();
    await expect(page.getByText("Forced entry after hours")).toBeVisible();
    const finding = page.getByRole("button", { name: "Fence gap at the loading dock" });
    await expect(finding).toHaveAttribute("aria-expanded", "false");
    await finding.click();
    await expect(page.getByText("Physical security: Perimeter barriers (SA-PER-1)")).toBeVisible();
    // axe cannot inject into the script-less sandboxed preview frame, so it runs before the report opens.
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Show report" }).click();
    await expect(page.getByTestId("portal-report")).toHaveAttribute("sandbox", "");
    await expect(page.frameLocator('[data-testid="portal-report"]').getByText("Approved summary for Northwind.")).toBeVisible();

    await page.getByRole("link", { name: new RegExp(q.number) }).click();
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    await page.getByLabel("Reason (optional)").fill("Budget is set for next year.");
    await page.getByLabel("Your full name").fill("Carmen Diaz");
    await page.getByRole("button", { name: "Decline proposal" }).click();
    await expect(page.getByText(/^Declined by Carmen Diaz on/)).toBeVisible();
    expect(p4.state.quotes.get(q.id)?.status).toBe("declined");

    // Workspace URLs show the portal, and the API refuses client viewers outside it.
    await page.goto(`/assessments/${ASSESSMENT_ID}/quotes`);
    await expect(page.getByRole("heading", { name: PORTAL_HOME, level: 1 })).toBeVisible();
    const status = await page.evaluate(async () => (await fetch("http://localhost:3000/assessments", { headers: { Authorization: "Bearer mock-access-token" } })).status);
    expect(status).toBe(403);
  });

  test("expired quote: client sees Expired, the team can revise", async ({ page }) => {
    const { p4 } = await setup(page, { complete: true });
    const q = p4.seedQuote("expired", { validUntil: "2026-10-01" });
    await signInAs(page, USERS.carmen.email, PORTAL_HOME);
    await page.goto(`/portal/quotes/${q.id}`);
    await expect(page.getByText(/This proposal expired on .+\. Contact your provider for an updated proposal\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept proposal" })).toHaveCount(0);
    await signOut(page);
    await signInAs(page, USERS.admin.email);
    await page.goto(`/assessments/${ASSESSMENT_ID}/quotes/${q.id}`);
    await expect(page.getByText("Expired", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Revise" }).click();
    await expect(page.getByRole("heading", { name: "Quote Q-2026-0001-R2", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  });
});

test.describe("Phase 4 portfolio and price book", () => {
  test("portfolio: trend per site with values in text, caveats, quote values", async ({ page }, testInfo) => {
    await setup(page);
    await signInAs(page, USERS.admin.email);
    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByRole("heading", { name: "Portfolio", level: 1 })).toBeVisible();
    await expect(page.getByTestId("portfolio-caveats")).toContainText("control library 1.0.0");
    const site = page.getByTestId("site-d0000000-0000-4000-8000-000000000001");
    await expect(site.getByTestId("trend-svg")).toBeVisible();
    await expect(site.getByTestId("trend-text")).toContainText(/Residual 16 High .*then 12 Medium .*then 9 Medium .*: improving\./);
    await expect(site).toContainText("accepted value $12,480.00, open value $5,320.50");
    // Ranked by latest residual: Head office (16) before Main warehouse (9).
    const names = await page.getByRole("heading", { level: 3 }).allTextContents();
    expect(names.slice(0, 2)).toEqual(["Head office", "Main warehouse"]);
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "portfolio.png");
  });

  test("price book: placeholder badge, import, add, duplicate SKU", async ({ page }) => {
    const { p4 } = await setup(page);
    await signInAs(page, USERS.admin.email);
    await page.goto("/settings/price-book");
    await expect(page.getByTestId("pb-TPL-LED-WP")).toContainText("Placeholder price");
    await page.getByRole("button", { name: "Import starter price book" }).first().click();
    await expect(page.getByText("Added 1 item. Skipped 1 that you already have.")).toBeVisible();
    await page.getByRole("button", { name: "Add item" }).click();
    await page.getByLabel("SKU").fill("FEN-REPAIR");
    await page.getByLabel("Name").fill("Gate closer");
    await page.getByRole("button", { name: "Save item" }).click();
    await expect(page.getByText("Another item already uses this SKU.")).toBeVisible();
    await page.getByLabel("SKU").fill("GATE-CL");
    await page.getByLabel("Remediates controls").fill("SC-PER-001");
    await page.getByRole("button", { name: "Save item" }).click();
    await expect(page.getByText("Gate closer added.")).toBeVisible();
    expect(p4.state.priceBook.find((i) => i.sku === "GATE-CL")).toMatchObject({ controlIds: ["SC-PER-001"], active: true });
    await page.getByLabel("Search the price book").fill("gate");
    await expect(page.getByRole("status").filter({ hasText: /^1 item$/ })).toBeVisible();
  });
});

test.describe("Phase 4 tour fix: short risk results on phones", () => {
  test("collapsed risk results stay under 4 viewport heights on Pixel 7", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "pixel-7", "Pixel 7 measurement");
    await setup(page);
    await signInAs(page, USERS.admin.email);
    await page.goto(`/assessments/${ASSESSMENT_ID}/risk`);
    await expect(page.getByRole("heading", { name: "Risk results", level: 1 })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(3);
    for (const b of await page.getByRole("article").getByRole("button", { expanded: false }).all()) await expect(b).toBeVisible();
    const { h, vh } = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, vh: window.innerHeight }));
    expect(h).toBeLessThan(4 * vh);
    await screenshotOnPixel(page, testInfo, "risk-results-collapsed.png");
  });
});
