// Governed by: "Telegram Message Origin Is Mandatory; Its Display Is Optional"
// (docs/STANDARDS-REGISTRY.md), extended to every platform by
// docs/specs/message-origin-all-platforms.md. Recording and presentation stay
// independent: nothing here decides whether a message is sent.
import type { OriginDisplaySettings, OriginEvidence, OriginEvidenceStatus, TelegramOriginProducer } from './telegram-origin/types.js';
import { DEFAULT_ORIGIN_DISPLAY } from './telegram-origin/OriginPresentation.js';

/** Friendly names for the harnesses ("doors") Instar launches. */
export const HARNESS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'codex-cli': 'Codex', 'claude-code': 'Claude Code', 'gemini-cli': 'Gemini', 'pi-cli': 'Pi', 'grok-build': 'Grok',
});

/** The origin of one agent message on a platform without the Telegram origin store (spec §1). */
export interface MessageOriginEvidence {
  v: 1;
  producerKind: 'session' | 'server-automation' | 'unknown';
  machineId: string | null;
  machine: OriginEvidence;
  harness: OriginEvidence;
  harnessName: string | null;
  model: OriginEvidence;
  recordedAt: number;
}

/** What a phone's history read gets on an agent row (spec §4). */
export interface DeviceOriginRow {
  recorded: boolean | null;
  reason?: DeviceOriginReason;
  machine: { value: string | null; status: OriginEvidenceStatus };
  harness: { value: string | null; id: string | null; status: OriginEvidenceStatus };
  model: { value: string | null; status: OriginEvidenceStatus };
  display: OriginDisplaySettings;
}
export type DeviceOriginReason = 'not-recorded' | 'other-machine' | 'not-found' | 'not-retained' | 'lookup-timeout' | 'lookup-failed' | 'ambiguous' | 'unlinked';

const STATUSES: ReadonlySet<string> = new Set(['observed', 'configured', 'unknown', 'not-applicable']);
const KINDS: ReadonlySet<string> = new Set(['session', 'server-automation', 'unknown']);
const EVIDENCE_KEYS = ['value', 'status', 'sourceEventRef', 'observedAt', 'reason'];
const RECORD_KEYS = ['v', 'producerKind', 'machineId', 'machine', 'harness', 'harnessName', 'model', 'recordedAt'];
/** Printable, single-line, bounded. Display values never carry control characters. */
const safeText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const HARNESS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The registry's own fallback name (`Machine <id prefix>`) is an id, not a name. */
const ID_SHAPED_MACHINE_NAME_RE = /^Machine [0-9a-f]{6,}$/i;

function validEvidence(raw: unknown): OriginEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !EVIDENCE_KEYS.includes(k))) return null;
  if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return null;
  if (!(r.value === null || safeText(r.value, 128))) return null;
  if (!(r.sourceEventRef === null || r.sourceEventRef === undefined || safeText(r.sourceEventRef, 160))) return null;
  if (!(r.observedAt === null || r.observedAt === undefined || (Number.isSafeInteger(r.observedAt) && (r.observedAt as number) >= 0))) return null;
  if (!(r.reason === null || r.reason === undefined || safeText(r.reason, 80))) return null;
  // A known value must carry a known-value status, and an unknown one no value.
  if ((r.status === 'observed' || r.status === 'configured') && r.value === null) return null;
  if ((r.status === 'unknown' || r.status === 'not-applicable') && r.value !== null) return null;
  return { value: r.value as string | null, status: r.status as OriginEvidenceStatus,
    sourceEventRef: (r.sourceEventRef as string | null | undefined) ?? null, observedAt: (r.observedAt as number | null | undefined) ?? null,
    reason: (r.reason as string | null | undefined) ?? null };
}

/** Strict, bounded check for a record read back from disk or received from another machine. Null = treat as absent. */
export function validateMessageOriginEvidence(raw: unknown): MessageOriginEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some((k) => !RECORD_KEYS.includes(k))) return null;
  if (r.v !== 1 || typeof r.producerKind !== 'string' || !KINDS.has(r.producerKind)) return null;
  if (!(r.machineId === null || safeText(r.machineId, 128))) return null;
  if (!(r.harnessName === null || safeText(r.harnessName, 64))) return null;
  if (!Number.isSafeInteger(r.recordedAt) || (r.recordedAt as number) < 0) return null;
  const machine = validEvidence(r.machine), harness = validEvidence(r.harness), model = validEvidence(r.model);
  if (!machine || !harness || !model) return null;
  if (harness.value !== null && !HARNESS_ID_RE.test(harness.value)) return null;
  return { v: 1, producerKind: r.producerKind as MessageOriginEvidence['producerKind'], machineId: r.machineId as string | null,
    machine, harness, harnessName: r.harnessName as string | null, model, recordedAt: r.recordedAt as number };
}

const unknownEvidence = (reason: string): OriginEvidence => ({ value: null, status: 'unknown', sourceEventRef: null, observedAt: null, reason });

/** A display name, or unknown. An id-shaped or empty name is never shown as a name. */
export function machineEvidence(name: string | null | undefined, at: number): OriginEvidence {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!safeText(n, 128) || ID_SHAPED_MACHINE_NAME_RE.test(n)) return unknownEvidence('machine-name-unavailable');
  return { value: n, status: 'observed', sourceEventRef: 'machine-identity', observedAt: at, reason: null };
}

/** The Telegram evidence derivation, reused unchanged: one producer, one record. */
export function originEvidenceFromProducer(producer: TelegramOriginProducer, at: number): MessageOriginEvidence {
  const machine = producer.machine.status === 'observed' || producer.machine.status === 'configured'
    ? machineEvidence(producer.originMachineName, producer.machine.observedAt ?? at) : { ...producer.machine };
  // Source refs are not copied: they can name transcript events. A coarse label replaces them (§1).
  const coarse = (e: OriginEvidence, label: string): OriginEvidence => ({ ...e, sourceEventRef: e.value === null ? null : label });
  const record: MessageOriginEvidence = {
    v: 1, producerKind: producer.producerKind === 'imported-legacy' ? 'unknown' : producer.producerKind,
    machineId: producer.originMachineId, machine: coarse(machine, 'machine-identity'),
    harness: coarse(producer.harness, producer.producerKind === 'session' ? 'session-credential' : 'automation-author'),
    harnessName: producer.harnessName,
    model: coarse(producer.model, producer.producerKind === 'session' ? 'session-credential' : 'automation-author'), recordedAt: at,
  };
  // Re-validate so a producer value that would not survive a read is recorded as unknown, not stored broken.
  return validateMessageOriginEvidence(record) ?? {
    ...record, harness: unknownEvidence('harness-evidence-invalid'), harnessName: null, model: unknownEvidence('model-evidence-invalid'),
  };
}

const MODEL_TIERS: ReadonlySet<string> = new Set(['fast', 'balanced', 'capable', 'default', 'escalated', 'opus', 'sonnet', 'haiku']);

/** Rung 2: the server's own launch record of a running session on this machine (status `configured`, never `observed`). */
export function originEvidenceFromLaunchRecord(input: { machineId: string | null; machineName: string | null;
  sessionId: string; framework: string | null | undefined; model: string | null | undefined; at: number }): MessageOriginEvidence {
  const ref = 'session-launch'; // never the session id: this record replicates (§1)
  const harnessOk = typeof input.framework === 'string' && HARNESS_ID_RE.test(input.framework);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const modelOk = safeText(model, 128) && !MODEL_TIERS.has(model.toLowerCase());
  return {
    v: 1, producerKind: 'session', machineId: input.machineId, machine: machineEvidence(input.machineName, input.at),
    harness: harnessOk ? { value: input.framework as string, status: 'configured', sourceEventRef: ref, observedAt: input.at, reason: 'session-launch-record' }
      : unknownEvidence('session-framework-unrecorded'),
    harnessName: harnessOk ? HARNESS_NAMES[input.framework as string] ?? null : null,
    model: modelOk ? { value: model, status: 'configured', sourceEventRef: ref, observedAt: input.at, reason: 'session-launch-record' }
      : unknownEvidence(model ? 'session-model-is-a-tier' : 'session-model-unrecorded'),
    recordedAt: input.at,
  };
}

/** Rung 3 (no session evidence) and server sends outside a reply route. */
export function originEvidenceWithoutSession(input: { machineId: string | null; machineName: string | null; at: number;
  kind: 'server-automation' | 'unknown' }): MessageOriginEvidence {
  const reason = input.kind === 'server-automation' ? 'unbound-author-call' : 'no-session-evidence';
  return { v: 1, producerKind: input.kind, machineId: input.machineId, machine: machineEvidence(input.machineName, input.at),
    harness: unknownEvidence(reason), harnessName: null, model: unknownEvidence(reason), recordedAt: input.at };
}

/** The single enabled Telegram messaging entry, or null (none, or more than one). */
export function singleEnabledTelegram(messaging: unknown): { config?: { messageOrigin?: { display?: unknown } } & Record<string, unknown> } | null {
  if (!Array.isArray(messaging)) return null;
  const enabled = messaging.filter((m) => !!m && typeof m === 'object' && (m as { type?: unknown }).type === 'telegram' && (m as { enabled?: unknown }).enabled === true);
  return enabled.length === 1 ? enabled[0] as { config?: { messageOrigin?: { display?: unknown } } & Record<string, unknown> } : null;
}

/** Resolve the four display bits; absent bits are on. Never throws on a malformed config: a bad bit reads as on. */
export function effectiveDisplay(agent: unknown, conversation?: unknown): OriginDisplaySettings {
  const pick = (src: unknown, key: keyof OriginDisplaySettings): boolean | undefined => {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return undefined;
    const v = (src as Record<string, unknown>)[key];
    return typeof v === 'boolean' ? v : undefined;
  };
  const out = { ...DEFAULT_ORIGIN_DISPLAY };
  for (const key of Object.keys(out) as (keyof OriginDisplaySettings)[]) {
    out[key] = pick(conversation, key) ?? pick(agent, key) ?? DEFAULT_ORIGIN_DISPLAY[key];
  }
  return out;
}

/**
 * The agent-wide display setting (spec §5): the Telegram messaging entry's
 * `messageOrigin.display` when a Telegram entry exists, else the top-level
 * `messageOrigin.display`. One setting per agent, one place to look.
 */
export function agentDisplaySetting(messaging: unknown, topLevelMessageOrigin: unknown): unknown {
  const telegram = singleEnabledTelegram(messaging);
  if (telegram) return telegram.config?.messageOrigin?.display;
  if (topLevelMessageOrigin && typeof topLevelMessageOrigin === 'object' && !Array.isArray(topLevelMessageOrigin)) {
    return (topLevelMessageOrigin as { display?: unknown }).display;
  }
  return undefined;
}

const harnessName = (id: string | null, recorded: string | null): string | null =>
  id ? HARNESS_NAMES[id] ?? recorded ?? id : null;

/** The phone row. `evidence` null ⇒ `recorded` is `false` (checked, none) or `null` (could not tell), per `reason`. */
export function deviceOriginRow(evidence: MessageOriginEvidence | null, display: OriginDisplaySettings,
  missing: DeviceOriginReason = 'not-recorded'): DeviceOriginRow {
  if (!evidence) {
    return { recorded: missing === 'not-recorded' ? false : null, reason: missing,
      machine: { value: null, status: 'unknown' }, harness: { value: null, id: null, status: 'unknown' },
      model: { value: null, status: 'unknown' }, display: { ...display } };
  }
  const harnessId = evidence.harness.value;
  return {
    recorded: true,
    machine: { value: evidence.machine.value, status: evidence.machine.status },
    harness: { value: harnessName(harnessId, evidence.harnessName), id: harnessId, status: evidence.harness.status },
    model: { value: evidence.model.value, status: evidence.model.status },
    display: { ...display },
  };
}

/** A peer's device row, re-checked before it is passed on. Null when it does not validate. */
export function validateDeviceOriginRow(raw: unknown, display: OriginDisplaySettings): DeviceOriginRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const field = (v: unknown, withId: boolean) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const f = v as Record<string, unknown>;
    if (typeof f.status !== 'string' || !STATUSES.has(f.status)) return null;
    if (!(f.value === null || safeText(f.value, 128))) return null;
    if (withId && !(f.id === null || (typeof f.id === 'string' && HARNESS_ID_RE.test(f.id)))) return null;
    return f;
  };
  const m = field(r.machine, false), h = field(r.harness, true), mo = field(r.model, false);
  if (!m || !h || !mo || !(r.recorded === true || r.recorded === false || r.recorded === null)) return null;
  const reasons: ReadonlySet<string> = new Set(['not-recorded', 'other-machine', 'not-found', 'not-retained', 'lookup-timeout', 'lookup-failed', 'ambiguous', 'unlinked']);
  if (r.recorded !== true && !(typeof r.reason === 'string' && reasons.has(r.reason))) return null;
  return {
    recorded: r.recorded as boolean | null, ...(r.recorded !== true ? { reason: r.reason as DeviceOriginReason } : {}),
    machine: { value: m.value as string | null, status: m.status as OriginEvidenceStatus },
    harness: { value: h.value as string | null, id: (h.id as string | null) ?? null, status: h.status as OriginEvidenceStatus },
    model: { value: mo.value as string | null, status: mo.status as OriginEvidenceStatus },
    // The display setting is this machine's, never the peer's.
    display: { ...display },
  };
}

/** The agent default display bits, read from a live config when one is available (spec §5). */
export function currentAgentDisplay(source: { liveConfig?: { get<T>(path: string, def: T): T } | null; config: { messaging?: unknown } & Record<string, unknown> }): OriginDisplaySettings {
  let messaging: unknown = source.config.messaging;
  let topLevel: unknown = (source.config as { messageOrigin?: unknown }).messageOrigin;
  if (source.liveConfig) {
    try {
      messaging = source.liveConfig.get<unknown>('messaging', messaging);
      topLevel = source.liveConfig.get<unknown>('messageOrigin', topLevel);
    } catch { /* @silent-fallback-ok — the boot config is the same setting, possibly older */ }
  }
  return effectiveDisplay(agentDisplaySetting(messaging, topLevel));
}

/** Escape one label for Slack mrkdwn so it can never become a mention, link or formatting. */
export function escapeSlackLabel(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([*_~`])/g, '\u200b$1\u200b');
}

/**
 * The one-line Slack footer for an agent reply (spec §5): `agent · machine · harness · model`,
 * italic, already-formatted mrkdwn. Returns '' when display is off or a label is unusable: the
 * footer is presentation and never fails a send.
 */
export function slackOriginFooter(agentName: string, evidence: MessageOriginEvidence, display: OriginDisplaySettings): string {
  if (!display.enabled || (!display.machine && !display.harness && !display.model)) return '';
  const label = (e: OriginEvidence, preferred?: string | null): string | null => {
    if (e.status === 'not-applicable') return null;
    if (e.value === null || e.status === 'unknown') return 'unknown';
    const v = preferred ?? e.value;
    return e.status === 'configured' ? `${v} (configured)` : v;
  };
  const parts = [agentName];
  if (display.machine) parts.push(label(evidence.machine) === 'unknown' ? 'unknown machine' : label(evidence.machine) ?? 'unknown machine');
  if (display.harness) {
    const h = label(evidence.harness, evidence.harness.value ? HARNESS_NAMES[evidence.harness.value] ?? evidence.harnessName : null);
    if (h) parts.push(h === 'unknown' ? 'unknown harness' : h);
  }
  if (display.model) { const m = label(evidence.model); if (m) parts.push(m === 'unknown' ? 'unknown model' : m); }
  if (parts.some((p) => !safeText(p, 160))) return '';
  return `_${parts.map(escapeSlackLabel).join(' · ')}_`;
}
