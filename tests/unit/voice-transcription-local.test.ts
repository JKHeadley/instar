/**
 * On-machine voice transcription (docs/specs/backup-on-machine-voice.md).
 *
 * Fake `ffmpeg` / `whisper-cli` shell scripts stand in for the real programs and replay the REAL
 * captured whisper.cpp 1.9.5 output in tests/fixtures/voice/. Where the real programs are installed
 * (the Studio), a few cases also run them on the real Opus fixtures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ffmpegArgs, measureWav, parseWhisperOutput, resetLocalTranscriberState, resolveLocalTranscriber,
  transcribeLocally, LocalTranscriptionError, whisperArgs, LOCAL_FAILED_WINDOW_MS,
} from '../../src/core/LocalVoiceTranscriber.js';
import {
  canTranscribe, cannotTranscribeReason, describeVoiceTranscription, resetVoiceTranscriptionState,
  transcribeAudioFileDetailed, transcriptionFailureReason, TranscriptionFailedError, TranscriptionUnavailableError,
} from '../../src/core/VoiceTranscription.js';

const FIXTURES = path.resolve(__dirname, '../fixtures/voice');
const REAL_SPEECH_STDOUT = path.join(FIXTURES, 'whisper-cli-1.9.5-speech.stdout');
const REAL_SILENCE_STDOUT = path.join(FIXTURES, 'whisper-cli-1.9.5-silence.stdout');

/** A 16 kHz mono 16-bit WAV: a 440 Hz tone (or silence) of the given length. */
function wavBuffer(seconds: number, amplitude: number): Buffer {
  const samples = Math.round(16000 * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

interface Rig {
  root: string; home: string; bin: string; models: string; lockDir: string; audio: string;
  env: NodeJS.ProcessEnv; local: { env: NodeJS.ProcessEnv; homeDir: string; fixedDirs: string[]; lockDir: string; noCache: boolean };
}

/** A temp home with fake programs. `whisper` and `ffmpeg` are shell bodies. */
function makeRig(opts: { whisper?: string | null; ffmpeg?: string | null; model?: boolean; wav?: Buffer } = {}): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-local-test-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const models = path.join(home, '.local', 'share', 'instar', 'models');
  const lockDir = path.join(root, 'lock');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(models, { recursive: true });
  const source = path.join(root, 'source.wav');
  fs.writeFileSync(source, opts.wav ?? wavBuffer(3, 8000));
  if (opts.ffmpeg !== null) {
    // Default fake ffmpeg: copy the prepared WAV to the output path (the last argument).
    const body = opts.ffmpeg ?? `for a; do out="$a"; done; cp "${source}" "$out"`;
    fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  if (opts.whisper !== null) {
    const body = opts.whisper ?? `cat "${REAL_SPEECH_STDOUT}"`;
    fs.writeFileSync(path.join(bin, 'whisper-cli'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  if (opts.model !== false) {
    const model = Buffer.alloc(1024 * 1024 + 16);
    model.write('lmgg', 0, 'latin1');
    fs.writeFileSync(path.join(models, 'ggml-base.bin'), model);
  }
  const audio = path.join(root, 'note.ogg');
  fs.writeFileSync(audio, 'not really ogg; the fake ffmpeg ignores it');
  const env: NodeJS.ProcessEnv = { PATH: bin };
  return { root, home, bin, models, lockDir, audio, env, local: { env, homeDir: home, fixedDirs: [], lockDir, noCache: true } };
}

let rigs: Rig[] = [];
function rig(o?: Parameters<typeof makeRig>[0]): Rig { const r = makeRig(o); rigs.push(r); return r; }

beforeEach(() => { resetLocalTranscriberState(); resetVoiceTranscriptionState(); });
afterEach(() => { for (const r of rigs) SafeFsExecutor.safeRmSync(r.root, { recursive: true, force: true, operation: 'tests/unit/voice-transcription-local.test.ts' }); rigs = []; });

describe('detection', () => {
  it('finds program, model and ffmpeg and starts installed-unproven', () => {
    const r = rig();
    const info = resolveLocalTranscriber(r.local);
    expect(info.state).toBe('installed-unproven');
    expect(info.ready).toBe(true);
    expect(info.binary).toBe(path.join(r.bin, 'whisper-cli'));
    expect(info.model).toBe(path.join(r.models, 'ggml-base.bin'));
  });

  it('names every missing piece in plain words', () => {
    const r = rig({ whisper: null, ffmpeg: null, model: false });
    const info = resolveLocalTranscriber(r.local);
    expect(info.state).toBe('missing');
    expect(info.missing).toEqual(['the whisper.cpp program', 'a whisper model file', 'ffmpeg']);
  });

  it('rejects a model without the ggml magic or too small (a half download)', () => {
    const r = rig({ model: false });
    fs.writeFileSync(path.join(r.models, 'ggml-base.bin'), Buffer.alloc(2 * 1024 * 1024)); // zeros, no magic
    fs.writeFileSync(path.join(r.models, 'ggml-tiny.bin'), Buffer.from('lmgg tiny'));       // magic, too small
    expect(resolveLocalTranscriber(r.local).missing).toContain('a whisper model file');
  });

  it('ignores a .part download and prefers base over others', () => {
    const r = rig();
    const big = Buffer.alloc(1024 * 1024 + 16); big.write('lmgg', 0, 'latin1');
    fs.writeFileSync(path.join(r.models, 'ggml-aaa.bin'), big);
    fs.writeFileSync(path.join(r.models, 'ggml-small.bin.part'), big);
    expect(resolveLocalTranscriber(r.local).model).toBe(path.join(r.models, 'ggml-base.bin'));
  });

  it('honours INSTAR_WHISPER_CLI and the legacy media folder; skips relative PATH entries', () => {
    const r = rig({ whisper: null, model: false });
    const other = path.join(r.root, 'elsewhere'); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'my-whisper'), '#!/bin/sh\n', { mode: 0o755 });
    const media = path.join(r.home, '.local', 'share', 'instar', 'media'); fs.mkdirSync(media, { recursive: true });
    const big = Buffer.alloc(1024 * 1024 + 16); big.write('lmgg', 0, 'latin1');
    fs.writeFileSync(path.join(media, 'ggml-base.bin'), big);
    const env = { PATH: `relative/bin${path.delimiter}${r.bin}`, INSTAR_WHISPER_CLI: path.join(other, 'my-whisper') };
    const info = resolveLocalTranscriber({ ...r.local, env });
    expect(info.binary).toBe(path.join(other, 'my-whisper'));
    expect(info.model).toBe(path.join(media, 'ggml-base.bin'));
  });

  it('finds the older whisper-cpp binary name in a fixed directory', () => {
    const r = rig({ whisper: null });
    const fixed = path.join(r.root, 'fixed'); fs.mkdirSync(fixed);
    fs.writeFileSync(path.join(fixed, 'whisper-cpp'), '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveLocalTranscriber({ ...r.local, fixedDirs: [fixed] }).binary).toBe(path.join(fixed, 'whisper-cpp'));
  });
});

describe('argument lists', () => {
  it('ffmpeg is hardened for untrusted input', () => {
    const a = ffmpegArgs('/in/v.ogg', '/out/a.wav');
    expect(a.slice(0, 4)).toEqual(['-nostdin', '-hide_banner', '-loglevel', 'error']);
    expect(a[a.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(a[a.indexOf('-format_whitelist') + 1]).not.toMatch(/hls|concat|dash|image2/);
    expect(a[a.indexOf('-i') + 1]).toBe('file:/in/v.ogg');
    expect(a[a.indexOf('-t') + 1]).toBe('7200');
    expect(a).not.toContain('-enable_drefs');
    expect(a.at(-1)).toBe('/out/a.wav');
  });
  it('whisper runs with no timestamps and no prints', () => {
    expect(whisperArgs('/m.bin', '/a.wav', 3)).toEqual(['-m', '/m.bin', '-f', '/a.wav', '-nt', '-np', '-t', '3']);
  });
});

describe('real whisper.cpp output (captured fixtures)', () => {
  it('parses the real speech output', () => {
    expect(parseWhisperOutput(fs.readFileSync(REAL_SPEECH_STDOUT, 'utf8')))
      .toBe('Hello Echo, this is a test voice note about the local transcriber.');
  });
  it('the real silence output is a hallucinated word, which is why silence is measured from audio', () => {
    expect(parseWhisperOutput(fs.readFileSync(REAL_SILENCE_STDOUT, 'utf8'))).toBe('you');
  });
  it('[BLANK_AUDIO] alone means silence', () => {
    expect(parseWhisperOutput('\n [BLANK_AUDIO]\n')).toBeNull();
  });
});

describe('measureWav', () => {
  it('reads peak and duration', async () => {
    const r = rig();
    const f = path.join(r.root, 't.wav');
    fs.writeFileSync(f, wavBuffer(2, 5000));
    const m = await measureWav(f);
    expect(m.seconds).toBeCloseTo(2, 2);
    expect(m.peak).toBeGreaterThan(4900);
    fs.writeFileSync(f, wavBuffer(1, 0));
    expect((await measureWav(f)).peak).toBe(0);
  });
});

describe('transcribeLocally', () => {
  it('returns the real transcript and becomes proven', async () => {
    const r = rig();
    const text = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 30_000 });
    expect(text).toBe('Hello Echo, this is a test voice note about the local transcriber.');
    expect(resolveLocalTranscriber(r.local).state).toBe('proven');
  });

  it('a silent recording fails as silent without running whisper, and does not change readiness', async () => {
    const marker = path.join(os.tmpdir(), `whisper-ran-${process.pid}-${Date.now()}`);
    const r = rig({ wav: wavBuffer(3, 0), whisper: `touch "${marker}"; cat "${REAL_SILENCE_STDOUT}"` });
    const err = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 30_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(LocalTranscriptionError);
    expect(err.kind).toBe('silent');
    expect(err.message).toMatch(/seems to be silent/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(resolveLocalTranscriber(r.local).state).toBe('installed-unproven');
  });

  it('ffmpeg refusing the input is a per-note failure (a junk attachment cannot disable local)', async () => {
    const r = rig({ ffmpeg: 'echo "Invalid data found" >&2; exit 1' });
    const err = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 30_000 }).catch((e) => e);
    expect(err.kind).toBe('request');
    expect(resolveLocalTranscriber(r.local).ready).toBe(true);
  });

  it('whisper failing on a good WAV is an install failure: local sits out, then a file change re-checks', async () => {
    const r = rig({ whisper: 'echo "failed to load model" >&2; exit 2' });
    const err = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 30_000 }).catch((e) => e);
    expect(err.kind).toBe('install');
    expect(err.message).toMatch(/model file may be damaged/);
    const info = resolveLocalTranscriber(r.local);
    expect(info.state).toBe('failed');
    expect(info.ready).toBe(false);
    // Past the window it is tried again.
    expect(resolveLocalTranscriber({ ...r.local, now: () => Date.now() + LOCAL_FAILED_WINDOW_MS + 1 }).ready).toBe(true);
    // Replacing the program re-checks at once.
    fs.writeFileSync(path.join(r.bin, 'whisper-cli'), `#!/bin/sh\ncat "${REAL_SPEECH_STDOUT}"\n`, { mode: 0o755 });
    fs.utimesSync(path.join(r.bin, 'whisper-cli'), new Date(), new Date(Date.now() + 5_000));
    expect(resolveLocalTranscriber(r.local).ready).toBe(true);
  });

  it('a replaced install after a success is unproven again', async () => {
    const r = rig();
    await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 30_000 });
    expect(resolveLocalTranscriber(r.local).state).toBe('proven');
    fs.utimesSync(path.join(r.models, 'ggml-base.bin'), new Date(), new Date(Date.now() + 5_000));
    expect(resolveLocalTranscriber(r.local).state).toBe('installed-unproven');
  });

  it('kills a stuck whisper at the deadline and reports took too long', async () => {
    const r = rig({ whisper: 'sleep 30' });
    const started = Date.now();
    const err = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 1_500 }).catch((e) => e);
    expect(err.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(resolveLocalTranscriber(r.local).ready).toBe(true); // a timeout is per-note
  });

  it('fails fast as busy when a note cannot fit behind the running job', async () => {
    const r = rig({ wav: wavBuffer(30, 8000), whisper: `sleep 2; cat "${REAL_SPEECH_STDOUT}"` });
    const long = transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 120_000 });
    await new Promise((res) => setTimeout(res, 400)); // let it measure and publish its estimate
    const err = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 10_000 }).catch((e) => e);
    expect(err.kind).toBe('busy');
    await long;
  });

  it('serves waiting notes earliest deadline first', async () => {
    const r = rig({ wav: wavBuffer(1, 8000), whisper: `sleep 0.3; cat "${REAL_SPEECH_STDOUT}"` });
    const order: string[] = [];
    const first = transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 60_000 }).then(() => order.push('first'));
    await new Promise((res) => setTimeout(res, 50));
    const late = transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 120_000 }).then(() => order.push('long-deadline'));
    const soon = transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 50_000 }).then(() => order.push('short-deadline'));
    await Promise.all([first, late, soon]);
    expect(order).toEqual(['first', 'short-deadline', 'long-deadline']);
  });

  it('takes over a lock left by a dead process, and never removes a live one', async () => {
    const r = rig();
    const lock = path.join(r.lockDir, 'instar-whisper-run.lock');
    fs.mkdirSync(lock, { recursive: true });
    // A pid that is not running.
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', startedAt: Date.now(), expectedEnd: Date.now() + 1000 }));
    await expect(transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 10_000 })).resolves.toMatch(/Hello Echo/);
    expect(fs.existsSync(lock)).toBe(false); // released after the run

    // A live owner (this process) with a long expected end: the note fails as busy and the lock stays.
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live', startedAt: Date.now(), expectedEnd: Date.now() + 60_000 }));
    const err = await transcribeLocally(r.audio, { ...r.local, deadline: Date.now() + 10_000 }).catch((e) => e);
    expect(err.kind).toBe('busy');
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).token).toBe('live');
  });
});

describe('order of preference (VoiceTranscription)', () => {
  const okFetch = (async () => new Response(JSON.stringify({ text: 'from groq' }), { status: 200 })) as unknown as typeof fetch;
  const failFetch = (status: number) => (async () => new Response('nope', { status })) as unknown as typeof fetch;

  it('uses local when no paid provider is configured', async () => {
    const r = rig();
    const res = await transcribeAudioFileDetailed(r.audio, { env: {}, storedKey: () => null, local: r.local, localEnabled: true });
    expect(res).toEqual({ text: 'Hello Echo, this is a test voice note about the local transcriber.', provider: 'local' });
  });

  it('uses the paid provider first when configured', async () => {
    const r = rig();
    const res = await transcribeAudioFileDetailed(r.audio, { env: { GROQ_API_KEY: 'gsk_x' }, storedKey: () => null, local: r.local, fetchImpl: okFetch, localEnabled: true });
    expect(res).toEqual({ text: 'from groq', provider: 'groq' });
  });

  it('falls back to local when the paid call fails, and names both reasons if local fails too', async () => {
    const r = rig();
    const res = await transcribeAudioFileDetailed(r.audio, { env: { GROQ_API_KEY: 'gsk_x' }, storedKey: () => null, local: r.local, fetchImpl: failFetch(503), localEnabled: true });
    expect(res.provider).toBe('local');
    const r2 = rig({ ffmpeg: 'exit 1' });
    resetLocalTranscriberState();
    const err = await transcribeAudioFileDetailed(r2.audio, { env: { GROQ_API_KEY: 'gsk_x' }, storedKey: () => null, local: r2.local, fetchImpl: failFetch(500), localEnabled: true }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionFailedError);
    expect(err.reason).toMatch(/Groq answered with an error \(500\), and on-machine transcription failed/);
  });

  it('an explicit paid provider whose key is missing uses local', async () => {
    const r = rig();
    const res = await transcribeAudioFileDetailed(r.audio, { explicit: 'openai', env: {}, storedKey: () => null, local: r.local, localEnabled: true });
    expect(res.provider).toBe('local');
  });

  it('explicit "local" never calls the paid provider', async () => {
    const r = rig();
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    const res = await transcribeAudioFileDetailed(r.audio, { explicit: 'local', env: { GROQ_API_KEY: 'gsk_x' }, storedKey: () => null, local: r.local, fetchImpl: spy, localEnabled: true });
    expect(res.provider).toBe('local');
    expect(called).toBe(false);
  });

  it('local off restores the old behaviour', async () => {
    const r = rig();
    const err = await transcribeAudioFileDetailed(r.audio, { env: {}, storedKey: () => null, local: r.local, localEnabled: false }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionUnavailableError);
    expect(err.userMessage).toMatch(/switched off/);
  });

  it('nothing installed: the unavailable error names what is missing, plainly', async () => {
    const r = rig({ whisper: null, ffmpeg: null, model: false });
    const err = await transcribeAudioFileDetailed(r.audio, { env: {}, storedKey: () => null, local: r.local, localEnabled: true }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionUnavailableError);
    expect(err.missing).toEqual(['the whisper.cpp program', 'a whisper model file', 'ffmpeg']);
    expect(err.userMessage).toBe("I can't transcribe voice notes on this machine yet: the free on-machine transcriber (whisper.cpp) needs the whisper.cpp program, a whisper model file and ffmpeg, and no transcription service is set up. Ask me to set it up and I'll do it.");
    expect(err.message.startsWith('No voice transcription provider configured.')).toBe(true);
    expect(transcriptionFailureReason(err)).toMatch(/needs the whisper.cpp program/);
    expect(cannotTranscribeReason({ local: r.local, localEnabled: true })).toMatch(/needs the whisper.cpp program/);
    expect(canTranscribe({ env: {}, storedKey: () => null, local: r.local, localEnabled: true })).toBe(false);
  });

  it('holds back 20 s for local, so a hanging paid service still leaves time for the fallback', async () => {
    const r = rig();
    const hang = ((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    const res = await transcribeAudioFileDetailed(r.audio, { env: { GROQ_API_KEY: 'gsk_x' }, storedKey: () => null, local: r.local, fetchImpl: hang, timeoutMs: 21_500, localEnabled: true });
    expect(res.provider).toBe('local');
    expect(Date.now() - started).toBeLessThan(5_000); // paid got ~1.5 s, then local
  });

  it('describes the active transcriber for this machine in one sentence', () => {
    const r = rig();
    const d = describeVoiceTranscription({ env: {}, storedKey: () => null, local: r.local, localEnabled: true, noCache: true });
    expect(d.active).toBe('local');
    expect(d.summary).toContain(os.hostname());
    expect(d.summary).toMatch(/whisper\.cpp/);
    const paid = describeVoiceTranscription({ env: { GROQ_API_KEY: 'gsk_x' }, storedKey: () => null, local: r.local, localEnabled: true, noCache: true });
    expect(paid.active).toBe('groq');
    expect(paid.fallback).toBe(true);
  });

  it('the cached-only description never reads the stored key', () => {
    const r = rig();
    let reads = 0;
    describeVoiceTranscription({ cachedOnly: true, env: {}, storedKey: () => { reads++; return 'gsk_abcdefghijklmnopqrstuv'; }, local: r.local, localEnabled: true });
    expect(reads).toBe(0);
  });
});

describe('no source file string-matches the transcription error text', () => {
  it('channels use instanceof, not the message', () => {
    const root = path.resolve(__dirname, '../../src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /includes\(['"]No voice transcription provider/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

const hasReal = (() => {
  try { execFileSync('which', ['ffmpeg', 'whisper-cli']); return fs.existsSync(path.join(os.homedir(), '.local/share/instar/media/ggml-base.bin')) || fs.existsSync(path.join(os.homedir(), '.local/share/instar/models/ggml-base.bin')); } catch { return false; }
})();

describe.skipIf(!hasReal)('real ffmpeg + whisper.cpp on the real Opus fixtures (where installed)', () => {
  const realLocal = () => ({ env: process.env, homeDir: os.homedir(), lockDir: fs.mkdtempSync(path.join(os.tmpdir(), 'voice-real-lock-')), noCache: true });
  it('transcribes the real Telegram-style Opus note', async () => {
    const text = await transcribeLocally(path.join(FIXTURES, 'speech.ogg'), { ...realLocal(), deadline: Date.now() + 60_000 });
    expect(text.toLowerCase()).toContain('local transcriber');
  }, 70_000);
  it('measures the real silent Opus note as silent', async () => {
    const err = await transcribeLocally(path.join(FIXTURES, 'silence.ogg'), { ...realLocal(), deadline: Date.now() + 60_000 }).catch((e) => e);
    expect(err.kind).toBe('silent');
  }, 70_000);
  it('refuses a playlist dressed as a voice note', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-hls-'));
    const hls = path.join(dir, 'voice.ogg');
    fs.writeFileSync(hls, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n/etc/hosts\n#EXT-X-ENDLIST\n');
    const concat = path.join(dir, 'list.ogg');
    fs.writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/hosts'\n");
    for (const f of [hls, concat]) {
      const err = await transcribeLocally(f, { ...realLocal(), deadline: Date.now() + 60_000 }).catch((e) => e);
      expect(err.kind).toBe('request');
    }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/voice-transcription-local.test.ts' });
  }, 70_000);
});
