/**
 * Network side of the sync engine, built on the typed API client so auth (in-memory token, one
 * refresh on 401) works the same as everywhere else. Errors are mapped to a small set of kinds the
 * engine can act on.
 */
import { z } from "zod";
import { Photo, SyncOpResult, SyncPullResponse, type PhotoMeta, type SyncOp } from "@sentinel/shared";
import { ApiError, NetworkError, type ApiClient } from "../api/client";

export type TransportErrorKind = "network" | "auth" | "server" | "not_found" | "client";

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    readonly code: string = kind,
    readonly status = 0,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface SyncTransport {
  /** Make sure a usable access token exists (refreshing if needed). */
  ensureAuth(): Promise<"ok" | "offline" | "signed_out">;
  push(deviceId: string, ops: SyncOp[]): Promise<SyncOpResult[]>;
  pull(assessmentId: string, since: string | null, limit: number): Promise<SyncPullResponse>;
  createPhoto(meta: PhotoMeta): Promise<void>;
  uploadPhoto(photoId: string, bytes: Blob, contentType: string): Promise<Photo>;
}

function mapError(err: unknown): TransportError {
  if (err instanceof TransportError) return err;
  if (err instanceof NetworkError) return new TransportError("network", err.message);
  if (err instanceof ApiError) {
    if (err.status === 401) return new TransportError("auth", err.message, err.code, 401);
    if (err.status === 404) return new TransportError("not_found", err.message, err.code, 404);
    if (err.status >= 500 || err.status === 429 || err.status === 408) return new TransportError("server", err.message, err.code, err.status);
    return new TransportError("client", err.message, err.code, err.status);
  }
  return new TransportError("server", err instanceof Error ? err.message : "Unknown error");
}

async function wrap<T>(p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (err) {
    throw mapError(err);
  }
}

export function createApiTransport(api: ApiClient): SyncTransport {
  return {
    async ensureAuth() {
      try {
        return (await api.ensureToken()) ? "ok" : "signed_out";
      } catch (err) {
        if (err instanceof NetworkError) return "offline";
        return "signed_out";
      }
    },
    push: (deviceId, ops) =>
      wrap(async () => (await api.request("/sync/push", { method: "POST", body: { deviceId, ops }, schema: z.object({ results: z.array(SyncOpResult) }) })).results),
    pull: (assessmentId, since, limit) => {
      const q = new URLSearchParams({ assessmentId, limit: String(limit) });
      if (since) q.set("since", since);
      return wrap(() => api.get(`/sync/pull?${q.toString()}`, SyncPullResponse));
    },
    createPhoto: (meta) =>
      wrap(async () => {
        await api.request(`/assessments/${encodeURIComponent(meta.assessmentId)}/photos`, { method: "POST", body: meta });
      }),
    uploadPhoto: (photoId, bytes, contentType) =>
      wrap(() => api.request(`/photos/${encodeURIComponent(photoId)}/content`, { method: "PUT", rawBody: bytes, contentType, schema: Photo })),
  };
}
