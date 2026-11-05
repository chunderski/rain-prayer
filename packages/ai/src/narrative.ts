/**
 * Report narrative drafting: one section per call, grounded in structured facts.
 *
 * 1. Build the prompt (frozen system prompt plus a user turn with escaped, delimited facts,
 *    confirmed findings, and optional style notes).
 * 2. Ask the model for plain text.
 * 3. Clean up: replace em and en dashes, strip markdown headings and emphasis, normalize
 *    bullets, trim to the section word limit at a sentence boundary.
 * 4. Grounding check: reject drafts naming a framework that is not in the facts, or stating
 *    an overall risk level other than the computed one. Retry once with feedback, then throw
 *    NarrativeError (code "invalid_output", reason set).
 *
 * The result is always a draft; the API stores it as `ai_draft` and only approved or edited
 * text reaches an export.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DraftNarrativeInput, DraftNarrativeResult, TextClient } from "./index.js";
import { VisionError } from "./errors.js";
import { NARRATIVE_PROMPT_VERSION, NARRATIVE_SYSTEM_PROMPT, SECTION_LIMITS, buildNarrativeUserText } from "./prompts/narrative.v1.js";

export { NARRATIVE_PROMPT_VERSION };

export type NarrativeErrorReason = "ungrounded_framework" | "inconsistent_risk_level" | "empty_output";

/** A draft that failed the grounding checks twice. `code` is always "invalid_output". */
export class NarrativeError extends VisionError {
  constructor(
    public reason: NarrativeErrorReason,
    message: string,
  ) {
    super("invalid_output", message);
  }
}

export interface DraftNarrativeDeps {
  client: TextClient;
  /** Model ID from configuration (for example ANTHROPIC_TEXT_MODEL). Never hard-coded here. */
  model: string;
}

export async function draftNarrative(input: DraftNarrativeInput, deps: DraftNarrativeDeps): Promise<DraftNarrativeResult> {
  if (!deps.model || !deps.model.trim()) throw new VisionError("model_error", "no model configured");
  const limits = SECTION_LIMITS[input.section];
  if (!limits) throw new VisionError("model_error", "unknown narrative section");

  let feedback: string | null = null;
  let lastProblem: { reason: NarrativeErrorReason; message: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: { text: string };
    try {
      res = await deps.client.complete({
        model: deps.model,
        system: NARRATIVE_SYSTEM_PROMPT,
        userText: buildNarrativeUserText(input, feedback),
        maxTokens: limits.maxTokens,
      });
    } catch (err) {
      if (err instanceof VisionError) throw err;
      throw new VisionError("model_error", `text client failed: ${err instanceof Error ? err.name : "unknown error"}`);
    }
    const text = trimToWords(cleanNarrative(res.text ?? ""), limits.words);
    const problem = checkGrounding(text, input.facts);
    if (!problem) return { text, model: deps.model, promptVersion: NARRATIVE_PROMPT_VERSION };
    lastProblem = problem;
    feedback = problem.message;
  }
  throw new NarrativeError(lastProblem!.reason, `narrative draft failed grounding checks after retry (${lastProblem!.reason}): ${lastProblem!.message}`);
}

// ---------- post-processing ----------

/** Remove em and en dashes, markdown headings and emphasis; normalize bullets and spacing. */
export function cleanNarrative(raw: string): string {
  let t = raw.replace(/\r\n?/g, "\n").trim();
  t = t.replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2"); // numeric ranges
  t = t.replace(/[ \t]*[—–―][ \t]*/g, ", "); // em, en, horizontal bar
  t = t.replace(/ -- /g, ", ");
  t = t
    .split("\n")
    .map((line) => {
      let l = line.replace(/^\s*#{1,6}\s+/, ""); // headings become plain lines
      l = l.replace(/^\s*(?:[*•+]|\d+[.)])\s+/, "- "); // bullets
      l = l.replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2").replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2");
      return l.replace(/^,\s*/, "").replace(/[ \t]+$/, "");
    })
    .join("\n");
  t = t.replace(/,\s*,/g, ",").replace(/,\s*([.;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

/** Keep whole sentences (or bullet lines) up to the word limit. */
export function trimToWords(text: string, limit: number): string {
  if (wordCount(text) <= limit) return text;
  const pieces = text.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [text];
  let out = "";
  for (const p of pieces) {
    if (wordCount(out + p) > limit) break;
    out += p;
  }
  return (out.trim() || text.split(/\s+/).slice(0, limit).join(" ")).trim();
}

// ---------- grounding checks ----------

/**
 * Framework and standard names the model might mention. `mention` finds them in the draft;
 * `owner` decides whether a framework in the facts covers that mention.
 */
const FRAMEWORK_PATTERNS: { label: string; mention: RegExp; owner: RegExp }[] = [
  { label: "CARVER", mention: /\bCARVER\b/, owner: /\bCARVER\b/i },
  { label: "CPTED", mention: /\bCPTED\b|crime prevention through environmental design/i, owner: /\bCPTED\b/i },
  { label: "NIST CSF", mention: /\bNIST\s+CSF\b|\bCSF\s*\d|cybersecurity framework/i, owner: /\bCSF\b|cybersecurity framework/i },
  { label: "PQC", mention: /\bPQC\b|post[- ]quantum|\bFIPS\s*20[345]\b|\bML-(?:KEM|DSA)\b|\bSLH-DSA\b/i, owner: /\bPQC\b|post[- ]quantum/i },
  { label: "ISO 27001", mention: /\bISO(?:\/IEC)?\s*2700\d\b/i, owner: /\bISO(?:\/IEC)?\s*2700\d\b/i },
  { label: "ISO", mention: /\bISO(?:\/IEC)?\s*\d{4,5}\b/i, owner: /\bISO\b/i },
  { label: "ASIS", mention: /\bASIS\b/, owner: /\bASIS\b/i },
  { label: "NIST SP 800", mention: /\b(?:NIST\s+)?SP\s*800-\d+|\bNIST\s+800-\d+/i, owner: /\b800-\d+/ },
  { label: "SOC 2", mention: /\bSOC\s*[12]\b/i, owner: /\bSOC\s*[12]\b/i },
  { label: "PCI DSS", mention: /\bPCI(?:[\s-]*DSS)?\b/i, owner: /\bPCI\b/i },
  { label: "HIPAA", mention: /\bHIPAA\b/i, owner: /\bHIPAA\b/i },
  { label: "GDPR", mention: /\bGDPR\b/i, owner: /\bGDPR\b/i },
  { label: "NFPA", mention: /\bNFPA\b/i, owner: /\bNFPA\b/i },
  { label: "CIS Controls", mention: /\bCIS\s+(?:Controls?|Benchmarks?|v\d)/i, owner: /\bCIS\b/i },
  { label: "NERC CIP", mention: /\bNERC\b/i, owner: /\bNERC\b/i },
  { label: "CMMC", mention: /\bCMMC\b/i, owner: /\bCMMC\b/i },
  { label: "FedRAMP", mention: /\bFedRAMP\b/i, owner: /\bFedRAMP\b/i },
  { label: "IEC 62443", mention: /\b62443\b/, owner: /\b62443\b/ },
  { label: "UL", mention: /\bUL\s*\d{3,4}\b/, owner: /\bUL\s*\d{3,4}\b/ },
  { label: "Cyber Essentials", mention: /\bCyber Essentials\b/i, owner: /\bCyber Essentials\b/i },
  { label: "OWASP", mention: /\bOWASP\b/i, owner: /\bOWASP\b/i },
];

const LEVEL_WORD = "(very low|very high|low|moderate|medium|high|critical|severe|minimal|negligible|elevated)";
/** Phrases that state the overall risk level. Scenario and finding severities are not checked. */
const OVERALL_LEVEL_PATTERNS: RegExp[] = [
  new RegExp(`\\boverall\\s+(?:residual\\s+|site\\s+|security\\s+)?risk(?:\\s+level|\\s+rating)?\\s*(?:is|was|remains|stands at|of|at|:|rated(?:\\s+as)?|assessed\\s+as)?\\s*(?:a\\s+|an\\s+)?${LEVEL_WORD}\\b`, "gi"),
  new RegExp(`\\b${LEVEL_WORD}\\s+overall\\s+(?:residual\\s+)?risk\\b`, "gi"),
  new RegExp(`\\ball\\s+(?:the\\s+)?risks?\\s+(?:are|is|were|remain)\\s+${LEVEL_WORD}\\b`, "gi"),
];

const LEVEL_MAP: Record<string, string> = {
  "very low": "very_low",
  low: "low",
  medium: "medium",
  moderate: "medium",
  high: "high",
  "very high": "very_high",
};

export function checkGrounding(text: string, facts: DraftNarrativeInput["facts"]): { reason: NarrativeErrorReason; message: string } | null {
  if (!text.trim()) return { reason: "empty_output", message: "the draft was empty." };

  const known = [...facts.frameworks.map((f) => `${f.shortName} ${f.version}`), ...facts.findings.flatMap((f) => f.frameworks)];
  const invented = FRAMEWORK_PATTERNS.filter((p) => p.mention.test(text) && !known.some((k) => p.owner.test(k))).map((p) => p.label);
  // A framework in the facts mentioned with a different version (for example a CSF version that does not exist).
  for (const f of facts.frameworks) {
    if (!/\bCSF\b/i.test(f.shortName)) continue;
    for (const m of text.matchAll(/\bCSF\s*(\d+(?:\.\d+)?)/gi)) {
      if (!facts.frameworks.some((g) => /\bCSF\b/i.test(g.shortName) && (g.version === m[1] || g.shortName.includes(m[1]!)))) invented.push(`NIST CSF ${m[1]}`);
    }
  }
  if (invented.length > 0) {
    const names = [...new Set(invented)].join(", ");
    return { reason: "ungrounded_framework", message: `it named frameworks or standards that are not in the facts (${names}). Name only the frameworks listed in the facts.` };
  }

  const expected = facts.risk.overall.level;
  for (const re of OVERALL_LEVEL_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const word = m[1]!.toLowerCase();
      if (LEVEL_MAP[word] !== expected) {
        return {
          reason: "inconsistent_risk_level",
          message: `it described the overall risk as "${word}" but the computed overall level is "${expected.replace(/_/g, " ")}". Use exactly that level.`,
        };
      }
    }
  }
  return null;
}

// ---------- Anthropic transport ----------

export interface AnthropicTextClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** SDK retries for 408, 409, 429, 5xx, and connection errors. */
  maxRetries?: number;
  /** Thinking effort; defaults to "low" (short grounded prose does not need more). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  baseURL?: string;
  /** Custom fetch, used by tests to record requests without a network. */
  fetch?: typeof fetch;
}

export function createAnthropicTextClient(opts: AnthropicTextClientOptions): TextClient {
  if (!opts.apiKey) throw new VisionError("model_error", "missing Anthropic API key");
  const anthropic = new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    async complete(req) {
      let message: Anthropic.Message;
      try {
        message = await anthropic.messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.userText }],
          output_config: { effort: opts.effort ?? "low" },
        });
      } catch (err) {
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new VisionError("timeout", "Anthropic request timed out");
        if (err instanceof Anthropic.APIError) throw new VisionError("model_error", `Anthropic API error${err.status ? ` ${err.status}` : ""}`);
        throw new VisionError("model_error", "Anthropic request failed");
      }
      if (message.stop_reason === "refusal") {
        throw new VisionError("refused", `model declined to draft the narrative${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`);
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (message.stop_reason === "max_tokens" && !text.trim()) throw new VisionError("invalid_output", "model ran out of tokens before writing the draft");
      return { text };
    },
  };
}
