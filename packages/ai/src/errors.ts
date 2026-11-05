/** Error type shared by the vision and narrative pipelines (kept separate to avoid an import cycle with index.ts). */
export class VisionError extends Error {
  constructor(public code: "model_error" | "invalid_output" | "refused" | "timeout", message: string) {
    super(message);
  }
}
