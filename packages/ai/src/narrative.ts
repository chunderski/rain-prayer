// Placeholder until the vision-ai-engineer lands the implementation.
import type { DraftNarrativeInput, DraftNarrativeResult, TextClient } from "./index.js";
import { VisionError } from "./index.js";
export const NARRATIVE_PROMPT_VERSION = "0.0.0";
export async function draftNarrative(_i: DraftNarrativeInput, _d: { client: TextClient; model: string }): Promise<DraftNarrativeResult> {
  throw new VisionError("model_error", "narrative drafting not implemented yet");
}
export function createAnthropicTextClient(_o: { apiKey: string; timeoutMs?: number }): TextClient {
  throw new VisionError("model_error", "narrative drafting not implemented yet");
}
