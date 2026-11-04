import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
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
});
