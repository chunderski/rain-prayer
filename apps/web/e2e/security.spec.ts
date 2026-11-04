import { expect, test } from "@playwright/test";
import { mockApi } from "./mock-api";

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
});
