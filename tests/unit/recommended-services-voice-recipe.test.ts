/**
 * The voice-transcription setup recipe (docs/specs/recommended-services.md, catalog row voice-transcription):
 * a key setup stores in the vault reaches every transcription caller; the check proves the provider accepts
 * the key and offers its model; the switch-off removes only setup's own key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { catalogWithProving, recipeFor, type StopDeps } from '../../src/recommended/recipes.js';
import {
  VOICE_TRANSCRIPTION_SECRET, providerForKey, registerStoredTranscriptionKey, resolveTranscriptionProvider,
} from '../../src/core/VoiceTranscription.js';

const GROQ = 'gsk_' + 'a'.repeat(52);
const OPENAI = 'sk-' + 'b'.repeat(48);
const row = RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'voice-transcription')!;
const recipe = recipeFor({ ...row, setupRecipe: 'voice-v1' })!;
const secrets = (names: Record<string, string>) => (n: string) => names[n] ?? null;
const fetchWith = (status: number, models: string[] = []) => (async (url: string) => {
  calls.push(String(url));
  return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status });
}) as unknown as typeof fetch;
let calls: string[] = [];

afterEach(() => { registerStoredTranscriptionKey(null); calls = []; });

describe('a stored transcription key', () => {
  it('names its provider from its prefix, and nothing else', () => {
    expect(providerForKey(GROQ)).toBe('groq');
    expect(providerForKey(OPENAI)).toBe('openai');
    expect(providerForKey('gsk_short')).toBeNull();
    expect(providerForKey('some-other-key-value-that-is-long')).toBeNull();
  });

  it('is used when the environment has no key, through the one reader the server registers', () => {
    expect(resolveTranscriptionProvider({ env: {} })).toBeNull();
    registerStoredTranscriptionKey(() => GROQ);
    expect(resolveTranscriptionProvider({ env: {} })).toMatchObject({ name: 'groq', apiKey: GROQ, model: 'whisper-large-v3' });
    registerStoredTranscriptionKey(() => OPENAI);
    expect(resolveTranscriptionProvider({ env: {} })).toMatchObject({ name: 'openai', model: 'whisper-1' });
  });

  it('never replaces a key from the environment, and never stands in for a different explicit vendor', () => {
    registerStoredTranscriptionKey(() => GROQ);
    expect(resolveTranscriptionProvider({ env: { OPENAI_API_KEY: OPENAI } })).toMatchObject({ name: 'openai' });
    expect(resolveTranscriptionProvider({ env: {}, explicit: 'openai' })).toBeNull();
    expect(resolveTranscriptionProvider({ env: {}, explicit: 'groq' })).toMatchObject({ name: 'groq', apiKey: GROQ });
  });

  it('an unreadable vault reads as no key', () => {
    registerStoredTranscriptionKey(() => { throw new Error('locked'); });
    expect(resolveTranscriptionProvider({ env: {} })).toBeNull();
  });
});

describe('the voice-v1 recipe', () => {
  it('is available on every agent after its live proof (2026-11-08)', () => {
    expect(row.setupRecipe).toBe('voice-v1');
    expect(recipe.service).toBe('voice-transcription');
    expect(recipe.secretName).toBe(VOICE_TRANSCRIPTION_SECRET);
    expect(recipeFor(catalogWithProving(['voice-v1'], () => true).find((r) => r.id === 'voice-transcription')!)?.id).toBe('voice-v1');
    expect(catalogWithProving([], () => false).find((r) => r.id === 'voice-transcription')!.setupRecipe).toBe('voice-v1');
  });

  it('passes only when the provider accepts the key and offers its transcription model', async () => {
    expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: GROQ }), fetch: fetchWith(200, ['whisper-large-v3', 'llama']) })).result).toBe('pass');
    expect(calls).toEqual(['https://api.groq.com/openai/v1/models']);
    expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: OPENAI }), fetch: fetchWith(200, ['whisper-1']) })).result).toBe('pass');
    expect(calls[1]).toBe('https://api.openai.com/v1/models');
    expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: GROQ }), fetch: fetchWith(200, ['llama']) })).result).toBe('fail');
    expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: GROQ }), fetch: fetchWith(401) })).result).toBe('fail');
    expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: GROQ }), fetch: fetchWith(503) })).result).toBe('unknown');
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: GROQ }), fetch: down })).result).toBe('unknown');
  });

  it('with no key anywhere it is absent; a key of the wrong shape fails; the person own environment key counts', async () => {
    const saved = { g: process.env.GROQ_API_KEY, o: process.env.OPENAI_API_KEY };
    delete process.env.GROQ_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      expect(await recipe.verify({ readSecret: secrets({}), fetch: fetchWith(200, ['whisper-large-v3']) })).toMatchObject({ result: 'fail', absent: true });
      expect((await recipe.verify({ readSecret: secrets({ [VOICE_TRANSCRIPTION_SECRET]: 'not-a-key' }), fetch: fetchWith(200) })).result).toBe('fail');
      process.env.GROQ_API_KEY = GROQ;
      expect((await recipe.verify({ readSecret: secrets({}), fetch: fetchWith(200, ['whisper-large-v3']) })).result).toBe('pass');
    } finally {
      if (saved.g === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved.g;
      if (saved.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.o;
    }
  });

  it('a switch-off removes only the key setup stored', async () => {
    const deleted: string[] = [];
    const deps = (have: boolean, setUpHere: boolean): StopDeps => ({
      readSecret: secrets(have ? { [VOICE_TRANSCRIPTION_SECRET]: GROQ } : {}), deleteSecret: (n) => { deleted.push(n); }, setUpHere,
    } as StopDeps);
    expect(await recipe.stop!(deps(true, true))).toMatchObject({ stopped: true, changed: true });
    expect(deleted).toEqual([VOICE_TRANSCRIPTION_SECRET]);
    expect(await recipe.stop!(deps(true, false))).toMatchObject({ stopped: true, changed: false });
    expect(await recipe.stop!(deps(false, true))).toMatchObject({ stopped: true, changed: false });
    expect(deleted).toHaveLength(1);
  });

  it('the brief keeps the key out of chat and commands, offers both accounts, and gives the person no task', () => {
    const brief = recipe.brief({ port: 4042 });
    expect(brief).toContain('/recommended-services/voice-transcription/key');
    expect(brief).toContain("don't print it");
    expect(brief).toContain('never recommend against either');
    expect(brief).toContain('through one Secret Drop, never in chat');
    expect(brief).not.toMatch(/ask (them|the person) to (go|visit|open|run|paste)/i);
  });
});
