/**
 * Framework library reads with an IndexedDB fallback: network first, cache on success, serve the
 * cached copy when the network is unavailable. Only reference data is cached here.
 */
import { z } from "zod";
import type { ApiClient } from "./client";
import { NetworkError } from "./client";
import { ControlDetail, ControlSummary, FrameworkSummary } from "./schemas";
import { getLibrary, putLibrary } from "../offline/db";

export interface Cached<T> {
  data: T;
  fromCache: boolean;
  cachedAt?: string;
}

export async function cachedGet<S extends z.ZodTypeAny>(api: ApiClient, path: string, schema: S): Promise<Cached<z.infer<S>>> {
  try {
    const data = await api.get(path, schema);
    putLibrary(path, data).catch(() => undefined);
    return { data, fromCache: false };
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    const hit = await getLibrary(path).catch(() => undefined);
    if (!hit) throw err;
    const parsed = schema.safeParse(hit.data);
    if (!parsed.success) throw err;
    return { data: parsed.data, fromCache: true, cachedAt: hit.cachedAt };
  }
}

export function controlsPath(filter: { framework?: string; domain?: string; q?: string } = {}): string {
  const params = new URLSearchParams();
  if (filter.framework) params.set("framework", filter.framework);
  if (filter.domain) params.set("domain", filter.domain);
  if (filter.q?.trim()) params.set("q", filter.q.trim());
  const qs = params.toString();
  return qs ? `/controls?${qs}` : "/controls";
}

export const fetchFrameworks = (api: ApiClient) => cachedGet(api, "/frameworks", z.array(FrameworkSummary));

export type ControlFilter = { framework?: string; domain?: string; q?: string };

/** Local filter used offline when the exact query was never cached but the full list was. */
export function filterControls(list: ControlSummary[], filter: ControlFilter): ControlSummary[] {
  const q = filter.q?.trim().toLowerCase();
  return list.filter(
    (c) =>
      (!filter.framework || c.mappings.some((m) => m.frameworkId === filter.framework)) &&
      (!filter.domain || c.domain === filter.domain) &&
      (!q || `${c.id} ${c.title} ${c.objective}`.toLowerCase().includes(q)),
  );
}

export async function fetchControls(api: ApiClient, filter: ControlFilter = {}): Promise<Cached<ControlSummary[]>> {
  const schema = z.array(ControlSummary);
  try {
    return await cachedGet(api, controlsPath(filter), schema);
  } catch (err) {
    if (!(err instanceof NetworkError) || controlsPath(filter) === "/controls") throw err;
    const all = await cachedGet(api, "/controls", schema);
    return { ...all, data: filterControls(all.data, filter) };
  }
}

export const fetchControl = (api: ApiClient, id: string) =>
  cachedGet(api, `/controls/${encodeURIComponent(id)}`, ControlDetail);
