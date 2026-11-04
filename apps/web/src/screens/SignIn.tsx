import { useState, type FormEvent } from "react";
import { LoginRequest } from "@sentinel/shared";
import { useAuth } from "../auth/AuthContext";
import { ApiError, NetworkError, TenantRequiredError } from "../api/client";
import type { TenantChoice } from "../api/schemas";
import { Banner, Button, Field, Logo, buttonClass } from "../components/ui";

const GOOGLE_ERRORS: Record<string, string> = {
  no_workspace: "No workspace found; ask your administrator for an invite.",
  google_not_configured: "Google sign in is not set up for this server yet. Use email and password.",
  no_account: "No Sentinel account uses that Google address; ask your administrator for an invite.",
  no_tenant_access: "Your account has no access to that workspace; ask your administrator.",
  email_not_verified: "Google has not verified that email address; verify it with Google, then try again.",
  google_account_mismatch: "That Google account is linked to a different Sentinel user.",
  account_mismatch: "That Google account is linked to a different Sentinel user.",
  google_denied: "Google sign in was cancelled.",
  invalid_state: "The sign in link expired; try again.",
  tenant_required: "Your Google account belongs to several workspaces; sign in with email and password to choose one.",
  invalid_request: "The sign in request was not valid; start again.",
  google_failed: "Google sign in failed; try again or use email and password.",
};

export function SignIn() {
  const { signIn, api } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [tenants, setTenants] = useState<TenantChoice[] | null>(null);
  const [tenantSlug, setTenantSlug] = useState("");
  const [busy, setBusy] = useState(false);

  const urlError = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("error");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = LoginRequest.safeParse({ email: email.trim(), password, tenantSlug: tenantSlug || undefined });
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors;
      setErrors({
        email: f.email ? "Enter a valid email address." : undefined,
        password: f.password ? "Enter your password." : undefined,
      });
      return;
    }
    if (tenants && !tenantSlug) {
      setErrors({ form: "Choose a workspace to continue." });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await signIn(parsed.data);
    } catch (err) {
      if (err instanceof TenantRequiredError) {
        setTenants(err.tenants);
        setTenantSlug("");
      } else if (err instanceof NetworkError) {
        setErrors({ form: err.message });
      } else if (err instanceof ApiError && err.status === 401) {
        setErrors({ form: "Email or password is incorrect." });
      } else {
        setErrors({ form: err instanceof Error ? err.message : "Sign in failed." });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-8">
      <div className="flex items-center gap-3">
        <Logo size={56} />
        <div>
          <h1 className="text-3xl font-bold">Sentinel Assess</h1>
          <p className="text-muted">Physical and cyber security assessments</p>
        </div>
      </div>

      {urlError && Object.hasOwn(GOOGLE_ERRORS, urlError) && <Banner tone="error">{GOOGLE_ERRORS[urlError]}</Banner>}
      {errors.form && <Banner tone="error">{errors.form}</Banner>}

      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">Sign in</h2>
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          required
        />

        {tenants && (
          <fieldset className="flex flex-col gap-2 rounded-xl border-2 border-primary bg-primary-soft p-4">
            <legend className="px-1 text-xl font-bold">Choose a workspace</legend>
            <p>Your account belongs to more than one workspace.</p>
            {tenants.map((t) => (
              <label key={t.slug} className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border-2 border-line bg-surface px-3">
                <input
                  type="radio"
                  name="tenant"
                  value={t.slug}
                  checked={tenantSlug === t.slug}
                  onChange={() => setTenantSlug(t.slug)}
                  className="size-6 accent-[var(--sa-primary)]"
                />
                <span className="font-semibold">{t.name}</span>
              </label>
            ))}
          </fieldset>
        )}

        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? "Signing in…" : tenants ? "Continue" : "Sign in"}
        </Button>
      </form>

      <div className="flex items-center gap-3 text-muted" aria-hidden="true">
        <span className="h-0.5 flex-1 bg-line" /> or <span className="h-0.5 flex-1 bg-line" />
      </div>
      <a href={api.googleStartUrl()} className={buttonClass("secondary", "lg", true) + " no-underline"}>
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path d="M12 12h7" stroke="currentColor" strokeWidth="2.5" />
        </svg>
        Sign in with Google
      </a>
    </main>
  );
}
