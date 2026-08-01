/**
 * Structural origin of a persisted conversational message.
 *
 * `fromUser` describes direction; provenance distinguishes an agent's
 * conversational reply from server-generated outbound traffic. Legacy rows
 * omit this field and therefore remain unknown rather than being inferred from
 * message text.
 */
export const MESSAGE_PROVENANCES = ['user', 'agent', 'automation'] as const;

export type MessageProvenance = (typeof MESSAGE_PROVENANCES)[number];

export function coerceMessageProvenance(value: unknown): MessageProvenance | undefined {
  return typeof value === 'string' && (MESSAGE_PROVENANCES as readonly string[]).includes(value)
    ? value as MessageProvenance
    : undefined;
}
