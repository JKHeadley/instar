import { TelegramOriginHoldError } from './types.js';
import type { TelegramOriginRecord } from './types.js';
import { canonicalOrigin } from './CanonicalOrigin.js';

/** Original authored text and advisory reactions, retained only in protected
 * request payloads. Neither caller-supplied exemptions nor a replacement review
 * body can cross this boundary. */
export interface OriginSendPolicyInput {
  text: string;
  reaction?: {
    toneAdvisoryAck?: string;
    toneAdvisoryAckReason?: string;
    toneAdvisoryDecisionRef?: string;
    toneAdvisoryComplied?: string;
  };
}
export type OriginSendPolicyDecision = { ok: true } |
  { ok: false; status: number; reason: string; body: Record<string, unknown> };
export interface OriginSendPolicyAuthority {
  review(record: TelegramOriginRecord, input: OriginSendPolicyInput): Promise<OriginSendPolicyDecision>;
  /** Synchronous live authority check, including after durable claim awaits. */
  authorizeDispatch(record: TelegramOriginRecord): OriginSendPolicyDecision;
  reserveContent?(record: TelegramOriginRecord, input: OriginSendPolicyInput, deadlineAt: number): Promise<OriginSendPolicyDecision>;
  completeContent?(record: TelegramOriginRecord, input: OriginSendPolicyInput): Promise<void>;
}
export class OriginSendPolicyRefusal extends TelegramOriginHoldError {
  constructor(readonly decision: Exclude<OriginSendPolicyDecision, { ok: true }>, operationId: string | null) {
    super(decision.reason, operationId);
  }
}
export function originSendPolicyInput(text: string, metadata?: unknown): OriginSendPolicyInput {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw new TelegramOriginHoldError('invalid-send-policy-input');
  const reaction: NonNullable<OriginSendPolicyInput['reaction']> = {};
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const source = metadata as Record<string, unknown>;
    for (const [key, maximum] of [['toneAdvisoryAck', 64], ['toneAdvisoryAckReason', 500],
      ['toneAdvisoryDecisionRef', 128], ['toneAdvisoryComplied', 64]] as const) {
      if (typeof source[key] === 'string') reaction[key] = source[key].slice(0, maximum);
    }
  }
  return { text, ...(Object.keys(reaction).length ? { reaction } : {}) };
}
export function validOriginSendPolicyInput(value: unknown): value is OriginSendPolicyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as OriginSendPolicyInput;
  if (Object.keys(input).some(key => key !== 'text' && key !== 'reaction')) return false;
  try { return canonicalOrigin(input) === canonicalOrigin(originSendPolicyInput(input.text, input.reaction)); }
  catch { return false; }
}
