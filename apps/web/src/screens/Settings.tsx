/** Settings, Integrations (admins): connect or disconnect Google for exports. */
import { useState } from "react";
import { SettingsNav } from "../components/SettingsNav";
import { ApiError } from "../api/client";
import { useApi, useCanAdmin } from "../auth/AuthContext";
import { disconnectGoogle, fetchGoogle, fetchGoogleConnectUrl } from "../api/phase3";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useOnline } from "../offline/useOnline";
import { Banner, Button, Card, Loading, PageHeader } from "../components/ui";

export function IntegrationsScreen() {
  const api = useApi();
  const isAdmin = useCanAdmin();
  const online = useOnline();
  const status = useAsync(() => fetchGoogle(api), [api]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("google");

  if (!isAdmin)
    return (
      <>
        <PageHeader title="Integrations" back={{ to: "/", label: "Home" }} />
        <Banner tone="info">Only workspace admins can manage integrations.</Banner>
      </>
    );

  const notConfigured = status.error instanceof ApiError && status.error.code === "google_not_configured";

  async function connect() {
    setError(null);
    let url: string;
    try {
      url = await fetchGoogleConnectUrl(api);
    } catch (e) {
      setError(errorMessage(e) || "Could not start Google sign in. Try again.");
      return;
    }
    // Google refuses to show consent inside a frame; use a new tab when embedded.
    if (window.top !== window.self) window.open(url, "_blank", "noopener");
    else window.location.assign(url);
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await disconnectGoogle(api);
      setConfirm(false);
      status.reload();
    } catch (e) {
      setError(errorMessage(e) || "Google could not be disconnected.");
    } finally {
      setBusy(false);
    }
  }

  const g = status.data;
  return (
    <>
      <PageHeader title="Integrations" subtitle="Settings" back={{ to: "/", label: "Home" }} />
      <SettingsNav />
      {result === "connected" && (
        <div className="mb-3">
          <Banner tone="ok" live>
            Google connected.
          </Banner>
        </div>
      )}
      {result === "error" && (
        <div className="mb-3">
          <Banner tone="error">Google could not be connected. Try again, and allow access when Google asks.</Banner>
        </div>
      )}
      <Card as="section">
        <h2 className="text-2xl font-bold">Google Docs, Sheets, and Drive</h2>
        <p className="mt-1 text-muted">
          Exports create files only in a "Sentinel Assess" folder. Sentinel can see only files it created (Google scope drive.file).
        </p>
        <div className="mt-3">
          {status.loading && !g && !status.error && <Loading label="Checking Google" />}
          {notConfigured ? (
            <Banner tone="warn" title="Not configured on this server">
              Google export needs Google API credentials on the server. Ask whoever runs your Sentinel Assess installation to set them up.
            </Banner>
          ) : status.error ? (
            <Banner tone="error" action={<button className="min-h-12 underline" onClick={status.reload}>Try again</button>}>
              {errorMessage(status.error)}
            </Banner>
          ) : g?.connected ? (
            <div className="flex flex-col gap-3">
              <Banner tone="ok" title="Connected">
                {g.email ? `As ${g.email}` : "Connected"}
                {g.connectedAt ? `, since ${new Date(g.connectedAt).toLocaleDateString()}` : ""}.
              </Banner>
              {confirm ? (
                <Card className="border-danger">
                  <p className="font-semibold">Disconnect Google? Exports stop until someone connects again. Files already exported stay in Drive.</p>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
                      Yes, disconnect
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirm(false)}>
                      Cancel
                    </Button>
                  </div>
                </Card>
              ) : (
                <Button variant="secondary" disabled={!online} onClick={() => setConfirm(true)}>
                  Disconnect Google
                </Button>
              )}
            </div>
          ) : g ? (
            <div className="flex flex-col gap-3">
              <p className="font-semibold">Not connected.</p>
              <Button size="lg" disabled={!online} onClick={connect}>
                Connect Google
              </Button>
            </div>
          ) : null}
          {error && (
            <div className="mt-3">
              <Banner tone="error">{error}</Banner>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
