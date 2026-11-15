/**
 * On-machine voice transcription with whisper.cpp (docs/specs/backup-on-machine-voice.md).
 *
 * Free, no account, no network: `ffmpeg` turns a voice note into 16 kHz mono WAV and
 * `whisper-cli` reads it with a ggml model. VoiceTranscription.ts decides WHEN this runs
 * (no paid provider, an explicit "local", or a paid failure); this module only knows HOW.
 *
 * Readiness is a state, not a file check: finding the files makes local
 * `installed-unproven`; a successful run makes it `proven`; an installation-level failure
 * makes it `failed` for a while. Failures that belong to one voice note (bad audio, a
 * timeout, a silent recording) never change readiness.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export type LocalState = 'missing' | 'installed-unproven' | 'proven' | 'failed';

export interface LocalTranscriberInfo {
  state: LocalState;
  /** True when a run may be attempted now (installed-unproven or proven). */
  ready: boolean;
  binary: string | null;
  model: string | null;
  ffmpeg: string | null;
  /** Plain-words names of what is missing, e.g. "the whisper.cpp program". Empty unless state is missing. */
  missing: string[];
  lastSuccessAt: string | null;
  lastFailure: { at: string; reason: string } | null;
}

export interface LocalDetectOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Bypass the 60 s detection cache (the status route and tests). */
  noCache?: boolean;
  /** Replaces the fixed install directories (tests). */
  fixedDirs?: readonly string[];
  now?: () => number;
}

/** Why a local run failed. Only `install` changes readiness (spec: Readiness is a state). */
export type LocalFailureKind = 'install' | 'request' | 'timeout' | 'busy' | 'silent';

export class LocalTranscriptionError extends Error {
  constructor(public readonly kind: LocalFailureKind, message: string) {
    super(message);
    this.name = 'LocalTranscriptionError';
  }
}

const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp'] as const;
const MODEL_PREFERENCE = ['ggml-base.bin', 'ggml-base.en.bin', 'ggml-small.bin', 'ggml-small.en.bin', 'ggml-tiny.bin', 'ggml-tiny.en.bin'] as const;
const GGML_MAGIC = Buffer.from('lmgg', 'latin1');
const MIN_MODEL_BYTES = 1024 * 1024;
const DETECT_CACHE_MS = 60_000;
/** After an installation-level failure, local sits out this long (or until a file changes). */
export const LOCAL_FAILED_WINDOW_MS = 10 * 60_000;
/** Longest audio converted: 2 hours (spec: 2-hour audio cap). */
export const LOCAL_MAX_AUDIO_SECONDS = 7200;
/** Peak below -50 dBFS reads as "seems silent". 32768 * 10^(-50/20) ≈ 103.6. */
const SILENCE_PEAK = Math.round(32768 * Math.pow(10, -50 / 20));
const QUEUE_DEPTH = 8;
const LOCK_STALE_MS = 15 * 60_000;
const LOCK_POLL_MS = 250;
const OUTPUT_MAX_BUFFER = 1024 * 1024;
/** Converting even 2 hours of Opus to WAV takes seconds; past this ffmpeg is stuck. */
const CONVERT_MAX_MS = 60_000;
const FORMAT_WHITELIST = 'ogg,mov,mp4,m4a,3gp,mp3,wav,webm,matroska,flac,aac';

export function defaultFixedDirs(homeDir: string): string[] {
  return ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/usr/bin', path.join(homeDir, '.local', 'bin')];
}

/** The model folder this change introduces, then the legacy hand-install folder. */
export function modelDirs(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homeDir, '.local', 'share');
  return [path.join(dataHome, 'instar', 'models'), path.join(dataHome, 'instar', 'media')];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false; // @silent-fallback-ok — "not here" is the answer; the caller names it as missing
  }
}

function findProgram(names: readonly string[], envOverride: string | undefined, env: NodeJS.ProcessEnv, fixedDirs: readonly string[]): string | null {
  if (envOverride && path.isAbsolute(envOverride) && isExecutableFile(envOverride)) return envOverride;
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const name of names) {
    for (const dir of [...pathDirs, ...fixedDirs]) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Structural check only (size + ggml magic). A truncated file can pass; a real run is the proof. */
function looksLikeModel(p: string): boolean {
  let fd: number | null = null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < MIN_MODEL_BYTES) return false;
    fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head.equals(GGML_MAGIC);
  } catch {
    return false; // @silent-fallback-ok — unreadable is "no usable model", named as missing
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closing a read-only fd */ }
  }
}

function findModel(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const override = env.INSTAR_WHISPER_MODEL;
  if (override && path.isAbsolute(override) && looksLikeModel(override)) return override;
  for (const dir of modelDirs(env, homeDir)) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const others = names.filter((n) => /^ggml-.+\.bin$/.test(n) && !(MODEL_PREFERENCE as readonly string[]).includes(n)).sort();
    for (const name of [...MODEL_PREFERENCE.filter((n) => names.includes(n)), ...others]) {
      const candidate = path.join(dir, name);
      if (looksLikeModel(candidate)) return candidate;
    }
  }
  return null;
}

interface Found { binary: string | null; model: string | null; ffmpeg: string | null; signature: string }

function mtimeOf(p: string | null): string {
  if (!p) return '-';
  try { return String(fs.statSync(p).mtimeMs); } catch { return '?'; }
}

function detectFiles(opts: LocalDetectOptions): Found {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const fixed = opts.fixedDirs ?? defaultFixedDirs(homeDir);
  const binary = findProgram(WHISPER_NAMES, env.INSTAR_WHISPER_CLI, env, fixed);
  const ffmpeg = findProgram(['ffmpeg'], env.INSTAR_FFMPEG, env, fixed);
  const model = findModel(env, homeDir);
  return { binary, model, ffmpeg, signature: [binary, model, ffmpeg].map((p) => `${p}@${mtimeOf(p)}`).join('|') };
}

// ── Module state (per server process) ─────────────────────────────────────────

let cache: { at: number; key: string; found: Found } | null = null;
let lastSuccess: number | null = null;
/** The install (paths + mtimes) the last success proved; a changed install is unproven again. */
let lastSuccessSignature: string | null = null;
/** Seconds of run time per second of audio, a moving average of real runs (spec: short budgets). */
let realTimeFactor = 0.5;
let lastFailure: { at: number; reason: string; signature: string } | null = null;

/** Test hook: forget cached detection and readiness. */
export function resetLocalTranscriberState(): void {
  cache = null;
  lastSuccess = null;
  lastSuccessSignature = null;
  lastFailure = null;
  realTimeFactor = 0.5;
  slotBusy = false;
  currentExpectedEnd = 0;
  waiters.length = 0;
}

function found(opts: LocalDetectOptions): Found {
  const now = (opts.now ?? Date.now)();
  const key = JSON.stringify([opts.env?.PATH, opts.env?.INSTAR_WHISPER_CLI, opts.env?.INSTAR_WHISPER_MODEL, opts.env?.INSTAR_FFMPEG, opts.env?.XDG_DATA_HOME, opts.homeDir, opts.fixedDirs]);
  if (!opts.noCache && cache && cache.key === key && now - cache.at < DETECT_CACHE_MS) return cache.found;
  const f = detectFiles(opts);
  cache = { at: now, key, found: f };
  return f;
}

/** What is installed and whether a run may be tried now. Never starts a process. */
export function resolveLocalTranscriber(opts: LocalDetectOptions = {}): LocalTranscriberInfo {
  const now = (opts.now ?? Date.now)();
  const f = found(opts);
  const missing: string[] = [];
  if (!f.binary) missing.push('the whisper.cpp program');
  if (!f.model) missing.push('a whisper model file');
  if (!f.ffmpeg) missing.push('ffmpeg');
  const base = {
    binary: f.binary, model: f.model, ffmpeg: f.ffmpeg, missing,
    lastSuccessAt: lastSuccess ? new Date(lastSuccess).toISOString() : null,
    lastFailure: lastFailure ? { at: new Date(lastFailure.at).toISOString(), reason: lastFailure.reason } : null,
  };
  if (missing.length > 0) return { ...base, state: 'missing', ready: false };
  const failedRecently = lastFailure && (lastSuccess === null || lastFailure.at > lastSuccess)
    && now - lastFailure.at < LOCAL_FAILED_WINDOW_MS && lastFailure.signature === f.signature;
  if (failedRecently) return { ...base, state: 'failed', ready: false };
  if (lastSuccess !== null && lastSuccessSignature === f.signature && (lastFailure === null || lastSuccess > lastFailure.at)) return { ...base, state: 'proven', ready: true };
  return { ...base, state: 'installed-unproven', ready: true };
}

// ── Running ───────────────────────────────────────────────────────────────────

export interface LocalRunOptions extends LocalDetectOptions {
  /** Absolute time (ms) the whole local attempt must finish by: queue, ffmpeg and whisper. */
  deadline: number;
  /** Replaces execFile (tests). */
  execFileImpl?: typeof execFile;
  /** Directory for the cross-process lock (tests); default the per-user state folder (defaultLockRoot). */
  lockDir?: string;
  cpus?: number;
}

interface Waiter { deadline: number; wake: () => void }
let slotBusy = false;
/** When the running job's per-run cap ends (ms); before it is measured, its deadline. */
let currentExpectedEnd = 0;
const waiters: Waiter[] = [];
/** Time a waiting note needs for its own run once the slot frees (spec: short budgets are not starved). */
const OWN_RUN_RESERVE_MS = 20_000;

function busyError(): LocalTranscriptionError {
  return new LocalTranscriptionError('busy', 'another voice note is being transcribed on this machine; try again in a minute');
}

/** Earliest-deadline-first slot; a note that cannot fit behind the running job fails at once. */
async function acquireSlot(deadline: number, now: () => number): Promise<void> {
  if (!slotBusy) { slotBusy = true; return; }
  if (waiters.length >= QUEUE_DEPTH) throw new LocalTranscriptionError('busy', 'too many voice notes are waiting; try again in a minute');
  if (currentExpectedEnd + OWN_RUN_RESERVE_MS > deadline) throw busyError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      reject(new LocalTranscriptionError('timeout', 'on-machine transcription took too long (other voice notes were ahead of it)'));
    }, Math.max(0, deadline - now()));
    const w: Waiter = { deadline, wake: () => { clearTimeout(timer); resolve(); } };
    const at = waiters.findIndex((x) => x.deadline > deadline);
    if (at < 0) waiters.push(w); else waiters.splice(at, 0, w);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next.wake(); else slotBusy = false;
}

/** The ffmpeg argument list, hardened for untrusted input (spec: Conversion). Exported for the test. */
export function ffmpegArgs(input: string, output: string): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    '-format_whitelist', FORMAT_WHITELIST,
    '-i', `file:${input}`,
    '-vn', '-map', '0:a:0', '-t', String(LOCAL_MAX_AUDIO_SECONDS),
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', output,
  ];
}

export function whisperArgs(model: string, wav: string, threads: number): string[] {
  return ['-m', model, '-f', wav, '-nt', '-np', '-t', String(threads)];
}

function run(execImpl: typeof execFile, file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execImpl(file, args, { timeout: Math.max(1, Math.floor(timeoutMs)), killSignal: 'SIGKILL', maxBuffer: OUTPUT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) { Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }); reject(err); return; }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
  });
}

type ExecError = Error & { killed?: boolean; signal?: string | null; code?: string | number | null; stderr?: string };

function overflowed(err: ExecError): boolean {
  return err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/** execFile's own timeout kills with our SIGKILL; a maxBuffer overflow also kills, so it is checked first. */
function timedOut(err: ExecError): boolean {
  if (overflowed(err)) return false;
  return err.killed === true || err.signal === 'SIGKILL';
}

/** Peak sample and duration of a 16-bit PCM WAV, read asynchronously in 1 MB chunks. */
export async function measureWav(wavPath: string, deadline = Infinity, now: () => number = Date.now): Promise<{ peak: number; seconds: number }> {
  const fh = await fs.promises.open(wavPath, 'r');
  try {
    const size = (await fh.stat()).size;
    const header = Buffer.alloc(12);
    await fh.read(header, 0, 12, 0);
    if (header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let offset = 12;
    const chunkHead = Buffer.alloc(8);
    while (offset + 8 <= size) {
      await fh.read(chunkHead, 0, 8, offset);
      const id = chunkHead.toString('latin1', 0, 4);
      let len = chunkHead.readUInt32LE(4);
      if (id === 'data') {
        if (len === 0 || len === 0xffffffff || offset + 8 + len > size) len = size - offset - 8; // streamed WAV: length unknown
        let peak = 0;
        const buf = Buffer.alloc(1024 * 1024);
        let pos = offset + 8;
        const end = pos + len;
        while (pos < end) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
          if (bytesRead <= 0) break;
          if (now() > deadline) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long');
          for (let i = 0; i + 1 < bytesRead; i += 2) {
            const v = Math.abs(buf.readInt16LE(i));
            if (v > peak) peak = v;
          }
          pos += bytesRead;
        }
        return { peak, seconds: len / (16000 * 2) };
      }
      offset += 8 + len + (len % 2);
    }
    throw new Error('WAV file has no audio data');
  } finally {
    await fh.close();
  }
}

/** whisper-cli -nt stdout → transcript. `[BLANK_AUDIO]` alone means silence. */
export function parseWhisperOutput(stdout: string): string | null {
  const text = stdout.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
  if (!text || /^\[BLANK_AUDIO\]$/i.test(text)) return null;
  return text;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Per-user folder for the machine-wide lock (not the shared /tmp, where another account could plant one). */
export function defaultLockRoot(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const stateHome = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homeDir, '.local', 'state');
  return path.join(stateHome, 'instar');
}

interface LockOwner { pid?: number; token?: string; startedAt?: number; expectedEnd?: number }

function readOwner(dir: string): LockOwner | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as LockOwner; } catch { return null; }
}

/** Stale: the owner's process is gone, or the lock directory itself is older than any run can be. */
function isStale(dir: string, o: LockOwner | null, wallNow: number): boolean {
  if (o && typeof o.pid === 'number' && !pidAlive(o.pid)) return true;
  try { return wallNow - fs.statSync(dir).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}

const TAKEOVER_STALE_MS = 30_000;

/**
 * Remove a stale run lock, serialized by a second lock so a waiter acting on an old observation can
 * never remove a live lock (spec: one local run at a time, per machine).
 */
function takeOverStale(lock: string, observed: LockOwner | null): void {
  const takeover = `${lock}.takeover`;
  try {
    fs.mkdirSync(takeover);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return;
    try {
      if (Date.now() - fs.statSync(takeover).mtimeMs > TAKEOVER_STALE_MS) {
        SafeFsExecutor.safeRmSync(takeover, { recursive: true, force: true, operation: 'src/core/LocalVoiceTranscriber.ts:staleTakeover' });
      }
    } catch { /* another waiter is handling it */ }
    return; // someone else is taking over; the caller retries
  }
  try {
    const now = readOwner(lock);
    const same = (now?.token ?? null) === (observed?.token ?? null);
    if (same && isStale(lock, now, Date.now())) {
      const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.renameSync(lock, aside);
        SafeFsExecutor.safeRmSync(aside, { recursive: true, force: true, operation: 'src/core/LocalVoiceTranscriber.ts:staleLock' });
      } catch { /* already gone */ }
    }
  } finally {
    try { SafeFsExecutor.safeRmSync(takeover, { recursive: true, force: true, operation: 'src/core/LocalVoiceTranscriber.ts:takeoverRelease' }); } catch { /* the 30 s rule covers it */ }
  }
}

/**
 * One whisper run at a time on the whole machine, for this user's agents (spec: one local run at a
 * time, per machine). Takeover of a stale lock renames it first (atomic: one taker wins), and release
 * only removes a lock that still carries this run's token.
 */
async function withMachineLock<T>(lockRoot: string, deadline: number, now: () => number, fn: (setExpectedEnd: (t: number) => void) => Promise<T>): Promise<T> {
  fs.mkdirSync(lockRoot, { recursive: true });
  const lock = path.join(lockRoot, 'instar-whisper-run.lock');
  const ownerFile = path.join(lock, 'owner.json');
  const token = crypto.randomBytes(8).toString('hex');
  const startedAt = now();
  const writeOwner = (expectedEnd: number): void => {
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, startedAt, expectedEnd }));
  };
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        writeOwner(Math.min(deadline, now() + 5_000)); // until the audio is measured: conversion is quick
      } catch (writeErr) {
        try { SafeFsExecutor.safeRmSync(lock, { recursive: true, force: true, operation: 'src/core/LocalVoiceTranscriber.ts:ownerWriteFailed' }); } catch { /* the stale rule covers it */ }
        throw writeErr;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const o = readOwner(lock);
      if (isStale(lock, o, Date.now())) {
        takeOverStale(lock, o);
        // Never a tight loop: check the budget and yield before trying again.
        if (now() + LOCK_POLL_MS > deadline) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long (another voice note was being transcribed)');
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const otherEnd = typeof o?.expectedEnd === 'number' ? o.expectedEnd : 0;
      if (otherEnd + OWN_RUN_RESERVE_MS > deadline) throw busyError();
      if (now() + LOCK_POLL_MS > deadline) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long (another voice note was being transcribed)');
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  const setExpectedEnd = (t: number): void => {
    currentExpectedEnd = t;
    try {
      if (readOwner(lock)?.token === token) {
        writeOwner(t);
        const touched = new Date();
        fs.utimesSync(lock, touched, touched); // the directory's mtime is the staleness clock: a live run keeps it fresh
      }
    } catch { /* best effort: others then wait or time out by their own deadline */ }
  };
  try {
    return await fn(setExpectedEnd);
  } finally {
    if (readOwner(lock)?.token === token) {
      try { SafeFsExecutor.safeRmSync(lock, { recursive: true, force: true, operation: 'src/core/LocalVoiceTranscriber.ts:releaseLock' }); } catch { /* the stale-lock rule covers a lock left behind */ }
    }
  }
}

function markFailure(reason: string, signature: string, now: number): void {
  lastFailure = { at: now, reason, signature };
}

/**
 * Transcribe one audio file on this machine. Resolves to the transcript; rejects with a
 * `LocalTranscriptionError` whose message is plain words for the person.
 */
export async function transcribeLocally(filePath: string, opts: LocalRunOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  const info = resolveLocalTranscriber(opts);
  if (!info.ready || !info.binary || !info.model || !info.ffmpeg) {
    throw new LocalTranscriptionError('install', info.state === 'failed'
      ? `on-machine transcription failed recently (${info.lastFailure?.reason ?? 'unknown reason'})`
      : `on-machine transcription is missing ${info.missing.join(', ')}`);
  }
  const signature = found(opts).signature;
  await acquireSlot(opts.deadline, now);
  try {
    currentExpectedEnd = now() + 5_000; // until the audio is measured: conversion is quick
    return await withMachineLock(opts.lockDir ?? defaultLockRoot(opts.env ?? process.env, opts.homeDir ?? os.homedir()), opts.deadline, now, (setExpectedEnd) =>
      runOnce(filePath, info.binary!, info.model!, info.ffmpeg!, signature, opts, setExpectedEnd));
  } finally {
    releaseSlot();
  }
}

async function runOnce(filePath: string, binary: string, model: string, ffmpeg: string, signature: string, opts: LocalRunOptions, setExpectedEnd: (t: number) => void): Promise<string> {
  const now = opts.now ?? Date.now;
  const execImpl = opts.execFileImpl ?? execFile;
  const remaining = () => opts.deadline - now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-voice-'));
  const wav = path.join(dir, 'audio.wav');
  try {
    if (remaining() <= 0) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long');
    try {
      // Conversion is far faster than real time; its own bound keeps a stuck ffmpeg from holding the slot.
      await run(execImpl, ffmpeg, ffmpegArgs(filePath, wav), Math.min(remaining(), CONVERT_MAX_MS));
    } catch (err) {
      const e = err as ExecError;
      if (timedOut(e)) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long (converting the audio)');
      if (e.code === 'ENOENT' || e.code === 'EACCES') {
        markFailure('ffmpeg could not be started', signature, now());
        throw new LocalTranscriptionError('install', 'on-machine transcription failed: ffmpeg could not be started');
      }
      // ffmpeg ran and refused this input: the note's problem, not the install's.
      throw new LocalTranscriptionError('request', "the voice note's audio could not be read");
    }

    let measured: { peak: number; seconds: number };
    try { measured = await measureWav(wav, opts.deadline, now); } catch (err) {
      if (err instanceof LocalTranscriptionError) throw err;
      throw new LocalTranscriptionError('request', "the voice note's audio could not be read");
    }
    if (measured.peak < SILENCE_PEAK) throw new LocalTranscriptionError('silent', 'the voice note seems to be silent (no sound above background level)');

    // Per-run cap: 60 s plus twice the audio's length, never past the deadline.
    const runCap = Math.min(remaining(), 60_000 + 2 * measured.seconds * 1000);
    if (runCap <= 0) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long');
    // The estimate others plan around; the cap is only the kill line.
    setExpectedEnd(now() + Math.min(runCap, measured.seconds * realTimeFactor * 1.5 * 1000 + 2_000));
    const runStarted = now();
    const cpus = opts.cpus ?? os.cpus().length;
    const threads = Math.min(4, Math.max(1, cpus - 1));
    let stdout: string;
    try {
      ({ stdout } = await run(execImpl, binary, whisperArgs(model, wav, threads), runCap));
    } catch (err) {
      const e = err as ExecError;
      if (timedOut(e)) throw new LocalTranscriptionError('timeout', 'on-machine transcription took too long');
      if (overflowed(e)) throw new LocalTranscriptionError('request', 'the transcript was too long to read');
      // The WAV is valid (ffmpeg made it), so a whisper failure is the install's: missing/broken binary or model.
      const reason = e.code === 'ENOENT' || e.code === 'EACCES' ? 'the whisper.cpp program could not be started'
        : /model|ggml|load/i.test(e.stderr ?? '') ? 'the model file may be damaged'
          : 'the whisper.cpp program failed';
      markFailure(reason, signature, now());
      throw new LocalTranscriptionError('install', `on-machine transcription failed: ${reason}`);
    }
    lastSuccess = now();
    lastSuccessSignature = signature;
    if (measured.seconds >= 1) {
      const observed = (lastSuccess - runStarted) / 1000 / measured.seconds;
      realTimeFactor = Math.min(20, Math.max(0.05, realTimeFactor * 0.7 + observed * 0.3));
    }
    const text = parseWhisperOutput(stdout);
    if (text === null) throw new LocalTranscriptionError('silent', 'the voice note seems to be silent (no speech found)');
    return measured.seconds >= LOCAL_MAX_AUDIO_SECONDS - 0.5
      ? `${text} (only the first 2 hours were transcribed)`
      : text;
  } finally {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'src/core/LocalVoiceTranscriber.ts:tempCleanup' }); } catch { /* temp dir; the OS clears it */ }
  }
}
