/**
 * Photo to structured suggestion pipeline.
 *
 * 1. Build the prompt (frozen system prompt plus a user turn with candidate controls and
 *    delimited, escaped untrusted context).
 * 2. Ask the model for JSON constrained by a JSON schema (structured outputs).
 * 3. Parse and validate the shape with zod; on failure retry once with a summary of the
 *    validation errors, then throw VisionError("invalid_output").
 * 4. Normalize: drop unknown control IDs (with a caution), clamp confidences, cap lists,
 *    drop draft findings for non security relevant photos, and validate against the
 *    shared VisionOutput contract.
 *
 * The result is always a suggestion; storing it with status `suggested` and any human
 * review is the API's job.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AssetType, Severity, VisionOutput } from "@sentinel/shared";
import type { AnalyzePhotoInput, AnalyzePhotoResult, VisionClient } from "./index.js";
import { VisionError } from "./index.js";
import { PROMPT_VERSION, SYSTEM_PROMPT, VISION_OUTPUT_JSON_SCHEMA, buildUserText } from "./prompts/photo-analysis.v1.js";

export { PROMPT_VERSION };

export const DEFAULT_MAX_TOKENS = 16_000;
/** Claude accepts images up to 5 MB base64 encoded; this is the matching raw byte limit. */
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

const LIMITS = { deficiencies: 10, controls: 15, draftFindings: 5, cautions: 10, controlIdsPerItem: 10 } as const;

// ---------- lenient shape check (structure and types), before normalization ----------

const RawConfidence = z.number().finite();
const RawVisionOutput = z.object({
  imageQuality: VisionOutput.shape.imageQuality,
  assetType: z.object({ value: AssetType, confidence: RawConfidence }),
  condition: z.object({ rating: z.enum(["good", "fair", "poor", "unknown"]), summary: z.string(), confidence: RawConfidence }),
  deficiencies: z.array(z.object({ description: z.string(), severity: Severity, confidence: RawConfidence, controlIds: z.array(z.string()) })),
  controls: z.array(z.object({ id: z.string(), confidence: RawConfidence, rationale: z.string() })),
  draftFindings: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      recommendation: z.string(),
      severity: Severity,
      controlIds: z.array(z.string()),
      confidence: RawConfidence,
    }),
  ),
  cautions: z.array(z.string()).default([]),
});
type RawVisionOutput = z.infer<typeof RawVisionOutput>;

export interface AnalyzePhotoDeps {
  client: VisionClient;
  /** Model ID from configuration (for example ANTHROPIC_VISION_MODEL). Never hard-coded here. */
  model: string;
  maxTokens?: number;
}

export async function analyzePhoto(input: AnalyzePhotoInput, deps: AnalyzePhotoDeps): Promise<AnalyzePhotoResult> {
  if (!deps.model || !deps.model.trim()) throw new VisionError("model_error", "no model configured");
  if (input.mediaType !== "image/jpeg") throw new VisionError("model_error", "only image/jpeg is supported");
  if (!input.image || input.image.byteLength === 0) throw new VisionError("model_error", "empty image");
  if (input.image.byteLength > MAX_IMAGE_BYTES) throw new VisionError("model_error", "image too large for the model");

  const { candidateControls, assetTypeHint, areaName, assessorNotes } = input.context;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let sawUsage = false;
  let retryFeedback: string | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // GPS is never part of the input contract; notes are present only when the tenant allows it.
    const userText = buildUserText({ candidateControls, assetTypeHint, areaName, assessorNotes, retryFeedback });
    let res: Awaited<ReturnType<VisionClient["analyze"]>>;
    try {
      res = await deps.client.analyze({
        model: deps.model,
        system: SYSTEM_PROMPT,
        userText,
        image: input.image,
        mediaType: "image/jpeg",
        maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
    } catch (err) {
      if (err instanceof VisionError) throw err;
      throw new VisionError("model_error", `vision client failed: ${err instanceof Error ? err.name : "unknown error"}`);
    }
    if (res.usage) {
      sawUsage = true;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
    }

    const parsed = parseModelText(res.text);
    if (parsed.ok) {
      const output = normalize(parsed.value, candidateControls.map((c) => c.id));
      return { output, model: deps.model, promptVersion: PROMPT_VERSION, ...(sawUsage ? { usage } : {}) };
    }
    retryFeedback = parsed.error;
  }
  throw new VisionError("invalid_output", `model output failed validation after retry: ${retryFeedback ?? "unknown"}`);
}

/** Parse the model text as JSON and check its shape. Errors are summarized without echoing model content. */
export function parseModelText(text: string): { ok: true; value: RawVisionOutput } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch {
    return { ok: false, error: "the response was not valid JSON" };
  }
  const result = RawVisionOutput.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  const more = result.error.issues.length > 5 ? ` and ${result.error.issues.length - 5} more` : "";
  return { ok: false, error: `${issues.join("; ")}${more}`.slice(0, 800) };
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m?.[1] ?? t;
}

const clamp01 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Apply contract limits and the control allow list, then validate against VisionOutput. */
export function normalize(raw: RawVisionOutput, allowedControlIds: readonly string[]): VisionOutput {
  const allowed = new Set(allowedControlIds);
  const dropped = new Set<string>();
  const pipelineCautions: string[] = [];

  const filterIds = (ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) {
      if (!allowed.has(id)) dropped.add(id);
      else if (!out.includes(id)) out.push(id);
    }
    return out.slice(0, LIMITS.controlIdsPerItem);
  };

  const notRelevant = raw.imageQuality === "not_security_relevant";

  const deficiencies = raw.deficiencies
    .filter((d) => d.description.trim().length >= 3)
    .map((d) => ({ description: cut(d.description.trim(), 1000), severity: d.severity, confidence: clamp01(d.confidence), controlIds: filterIds(d.controlIds) }));

  const seenControls = new Set<string>();
  const controls = raw.controls
    .filter((c) => {
      if (!allowed.has(c.id)) {
        dropped.add(c.id);
        return false;
      }
      if (seenControls.has(c.id)) return false;
      seenControls.add(c.id);
      return true;
    })
    .map((c) => ({ id: c.id, confidence: clamp01(c.confidence), rationale: cut(c.rationale, 500) }));

  let removedFindings = 0;
  const draftFindings = notRelevant
    ? []
    : raw.draftFindings
        .map((f) => ({
          title: cut(f.title.trim(), 200),
          description: cut(f.description, 4000),
          recommendation: cut(f.recommendation, 4000),
          severity: f.severity,
          controlIds: filterIds(f.controlIds),
          confidence: clamp01(f.confidence),
        }))
        .filter((f) => {
          const keep = f.title.length >= 3 && f.controlIds.length > 0;
          if (!keep) removedFindings++;
          return keep;
        });

  if (dropped.size > 0) {
    const list = [...dropped].slice(0, 5).map((id) => cut(id.replace(/[^\w-]/g, ""), 20)).join(", ");
    pipelineCautions.push(`Removed ${dropped.size} control ID(s) not in the candidate list (${list}). Check the control mapping manually.`);
  }
  if (removedFindings > 0) {
    pipelineCautions.push(`Removed ${removedFindings} draft finding(s) with no valid candidate control or no title.`);
  }
  if (notRelevant && raw.draftFindings.length > 0) {
    pipelineCautions.push("The photo was rated not security relevant, so no draft findings are suggested.");
  }
  if (raw.deficiencies.length > LIMITS.deficiencies || raw.controls.length > LIMITS.controls || raw.draftFindings.length > LIMITS.draftFindings) {
    pipelineCautions.push("The model returned more items than allowed; extra items were removed.");
  }

  const modelCautions = raw.cautions.map((c) => c.trim()).filter(Boolean);
  const cautions = [...pipelineCautions, ...modelCautions].slice(0, LIMITS.cautions).map((c) => cut(c, 500));

  const candidate = {
    imageQuality: raw.imageQuality,
    assetType: { value: raw.assetType.value, confidence: clamp01(raw.assetType.confidence) },
    condition: { rating: raw.condition.rating, summary: cut(raw.condition.summary, 1000), confidence: clamp01(raw.condition.confidence) },
    deficiencies: deficiencies.slice(0, LIMITS.deficiencies),
    controls: controls.slice(0, LIMITS.controls),
    draftFindings: draftFindings.slice(0, LIMITS.draftFindings),
    cautions,
  };
  const final = VisionOutput.safeParse(candidate);
  if (!final.success) throw new VisionError("invalid_output", "normalized output does not match the VisionOutput contract");
  return final.data;
}

// ---------- Anthropic transport ----------

export interface AnthropicVisionClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** SDK retries for 408, 409, 429, 5xx, and connection errors. */
  maxRetries?: number;
  /** Thinking effort; lower is cheaper. Defaults to "medium". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** For tests or proxies. */
  baseURL?: string;
}

export function createAnthropicVisionClient(opts: AnthropicVisionClientOptions): VisionClient {
  if (!opts.apiKey) throw new VisionError("model_error", "missing Anthropic API key");
  const anthropic = new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  return {
    async analyze(req) {
      if (req.image.byteLength > MAX_IMAGE_BYTES) throw new VisionError("model_error", "image too large for the model");
      let message: Anthropic.Message;
      try {
        message = await anthropic.messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          // Frozen system prompt, cached across photos.
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: req.mediaType, data: Buffer.from(req.image).toString("base64") } },
                { type: "text", text: req.userText },
              ],
            },
          ],
          // Structured outputs: the response text is constrained to this schema.
          // (Forced tool_choice is rejected by current models, so it is not used.)
          output_config: { format: { type: "json_schema", schema: VISION_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown> }, effort: opts.effort ?? "medium" },
        });
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new VisionError("timeout", "Anthropic request timed out");
        if (err instanceof Anthropic.APIError) throw new VisionError("model_error", `Anthropic API error${err.status ? ` ${err.status}` : ""}`);
        throw new VisionError("model_error", "Anthropic request failed");
      }

      if (message.stop_reason === "refusal") {
        throw new VisionError("refused", `model declined to analyze the photo${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`);
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      // A max_tokens stop leaves truncated JSON; the pipeline treats that as invalid output and retries once.
      return { text, usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens } };
    },
  };
}
