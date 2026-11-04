import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// App shell caching for the standalone PWA (also fine inside an iframe on the app's own origin).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  registerSW({ immediate: true });
}
