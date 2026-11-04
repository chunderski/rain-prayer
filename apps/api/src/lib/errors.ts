import type { ZodError, ZodTypeAny, z } from "zod";

/** An error that maps directly to the API error envelope. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);

export function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Parses input with a zod schema; throws 400 validation_error with per-field details on failure. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError(400, "validation_error", "Request validation failed", zodDetails(r.error));
  return r.data;
}
