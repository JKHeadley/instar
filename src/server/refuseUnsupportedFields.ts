/**
 * A write route that accepts a body, applies the fields it knows and silently
 * ignores the rest answers 200 for a change it did not make. The caller cannot
 * tell — the 2026-10-19 case was `PATCH /attention/:id` with `{status, body}`:
 * the status landed, the body vanished, and the response said success.
 *
 * This is the one shared refusal: an unknown field is a 400 that names it and
 * lists what the route does accept, in the same shape `PATCH
 * /evolution/actions/:id` already used. Every PATCH/PUT handler either calls
 * it or carries its own equivalent allowlist (pinned by
 * tests/unit/write-routes-refuse-unsupported-fields.test.ts).
 */
import type { Response } from 'express';

/** Returns true (and has answered 400) when the body is not an object or carries a field outside `supported`. */
export function refuseUnsupportedFields(res: Response, body: unknown, supported: readonly string[]): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Request body must be a JSON object', supportedFields: [...supported] });
    return true;
  }
  const allowed = new Set(supported);
  const unsupportedFields = Object.keys(body).filter((field) => !allowed.has(field));
  if (unsupportedFields.length === 0) return false;
  res.status(400).json({
    error: `Unsupported field(s): ${unsupportedFields.join(', ')}`,
    unsupportedFields,
    supportedFields: [...supported],
  });
  return true;
}
