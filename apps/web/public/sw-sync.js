/*
 * Imported into the generated service worker (vite.config.ts, workbox.importScripts).
 * Background Sync: when the browser fires our tag, wake open app windows so they push their
 * outbox. The worker never holds an access token, so it cannot push by itself.
 */
self.addEventListener("sync", (event) => {
  if (event.tag !== "sentinel-sync") return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) c.postMessage({ type: "sentinel-sync" });
    }),
  );
});
