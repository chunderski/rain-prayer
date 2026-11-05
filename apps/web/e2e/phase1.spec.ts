import { expect, test } from "@playwright/test";
import { API, mockApi, PASSWORD } from "./mock-api";
import { expectNoSeriousA11yViolations, screenshotOnPixel, signIn } from "./helpers";

test.describe("Phase 1", () => {
  test("sign-in page is accessible and offers Google sign in", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "http://localhost:3000/auth/google/start");
    await expectNoSeriousA11yViolations(page);
  });

  test("wrong password shows an error", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await page.getByLabel("Email").fill("assessor@acme.test");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Email or password is incorrect" })).toBeVisible();
  });

  test("a user in several workspaces chooses one", async ({ page }) => {
    await mockApi(page, { multiTenant: true });
    await page.goto("/");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("group", { name: "Choose a workspace" })).toBeVisible();
    await page.getByRole("radio", { name: "Bluefield Security" }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
    await expect(page.getByText("Bluefield Security")).toBeVisible();
  });

  test("create an assessment with two frameworks", async ({ page }, testInfo) => {
    const api = await mockApi(page);
    await signIn(page);
    await page.getByRole("link", { name: "New assessment" }).click();

    await expect(page.getByRole("heading", { name: "Step 1 of 3: Client and site" })).toBeVisible();
    await page.getByRole("radio", { name: /Northwind Logistics/ }).check();
    await page.getByRole("radio", { name: /Main warehouse/ }).check();
    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByRole("heading", { name: "Step 2 of 3: Frameworks" })).toBeVisible();
    // Next without a framework is refused.
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Choose at least one framework." })).toBeVisible();

    await page.getByRole("checkbox", { name: "CPTED" }).check();
    await page.getByRole("checkbox", { name: "Physical security" }).check();
    const summary = page.getByTestId("picker-summary");
    // physical-general: LGT, PER; cpted: LGT, PER, ENV -> 3 shared controls, 2 overlapping.
    await expect(summary).toContainText("2 frameworks selected: 3 shared controls to check, 2 of them count toward more than one framework.");
    await expect(page.getByText("2 items need expert review")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await screenshotOnPixel(page, testInfo, "framework-picker.png");

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("heading", { name: "Step 3 of 3: Details and review" })).toBeVisible();
    await page.getByLabel("Assessment title").fill("Warehouse night survey");
    await page.getByLabel("Scheduled date (optional)").fill("2026-11-20");
    const counts = page.getByTestId("review-counts");
    await expect(counts).toContainText("Shared controls3");
    await expect(counts).toContainText("Questions7");
    await expect(counts).toContainText("2 checks saved");
    await page.getByRole("button", { name: "Create assessment" }).click();

    await expect(page.getByRole("heading", { name: "Warehouse night survey", level: 1 })).toBeVisible();
    await expect(page.getByTestId("assessment-control-count")).toHaveText("3");
    expect(api.createdAssessments).toEqual([
      {
        siteId: "d0000000-0000-4000-8000-000000000001",
        title: "Warehouse night survey",
        scheduledFor: "2026-11-20",
        frameworks: [
          { frameworkId: "physical-general", version: "1.0.0" },
          { frameworkId: "cpted", version: "1.0.0" },
        ],
      },
    ]);
  });

  test("browse a control and see every framework it counts toward", async ({ page }, testInfo) => {
    await mockApi(page);
    await signIn(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click();
    await expect(page.getByRole("heading", { name: "Control library" })).toBeVisible();
    await expect(page.getByText("5 controls")).toBeVisible();
    await expectNoSeriousA11yViolations(page);

    await page.getByLabel("Search controls").fill("lighting");
    await expect(page.getByText("1 control", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Exterior lighting covers approaches/ }).click();

    const counts = page.getByTestId("counts-toward");
    await expect(counts).toContainText("counts toward 3 requirements in 3 frameworks");
    for (const name of ["Physical security", "CPTED", "CARVER"]) {
      await expect(counts.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
    }
    await expect(counts).toContainText("Informs");
    await expect(page.getByRole("heading", { name: "Questions (3)" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    // Viewport shot scrolled to the mappings: a full-page capture paints the fixed bottom nav mid-page.
    await page.getByRole("heading", { name: "Counts toward" }).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await screenshotOnPixel(page, testInfo, "control-detail.png", false);
  });

  test("library filters by framework and flags controls pending review", async ({ page }) => {
    await mockApi(page);
    await signIn(page);
    await page.goto("/library");
    await expect(page.getByText("5 controls")).toBeVisible();
    await page.getByLabel("Framework").selectOption("cpted");
    await expect(page.getByText("3 controls")).toBeVisible();
    await page.getByLabel("Domain").selectOption("ENV");
    await expect(page.getByText("1 control", { exact: true })).toBeVisible();
    await expect(page.getByText("Wording pending review")).toBeVisible();
  });

  test("library keeps working offline once loaded", async ({ page, context }) => {
    await mockApi(page);
    await signIn(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Library" }).click();
    await expect(page.getByText("5 controls")).toBeVisible();
    await page.getByRole("link", { name: /Cryptographic inventory exists/ }).click();
    await expect(page.getByTestId("counts-toward")).toContainText("2 frameworks");
    await page.getByRole("link", { name: "Control library" }).click();
    await expect(page.getByText("5 controls")).toBeVisible();

    await context.setOffline(true);
    // page.route() would still answer while offline; make every API call fail like a dead network.
    await page.route(`${API}/**`, (route) => route.abort("internetdisconnected"));
    await expect(page.getByText("You are offline")).toBeVisible();
    await page.getByLabel("Framework").selectOption("pqc-readiness");
    await expect(page.getByText("Showing the library saved on this device.")).toBeVisible();
    await expect(page.getByText("1 control", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Cryptographic inventory exists/ }).click();
    await expect(page.getByTestId("counts-toward")).toContainText("2 frameworks");
  });

  test("create a client and a site", async ({ page }) => {
    await mockApi(page);
    await signIn(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Clients" }).click();
    await page.getByRole("button", { name: "Add client" }).click();
    await page.getByLabel("Client name").fill("northwind logistics");
    await page.getByRole("button", { name: "Save client" }).click();
    await expect(page.getByText('A client named "Northwind Logistics" already exists.')).toBeVisible();
    await page.getByLabel("Client name").fill("Harbor Clinic");
    await page.getByLabel("Industry (optional)").fill("Healthcare");
    await page.getByRole("button", { name: "Save client" }).click();
    await expect(page.getByRole("heading", { name: "Harbor Clinic", level: 1 })).toBeVisible();
    await page.getByLabel("Site name").fill("Clinic east wing");
    await page.getByRole("button", { name: "Add site" }).click();
    await expect(page.getByText('Site "Clinic east wing" added.')).toBeVisible();
    await expect(page.getByText("Clinic east wing", { exact: true })).toBeVisible();
  });
});

test.describe("Embedding", () => {
  test("runs inside an iframe and as a <sentinel-assess> web component", async ({ page }) => {
    await mockApi(page);
    await page.goto("/embed-demo.html");
    const frame = page.frameLocator('iframe[title="Sentinel Assess (iframe)"]');
    await expect(frame.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const element = page.locator("sentinel-assess");
    await expect(element.getByRole("heading", { name: "Sign in" })).toBeVisible();
    // The web component must not change the host page URL.
    expect(new URL(page.url()).pathname).toBe("/embed-demo.html");
  });
});
