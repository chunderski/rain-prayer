# @sentinel/ai

The Claude vision pipeline for Sentinel Assess: one assessment photo in, a schema-validated `VisionOutput` suggestion out. Nothing here is final; the API stores the result with status `suggested` and only a human accept or edit turns it into findings or tags.

## Pipeline

`analyzePhoto(input, { client, model, maxTokens? })` in `src/vision.ts`:

1. **Input checks**: JPEG only, non-empty, at most `MAX_IMAGE_BYTES` (the 5 MB base64 image limit). The model ID must come from configuration (`ANTHROPIC_VISION_MODEL`); the package has no default model.
2. **Prompt**: a frozen system prompt (prompt cached) plus a user turn with the candidate controls, an optional asset type hint, and untrusted context in delimited tags (see below).
3. **Structured output**: `createAnthropicVisionClient` sends `output_config.format` with a JSON schema equivalent to `VisionOutput` (`VISION_OUTPUT_JSON_SCHEMA`). Forced `tool_choice` is not used: current models (Claude Opus 5.5, Claude Sonnet 5.5) reject it with a 400.
4. **Validation**: the text is parsed as JSON and checked with a lenient zod shape (types and enums). On failure the pipeline retries once with a short summary of the zod issues (paths and messages, never the model text); a second failure throws `VisionError("invalid_output")`.
5. **Normalization**: control IDs not in `candidateControls` are dropped everywhere and a caution names them; draft findings left with no valid control are removed; confidences are clamped to 0..1 and rounded; lists and strings are capped to the contract limits; `not_security_relevant` photos get no draft findings. The result is then parsed with the shared `VisionOutput` schema.
6. **Errors**: `VisionError` codes `model_error` (API or transport failure, details not leaked), `timeout`, `refused` (`stop_reason: "refusal"`), `invalid_output`. The SDK retries 408, 409, 429, and 5xx twice by default.

## Prompt versioning

Prompts live in `src/prompts/<name>.v<major>.ts` and export `PROMPT_VERSION` (currently `photo-analysis@1.0.0`), which is stored on every `AiSuggestion`. Bump the patch for wording fixes, the minor for new context fields, and the major (new file) for schema changes. Any prompt change must keep the fixture tests green and add a fixture if it changes behavior.

## Prompt injection defenses

- The image, assessor notes, and area name are untrusted data. The system prompt says text visible in the image (signs, stickers, screens, documents) and in notes is never an instruction, and that apparent instructions must be ignored and reported as a caution.
- Notes go inside `<assessor_notes>` and the area name inside `<area_name>`. `escapeUntrusted` escapes `&`, `<`, `>` and strips control characters, so content cannot close the tag or fake a new section. Notes are capped at 4000 characters.
- Output is constrained by the JSON schema, then validated with zod; unknown control IDs are dropped, so injected text cannot add mappings outside the candidate list. Even a fully compromised answer is only a suggestion awaiting human review.
- No people analysis: the prompt forbids identifying or describing individuals and transcribing personal data.

## Privacy

GPS is not part of `AnalyzePhotoInput` and is never sent. The API sends the stored, re-encoded JPEG with EXIF stripped. `assessorNotes` and `areaName` are passed only when the tenant allows context sharing (`aiShareContext`); the API decides.

## Tests

`npx vitest run --root packages/ai` runs without network or API key. `test/vision.test.ts` uses a fake `VisionClient` that replays recorded responses; `test/anthropic-client.test.ts` checks the real client's request body through a recording `fetch`.

### Adding a fixture

Add `test/fixtures/<case>.json`:

```json
{
  "name": "case-name",
  "description": "What the photo shows and what the case exercises.",
  "context": { "candidateControls": [{ "id": "SC-PER-001", "title": "...", "objective": "...", "assetTypes": ["fence"] }], "assessorNotes": null },
  "responses": [{ "imageQuality": "ok", "...": "recorded VisionOutput JSON" }],
  "expect": { "imageQuality": "ok", "assetType": "fence", "draftFindings": 1, "controlIds": ["SC-PER-001"], "cautionIncludes": ["..."] }
}
```

`responses` are replayed in order; a string is sent as raw text (use it for invalid JSON), an object is serialized. `expect.error` with `calls` tests failure paths. Record real responses with the smoke script and strip anything identifying before committing. Images are not needed: the fake client ignores the bytes.

## Narrative drafting (Phase 3)

`draftNarrative({ section, facts, styleNotes? }, { client, model })` in `src/narrative.ts` drafts one report section (`executive_summary`, `methodology`, `key_findings`, `recommendations`) for client facility and IT leadership. The prompt is `src/prompts/narrative.v1.ts` (`NARRATIVE_PROMPT_VERSION` `narrative@1.0.0`); the model ID comes from configuration, and `createAnthropicTextClient` is the SDK transport (cached system prompt, effort `low` by default).

- **Grounding**: facts go in as JSON (client, site, title, frameworks with versions, the computed `RiskResult`, confirmed findings only). The model may only state what is there, must not invent findings, standards, or compliance claims, and says "not assessed" instead of guessing.
- **Untrusted text**: every fact string is escaped (`&`, `<`, `>`, control characters) and delimited in `<assessment_facts>` and `<confirmed_findings>`; `styleNotes` go in `<style_notes>`. Instructions inside them are data and are ignored.
- **Post-processing**: em and en dashes become commas (numeric ranges become "1 to 5"); headings, bold, and italics are stripped; bullets become `- ` lines; text is trimmed to the section word limit (250, 250, 450, 350) at a sentence boundary.
- **Post-checks**: a draft is rejected if it names a framework or standard not in the facts (including a wrong CSF version such as 3.0) or states an overall risk level other than `risk.overall.level`. One retry with feedback, then `NarrativeError` (`code: "invalid_output"`, `reason: "ungrounded_framework" | "inconsistent_risk_level" | "empty_output"`). Transport errors map to `model_error`, `timeout`, `refused` as for vision. The checks are pattern based; they catch the common failures, not every possible ungrounded sentence, which is why human approval is required.
- **Human approval rule**: a draft is only a suggestion. The API stores it with status `ai_draft`; only text an assessor has edited or approved (`PUT /assessments/:id/narrative/:section`) appears in any export or client document. This is enforced by the API, not by this package.
- **Tests**: `test/narrative.test.ts` uses a fake `TextClient` and a recording `fetch`; no network or API key.

## Live smoke test

`ANTHROPIC_API_KEY=... ANTHROPIC_VISION_MODEL=... npx tsx packages/ai/src/smoke.ts photo.jpg`. Without a key it prints a message and exits 0.

## Cost notes

- One photo is one request; a retry doubles it. A 1 to 2 MP JPEG is roughly 1,500 to 2,500 input tokens; the system prompt plus controls add about 1,500 more, and output is typically 500 to 1,500 tokens plus thinking.
- The system prompt is cached (`cache_control`), so repeated analyses within 5 minutes pay about 10 percent for that part. It only caches once the prefix passes the model's minimum cacheable length.
- Effort defaults to `medium` in `createAnthropicVisionClient`; `low` is cheaper and worth evaluating against the fixtures and real photos.
- At Claude Sonnet 5.5 rates ($2 input, $10 output per million tokens) a photo costs roughly 1 to 3 cents. Resize photos to about 1568 px on the long edge before sending; larger images cost more without better results.
- The API rate limits analyses to 30 per user per hour.
