/**
 * <sentinel-assess> web component.
 *
 * Choice: the app renders inside an open shadow root so Tailwind's reset and utilities never
 * leak into the host page, and host styles do not restyle the app. Design tokens are declared on
 * :host in index.css. Browsers ignore @property rules inside shadow roots, so those rules are
 * copied once into document.head (they only register custom property types, nothing visual).
 *
 * The component uses an in-memory router so it never changes the host page URL, and it does not
 * register a service worker (the host origin owns that). Attributes:
 *   - initial-path: starting route, default "/" (for example "/library").
 *
 * The API base URL is fixed at build time (VITE_API_URL). The API must allow the host origin
 * (CORS with credentials); which origins may embed is a server-side allowlist decision (Phase 2).
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import css from "./index.css?inline";
import { App } from "./App";

const PROPERTY_RULES = /@property\s+[^{]+\{[^}]*\}/g;

function ensureGlobalPropertyRules() {
  if (document.head.querySelector("style[data-sentinel-assess-properties]")) return;
  const rules = css.match(PROPERTY_RULES);
  if (!rules?.length) return;
  const style = document.createElement("style");
  style.dataset.sentinelAssessProperties = "";
  style.textContent = rules.join("\n");
  document.head.append(style);
}

export class SentinelAssessElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (this.root) return;
    ensureGlobalPropertyRules();
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    const mount = document.createElement("div");
    shadow.replaceChildren(style, mount);
    this.root = createRoot(mount);
    this.root.render(
      <StrictMode>
        <App router="memory" initialPath={this.getAttribute("initial-path") ?? "/"} />
      </StrictMode>,
    );
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get("sentinel-assess")) customElements.define("sentinel-assess", SentinelAssessElement);
