/**
 * Cached session profile for offline start (decision D-031).
 *
 * Holds only who the user is (user id, name, email, tenant, role) and when the server last
 * confirmed it. It is not a credential: it grants no API access, and sync waits until the refresh
 * cookie yields a new in-memory access token. Tokens are never written to IndexedDB or localStorage.
 */
import { SessionInfo } from "@sentinel/shared";
import { getMeta, setMeta } from "../offline/db";

/** Matches the API's absolute session lifetime (refresh tokens stop rotating after 30 days). */
export const OFFLINE_PROFILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredProfile {
  session: SessionInfo;
  verifiedAt: number;
}

export async function saveProfile(session: SessionInfo): Promise<void> {
  const clean = SessionInfo.parse(session); // strips anything unexpected
  await setMeta("profile", { session: clean, verifiedAt: Date.now() } satisfies StoredProfile);
}

export async function loadProfile(opts: { ignoreAge?: boolean } = {}): Promise<SessionInfo | null> {
  const p = await getMeta<StoredProfile>("profile");
  if (!p) return null;
  if (!opts.ignoreAge && Date.now() - p.verifiedAt > OFFLINE_PROFILE_MAX_AGE_MS) return null;
  const parsed = SessionInfo.safeParse(p.session);
  return parsed.success ? parsed.data : null;
}
