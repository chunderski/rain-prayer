import { expect, test } from "@playwright/test";
import { mockApi } from "./mock-api";
import { signIn } from "./helpers";

// QA security: hostile query strings on the sign-in page must not break rendering.
test.describe("Security", () => {
  for (const code of ["__proto__", "constructor", "toString"]) {
    test(`sign-in survives ?error=${code}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await mockApi(page);
      await page.goto(`/?error=${code}`);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("known Google error codes still show their message", async ({ page }) => {
    await mockApi(page);
    await page.goto("/?error=google_denied");
    await expect(page.getByText("Google sign in was cancelled.")).toBeVisible();
  });

  test("the app page ships a strict CSP and runs without violations (QA R-10)", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await mockApi(page);
    await signIn(page);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toMatch(/connect-src 'self' http:\/\/localhost:3000/);
    expect(csp).toMatch(/img-src 'self' blob: data: http:\/\/localhost:3000/);
    expect(csp).toContain("object-src 'none'");
    await page.getByRole("link", { name: "Library" }).click();
    await expect(page.getByRole("heading", { name: "Control library", level: 1 })).toBeVisible();
    expect(violations).toEqual([]);
  });
});
