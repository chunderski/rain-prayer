// Placeholder until the vision-ai-engineer lands the implementation.
import type { AnalyzePhotoInput, AnalyzePhotoResult, VisionClient } from "./index.js";
import { VisionError } from "./index.js";
export const PROMPT_VERSION = "0.0.0";
export async function analyzePhoto(_input: AnalyzePhotoInput, _deps: { client: VisionClient; model: string }): Promise<AnalyzePhotoResult> {
  throw new VisionError("model_error", "vision pipeline not implemented yet");
}
export function createAnthropicVisionClient(_opts: { apiKey: string; timeoutMs?: number }): VisionClient {
  throw new VisionError("model_error", "vision pipeline not implemented yet");
}
