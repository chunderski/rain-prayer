/**
 * Opt-in live smoke test against the real Anthropic API. Costs money; never runs in CI.
 *
 *   ANTHROPIC_API_KEY=... ANTHROPIC_VISION_MODEL=... npx tsx packages/ai/src/smoke.ts [photo.jpg]
 *
 * Without ANTHROPIC_API_KEY it prints a message and exits 0.
 */
import { readFileSync } from "node:fs";
import { analyzePhoto, createAnthropicVisionClient, VisionError } from "./index.js";

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("smoke: ANTHROPIC_API_KEY is not set, skipping the live vision smoke test.");
    return 0;
  }
  const model = process.env.ANTHROPIC_VISION_MODEL;
  if (!model) {
    console.error("smoke: set ANTHROPIC_VISION_MODEL (see .env.example).");
    return 1;
  }
  const path = process.argv[2];
  if (!path) {
    console.error("smoke: pass a metadata-stripped JPEG path, for example a photo of a fence.");
    return 1;
  }
  const image = new Uint8Array(readFileSync(path));
  const client = createAnthropicVisionClient({ apiKey, timeoutMs: 90_000 });
  try {
    const res = await analyzePhoto(
      {
        image,
        mediaType: "image/jpeg",
        context: {
          candidateControls: [
            { id: "SC-PER-001", title: "Perimeter fence height and condition", objective: "The perimeter fence is intact and free of gaps or damage.", assetTypes: ["fence"] },
            { id: "SC-VSS-002", title: "Perimeter and parking camera coverage", objective: "Cameras cover the perimeter and parking areas with unobstructed views.", assetTypes: ["camera", "parking"] },
            { id: "SC-ACC-003", title: "Controlled entry points", objective: "Entry points are closed and secured when not in use.", assetTypes: ["door"] },
            { id: "SC-LGT-001", title: "Parking area illuminance", objective: "Parking areas are lit to support observation at night.", assetTypes: ["parking", "lighting"] },
          ],
        },
      },
      { client, model },
    );
    console.log(JSON.stringify(res, null, 2));
    return 0;
  } catch (err) {
    console.error(`smoke: failed (${err instanceof VisionError ? err.code : "unexpected"}): ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
