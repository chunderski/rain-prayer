/**
 * Settings > Members (admins): list, invite with a one-time setup link (D-082: the app sends no
 * email, the admin shares the link), change role, disable or enable. Client viewer invites must
 * name the client. Also the public /setup page where an invited person sets a password.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { CompleteSetup, CreateMember, type Member } from "@sentinel/shared";
import { ApiError } from "../api/client";
import { ClientSummary } from "../api/schemas";
import { createMember, fetchMembers, patchMember, ROLE_LABEL } from "../api/phase4";
import { useApi, useAuth, useCanAdmin, useIsOwner } from "../auth/AuthContext";
import { errorMessage, useAsync } from "../lib/useAsync";
import { SettingsNav } from "../components/SettingsNav";
import { Banner, Button, Card, Chip, Field, Loading, Logo, PageHeader, SelectField } from "../components/ui";

const STATUS_CHIP: Record<Member["status"], { tone: "ok" | "warn" | "neutral"; text: string }> = {
  active: { tone: "ok", text: "Active" },
  invited: { tone: "warn", text: "Invited: setup not finished" },
  disabled: { tone: "neutral", text: "Disabled" },
};

const ERROR_TEXT: Record<string, string> = {
  last_owner: "The workspace needs at least one active owner. Make someone else an owner first.",
  forbidden: "Only owners can create or change owners and admins.",
  member_exists: "This person is already a member of the workspace.",
  invite_pending: "This person has not finished setup yet. Create a new invite to send a fresh link.",
  unknown_client: "That client no longer exists. Refresh and choose again.",
};

function InviteLink({ url, expiresAt, onDone }: { url: string; expiresAt: string; onDone: () => void }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }
  return (
    <Card as="section" className="border-primary" >
      <h2 className="text-2xl font-bold">Setup link</h2>
      <Banner tone="warn" title="Share this securely">
        Anyone with this link can set the password for this account. Send it directly to the person (for example in a direct message or by phone), not in a shared channel. It works once and expires {new Date(expiresAt).toLocaleString()}. It is shown only now.
      </Banner>
      <div className="mt-3">
        <Field label="One-time setup link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} data-testid="setup-link" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void copy()}>Copy link</Button>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
      <p role="status" className="mt-2 font-semibold">
        {copied === "yes" ? "Link copied." : copied === "no" ? "Copy is blocked here: select the link and copy it by hand." : ""}
      </p>
    </Card>
  );
}

function InviteForm({ clients, onInvited }: { clients: { id: string; name: string }[]; onInvited: (r: { url: string; expiresAt: string }) => void }) {
  const api = useApi();
  const owner = useIsOwner();
  const [form, setForm] = useState({ email: "", name: "", role: "assessor", clientId: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roles = owner ? ["owner", "admin", "assessor", "viewer", "client_viewer"] : ["assessor", "viewer", "client_viewer"];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const parsed = CreateMember.safeParse({ email: form.email.trim(), name: form.name, role: form.role, clientId: form.role === "client_viewer" ? form.clientId || null : null });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        const k = String(i.path[0]);
        errs[k] ??= k === "email" ? "Enter a valid email." : k === "name" ? "Enter a name." : k === "clientId" ? "Choose the client this person may see." : "Check this field.";
      }
      return setErrors(errs);
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await createMember(api, parsed.data);
      setForm({ email: "", name: "", role: "assessor", clientId: "" });
      onInvited({ url: r.setupUrl, expiresAt: r.expiresAt });
    } catch (err) {
      setMsg(err instanceof ApiError ? (ERROR_TEXT[err.code] ?? err.message) : errorMessage(err) || "The invite could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="section">
      <h2 className="text-2xl font-bold">Invite someone</h2>
      <form onSubmit={submit} noValidate className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Email" type="email" autoComplete="off" value={form.email} maxLength={254} error={errors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Field label="Name" autoComplete="off" value={form.name} maxLength={120} error={errors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <SelectField label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} hint="Client viewers see only their own client's completed reports and quotes.">
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </SelectField>
        {form.role === "client_viewer" && (
          <SelectField label="Client" value={form.clientId} error={errors.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
            <option value="">Choose a client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        )}
        {msg && (
          <div className="sm:col-span-2">
            <Banner tone="error">{msg}</Banner>
          </div>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" size="lg" block disabled={busy}>
            {busy ? "Creating invite" : "Create invite"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MemberRow({ m, onChanged }: { m: Member; onChanged: (m: Member) => void }) {
  const api = useApi();
  const owner = useIsOwner();
  const { session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const privileged = m.role === "owner" || m.role === "admin";
  const canEdit = owner || !privileged;
  const roles = (owner ? ["owner", "admin", "assessor", "viewer"] : ["assessor", "viewer"]).concat(m.role === "client_viewer" ? ["client_viewer"] : []);

  async function patch(body: Parameters<typeof patchMember>[2]) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await patchMember(api, m.userId, body));
    } catch (err) {
      setError(err instanceof ApiError ? (ERROR_TEXT[err.code] ?? err.message) : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const chip = STATUS_CHIP[m.status];
  return (
    <li className="rounded-xl border-2 border-line bg-surface p-4" data-testid={`member-${m.email}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xl font-bold">
            {m.name}
            {m.userId === session?.user.id && <span className="font-normal text-muted"> (you)</span>}
          </p>
          <p className="break-all text-muted">{m.email}</p>
          {m.clientName && <p>Client: {m.clientName}</p>}
        </div>
        <Chip tone={chip.tone}>{chip.text}</Chip>
      </div>
      {canEdit ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <SelectField label={`Role for ${m.name}`} value={m.role} disabled={busy || m.role === "client_viewer"} onChange={(e) => void patch({ role: e.target.value })}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </SelectField>
          {m.status === "disabled" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void patch({ status: "active" })}>
              Enable
            </Button>
          ) : (
            <Button variant="danger" disabled={busy} onClick={() => void patch({ status: "disabled" })}>
              Disable
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-2">Role: {ROLE_LABEL[m.role]}. Only owners can change owners and admins.</p>
      )}
      {error && (
        <p role="alert" className="mt-2 font-semibold text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export function MembersScreen() {
  const api = useApi();
  const isAdmin = useCanAdmin();
  const members = useAsync(() => (isAdmin ? fetchMembers(api) : Promise.resolve([])), [api, isAdmin]);
  const clients = useAsync(() => (isAdmin ? api.get("/clients", z.array(ClientSummary)) : Promise.resolve([])), [api, isAdmin]);
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Member>>({});

  if (!isAdmin)
    return (
      <>
        <PageHeader title="Members" back={{ to: "/", label: "Home" }} />
        <Banner tone="info">Only workspace admins can manage members.</Banner>
      </>
    );

  const list = (members.data ?? []).map((m) => overrides[m.userId] ?? m);
  return (
    <>
      <PageHeader title="Members" subtitle="Settings" back={{ to: "/", label: "Home" }} />
      <SettingsNav />
      <div className="flex flex-col gap-4">
        {invite ? (
          <InviteLink url={invite.url} expiresAt={invite.expiresAt} onDone={() => setInvite(null)} />
        ) : (
          <InviteForm
            clients={clients.data ?? []}
            onInvited={(r) => {
              setInvite(r);
              setOverrides({});
              members.reload();
            }}
          />
        )}
        <section aria-labelledby="members-h">
          <h2 id="members-h" className="mb-2 text-2xl font-bold">
            Workspace members
          </h2>
          {members.loading && !members.data && <Loading label="Loading members" />}
          {members.error ? <Banner tone="error">{errorMessage(members.error)}</Banner> : null}
          <ul className="flex flex-col gap-3">
            {list.map((m) => (
              <MemberRow key={m.userId} m={m} onChanged={(next) => setOverrides((o) => ({ ...o, [next.userId]: next }))} />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

/** Reads the one-time token from the link fragment (#token=, never sent to servers) or, as a fallback, the query. */
export function setupTokenFrom(hash: string, search: string): string {
  const fromHash = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return fromHash ?? new URLSearchParams(search).get("token") ?? "";
}

/**
 * Public page from a setup link. New people choose a password; someone who already has a Sentinel
 * Assess account enters its current password to join this workspace (the API never replaces it).
 */
export function SetupScreen() {
  const { completeSetup } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Keep the token in memory and take it out of the address bar (history, screenshots, shoulder surfing).
  const [token, setToken] = useState(() => setupTokenFrom(location.hash, location.search));
  useEffect(() => {
    // Also covers opening a second link while this page is open (only the fragment changes).
    const next = setupTokenFrom(location.hash, location.search);
    if (next && next !== token) {
      setToken(next);
      setMode("new");
      setMsg(null);
      setPassword("");
      setConfirm("");
    }
    if (location.hash || location.search) navigate("/setup", { replace: true });
  }, [location.hash, location.search]); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const pwErr = mode === "existing" ? (password ? undefined : "Enter your current password.") : password.length < 12 ? "Use at least 12 characters." : password.length > 256 ? "Use at most 256 characters." : undefined;
    const confErr = mode === "new" && !pwErr && password !== confirm ? "The passwords do not match." : undefined;
    setErrors({ password: pwErr, confirm: confErr });
    if (pwErr || confErr) return;
    if (!CompleteSetup.shape.token.safeParse(token).success) return setMsg("This setup link is not valid. Ask your admin for a new one.");
    setBusy(true);
    try {
      await completeSetup(token, password);
      navigate("/", { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (code === "invalid_credentials") {
        setMode("existing");
        setPassword("");
        setConfirm("");
        setMsg(mode === "existing" ? "That is not the current password for this account. Try again." : "This email already has a Sentinel Assess account. Enter its current password to join this workspace.");
      } else if (code === "existing_account") {
        setMsg("This email already has an account that signs in another way, such as Google. Sign in with it, then ask your admin to add you again.");
      } else if (code === "invalid_setup_token" || (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 410))) {
        setMsg("This setup link has expired or was already used. Ask your admin for a new one.");
      } else if (err instanceof ApiError && err.status === 429) {
        setMsg("Too many attempts. Wait a minute and try again.");
      } else if (code === "validation_failed" && mode === "existing") {
        setMsg("That is not the current password for this account.");
      } else {
        setMsg(errorMessage(err) || "The password could not be set.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 py-8">
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <h1 className="text-3xl font-bold">{mode === "new" ? "Set your password" : "Join with your account"}</h1>
      </div>
      {!token ? (
        <Banner tone="error">This page needs the setup link your admin shared. Open the full link, or ask for a new one.</Banner>
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="font-semibold">Do you already have a Sentinel Assess account with this email?</legend>
            <label className="flex min-h-12 items-center gap-3">
              <input type="radio" name="setup-mode" className="size-6" checked={mode === "new"} onChange={() => (setMode("new"), setMsg(null))} />
              No, I am new: choose a password
            </label>
            <label className="flex min-h-12 items-center gap-3">
              <input type="radio" name="setup-mode" className="size-6" checked={mode === "existing"} onChange={() => (setMode("existing"), setMsg(null))} />
              Yes: use my current password
            </label>
          </fieldset>
          {mode === "new" ? (
            <>
              <Field label="New password" type="password" autoComplete="new-password" value={password} maxLength={256} error={errors.password} hint="At least 12 characters. A short sentence is easy to remember." onChange={(e) => setPassword(e.target.value)} />
              <Field label="Confirm password" type="password" autoComplete="new-password" value={confirm} maxLength={256} error={errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
            </>
          ) : (
            <Field label="Current password" type="password" autoComplete="current-password" value={password} maxLength={256} error={errors.password} hint="Your existing password stays the same; this only adds you to the workspace." onChange={(e) => setPassword(e.target.value)} />
          )}
          {msg && <Banner tone="error">{msg}</Banner>}
          <Button type="submit" size="lg" block disabled={busy}>
            {busy ? "Saving" : mode === "new" ? "Set password and continue" : "Join and continue"}
          </Button>
        </form>
      )}
    </main>
  );
}
