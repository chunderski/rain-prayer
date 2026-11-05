/**
 * Sync review: conflicts (both copies side by side, keep the server copy or send mine again) and
 * changes the server refused (with its reason; discard). Reached from the header status.
 */
import { refusalMessage } from "../field/Lock";
import { useAuth, useWriteCtx } from "../auth/AuthContext";
import { useOnline } from "../offline/useOnline";
import { useLocal } from "../lib/useLocal";
import { listConflicts, listRejected } from "../sync/engine";
import { summarize, useSync } from "../sync/SyncContext";
import { Banner, Button, Card, EmptyState, PageHeader } from "../components/ui";

const ENTITY_LABEL: Record<string, string> = { area: "Area", asset: "Asset", answer: "Answer", finding: "Finding", photo_meta: "Photo tags" };
const HIDDEN = new Set(["id", "assessmentId", "siteId", "version"]);

function describe(v: unknown): [string, string][] {
  if (!v || typeof v !== "object") return [["Value", "None"]];
  return Object.entries(v as Record<string, unknown>)
    .filter(([k]) => !HIDDEN.has(k))
    .map(([k, x]) => [k, x === null || x === undefined ? "None" : typeof x === "object" ? JSON.stringify(x) : String(x)]);
}

function Copy({ title, value, other }: { title: string; value: unknown; other: unknown }) {
  const theirs = new Map(describe(other));
  return (
    <div className="min-w-0 flex-1 rounded-lg border-2 border-line p-3">
      <p className="font-bold">{title}</p>
      <dl className="mt-1 flex flex-col gap-1 text-base">
        {describe(value).map(([k, v]) => (
          <div key={k} className={theirs.get(k) !== v ? "font-bold" : ""}>
            <dt className="inline">{k}: </dt>
            <dd className="inline break-words">
              {v}
              {theirs.get(k) !== v && <span className="sr-only"> (differs)</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function SyncReview() {
  const { engine, status, syncNow } = useSync();
  const { offlineSession } = useAuth();
  const ctx = useWriteCtx();
  const online = useOnline();
  const conflicts = useLocal(listConflicts, []);
  const rejected = useLocal(() => listRejected(ctx), [ctx]);
  const summary = summarize(status, online);
  return (
    <>
      <PageHeader title="Sync" back={{ to: "/", label: "Assessments" }} />
      <div className="flex flex-col gap-4">
        <Banner tone={summary.tone} title={summary.text} live action={<Button variant="secondary" disabled={!online} onClick={syncNow}>Sync now</Button>}>
          {status.lastSyncedAt ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}.` : "Not synced yet in this session."}
          {status.nextRetryAt && status.pending > 0 ? ` Next try at ${new Date(status.nextRetryAt).toLocaleTimeString()}.` : ""}
          {offlineSession ? " Your sign in will be confirmed when you are back online." : ""}
          {status.lastError ? ` ${status.lastError}` : ""}
        </Banner>
        <section aria-labelledby="conf-h">
          <h2 id="conf-h" className="mb-2 text-2xl font-bold">
            Conflicts ({conflicts.data?.length ?? 0})
          </h2>
          {conflicts.data?.length ? (
            <ul className="flex flex-col gap-3">
              {conflicts.data.map((c) => (
                <li key={c.id}>
                  <Card>
                    <p className="font-semibold">
                      {ENTITY_LABEL[c.entity] ?? c.entity} was also changed by someone else. The server kept the newer copy; check it and choose.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <Copy title="On the server now" value={c.server} other={c.local} />
                      <Copy title="Your copy" value={c.local} other={c.server} />
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Button variant="secondary" onClick={() => void engine?.keepServer(c.id)}>
                        Keep server copy
                      </Button>
                      <Button disabled={!ctx || !c.local} onClick={() => ctx && void engine?.useMine(ctx, c.id)}>
                        Use my copy
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No conflicts" />
          )}
        </section>
        <section aria-labelledby="rej-h">
          <h2 id="rej-h" className="mb-2 text-2xl font-bold">
            Not accepted ({rejected.data?.length ?? 0})
          </h2>
          {rejected.data?.length ? (
            <ul className="flex flex-col gap-3">
              {rejected.data.map((o) => (
                <li key={o.opId}>
                  <Card>
                    <p className="font-semibold">{ENTITY_LABEL[o.op.entity] ?? o.op.entity}</p>
                    <p>
                      {refusalMessage(o.error?.code, o.error?.message)}
                    </p>
                    <Button variant="secondary" className="mt-2" onClick={() => void engine?.discardRejected(o.opId)}>
                      Discard this change
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing refused" />
          )}
        </section>
      </div>
    </>
  );
}
