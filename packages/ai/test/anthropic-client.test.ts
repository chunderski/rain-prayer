import { describe, expect, it } from "vitest";
import { VisionError, createAnthropicVisionClient } from "../src/index.js";
import { VISION_OUTPUT_JSON_SCHEMA } from "../src/prompts/photo-analysis.v1.js";

/** Records the outgoing HTTP body and returns a canned Messages API response. No network. */
function recordingFetch(reply: Record<string, unknown>, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }) as typeof fetch;
  return { f, bodies };
}

const message = (over: Record<string, unknown>) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "{}" }],
  stop_reason: "end_turn",
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...over,
});

const req = { model: "configured-model", system: "SYS", userText: "USER", image: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mediaType: "image/jpeg" as const, maxTokens: 1234 };

describe("createAnthropicVisionClient", () => {
  it("sends image, cached system prompt, and the JSON schema output format", async () => {
    const { f, bodies } = recordingFetch(message({ content: [{ type: "text", text: '{"a":1}' }] }));
    const client = createAnthropicVisionClient({ apiKey: "test-key", fetch: f, maxRetries: 0 });
    const res = await client.analyze(req);
    expect(res).toEqual({ text: '{"a":1}', usage: { inputTokens: 10, outputTokens: 5 } });
    const body = bodies[0] as any;
    expect(body.model).toBe("configured-model");
    expect(body.max_tokens).toBe(1234);
    expect(body.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/2Q==" } });
    expect(body.messages[0].content[1]).toEqual({ type: "text", text: "USER" });
    expect(body.output_config.format).toEqual({ type: "json_schema", schema: VISION_OUTPUT_JSON_SCHEMA });
    expect(body.tool_choice).toBeUndefined();
  });

  it("maps a refusal stop reason to VisionError refused", async () => {
    const { f } = recordingFetch(message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }));
    const client = createAnthropicVisionClient({ apiKey: "test-key", fetch: f, maxRetries: 0 });
    await expect(client.analyze(req)).rejects.toMatchObject({ code: "refused" });
  });

  it("maps API errors to VisionError model_error", async () => {
    const { f } = recordingFetch({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400);
    const client = createAnthropicVisionClient({ apiKey: "test-key", fetch: f, maxRetries: 0 });
    const err = await client.analyze(req).catch((e) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect(err.code).toBe("model_error");
  });

  it("requires an API key", () => {
    expect(() => createAnthropicVisionClient({ apiKey: "" })).toThrow(VisionError);
  });
});
