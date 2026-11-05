import { describe, expect, it } from "vitest";
import type { VisionOutput } from "@sentinel/shared";
import { buildReview } from "./SuggestionReview";

const draft = (title: string) => ({ title, description: "d", recommendation: "r", severity: "high" as const, controlIds: ["SC-LGT-001"], confidence: 0.7 });
const output: VisionOutput = {
  imageQuality: "ok",
  assetType: { value: "lighting", confidence: 0.9 },
  condition: { rating: "poor", summary: "Dark", confidence: 0.8 },
  deficiencies: [],
  controls: [{ id: "SC-LGT-001", confidence: 0.8, rationale: "Lighting" }],
  draftFindings: [draft("One"), draft("Two")],
  cautions: [],
};

describe("buildReview", () => {
  it("accepts only the drafts the assessor accepted, tags only when ticked", () => {
    expect(buildReview(output.draftFindings, { 0: { kind: "reject" }, 1: { kind: "accept" } }, false, output)).toEqual({ decision: "accept", findingIndexes: [1], applyTags: false });
  });
  it("sends edits together with accepted drafts", () => {
    const edited = { ...draft("Two, edited"), confidence: undefined };
    const r = buildReview(output.draftFindings, { 0: { kind: "accept" }, 1: { kind: "edit", finding: edited } }, true, output);
    expect(r).toMatchObject({ decision: "edit", findings: [{ title: "One" }, { title: "Two, edited" }], tags: { assetType: "lighting", controlIds: ["SC-LGT-001"] } });
  });
  it("rejects when every draft is rejected and no tags apply", () => {
    expect(buildReview(output.draftFindings, { 0: { kind: "reject" }, 1: { kind: "reject" } }, false, output, " wrong door ")).toEqual({ decision: "reject", reason: "wrong door" });
  });
});
