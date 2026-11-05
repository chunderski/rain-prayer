import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const originOf = (url: string | undefined, fallback: string) => {
  try {
    return new URL(url || fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
};

/**
 * Builds the Content-Security-Policy for the app page (QA R-10). Only for production builds:
 * the dev server injects inline scripts for hot reload. `frame-ancestors` cannot be set from a
 * meta tag; the host must send it as a header (see README).
 */
export function buildCsp(env: Record<string, string>): string {
  const api = originOf(env.VITE_API_URL, "http://localhost:3000");
  // Signed photo URLs: the API itself for the local storage driver, or the S3 endpoint.
  const photos = (env.VITE_PHOTO_URL_ORIGINS || api)
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((o) => originOf(o, api));
  const img = [...new Set(["'self'", "blob:", "data:", ...photos])].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${img}`,
    `connect-src 'self' ${api}`,
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function cspPlugin(env: Record<string, string>): Plugin {
  return {
    name: "sentinel-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // The app page only; embed-demo.html stands in for a third-party host page.
        if (!ctx.filename.endsWith("index.html")) return html;
        return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp(env)}" />`);
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    cspPlugin(loadEnv(mode, process.cwd(), "VITE_")),
    react(),
    tailwindcss(),
    VitePWA({
      // Registration is done in src/main.tsx (standalone app only, never in the embed bundle).
      injectRegister: null,
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Sentinel Assess",
        short_name: "Sentinel",
        description: "Physical and cyber security assessments in the field.",
        theme_color: "#0b3d91",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell only. API responses (including /auth and anything carrying tokens) are never
        // cached by the service worker: there is deliberately no runtimeCaching entry. Library
        // data is cached in IndexedDB by the app itself (src/offline/db.ts).
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        globIgnores: ["embed-demo.html"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/auth\//, /^\/api\//],
        cleanupOutdatedCaches: true,
        // Background Sync relay (public/sw-sync.js): wakes open windows to push their outbox.
        importScripts: ["sw-sync.js"],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        main: r("./index.html"),
        "embed-demo": r("./embed-demo.html"),
        // Stable file name for third-party hosts: <script type="module" src=".../sentinel-assess.js">
        "sentinel-assess": r("./src/embed.tsx"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sentinel-assess" ? "sentinel-assess.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
}));
