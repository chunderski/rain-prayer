import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The API is mocked with page.route(); keep the service worker out of the way.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"], browserName: "chromium" } },
    { name: "pixel-7", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    // iPhone 14 viewport, touch, and user agent emulated in Chromium (only Chromium is installed).
    { name: "iphone-14", use: { ...devices["iPhone 14"], browserName: "chromium" } },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
