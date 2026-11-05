/**
 * @sentinel/ai public interface (contract). The vision-ai-engineer owns the implementation.
 * apps/api depends only on what is exported here.
 */
import type { AssetType, VisionOutput } from "@sentinel/shared";

export interface CandidateControl {
  id: string;
  title: string;
  objective: string;
  assetTypes: AssetType[];
}

export interface AnalyzePhotoInput {
  /** Stored, metadata-stripped JPEG bytes. */
  image: Uint8Array;
  mediaType: "image/jpeg";
  context: {
    /** Shared controls the model may reference; output IDs outside this list are dropped. */
    candidateControls: CandidateControl[];
    assetTypeHint?: AssetType | null;
    areaName?: string | null;
    /** Only passed when the tenant allows sharing context (aiShareContext). Untrusted text. */
    assessorNotes?: string | null;
  };
}

export interface AnalyzePhotoResult {
  output: VisionOutput;
  model: string;
  promptVersion: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Minimal transport so tests can run without a network or API key. */
export interface VisionClient {
  analyze(req: { model: string; system: string; userText: string; image: Uint8Array; mediaType: "image/jpeg"; maxTokens: number }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>;
}

export { VisionError } from "./errors.js";

export { analyzePhoto, createAnthropicVisionClient, PROMPT_VERSION } from "./vision.js";
export type { AnalyzePhotoDeps, AnthropicVisionClientOptions } from "./vision.js";
export { DEFAULT_MAX_TOKENS, MAX_IMAGE_BYTES } from "./vision.js";

// ---------- Phase 3: report narrative drafting (contract; implementation in narrative.ts) ----------

export interface DraftNarrativeInput {
  section: "executive_summary" | "methodology" | "key_findings" | "recommendations";
  /** Facts only: the model may not introduce findings, numbers, or names that are not here. */
  facts: {
    clientName: string;
    siteName: string;
    assessmentTitle: string;
    frameworks: { shortName: string; version: string }[];
    risk: import("@sentinel/shared").RiskResult;
    /** Confirmed findings only (title, severity, controls, frameworks); AI drafts never feed AI drafts. */
    findings: { title: string; severity: string; description: string; recommendation?: string; frameworks: string[] }[];
  };
  /** Integrator tone and length guidance; untrusted text, escaped. */
  styleNotes?: string | null;
}

export interface DraftNarrativeResult {
  text: string;
  model: string;
  promptVersion: string;
}

export interface TextClient {
  complete(req: { model: string; system: string; userText: string; maxTokens: number }): Promise<{ text: string }>;
}

export { draftNarrative, createAnthropicTextClient, NARRATIVE_PROMPT_VERSION } from "./narrative.js";
export { NarrativeError, checkGrounding, cleanNarrative } from "./narrative.js";
export type { DraftNarrativeDeps, AnthropicTextClientOptions, NarrativeErrorReason } from "./narrative.js";
