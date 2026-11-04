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

export class VisionError extends Error {
  constructor(public code: "model_error" | "invalid_output" | "refused" | "timeout", message: string) {
    super(message);
  }
}

export { analyzePhoto, createAnthropicVisionClient, PROMPT_VERSION } from "./vision.js";
