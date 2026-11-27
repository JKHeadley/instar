/**
 * What a spawned Slack session may set on its reply. The route lets `metadata` through for the
 * tone-gate reaction only: without it a session could not answer an advisory and would loop on the
 * 422 (live test, 2026-11-06). Anything else is refused, so a session cannot reach `allowDuplicate`,
 * `allowDebugText` or a format override.
 */
const TONE_FIELDS = ['toneAdvisoryAck', 'toneAdvisoryAckReason', 'toneAdvisoryComplied', 'toneAdvisoryDecisionRef'] as const;

/** False when `metadata` holds anything but the tone reaction. The route answers 400. */
export function slackSessionMetadataAllowed(metadata: unknown): boolean {
  if (metadata === undefined) return true;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return Object.keys(metadata).every((key) => (TONE_FIELDS as readonly string[]).includes(key));
}

export function slackSessionMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (Array.isArray(body.nativeReferences)) out.nativeReferences = body.nativeReferences;
  const metadata = body.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const field of TONE_FIELDS) {
      const value = (metadata as Record<string, unknown>)[field];
      if (typeof value === 'string') out[field] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
