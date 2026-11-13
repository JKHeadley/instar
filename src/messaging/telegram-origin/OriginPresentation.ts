import { originDigest } from './CanonicalOrigin.js';
import type { OriginDisplaySettings, OriginDisplaySnapshot, TelegramOriginProducer, OriginEvidence } from './types.js';

export const DEFAULT_ORIGIN_DISPLAY: Readonly<OriginDisplaySettings> = Object.freeze({
  enabled: true, machine: true, harness: true, model: true,
});
export function resolveOriginDisplay(agent: Partial<OriginDisplaySettings> = {},
  conversation: Partial<OriginDisplaySettings> = {}): OriginDisplaySnapshot {
  const bits = { ...DEFAULT_ORIGIN_DISPLAY };
  for (const key of Object.keys(bits) as (keyof OriginDisplaySettings)[]) {
    const value = conversation[key] ?? agent[key] ?? true;
    if (typeof value !== 'boolean') throw new Error(`origin-display: ${key} must be boolean`);
    bits[key] = value;
  }
  return { ...bits, version: originDigest(bits) };
}
export function validateOriginDisplay(value: unknown): Partial<OriginDisplaySettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('origin-display: object required');
  for (const [key, bit] of Object.entries(value)) {
    if (!(key in DEFAULT_ORIGIN_DISPLAY) || typeof bit !== 'boolean') throw new Error('origin-display: unknown field or non-boolean');
  }
  return value as Partial<OriginDisplaySettings>;
}
function label(evidence: OriginEvidence, preferred?: string | null, omitUnknown = false): string | null {
  if (evidence.status === 'not-applicable') return null;
  if (!evidence.value || evidence.status === 'unknown') return omitUnknown ? null : 'unknown';
  const value = preferred ?? evidence.value;
  return evidence.status === 'configured' ? `${value} (configured)` : value;
}
export function originFooter(producer: TelegramOriginProducer, display: OriginDisplaySettings): string {
  if (!display.enabled || (!display.machine && !display.harness && !display.model)) return '';
  const values = [producer.agentName];
  const automation = producer.producerKind === 'server-automation';
  if (display.machine) {
    const machine = label(producer.machine, producer.originMachineName, automation);
    if (machine) values.push(machine);
    else if (!automation) values.push('unknown machine');
  }
  if (automation) {
    if (display.harness) {
      values.push('automation');
      const harness = label(producer.harness, producer.harnessName, true);
      if (harness) values.push(harness);
    }
    if (display.model) { const model = label(producer.model, undefined, true); if (model) values.push(model); }
  } else {
    if (display.harness) values.push(label(producer.harness, producer.harnessName) ?? 'unknown harness');
    if (display.model) values.push(label(producer.model) ?? 'unknown model');
  }
  // Friendly names are configuration-owned. Refuse multiline/control labels; do not silently redact an identity.
  if (values.some(v => /[\r\n\u0000-\u001f\u007f]/.test(v) || v.length > 128)) {
    throw new Error('origin-display: invalid friendly label');
  }
  return values.join(' · ');
}
export function escapeOriginFooter(text: string, parseMode?: string): string {
  if (parseMode === 'HTML') return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (parseMode === 'MarkdownV2') return text.replace(/([_\*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  if (parseMode === 'Markdown') return text.replace(/([_*\[`\\])/g, '\\$1');
  return text;
}
/** Indexes all eight presealed field variants; enabled:false uses the all-off request. */
export function originDisplayVariant(display: OriginDisplaySettings): number {
  return display.enabled ? (Number(display.machine) * 4 + Number(display.harness) * 2 + Number(display.model)) : 0;
}
/**
 * The machine name a message footer shows. The pool nickname first, then the machine's own name from
 * pairing or identity (its hostname), and the raw id only when no name exists at all — a footer reading
 * "Machine m_b7f06b" tells the operator nothing. A name must be one printable line the footer accepts.
 */
export function publicMachineName(input: { machineId: string; nickname?: string | null; registryName?: string | null; identityName?: string | null }): string {
  const usable = (v: string | null | undefined): string | null => {
    const n = typeof v === 'string' ? v.trim() : '';
    if (!n || n.length > 64 || /[\r\n\u0000-\u001f\u007f]/.test(n)) return null;
    if (n === input.machineId || /^m_[0-9a-f]{6,}$/i.test(n) || /^Machine (m_)?[0-9a-f]{6,}$/i.test(n)) return null; // an id, not a name
    return n;
  };
  return usable(input.nickname) ?? usable(input.registryName) ?? usable(input.identityName) ?? `Machine ${input.machineId.slice(0, 8)}`;
}
