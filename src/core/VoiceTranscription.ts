/**
 * Server-side voice transcription, shared by the Telegram voice handler and app conversations
 * (docs/specs/mobile-native-chat-media.md §4.5.1: "extracted into a shared VoiceTranscription
 * module that both call"). One provider table, one request shape: Groq (whisper-large-v3) or
 * OpenAI (whisper-1), chosen by an explicit provider name or auto-detected from the environment.
 */
import fs from 'node:fs';
import path from 'node:path';

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

/** Thrown when no provider is configured: the caller says "transcription unavailable", never retries. */
export class TranscriptionUnavailableError extends Error {
  constructor(message = 'No voice transcription provider configured. Set GROQ_API_KEY or OPENAI_API_KEY.') {
    super(message);
    this.name = 'TranscriptionUnavailableError';
  }
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
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Transcribe one audio file. Throws `TranscriptionUnavailableError` with no provider, `Error` on failure. */
export async function transcribeAudioFile(filePath: string, opts: TranscribeOptions = {}): Promise<string> {
  const provider = resolveTranscriptionProvider(opts);
  if (!provider) throw new TranscriptionUnavailableError();
  const doFetch = opts.fetchImpl ?? fetch;

  const formData = new FormData();
  const fileBuffer = await fs.promises.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: opts.mediaType ?? 'audio/ogg' });
  formData.append('file', blob, path.basename(filePath));
  formData.append('model', provider.model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const response = await doFetch(`${provider.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: formData,
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Transcription API error (${response.status}): ${errText}`);
    }
    const data = await response.json() as { text?: unknown };
    if (typeof data.text !== 'string') throw new Error('Transcription API returned no text');
    return data.text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The agent's explicit voice provider, if any: the Telegram messaging config's `voiceProvider`
 * (the one setting Telegram voice notes already honor), so app voice notes use the same vendor.
 */
export function configuredVoiceProvider(config: { messaging?: ReadonlyArray<{ type: string; config?: unknown }> }): string | undefined {
  const tg = config.messaging?.find((m) => m.type === 'telegram')?.config as { voiceProvider?: unknown } | undefined;
  return typeof tg?.voiceProvider === 'string' ? tg.voiceProvider : undefined;
}
