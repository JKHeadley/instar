/**
 * Server-side voice transcription, shared by the Telegram voice handler and app conversations
 * (docs/specs/mobile-native-chat-media.md §4.5.1: "extracted into a shared VoiceTranscription
 * module that both call"). One provider table, one request shape: Groq (whisper-large-v3) or
 * OpenAI (whisper-1), chosen by an explicit provider name or auto-detected from the environment.
 *
 * Plus the free on-machine provider, whisper.cpp (docs/specs/backup-on-machine-voice.md): used with
 * an explicit "local", when no paid provider is configured, and as the fallback when a paid one
 * fails. Every channel (Telegram, the app, Slack, WhatsApp) calls this one module.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import {
  LocalTranscriptionError, resolveLocalTranscriber, transcribeLocally,
  type LocalDetectOptions, type LocalTranscriberInfo,
} from './LocalVoiceTranscriber.js';

export interface TranscriptionProvider { name: string; apiKey: string; baseUrl: string; model: string }

const PROVIDERS: Readonly<Record<string, { envKey: string; baseUrl: string; model: string }>> = {
  groq: { envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  openai: { envKey: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
};

/** The vault name the voice-transcription setup recipe stores its key under (docs/specs/recommended-services.md). */
export const VOICE_TRANSCRIPTION_SECRET = 'voice_transcription_key';

/**
 * A key setup stored in the agent's vault, read on each transcription. Registered once by the server, so
 * every caller (Telegram, Slack, WhatsApp, the app) sees it without its own wiring. Null when none is set.
 */
let storedKeyReader: (() => string | null) | null = null;
export function registerStoredTranscriptionKey(reader: (() => string | null) | null): void {
  storedKeyReader = reader;
}

/** Which provider a key belongs to, from its published prefix. Groq keys start `gsk_`, OpenAI keys `sk-`. */
export function providerForKey(key: string): 'groq' | 'openai' | null {
  if (/^gsk_[A-Za-z0-9]{20,}$/.test(key)) return 'groq';
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return 'openai';
  return null;
}

export function providerSettings(name: 'groq' | 'openai'): { baseUrl: string; model: string } {
  const p = PROVIDERS[name]!;
  return { baseUrl: p.baseUrl, model: p.model };
}

/**
 * Thrown when nothing can transcribe here: no paid provider and no ready on-machine transcriber.
 * `missing` names what is missing in plain words; `userMessage` is the sentence for the person.
 * Callers check it with `instanceof`, never by its text.
 */
export class TranscriptionUnavailableError extends Error {
  readonly missing: string[];
  readonly userMessage: string;
  constructor(message = 'No voice transcription provider configured. Set GROQ_API_KEY or OPENAI_API_KEY.', missing: string[] = []) {
    super(missing.length ? `${message} Missing: ${missing.join(', ')}.` : message);
    this.name = 'TranscriptionUnavailableError';
    this.missing = missing;
    this.userMessage = `I can't transcribe voice notes on this machine yet: ${unavailableReason(missing)}. Ask me to set it up and I'll do it.`;
  }
}

/** A transcription attempt that failed, with a plain reason the channel passes on. */
export class TranscriptionFailedError extends Error {
  /**
   * `fault` is true for a real fault worth a degradation report (a paid provider error, a broken local
   * install); false for an outcome of one note (silent, busy, took too long, unreadable audio).
   */
  constructor(public readonly reason: string, public readonly provider: string | null = null, public readonly fault = true) {
    super(`Voice transcription failed: ${reason}`);
    this.name = 'TranscriptionFailedError';
  }
}

/** The plain reason for the person and the agent, from any transcription error. */
export function transcriptionFailureReason(err: unknown): string {
  if (err instanceof TranscriptionUnavailableError) return unavailableReason(err.missing);
  if (err instanceof TranscriptionFailedError) return err.reason;
  return 'the transcription service failed';
}

function unavailableReason(missing: string[]): string {
  if (missing.length === 0) return 'no transcription service is set up';
  if (missing.includes(LOCAL_OFF)) return 'on-machine transcription is switched off, and no transcription service is set up';
  return `the free on-machine transcriber (whisper.cpp) needs ${joinPlain(missing)}, and no transcription service is set up`;
}

function joinPlain(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const LOCAL_OFF = 'on-machine transcription is switched off';

/** `voiceTranscription.local` from the agent config; registered once by the server. Absent means on. */
let localEnabledReader: (() => boolean) | null = null;
export function registerLocalTranscriptionEnabled(reader: (() => boolean) | null): void {
  localEnabledReader = reader;
  cachedDescription = null;
}

/**
 * The `voice-unreadable` source (docs/specs/recommended-services.md, Real-problem events): told each time a voice
 * note meets nothing that can transcribe it. Registered once by the server. The listener gets a fixed channel token,
 * never error text, and a listener that throws never changes what the channel sees.
 */
let voiceUnreadableListener: ((evidenceRef: string) => void) | null = null;
export function registerVoiceUnreadableListener(listener: ((evidenceRef: string) => void) | null): void {
  voiceUnreadableListener = listener;
}

/** Every channel calls this when a voice note can't be read because nothing here can transcribe it. */
export function reportVoiceUnreadable(evidenceRef: string): void {
  try {
    voiceUnreadableListener?.(evidenceRef);
  } catch { /* @silent-fallback-ok — a signal only; the listener reports its own failures */ }
}

/** The config value as the server reads it: on unless explicitly `false`. */
export function localTranscriptionEnabledFromConfig(config: { voiceTranscription?: { local?: unknown } } | undefined): boolean {
  return config?.voiceTranscription?.local !== false;
}

export interface ResolveOptions {
  /** An explicit provider name (e.g. the Telegram config's `voiceProvider`). */
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Tests pass their own stored key; the server registers the vault reader once. */
  storedKey?: () => string | null;
}

/**
 * The provider to use, or null. An explicit, known provider whose key is missing is null (it is
 * never silently replaced by another vendor); otherwise Groq first (cheaper), then OpenAI.
 */
export function resolveTranscriptionProvider(opts: ResolveOptions = {}): TranscriptionProvider | null {
  const env = opts.env ?? process.env;
  const explicit = opts.explicit?.toLowerCase();
  if (explicit && PROVIDERS[explicit]) {
    const p = PROVIDERS[explicit];
    const apiKey = env[p.envKey];
    if (!apiKey) {
      const stored = storedProvider(opts);
      if (stored) return stored;
      opts.log?.(`${p.envKey} not set — required for ${explicit} voice transcription`);
      return null;
    }
    return { name: explicit, apiKey, baseUrl: p.baseUrl, model: p.model };
  }
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const apiKey = env[p.envKey];
    if (apiKey) {
      opts.log?.(`Auto-detected voice transcription provider: ${name}`);
      return { name, apiKey, baseUrl: p.baseUrl, model: p.model };
    }
  }
  return storedProvider(opts);
}

/** The key setup stored, when nothing in the environment answers. An explicit provider is never replaced by another vendor. */
function storedProvider(opts: ResolveOptions): TranscriptionProvider | null {
  let key: string | null = null;
  try {
    key = (opts.storedKey ?? storedKeyReader)?.() ?? null;
  } catch {
    return null; // @silent-fallback-ok — an unreadable vault is "no stored key", and the caller says transcription is unavailable
  }
  if (!key) return null;
  const name = providerForKey(key);
  if (!name) return null;
  const explicit = opts.explicit?.toLowerCase();
  if (explicit && PROVIDERS[explicit] && explicit !== name) return null;
  const p = PROVIDERS[name]!;
  return { name, apiKey: key, baseUrl: p.baseUrl, model: p.model };
}

export interface TranscribeOptions extends ResolveOptions {
  /** The audio's media type (Telegram voice notes are OGG; app voice notes are usually M4A). */
  mediaType?: string;
  /** The whole budget for this call: paid attempt, fallback, queue wait and the local run. Default 60 s. */
  timeoutMs?: number;
  /** A fixed token naming the channel (`telegram`, `app`), passed to the voice-unreadable signal. Default `voice-note`. */
  channel?: string;
  fetchImpl?: typeof fetch;
  /** Overrides the registered `voiceTranscription.local` setting (tests). */
  localEnabled?: boolean;
  /** Detection options for the on-machine transcriber (tests). */
  local?: Omit<LocalDetectOptions, 'now'> & { lockDir?: string; execFileImpl?: Parameters<typeof transcribeLocally>[1]['execFileImpl'] };
  now?: () => number;
}

export interface TranscriptResult { text: string; provider: string }

const DEFAULT_BUDGET_MS = 60_000;
const PAID_MAX_MS = 60_000;
/** Kept back from a paid call when local is ready, so a hanging paid service still leaves time for the fallback. */
const LOCAL_RESERVE_MS = 20_000;
/** Below this, a fallback can't finish even a short note, so the paid error is reported instead. */
const FALLBACK_MIN_MS = 5_000;

const PROVIDER_LABELS: Record<string, string> = { groq: 'Groq', openai: 'OpenAI' };

class PaidTranscriptionError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly timedOut = false) {
    super(message);
    this.name = 'PaidTranscriptionError';
  }
}

const keyRefusalReported = new Set<string>();

function paidReason(provider: TranscriptionProvider, err: unknown): string {
  const label = PROVIDER_LABELS[provider.name] ?? provider.name;
  if (err instanceof PaidTranscriptionError) {
    if (err.timedOut) return `${label} took too long to answer`;
    if (err.status === 401 || err.status === 402 || err.status === 403) return `${label} refused the transcription key (${err.status})`;
    if (err.status !== null) return `${label} answered with an error (${err.status})`;
  }
  return `${label} could not be reached`;
}

/** Transcribe one audio file. Throws `TranscriptionUnavailableError` with nothing to use, `TranscriptionFailedError` on failure. */
export async function transcribeAudioFile(filePath: string, opts: TranscribeOptions = {}): Promise<string> {
  return (await transcribeAudioFileDetailed(filePath, opts)).text;
}

/** As `transcribeAudioFile`, with the provider that actually produced the text (`groq`, `openai`, `local`). */
export async function transcribeAudioFileDetailed(filePath: string, opts: TranscribeOptions = {}): Promise<TranscriptResult> {
  try {
    return await transcribeDetailedInner(filePath, opts);
  } catch (err) {
    if (err instanceof TranscriptionUnavailableError) reportVoiceUnreadable(opts.channel ?? 'voice-note');
    throw err;
  }
}

async function transcribeDetailedInner(filePath: string, opts: TranscribeOptions): Promise<TranscriptResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_BUDGET_MS);
  const explicit = opts.explicit?.toLowerCase();
  const localEnabled = opts.localEnabled ?? localEnabledReader?.() ?? true;
  const localInfo = (): LocalTranscriberInfo => resolveLocalTranscriber({ ...opts.local, now });

  const runLocal = async (): Promise<TranscriptResult> => {
    try {
      const text = await transcribeLocally(filePath, { ...opts.local, now, deadline });
      return { text, provider: 'local' };
    } catch (err) {
      if (err instanceof LocalTranscriptionError) throw new TranscriptionFailedError(err.message, 'local', err.kind === 'install');
      throw err;
    }
  };
  const noLocal = (info: LocalTranscriberInfo | null): never => {
    if (!info) throw new TranscriptionUnavailableError(undefined, [LOCAL_OFF]);
    if (info.state === 'failed') throw new TranscriptionFailedError(`on-machine transcription failed recently (${info.lastFailure?.reason ?? 'unknown reason'})`, 'local');
    throw new TranscriptionUnavailableError(undefined, info.missing);
  };

  if (explicit === 'local') {
    if (!localEnabled) noLocal(null);
    const info = localInfo();
    if (!info.ready) noLocal(info);
    return runLocal();
  }

  const paid = resolveTranscriptionProvider(opts);
  const local = localEnabled ? localInfo() : null;
  if (paid) {
    const reserve = local?.ready ? LOCAL_RESERVE_MS : 0;
    const paidDeadline = Math.min(now() + PAID_MAX_MS, deadline - reserve);
    try {
      const text = await transcribeWithPaid(paid, filePath, opts, paidDeadline, now);
      keyRefusalReported.delete(paid.name); // a working key re-arms the report for the next refusal
      return { text, provider: paid.name };
    } catch (err) {
      const reason = paidReason(paid, err);
      opts.log?.(`voice transcription via ${paid.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      const refused = err instanceof PaidTranscriptionError && (err.status === 401 || err.status === 402 || err.status === 403);
      if (refused && !keyRefusalReported.has(paid.name)) {
        keyRefusalReported.add(paid.name);
        DegradationReporter.getInstance().report({
          feature: 'VoiceTranscription.paidKey',
          primary: `Transcribe voice notes with ${PROVIDER_LABELS[paid.name] ?? paid.name}`,
          fallback: local?.ready ? 'Voice notes are read on this machine with whisper.cpp meanwhile' : 'Voice notes can not be transcribed until the key is fixed',
          reason,
          impact: 'The transcription key stopped working. Offer the person to fix or replace the key (the voice-transcription setup recipe).',
        });
      }
      if (!local?.ready || deadline - now() < FALLBACK_MIN_MS) throw new TranscriptionFailedError(reason, paid.name);
      try {
        return await runLocal();
      } catch (localErr) {
        // Both failed: keep both reasons, so the paid fault isn't hidden behind the local one.
        if (localErr instanceof TranscriptionFailedError) throw new TranscriptionFailedError(`${reason}, and on-machine transcription failed: ${localErr.reason}`, paid.name, true);
        throw localErr;
      }
    }
  }
  if (!local?.ready) noLocal(local);
  return runLocal();
}

/** The paid call, bounded by an absolute deadline that covers reading the file as well as the request. */
async function transcribeWithPaid(provider: TranscriptionProvider, filePath: string, opts: TranscribeOptions, deadline: number, now: () => number): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  if (deadline - now() <= 0) throw new PaidTranscriptionError('Transcription API skipped: no time left', null, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - now()));
  try {
    const formData = new FormData();
    let fileBuffer: Buffer;
    try {
      fileBuffer = await fs.promises.readFile(filePath, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new PaidTranscriptionError('Transcription API timed out', null, true);
      throw err;
    }
    if (controller.signal.aborted) throw new PaidTranscriptionError('Transcription API timed out', null, true);
    const blob = new Blob([fileBuffer], { type: opts.mediaType ?? 'audio/ogg' });
    formData.append('file', blob, path.basename(filePath));
    formData.append('model', provider.model);
    let response: Response;
    try {
      response = await doFetch(`${provider.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: formData,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new PaidTranscriptionError('Transcription API timed out', null, true);
      throw new PaidTranscriptionError(`Transcription API unreachable: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new PaidTranscriptionError(`Transcription API error (${response.status}): ${errText}`, response.status);
    }
    const data = await response.json() as { text?: unknown };
    if (typeof data.text !== 'string') throw new PaidTranscriptionError('Transcription API returned no text', response.status);
    return data.text;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a voice note can be transcribed here: a paid provider is configured or local is ready. File checks only. */
export function canTranscribe(opts: Omit<TranscribeOptions, 'timeoutMs' | 'fetchImpl' | 'mediaType'> = {}): boolean {
  const localEnabled = opts.localEnabled ?? localEnabledReader?.() ?? true;
  const localReady = localEnabled && resolveLocalTranscriber({ ...opts.local, now: opts.now }).ready;
  if (opts.explicit?.toLowerCase() === 'local') return localReady;
  return localReady || resolveTranscriptionProvider(opts) !== null;
}

/** The plain reason nothing can transcribe here right now (for a placeholder line). */
export function cannotTranscribeReason(opts: Omit<TranscribeOptions, 'timeoutMs' | 'fetchImpl' | 'mediaType'> = {}): string {
  const localEnabled = opts.localEnabled ?? localEnabledReader?.() ?? true;
  if (!localEnabled) return unavailableReason([LOCAL_OFF]);
  const info = resolveLocalTranscriber({ ...opts.local, now: opts.now });
  if (info.state === 'failed') return `on-machine transcription failed recently (${info.lastFailure?.reason ?? 'unknown reason'})`;
  return unavailableReason(info.missing);
}

export interface VoiceTranscriptionStatus {
  /** What a voice note would use right now. */
  active: 'groq' | 'openai' | 'local' | null;
  paid: string | null;
  localEnabled: boolean;
  local: LocalTranscriberInfo | null;
  /** True when a paid provider is first and local stands behind it. */
  fallback: boolean;
  machine: string;
  /** False when the description skipped the vault key (the /capabilities path never reads the keychain). */
  storedKeyChecked: boolean;
  summary: string;
  checkedAt: string;
}

let cachedDescription: { at: number; value: VoiceTranscriptionStatus } | null = null;
const DESCRIPTION_CACHE_MS = 60_000;

/**
 * Which transcriber a voice note on this machine would use, in data and in one plain sentence.
 * `cachedOnly` (the synchronous /capabilities path) returns the last full description, or one
 * built without the vault key so no keychain read or process start happens there.
 */
export function describeVoiceTranscription(opts: Omit<TranscribeOptions, 'timeoutMs' | 'fetchImpl' | 'mediaType'> & { cachedOnly?: boolean; noCache?: boolean } = {}): VoiceTranscriptionStatus {
  const now = (opts.now ?? Date.now)();
  if (opts.cachedOnly && cachedDescription && now - cachedDescription.at < DESCRIPTION_CACHE_MS) return cachedDescription.value;
  const machine = os.hostname();
  const localEnabled = opts.localEnabled ?? localEnabledReader?.() ?? true;
  const local = localEnabled ? resolveLocalTranscriber({ ...opts.local, now: opts.now, noCache: opts.noCache || opts.local?.noCache }) : null;
  const storedKeyChecked = !opts.cachedOnly;
  const paidProvider = resolveTranscriptionProvider(storedKeyChecked ? opts : { ...opts, storedKey: () => null });
  const explicitLocal = opts.explicit?.toLowerCase() === 'local';
  const paid = explicitLocal ? null : paidProvider?.name ?? null;
  const active = paid ? (paid as 'groq' | 'openai') : local?.ready ? 'local' : null;
  const label = paid ? (PROVIDER_LABELS[paid] ?? paid) : '';
  let summary: string;
  if (paid && local?.ready) summary = `On ${machine}, voice notes are transcribed by ${label}, with whisper.cpp on this machine as the backup.`;
  else if (paid) summary = `On ${machine}, voice notes are transcribed by ${label}. ${local ? `There is no on-machine backup (missing ${joinPlain(local.missing)}${local.state === 'failed' ? `; last run failed: ${local.lastFailure?.reason}` : ''}).` : 'On-machine transcription is switched off.'}`;
  else if (local?.ready) summary = `On ${machine}, voice notes are transcribed on this machine with whisper.cpp (free; the audio never leaves the machine)${local.state === 'proven' ? '' : ', not yet proven by a real voice note'}.`;
  else if (local?.state === 'failed') summary = `On ${machine}, whisper.cpp is installed but its last run failed (${local.lastFailure?.reason}); it will be tried again soon. No transcription service is set up.`;
  else summary = `On ${machine}, voice notes can't be transcribed yet: ${unavailableReason(local ? local.missing : [LOCAL_OFF])}.`;
  const value: VoiceTranscriptionStatus = {
    active, paid, localEnabled, local, fallback: Boolean(paid && local?.ready), machine, storedKeyChecked, summary,
    checkedAt: new Date(now).toISOString(),
  };
  if (storedKeyChecked) cachedDescription = { at: now, value };
  return value;
}

/** Test hook. */
export function resetVoiceTranscriptionState(): void {
  cachedDescription = null;
  keyRefusalReported.clear();
}

/**
 * The agent's explicit voice provider, if any: the Telegram messaging config's `voiceProvider`
 * (the one setting Telegram voice notes already honor), so app voice notes use the same vendor.
 */
export function configuredVoiceProvider(config: { messaging?: ReadonlyArray<{ type: string; config?: unknown }> }): string | undefined {
  const tg = config.messaging?.find((m) => m.type === 'telegram')?.config as { voiceProvider?: unknown } | undefined;
  return typeof tg?.voiceProvider === 'string' ? tg.voiceProvider : undefined;
}
