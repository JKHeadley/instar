import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { OriginHookChallenge, OriginNativeHookProof } from './OriginNativeHookProof.js';

export type OriginHarness = 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'grok-build';
export interface OriginSessionLaunch {
  sessionId: string;
  harnessId: OriginHarness;
  projectDir: string;
  configuredModel?: string;
  nativeSessionId?: string;
  /** Actual selected framework config home, not the agent's project directory. */
  configHome?: string;
  /** Captured by SessionManager before CLI spawn, never by existing-session enrollment. */
  launchHookSettingsDigest?: string;
}
export interface OriginSessionBinding extends OriginSessionLaunch {
  agentId: string;
  machineId: string;
  sessionIncarnation: string;
  issuedAt: string;
}
export interface OriginSessionLifecycle {
  issue(launch: OriginSessionLaunch): Promise<string>;
  bindNative(sessionId: string, nativeSessionId: string): void;
  /** Implementations invalidate in memory synchronously, then persist. */
  revoke(sessionId: string): void | Promise<void>;
}
export type OriginTokenVerification =
  | { ok: true; binding: OriginSessionBinding }
  | { ok: false; reason: string };
interface Entry { verifier: string; binding: OriginSessionBinding }
const harnesses = new Set<string>(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli', 'grok-build']);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Preparation-only credentials. Neither raw tokens nor destination permissions are stored. */
export class OriginSessionRegistry {
  private entries = new Map<string, Entry>();
  private hookChallenges = new Map<string, OriginHookChallenge>();
  private ready = false;
  private persistence: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly maxSessions: number;

  constructor(private readonly options: {
    agentId: string;
    machineId: string;
    stateDir: string;
    isSessionLive?: (binding: OriginSessionBinding) => boolean;
    maxSessions?: number;
    now?: () => number;
  }) {
    if (!options.agentId || !options.machineId) throw new Error('Origin registry requires host and agent identity');
    this.maxSessions = options.maxSessions ?? 1000;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) throw new Error('Invalid origin session capacity');
    this.file = path.join(options.stateDir, `origin-sessions-${digest(`${options.agentId}\0${options.machineId}`)}.json`);
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.ready = true;
      return;
    }
    if (Buffer.byteLength(raw) > this.maxSessions * 16_384) throw new Error('Origin registry exceeds bounded size');
    const stored = JSON.parse(raw) as { version: number; entries: Entry[] };
    if (stored.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > this.maxSessions) {
      throw new Error('Invalid origin session registry');
    }
    const loaded = new Map<string, Entry>();
    for (const entry of stored.entries) {
      const b = entry.binding;
      if (!/^[a-f0-9]{64}$/.test(entry.verifier) || !b || b.agentId !== this.options.agentId ||
          b.machineId !== this.options.machineId || !b.sessionIncarnation || !b.sessionId ||
          (b.launchHookSettingsDigest !== undefined && !/^[a-f0-9]{64}$/.test(b.launchHookSettingsDigest)) ||
          !harnesses.has(b.harnessId) || !path.isAbsolute(b.projectDir) || loaded.has(b.sessionId)) {
        throw new Error('Invalid origin session binding');
      }
      loaded.set(b.sessionId, entry);
    }
    this.entries = loaded;
    this.ready = true;
  }

  async issue(launch: OriginSessionLaunch): Promise<string> {
    if (!this.ready) throw new Error('Origin registry not initialized');
    if (!launch.sessionId || !harnesses.has(launch.harnessId) || !path.isAbsolute(launch.projectDir) ||
      (launch.launchHookSettingsDigest !== undefined && !/^[a-f0-9]{64}$/.test(launch.launchHookSettingsDigest))) {
      throw new Error('Invalid origin session launch');
    }
    if (!this.entries.has(launch.sessionId) && this.entries.size >= this.maxSessions) {
      throw new Error('Origin session capacity unavailable');
    }
    const token = `ior1_${randomBytes(32).toString('base64url')}`;
    const binding: OriginSessionBinding = {
      ...launch, agentId: this.options.agentId, machineId: this.options.machineId,
      sessionIncarnation: randomUUID(), issuedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    };
    const verifier = digest(token);
    this.hookChallenges.delete(launch.sessionId);
    this.entries.set(launch.sessionId, { verifier, binding });
    try { await this.persist(); }
    catch (error) {
      if (this.entries.get(launch.sessionId)?.verifier === verifier) this.entries.delete(launch.sessionId);
      throw error;
    }
    return token;
  }

  verify(token: string): OriginTokenVerification {
    if (!this.ready) return { ok: false, reason: 'registry-unavailable' };
    if (!/^ior1_[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'invalid-origin-token' };
    const candidate = Buffer.from(digest(token), 'hex');
    // Bounded population and constant-time digest comparisons; no secret prefix comparisons.
    let matched: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (timingSafeEqual(candidate, Buffer.from(entry.verifier, 'hex'))) matched = entry;
    }
    if (!matched) return { ok: false, reason: 'invalid-origin-token' };
    if (!this.options.isSessionLive) return { ok: false, reason: 'session-liveness-unavailable' };
    try {
      if (!this.options.isSessionLive({ ...matched.binding })) return { ok: false, reason: 'session-not-live' };
    } catch { return { ok: false, reason: 'session-liveness-unavailable' }; }
    return { ok: true, binding: { ...matched.binding } };
  }

  getBinding(sessionId: string): OriginSessionBinding | undefined {
    const entry = this.entries.get(sessionId);
    return entry ? { ...entry.binding } : undefined;
  }

  /** One bounded challenge per live incarnation. Not itself execution proof. */
  challengeNativeHook(token: string, nativeSessionId: string, guardDigest: string): OriginHookChallenge | undefined {
    const verified = this.verify(token);
    if (!verified.ok || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeSessionId) || !/^[a-f0-9]{64}$/.test(guardDigest)) return;
    const binding = verified.binding, now = this.options.now?.() ?? Date.now();
    const previous = this.hookChallenges.get(binding.sessionId);
    if (previous && previous.sessionIncarnation === binding.sessionIncarnation && previous.nativeSessionId === nativeSessionId &&
      previous.guardDigest === guardDigest && now >= previous.issuedAt && now - previous.issuedAt < 3_600_000) return { ...previous };
    const challenge = { nonce: randomBytes(32).toString('base64url'), sessionIncarnation: binding.sessionIncarnation,
      nativeSessionId, guardDigest, issuedAt: now };
    this.hookChallenges.set(binding.sessionId, challenge);
    return { ...challenge };
  }

  verifyNativeHookProof(sessionId: string, proof: OriginNativeHookProof, guardDigest: string): boolean {
    const binding = this.entries.get(sessionId)?.binding, expected = this.hookChallenges.get(sessionId);
    const now = this.options.now?.() ?? Date.now();
    if (!binding || !expected) return false;
    try { if (!this.options.isSessionLive?.({ ...binding })) return false; }
    catch { return false; }
    return binding.sessionIncarnation === expected.sessionIncarnation && guardDigest === expected.guardDigest &&
      proof.nonce === expected.nonce && proof.sessionIncarnation === expected.sessionIncarnation &&
      proof.nativeSessionId === expected.nativeSessionId && proof.guardDigest === expected.guardDigest && proof.issuedAt === expected.issuedAt &&
      proof.observedAt >= expected.issuedAt && proof.observedAt <= now && now - expected.issuedAt < 3_600_000;
  }

  /** For restart enrollment only; production still checks live session state before tracking. */
  listBindings(): OriginSessionBinding[] { return [...this.entries.values()].map(e => ({ ...e.binding })); }

  revoke(sessionId: string): Promise<void> {
    this.entries.delete(sessionId);
    this.hookChallenges.delete(sessionId);
    return this.persist();
  }

  private persist(): Promise<void> {
    const data = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    const write = async (): Promise<void> => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(tmp, 'wx', 0o600);
      try { await handle.writeFile(data, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(tmp, this.file);
      const directory = await open(path.dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    };
    const result = this.persistence.then(write);
    this.persistence = result.catch(() => undefined);
    return result;
  }
}
