import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";
import { hasPin, PIN_MAX_ATTEMPTS, setPin, validatePin, verifyPin, wrongAttempts } from "./pin";
import { Banner, Button, Card, Field, Logo } from "../components/ui";

export const WIPED_NOTICE = "Too many wrong PIN attempts. Work saved on this device was deleted. Sign in to continue.";
export const FORGOT_NOTICE = "You signed out and work saved on this device was deleted. Sign in to continue.";

/** Full-screen lock. Nothing from the cached workspace renders behind it. */
export function PinLock() {
  const { session, unlock, signOut } = useAuth();
  const [pin, setPinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmForgot, setConfirmForgot] = useState(false);
  const [remaining, setRemaining] = useState(PIN_MAX_ATTEMPTS);

  useEffect(() => {
    wrongAttempts().then((n) => setRemaining(PIN_MAX_ATTEMPTS - n), () => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const invalid = validatePin(pin);
    if (invalid) return setError(invalid);
    setBusy(true);
    const r = await verifyPin(pin).catch(() => ({ kind: "wrong" as const, remaining }));
    setBusy(false);
    setPinValue("");
    if (r.kind === "ok") return unlock();
    if (r.kind === "wiped" || r.kind === "no_pin") return void signOut(WIPED_NOTICE);
    setRemaining(r.remaining);
    setError(`Wrong PIN. ${r.remaining} ${r.remaining === 1 ? "attempt" : "attempts"} left before work on this device is deleted.`);
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 py-8">
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <h1 className="text-3xl font-bold">Enter your PIN</h1>
      </div>
      <p>
        Work for {session?.user.name ?? "you"} is locked on this device. Enter the PIN you set to continue.
      </p>
      {remaining < PIN_MAX_ATTEMPTS && !error && (
        <Banner tone="warn">
          {remaining} {remaining === 1 ? "attempt" : "attempts"} left. After {PIN_MAX_ATTEMPTS} wrong attempts, work saved on this device is deleted.
        </Banner>
      )}
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field
          label="PIN"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
          error={error ?? undefined}
          hint={`4 to 8 digits. ${PIN_MAX_ATTEMPTS} wrong attempts delete work saved on this device.`}
          autoFocus
        />
        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? "Checking" : "Unlock"}
        </Button>
      </form>
      {confirmForgot ? (
        <Card className="border-danger">
          <p className="font-semibold">Forgot your PIN? Signing out deletes all work saved on this device that has not been sent, then you sign in again.</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button variant="danger" onClick={() => void signOut(FORGOT_NOTICE)}>
              Sign out and delete
            </Button>
            <Button variant="secondary" onClick={() => setConfirmForgot(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : (
        <Button variant="ghost" onClick={() => setConfirmForgot(true)}>
          Forgot PIN
        </Button>
      )}
    </main>
  );
}

/** Shown after sign in until a PIN exists on this device. Collapsed to one line until opened. */
export function PinSetupPrompt() {
  const { offlineSession } = useAuth();
  const [state, setState] = useState<"hidden" | "prompt" | "form" | "done">("hidden");
  const [pin, setPinValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ pin?: string; confirm?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (offlineSession) return;
    hasPin().then((p) => !p && setState("prompt"), () => undefined);
  }, [offlineSession]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const pinErr = validatePin(pin);
    const confErr = !pinErr && pin !== confirm ? "The PINs do not match." : undefined;
    setErrors({ pin: pinErr ?? undefined, confirm: confErr });
    if (pinErr || confErr) return;
    setBusy(true);
    try {
      await setPin(pin);
      setState("done");
    } catch {
      setErrors({ pin: "The PIN could not be saved on this device." });
    } finally {
      setBusy(false);
    }
  }

  if (state === "hidden") return null;
  if (state === "done")
    return (
      <div className="px-4 pt-3">
        <Banner tone="ok" live title="PIN set">
          Your PIN is needed to open saved work offline and after 5 minutes away.
        </Banner>
      </div>
    );
  return (
    <div className="px-4 pt-3">
      <section aria-labelledby="pin-setup-h" className="mx-auto max-w-5xl rounded-lg border-2 border-primary bg-primary-soft p-4">
        <h2 id="pin-setup-h" className="text-xl font-bold">
          Set a PIN for offline work
        </h2>
        <p className="mt-1">Without a PIN, work saved on this device cannot be opened offline.</p>
        {state === "prompt" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => setState("form")}>Set PIN</Button>
            <Button variant="secondary" onClick={() => setState("hidden")}>
              Not now
            </Button>
          </div>
        ) : (
          <form onSubmit={save} className="mt-3 grid gap-3 sm:grid-cols-2" noValidate>
            <Field label="New PIN" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))} error={errors.pin} hint="4 to 8 digits" />
            <Field label="Confirm PIN" type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))} error={errors.confirm} />
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" disabled={busy}>
                Save PIN
              </Button>
              <Button variant="secondary" onClick={() => setState("hidden")}>
                Not now
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
