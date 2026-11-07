#!/usr/bin/env node
/**
 * Single-origin demo server: serves the built PWA (apps/web/dist) and proxies /api/* to the API,
 * so the whole product works from ONE address (a remote preview, a tunnel, or a LAN URL).
 *
 * Demo use only, never production. It rewrites the internal origin (INTERNAL_ORIGIN, default
 * http://localhost:8080) out of responses so every link the browser sees is relative:
 *   - text bodies: the internal origin becomes the origin the browser used (signed photo URLs, preview CSS)
 *   - CSP source lists (headers and <meta>): the internal origin becomes 'self'
 *   - Set-Cookie Path=/auth becomes Path=/api/auth (the refresh cookie)
 *   - requests to the API get Origin and Referer set to the internal origin (the API's CSRF check)
 *
 * Start the API with WEB_ORIGIN=http://localhost:8080 and API_PUBLIC_URL=http://localhost:8080/api,
 * build the PWA with VITE_API_URL=http://localhost:8080/api, then: node scripts/demo-server.mjs
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.DEMO_PORT ?? 8080);
const API = new URL(process.env.DEMO_API ?? "http://127.0.0.1:3000");
const INTERNAL = (process.env.INTERNAL_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const DIST = resolve(fileURLToPath(new URL("../apps/web/dist", import.meta.url)));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const INT = esc(INTERNAL);
const isText = (ct = "") => /^(text\/|application\/(json|javascript|manifest\+json))/.test(ct);

/** The origin the browser used (behind a preview proxy or tunnel: X-Forwarded-Host and -Proto). */
function publicOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${PORT}`).split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  return /^[a-z0-9.:\[\]-]+$/i.test(host) && /^https?$/.test(proto) ? `${proto}://${host}` : INTERNAL;
}

/** Point every URL the browser sees at the origin it actually used. */
function rewriteText(s, origin) {
  // Inside CSP source lists, the internal origin (optionally with /api) becomes 'self'.
  s = s.replace(new RegExp(`((?:default|script|style|img|connect|font|frame|media|object|worker|manifest)-src[^;"]*?)${INT}(?:/api)?`, "g"), "$1'self'");
  s = s.replace(new RegExp(`((?:default|script|style|img|connect|font|frame|media|object|worker|manifest)-src[^;"]*?)${INT}(?:/api)?`, "g"), "$1'self'");
  s = s.replace(new RegExp(`frame-ancestors[^;"]*`, "g"), "frame-ancestors *");
  return s.replace(new RegExp(INT, "g"), origin);
}

function rewriteHeaders(h, origin) {
  const out = { ...h };
  delete out["content-length"];
  delete out["x-frame-options"];
  for (const k of ["content-security-policy", "location"]) if (typeof out[k] === "string") out[k] = rewriteText(out[k], origin);
  if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map((c) => c.replace(/Path=\/auth/i, "Path=/api/auth"));
  return out;
}

async function proxy(req, res) {
  const path = req.url.replace(/^\/api/, "") || "/";
  const headers = { ...req.headers, host: API.host, origin: INTERNAL, referer: INTERNAL + "/" };
  delete headers["accept-encoding"]; // keep bodies uncompressed so they can be rewritten
  const up = http.request({ hostname: API.hostname, port: API.port, path, method: req.method, headers }, async (r) => {
    const ct = r.headers["content-type"] ?? "";
    const origin = publicOrigin(req);
    const hdrs = rewriteHeaders(r.headers, origin);
    if (!isText(ct)) {
      res.writeHead(r.statusCode ?? 502, hdrs);
      r.pipe(res);
      return;
    }
    const chunks = [];
    for await (const c of r) chunks.push(c);
    const body = Buffer.from(rewriteText(Buffer.concat(chunks).toString("utf8"), origin), "utf8");
    res.writeHead(r.statusCode ?? 502, { ...hdrs, "content-length": body.length });
    res.end(body);
  });
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "api_unreachable", message: e.message } }));
  });
  req.pipe(up);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return void res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(DIST, "index.html"); // SPA fallback
  }
  let data;
  try {
    data = await readFile(file);
  } catch {
    return void res.writeHead(404).end();
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const body = isText(type) ? Buffer.from(rewriteText(data.toString("utf8"), publicOrigin(req)), "utf8") : data;
  res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": file.endsWith("sw.js") || file.endsWith("index.html") ? "no-cache" : "public, max-age=300" });
  res.end(body);
}

http
  .createServer((req, res) => (req.url.startsWith("/api/") || req.url === "/api" ? proxy(req, res) : serveStatic(req, res)))
  .listen(PORT, "0.0.0.0", () => console.log(`Sentinel Assess demo on http://localhost:${PORT} (API ${API.origin}, dist ${DIST})`));
