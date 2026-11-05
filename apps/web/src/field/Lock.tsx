/**
 * Assessment lock (CW decision, D-057): Complete assessment with confirmation, a locked banner on
 * every field screen, admin Reopen with a reason, and a clear message when sync refuses changes
 * with `assessment_locked`.
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useApi, useCanAdmin, useCanWrite, useWriteCtx } from "../auth/AuthContext";
import { completeAssessment, reopenAssessment } from "../api/phase3";
import { errorMessage } from "../lib/useAsync";
import { useLocal } from "../lib/useLocal";
import { listRejected } from "../sync/engine";
import { useSync } from "../sync/SyncContext";
import { Banner, Button, Card, TextArea } from "../components/ui";
import { useField } from "./FieldContext";

export const LOCKED_CODE = "assessment_locked";
export const LOCKED_MESSAGE = "This assessment is complete and locked, so the change was not saved. An admin can reopen it.";

/** Plain-language text for a refused change. */
export function refusalMessage(code: string | undefined, fallback?: string): string {
  if (code === LOCKED_CODE) return LOCKED_MESSAGE;
  if (code === "forbidden") return "You are not assigned to this assessment, or your role cannot change it.";
  return fallback ?? "The server did not accept this change.";
}

export function LockedNotice() {
  const f = useField();
  if (!f.locked) return null;
  return (
    <div className="mb-4" data-testid="locked-banner">
      <Banner tone="warn" title="Assessment complete: locked">
        Answers, photos, findings, areas, and risk inputs are read only. <Link to={`/assessments/${f.assessmentId}`} className="font-semibold underline">An admin can reopen it</Link>.
      </Banner>
    </div>
  );
}

/** Changes the sync engine could not send because the assessment was locked meanwhile. */
export function LockRejections() {
  const f = useField();
  const ctx = useWriteCtx();
  const rejected = useLocal(() => listRejected(ctx), [ctx]);
  const n = rejected.data?.filter((o) => o.assessmentId === f.assessmentId && o.error?.code === LOCKED_CODE).length ?? 0;
  if (!n) return null;
  return (
    <div className="mb-4">
      <Banner tone="error" title={`${n} ${n === 1 ? "change was" : "changes were"} not saved: the assessment is locked`} action={<Link to="/sync" className="inline-flex min-h-12 items-center font-semibold underline">Review</Link>}>
        This assessment was completed before these changes reached the server. Ask an admin to reopen it, then send them again, or discard them.
      </Banner>
    </div>
  );
}

/** Detail page: Complete (with confirmation) when open; locked status and admin Reopen when complete. */
export function LockPanel() {
  const f = useField();
  const api = useApi();
  const canWrite = useCanWrite();
  const isAdmin = useCanAdmin();
  const { status } = useSync();
  const [mode, setMode] = useState<"idle" | "confirm" | "reopen">("idle");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode("idle");
      setReason("");
      setDone(okText);
      f.reload();
    } catch (e) {
      setError(errorMessage(e) || "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function submitReopen(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return setReasonError("Give a reason for reopening; it is recorded in the audit log.");
    setReasonError(undefined);
    void run(() => reopenAssessment(api, f.assessmentId, reason.trim()), "Assessment reopened. Field data can be changed again.");
  }

  return (
    <section aria-labelledby="lock-h" className="mb-4">
      <h2 id="lock-h" className="sr-only">
        Assessment lock
      </h2>
      {done && (
        <div className="mb-2">
          <Banner tone="ok" live>
            {done}
          </Banner>
        </div>
      )}
      {error && (
        <div className="mb-2">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {f.locked ? (
        <div data-testid="locked-banner">
          <Banner
            tone="warn"
            title="Assessment complete: locked"
            action={isAdmin && mode !== "reopen" ? <Button variant="secondary" onClick={() => setMode("reopen")}>Reopen</Button> : undefined}
          >
            Field data is read only. Risk scores and the report use the numbers frozen at completion.
          </Banner>
          {mode === "reopen" && (
            <Card className="mt-2">
              <form onSubmit={submitReopen} className="flex flex-col gap-3" noValidate>
                <TextArea label="Reason for reopening" value={reason} onChange={(e) => setReason(e.target.value)} error={reasonError} hint="Recorded in the audit log." maxLength={500} />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button type="submit" disabled={busy}>
                    Reopen assessment
                  </Button>
                  <Button variant="secondary" onClick={() => setMode("idle")}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>
      ) : canWrite && mode === "confirm" ? (
        <Card className="border-warn">
          <p className="text-xl font-bold">Complete this assessment?</p>
          <p className="mt-1">
            Completing locks answers, photos, findings, areas, and risk inputs, and freezes the risk scores for the report. Only an admin can reopen it.
          </p>
          {status.pending > 0 && (
            <p className="mt-2 font-semibold text-warn">
              {status.pending} {status.pending === 1 ? "change is" : "changes are"} still waiting to send. Sync first, or they will be refused once the assessment is locked.
            </p>
          )}
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button disabled={busy || !f.online} onClick={() => void run(() => completeAssessment(api, f.assessmentId, f.assessment.status), "Assessment completed and locked.")}>
              Yes, complete and lock
            </Button>
            <Button variant="secondary" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
          {!f.online && <p className="mt-2 text-muted">Completing needs a connection.</p>}
        </Card>
      ) : canWrite ? (
        <Button variant="secondary" size="lg" block onClick={() => setMode("confirm")}>
          Complete assessment
        </Button>
      ) : null}
    </section>
  );
}
