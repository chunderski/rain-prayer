/**
 * Minimal Google API client over an injectable transport (D-059): OAuth code exchange, refresh, and
 * revoke; Drive folders, multipart uploads, and permissions; Docs and Sheets creation and updates.
 * Scope is drive.file only, so the app sees only files it created. Tests pass a fake transport.
 *
 * Retries: one retry on 429 and 5xx (honoring Retry-After up to 10 s), then GoogleApiError.
 */
import { randomBytes } from "node:crypto";

export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<Response>;

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";
const SHEETS = "https://sheets.googleapis.com/v4";

export const MIME = {
  folder: "application/vnd.google-apps.folder",
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
} as const;

export class GoogleApiError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface ClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  transport?: Transport;
  /** Injected so tests do not wait for real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultTransport: Transport = (url, init) => fetch(url, init as RequestInit);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createGoogleClient(o: ClientOptions) {
  const transport = o.transport ?? defaultTransport;
  const sleep = o.sleep ?? defaultSleep;

  async function call(url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await transport(url, init);
      } catch (err) {
        if (attempt === 0) {
          await sleep(500);
          continue;
        }
        throw new GoogleApiError(0, "network", `Google request failed: ${(err as Error).message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 1000);
        continue;
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!res.ok) {
        const b = body as { error?: string | { status?: string; message?: string }; error_description?: string } | null;
        const reason = typeof b?.error === "string" ? b.error : b?.error?.status ?? `http_${res.status}`;
        // Never include request bodies or tokens in the message.
        throw new GoogleApiError(res.status, reason, `Google API ${res.status} ${reason}`);
      }
      return body;
    }
  }

  const form = (p: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(p).toString(),
  });

  return {
    authorizeUrl(state: string, codeChallenge: string): string {
      const u = new URL(AUTH_URL);
      u.search = new URLSearchParams({
        client_id: o.clientId,
        redirect_uri: o.redirectUri,
        response_type: "code",
        scope: DRIVE_FILE_SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return u.toString();
    },

    async exchangeCode(code: string, codeVerifier: string) {
      const b = (await call(TOKEN_URL, form({
        code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier,
      }))) as { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number };
      if (!b?.access_token) throw new GoogleApiError(502, "no_access_token", "Google returned no access token");
      return { accessToken: b.access_token, refreshToken: b.refresh_token ?? null, scopes: (b.scope ?? "").split(" ").filter(Boolean) };
    },

    async refresh(refreshToken: string): Promise<string> {
      const b = (await call(TOKEN_URL, form({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }))) as {
        access_token?: string;
      };
      if (!b?.access_token) throw new GoogleApiError(502, "no_access_token", "Google returned no access token");
      return b.access_token;
    },

    async revoke(token: string): Promise<void> {
      await call(REVOKE_URL, form({ token }));
    },

    /** API calls with an access token. */
    api(accessToken: string) {
      const json = (method: string, url: string, body?: unknown) =>
        call(url, {
          method,
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      return {
        async aboutEmail(): Promise<string | null> {
          const b = (await json("GET", `${DRIVE}/about?fields=user(emailAddress)`)) as { user?: { emailAddress?: string } };
          return b?.user?.emailAddress ?? null;
        },
        async createFile(name: string, mimeType: string, parentId: string | null): Promise<string> {
          const b = (await json("POST", `${DRIVE}/files?fields=id`, { name, mimeType, ...(parentId ? { parents: [parentId] } : {}) })) as { id: string };
          return b.id;
        },
        /** Multipart upload (metadata plus bytes) into a folder. */
        async upload(name: string, mimeType: string, bytes: Uint8Array, parentId: string): Promise<string> {
          const boundary = `sentinel-${randomBytes(12).toString("hex")}`;
          const meta = JSON.stringify({ name, parents: [parentId] });
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`),
            Buffer.from(bytes),
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          const b = (await call(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}`, accept: "application/json" },
            body,
          })) as { id: string };
          return b.id;
        },
        async addAnyoneReader(fileId: string): Promise<string> {
          const b = (await json("POST", `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions?fields=id`, { role: "reader", type: "anyone" })) as { id: string };
          return b.id;
        },
        async deletePermission(fileId: string, permissionId: string): Promise<void> {
          await json("DELETE", `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`);
        },
        /** Creates an empty Google Doc inside a folder (Drive create, so it lands in the folder directly). */
        createDocument: (title: string, parentId: string) => json("POST", `${DRIVE}/files?fields=id`, { name: title, mimeType: MIME.doc, parents: [parentId] }).then((b) => (b as { id: string }).id),
        async docsBatchUpdate(documentId: string, requests: unknown[]): Promise<void> {
          await json("POST", `${DOCS}/documents/${encodeURIComponent(documentId)}:batchUpdate`, { requests });
        },
        /** Creates a spreadsheet inside a folder; it starts with one sheet whose id is 0. */
        createSpreadsheet: (title: string, parentId: string) => json("POST", `${DRIVE}/files?fields=id`, { name: title, mimeType: MIME.sheet, parents: [parentId] }).then((b) => (b as { id: string }).id),
        async sheetsBatchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
          await json("POST", `${SHEETS}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { requests });
        },
        /** RAW input: cell text that starts with "=" stays text, so finding text cannot become a formula. */
        async valuesBatchUpdate(spreadsheetId: string, data: { range: string; values: string[][] }[]): Promise<void> {
          await json("POST", `${SHEETS}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, { valueInputOption: "RAW", data });
        },
      };
    },
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
export type GoogleApi = ReturnType<GoogleClient["api"]>;

export const driveFolderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;
export const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
/** Download URL for a file shared with "anyone with the link" (used only for the Docs image fetch). */
export const driveDownloadUrl = (id: string) => `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
