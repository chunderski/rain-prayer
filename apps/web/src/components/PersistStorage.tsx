import { useEffect, useState } from "react";
import { Banner, Button } from "./ui";

/**
 * Ask the browser to keep this origin's storage (navigator.storage.persist) so offline field work
 * and photos are not evicted under storage pressure. Shown with an explanation; asked on a tap.
 */
export function PersistStorage() {
  const [state, setState] = useState<"unknown" | "ask" | "granted" | "denied" | "unsupported">("unknown");
  useEffect(() => {
    if (!navigator.storage?.persisted) {
      setState("unsupported");
      return;
    }
    navigator.storage
      .persisted()
      .then((p) => setState(p ? "granted" : "ask"))
      .catch(() => setState("unsupported"));
  }, []);
  if (state === "unknown" || state === "unsupported" || state === "granted") return null;
  if (state === "denied")
    return (
      <Banner tone="warn" title="The browser may clear offline data">
        Your browser did not agree to keep data. Sync often, and install the app to the home screen for more reliable storage.
      </Banner>
    );
  return (
    <Banner
      tone="info"
      title="Keep field work safe on this device"
      action={
        <Button variant="secondary" onClick={() => void navigator.storage.persist().then((ok) => setState(ok ? "granted" : "denied")).catch(() => setState("denied"))}>
          Keep data on this device
        </Button>
      }
    >
      Answers and photos are saved here first. Allow the browser to keep them so they are not cleared when the phone is short of space before they reach the server.
    </Banner>
  );
}
