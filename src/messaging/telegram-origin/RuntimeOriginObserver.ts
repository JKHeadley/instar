/**
 * RULE 3.1 RATIONALE
 * - Criticality: high; a false observation misattributes model or native hook evidence.
 * - Frequency: bounded native-source polling (250ms by default), per tracked incarnation.
 * - Stability: semi-stable or unstable third-party native transcript/hook schemas.
 * - Fallback: exact native/turn binding, freshness, source/generation fences and
 *   explicit configured/unknown evidence; requested models never become observed by fallback.
 * - Verdict: deterministic schema parsing plus native hook challenge/proof controls.
 *   Hook carrier proof does not prove current-model extraction; separate live-model
 *   canary enrollment and per-harness limits are recorded in the detector registry.
 */
import { open, opendir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { OriginHarness, OriginSessionBinding } from './OriginSessionRegistry.js';
import { parseOriginHookMarker, type OriginNativeHookProof } from './OriginNativeHookProof.js';

export interface RuntimeModelEvidence {
  value: string | null;
  status: 'observed' | 'configured' | 'unknown';
  sourceEventRef: string | null;
  observedAt: string | null;
  reason?: string;
}
export interface RuntimeOriginObservation {
  sessionId: string;
  sessionIncarnation: string;
  harnessId: OriginHarness;
  nativeSessionId: string | null;
  turnId: string | null;
  model: RuntimeModelEvidence;
  configuredModel: string | null;
}
export interface RuntimeOriginSource {
  path: string;
  nativeSessionId: string;
  format?: 'jsonl' | 'snapshot';
  /** Grok's independent turn-start stream; never used as authored-model evidence. */
  eventsPath?: string;
}
interface Turn {
  turnId: string | null;
  model: string | null;
  ref: string | null;
  at: string | null;
}
interface ParserState extends Turn {
  nativeHookProof?: OriginNativeHookProof;
  verified: boolean;
  invalid: string | null;
  waitForUser: boolean;
  branches: Map<string, Turn>;
}
interface Cursor { offset: number; partial: Buffer; inode: number | null; mtime: number; line: number }
interface Tracked {
  binding: OriginSessionBinding;
  source?: RuntimeOriginSource;
  parser: ParserState;
  cursor: Cursor;
  events: Cursor;
  busy?: Promise<void>;
  generation: number;
  lastHealthy: number;
  unavailable: string | null;
  discoveryAt: number;
}
const emptyTurn = (): Turn => ({ turnId: null, model: null, ref: null, at: null });
const newParser = (): ParserState => ({ ...emptyTurn(), verified: false, invalid: null, waitForUser: false, branches: new Map() });
const newCursor = (): Cursor => ({ offset: 0, partial: Buffer.alloc(0), inode: null, mtime: 0, line: 0 });
const cleanString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
function resetTurn(s: ParserState, id: string | null): void { Object.assign(s, emptyTurn(), { turnId: id }); }
function observe(s: ParserState, model: unknown, ref: string, at: string): void {
  const value = cleanString(model);
  if (!s.verified || !s.turnId || !value || s.invalid || s.waitForUser) return;
  s.model = value; s.ref = ref; s.at = at;
}
function userContent(message: RecordValue): boolean {
  if (typeof message.content === 'string') return true;
  return Array.isArray(message.content) && message.content.some((part: unknown) => record(part).type !== 'tool_result');
}

/** Native schemas are source-grounded; requested launch/configuration events never call observe(). */
function consume(s: ParserState, harness: OriginHarness, nativeId: string, input: unknown, ref: string, now: string): void {
  const r = record(input);
  const at = cleanString(r.timestamp) ?? cleanString(r.ts) ?? now;
  if (harness === 'codex-cli') {
    const p = record(r.payload);
    if (r.type === 'session_meta') {
      s.verified = p.id === nativeId;
      if (!s.verified) { s.invalid = 'native-session-mismatch'; resetTurn(s, null); }
    } else if (s.verified && r.type === 'response_item' && p.type === 'message' && p.role === 'developer') {
      // Source-grounded in native Codex JSONL: ordinary user, assistant and
      // tool output records do not carry this listener-owned content kind.
      const kinds = record(p.internal_chat_message_metadata_passthrough).content_item_kinds;
      if (Array.isArray(kinds) && Array.isArray(p.content) && kinds.length === p.content.length && kinds.length <= 32) {
        for (let index = 0; index < kinds.length; index++) {
          if (kinds[index] !== 'hooks.additional_context' || record(p.content[index]).type !== 'input_text') continue;
          const marker = parseOriginHookMarker(record(p.content[index]).text);
          const command = cleanString(marker?.command), toolUseId = cleanString(marker?.toolUseId), observedAt = Date.parse(at);
          if (marker && marker.hookEvent === 'PreToolUse' && marker.nativeSessionId === nativeId && command && toolUseId && Number.isFinite(observedAt)) {
            s.nativeHookProof = { ...marker, command, toolUseId, sourceEventRef: ref, observedAt };
          }
        }
      }
    } else if (s.verified && r.type === 'event_msg' && p.type === 'task_started') {
      resetTurn(s, cleanString(p.turn_id));
    } else if (s.verified && r.type === 'turn_context') {
      const turnId = cleanString(p.turn_id);
      // A turn_context is native current-turn evidence even before token_count exists.
      if (turnId && !s.turnId) resetTurn(s, turnId);
      if (turnId && turnId !== s.turnId) return;
      observe(s, p.model, ref, at);
    }
    return;
  }
  if (harness === 'claude-code') {
    if (r.isSidechain || r.agentId || (r.sessionId && r.sessionId !== nativeId)) return;
    if (r.sessionId === nativeId) s.verified = true;
    const attachment = record(r.attachment);
    if (s.verified && r.sessionId === nativeId && r.type === 'attachment' && attachment.hookEvent === 'PreToolUse' &&
      (attachment.type === 'hook_success' && attachment.exitCode === 0 || attachment.type === 'hook_blocking_error' && attachment.exitCode === 2)) {
      const marker = parseOriginHookMarker(attachment.stderr) ?? parseOriginHookMarker(attachment.stdout);
      const command = cleanString(attachment.command), toolUseId = cleanString(attachment.toolUseID), observedAt = Date.parse(at);
      if (marker && marker.nativeSessionId === nativeId && command && toolUseId && Number.isFinite(observedAt)) {
        s.nativeHookProof = { ...marker, command, toolUseId, sourceEventRef: ref, observedAt };
      }
    }
    const m = record(r.message);
    if (r.type === 'user' && !r.isMeta && userContent(m)) resetTurn(s, cleanString(r.uuid));
    else if (r.type === 'assistant') observe(s, m.model, ref, at);
    return;
  }
  if (harness === 'gemini-cli') {
    if (r.sessionId) {
      s.verified = r.sessionId === nativeId;
      if (!s.verified) { s.invalid = 'native-session-mismatch'; resetTurn(s, null); return; }
    }
    if (r.type === 'user') resetTurn(s, cleanString(r.id));
    else if (r.type === 'gemini') observe(s, r.model, ref, at);
    return;
  }
  if (harness === 'pi-cli') {
    if (r.type === 'session') {
      s.verified = r.id === nativeId;
      if (!s.verified) { s.invalid = 'native-session-mismatch'; resetTurn(s, null); }
      return;
    }
    if (!s.verified) return;
    const id = cleanString(r.id);
    if (!id) return;
    const parent = cleanString(r.parentId);
    const previous = parent ? s.branches.get(parent) : undefined;
    Object.assign(s, previous ?? emptyTurn());
    const m = record(r.message);
    if (r.type === 'model_change') {
      // Configuration has changed; wait for an actual assistant model on this branch.
      s.model = null; s.ref = null; s.at = null;
    } else if (r.type === 'message' && m.role === 'user') resetTurn(s, id);
    else if (r.type === 'message' && m.role === 'assistant') observe(s, m.model, ref, at);
    // Bounded branch ancestry. Evicted ancestry is unavailable, never guessed from another leaf.
    if (s.branches.size >= 4096) s.branches.delete(s.branches.keys().next().value!);
    s.branches.set(id, { turnId: s.turnId, model: s.model, ref: s.ref, at: s.at });
    return;
  }
  if (harness === 'grok-build') {
    if (r.type === 'user' && !r.synthetic_reason) {
      const index = Number.isSafeInteger(r.prompt_index) ? String(r.prompt_index) : cleanString(r.id);
      resetTurn(s, index ? `history:${index}` : null);
      s.waitForUser = false;
    } else if (r.type === 'assistant') observe(s, r.model_id, ref, at);
  }
}

/**
 * Bounded asynchronous tailer. get() only copies cached metadata; no I/O occurs on preparation.
 * JSONL work is capped per refresh and yields between 64-record batches. Snapshot size is capped.
 */
export class RuntimeOriginObserver {
  private readonly sessions = new Map<string, Tracked>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private nextSession = 0;
  private readonly bytes: number;
  private readonly snapshotBytes: number;
  private readonly freshnessMs: number;
  constructor(private readonly options: {
    maxBytesPerRefresh?: number;
    maxSnapshotBytes?: number;
    maxSessions?: number;
    freshnessMs?: number;
    pollIntervalMs?: number;
    homeDir?: string;
    now?: () => number;
  } = {}) {
    this.bytes = options.maxBytesPerRefresh ?? 256 * 1024;
    this.snapshotBytes = options.maxSnapshotBytes ?? 8 * 1024 * 1024;
    this.freshnessMs = options.freshnessMs ?? 30_000;
    for (const n of [this.bytes, this.snapshotBytes, this.freshnessMs, options.maxSessions ?? 1000, options.pollIntervalMs ?? 250]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid runtime observation bound');
    }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Read-only aggregate source health; hook proof is not a model canary. */
  getHealth() {
    const harnesses: Record<string, { tracked: number; observed: number; configured: number; unknown: number; unavailable: number; hookProofs: number }> = {};
    let succeededAt: number | null = null;
    for (const [id, tracked] of this.sessions) {
      const row = harnesses[tracked.binding.harnessId] ??= { tracked: 0, observed: 0, configured: 0, unknown: 0, unavailable: 0, hookProofs: 0 };
      row.tracked++;
      const observation = this.get(id)!; row[observation.model.status]++;
      if (tracked.unavailable || tracked.parser.invalid || this.now() - tracked.lastHealthy > this.freshnessMs) row.unavailable++;
      if (this.getNativeHookProof(id)) row.hookProofs++;
      if (tracked.lastHealthy > 0) succeededAt = Math.max(succeededAt ?? 0, tracked.lastHealthy);
    }
    return { state: this.stopped ? 'closed' : !this.sessions.size ? 'idle' : Object.values(harnesses).some(row => row.unavailable || row.unknown || row.configured) ? 'degraded' : 'healthy',
      reason: this.stopped ? 'observer-stopped' : !this.sessions.size ? 'no-tracked-sessions' : 'native-source-observations', succeededAt, harnesses };
  }

  track(binding: OriginSessionBinding, source?: RuntimeOriginSource): void {
    if (!this.sessions.has(binding.sessionId) && this.sessions.size >= (this.options.maxSessions ?? 1000)) {
      throw new Error('Runtime observer capacity unavailable');
    }
    if (source && (!path.isAbsolute(source.path) || !source.nativeSessionId)) throw new Error('Invalid runtime source');
    const previous = this.sessions.get(binding.sessionId);
    this.sessions.set(binding.sessionId, {
      binding: { ...binding, nativeSessionId: source?.nativeSessionId ?? binding.nativeSessionId }, source,
      parser: newParser(), cursor: newCursor(), events: newCursor(), generation: (previous?.generation ?? 0) + 1,
      lastHealthy: 0, unavailable: 'observation-pending', discoveryAt: 0,
    });
  }

  bindNative(sessionId: string, nativeSessionId: string): void {
    const tracked = this.sessions.get(sessionId);
    if (!tracked || !cleanString(nativeSessionId)) return;
    if (tracked.binding.nativeSessionId === nativeSessionId) return;
    this.track({ ...tracked.binding, nativeSessionId });
  }

  invalidate(sessionId: string, reason = 'runtime-invalidated'): void {
    const t = this.sessions.get(sessionId);
    if (!t) return;
    t.generation++; t.parser = newParser(); t.cursor = newCursor(); t.events = newCursor();
    t.lastHealthy = 0; t.unavailable = reason;
  }
  untrack(sessionId: string): void { this.sessions.delete(sessionId); }

  get(sessionId: string): RuntimeOriginObservation | undefined {
    const t = this.sessions.get(sessionId);
    if (!t) return undefined;
    const configured = cleanString(t.binding.configuredModel);
    const unavailable = t.unavailable ?? t.parser.invalid ??
      (this.now() - t.lastHealthy > this.freshnessMs ? 'observation-stale' : null);
    const model: RuntimeModelEvidence = !unavailable && t.parser.verified && t.parser.model
      ? { value: t.parser.model, status: 'observed', sourceEventRef: t.parser.ref, observedAt: t.parser.at }
      : { value: configured, status: configured ? 'configured' : 'unknown', sourceEventRef: null, observedAt: null,
          reason: unavailable ?? 'current-turn-model-unavailable' };
    return { sessionId, sessionIncarnation: t.binding.sessionIncarnation, harnessId: t.binding.harnessId,
      nativeSessionId: t.binding.nativeSessionId ?? null, turnId: t.parser.turnId, model, configuredModel: configured };
  }

  /** Only registered native sources feed this cache; callers cannot supply a path or record. */
  getNativeHookProof(sessionId: string): OriginNativeHookProof | undefined {
    const t = this.sessions.get(sessionId), proof = t?.parser.nativeHookProof;
    if (!t || !proof || t.unavailable || t.parser.invalid || !t.parser.verified ||
      this.now() - t.lastHealthy > this.freshnessMs || proof.sessionIncarnation !== t.binding.sessionIncarnation ||
      proof.nativeSessionId !== t.binding.nativeSessionId) return;
    return { ...proof };
  }

  refresh(sessionId: string): Promise<void> {
    const t = this.sessions.get(sessionId);
    if (!t || this.stopped) return Promise.resolve();
    if (t.busy) return t.busy;
    const generation = t.generation;
    t.busy = this.refreshTracked(t, generation).catch(() => {
      if (this.sessions.get(sessionId) === t && generation === t.generation) t.unavailable = 'source-unreadable';
    }).finally(() => { t.busy = undefined; });
    return t.busy;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async (): Promise<void> => {
      const ids = [...this.sessions.keys()];
      // Four sources at a time; never enqueue an unbounded refresh population.
      const selected: string[] = [];
      for (let n = 0; n < Math.min(4, ids.length); n++) selected.push(ids[(this.nextSession++) % ids.length]);
      await Promise.all(selected.map(id => this.refresh(id)));
      if (!this.stopped) { this.timer = setTimeout(() => { void tick(); }, this.options.pollIntervalMs ?? 250); this.timer.unref(); }
    };
    this.timer = setTimeout(() => { void tick(); }, 0); this.timer.unref();
  }
  stop(): void {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const t of this.sessions.values()) { t.generation++; t.unavailable = 'observer-stopped'; }
  }

  private async refreshTracked(t: Tracked, generation: number): Promise<void> {
    const current = (): boolean => this.sessions.get(t.binding.sessionId) === t && generation === t.generation && !this.stopped;
    const nativeId = t.binding.nativeSessionId;
    if (!nativeId) { t.unavailable = 'native-session-unbound'; return; }
    if (!t.source) {
      if (t.discoveryAt && this.now() - t.discoveryAt < 5000) return;
      t.discoveryAt = this.now();
      const source = await this.discover(t.binding);
      if (!current()) return;
      t.source = source;
      if (!source) { t.unavailable = 'native-source-unavailable'; return; }
    }
    const source = t.source;
    if (!source) { t.unavailable = 'native-source-unavailable'; return; }
    t.unavailable = 'observation-refreshing';
    if (source.nativeSessionId !== nativeId) { t.unavailable = 'native-session-mismatch'; return; }
    if (t.binding.harnessId === 'grok-build') {
      if (!source.eventsPath) { t.unavailable = 'native-event-binding-unavailable'; return; }
      const done = await this.readJsonl(t, source.eventsPath, t.events, (row, ref) => {
        const r = record(row);
        if (r.session_id && r.session_id !== nativeId) {
          t.parser.invalid = 'native-session-mismatch'; t.parser.verified = false; resetTurn(t.parser, null);
        } else if (r.type === 'turn_started' && r.session_id === nativeId) {
          t.parser.verified = true; t.parser.waitForUser = true; resetTurn(t.parser, null);
        }
      }, current);
      if (!current()) return;
      if (!done) { t.unavailable = 'event-source-backlog'; return; }
    }
    if (source.format === 'snapshot' || source.path.endsWith('.json')) {
      const handle = await open(source.path, 'r');
      try {
        const before = await handle.stat();
        if (before.size > this.snapshotBytes) { t.unavailable = 'source-size-limit'; return; }
        if (t.cursor.inode === before.ino && t.cursor.offset === before.size && t.cursor.mtime === before.mtimeMs) {
          if (current()) {
            t.unavailable = t.parser.invalid ?? (t.parser.verified ? null : 'native-session-unverified');
            t.lastHealthy = this.now();
          }
          return;
        }
        const buffer = Buffer.alloc(before.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const parsed = record(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
        const state = newParser();
        consume(state, t.binding.harnessId, nativeId, parsed, `${nativeId}:header`, new Date(this.now()).toISOString());
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        for (let i = 0; i < messages.length; i++) {
          consume(state, t.binding.harnessId, nativeId, messages[i], `${nativeId}:message:${cleanString(record(messages[i]).id) ?? i}`, new Date(this.now()).toISOString());
          if (i % 64 === 63) await new Promise<void>(resolve => setImmediate(resolve));
        }
        const after = await handle.stat();
        if (!current()) return;
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) { t.unavailable = 'source-changing'; return; }
        t.parser = state;
        t.cursor.inode = before.ino; t.cursor.offset = before.size; t.cursor.mtime = before.mtimeMs;
      } finally { await handle.close(); }
    } else {
      const done = await this.readJsonl(t, source.path, t.cursor,
        (row, ref) => consume(t.parser, t.binding.harnessId, nativeId, row, ref, new Date(this.now()).toISOString()), current);
      if (!current()) return;
      if (!done) { t.unavailable = 'source-backlog-or-partial-record'; return; }
    }
    if (current()) {
      t.unavailable = t.parser.invalid ?? (t.parser.verified ? null : 'native-session-unverified');
      t.lastHealthy = this.now();
    }
  }

  private async readJsonl(t: Tracked, file: string, cursor: Cursor,
    accept: (row: unknown, ref: string) => void, current: () => boolean): Promise<boolean> {
    const handle = await open(file, 'r');
    try {
      const before = await handle.stat();
      if (!current()) return false;
      if (cursor.inode !== null && (cursor.inode !== before.ino || before.size < cursor.offset ||
          (before.size === cursor.offset && before.mtimeMs !== cursor.mtime))) {
        Object.assign(cursor, newCursor()); t.parser = newParser();
      }
      cursor.inode = before.ino;
      const buffer = Buffer.alloc(Math.min(this.bytes, Math.max(0, before.size - cursor.offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
      if (!current()) return false;
      cursor.offset += bytesRead; cursor.mtime = before.mtimeMs;
      const data = Buffer.concat([cursor.partial, buffer.subarray(0, bytesRead)]);
      let begin = 0; let count = 0;
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, begin)) {
        const line = data.subarray(begin, end).toString('utf8'); begin = end + 1; cursor.line++;
        if (line.trim()) {
          try { accept(JSON.parse(line), `${t.binding.nativeSessionId}:line:${cursor.line}`); }
          catch { t.parser.invalid = 'malformed-native-record'; resetTurn(t.parser, null); }
        }
        if (++count % 64 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); if (!current()) return false; }
      }
      cursor.partial = Buffer.from(data.subarray(begin));
      if (cursor.partial.length > this.bytes) {
        // Never allow a hostile/changed native record to accumulate an unbounded buffer.
        cursor.partial = Buffer.alloc(0); t.parser.invalid = 'native-record-size-limit';
        return false;
      }
      const after = await handle.stat();
      return cursor.offset === after.size && before.mtimeMs === after.mtimeMs && cursor.partial.length === 0;
    } finally { await handle.close(); }
  }

  /** Exact native identity, bounded asynchronous discovery, performed only on track/rebind or a throttled miss. */
  private async discover(b: OriginSessionBinding): Promise<RuntimeOriginSource | undefined> {
    const nativeId = b.nativeSessionId!;
    if (!/^[A-Za-z0-9_-]+$/.test(nativeId)) return undefined;
    const home = this.options.homeDir ?? os.homedir();
    if (b.harnessId === 'claude-code') return {
      path: path.join(b.configHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects', b.projectDir.replace(/[\\/.]/g, '-'), `${nativeId}.jsonl`), nativeSessionId: nativeId,
    };
    if (b.harnessId === 'grok-build') {
      const dir = path.join(b.configHome ?? process.env.GROK_HOME ?? path.join(home, '.grok'), 'sessions', encodeURIComponent(b.projectDir), nativeId);
      return { path: path.join(dir, 'chat_history.jsonl'), eventsPath: path.join(dir, 'events.jsonl'), nativeSessionId: nativeId };
    }
    const root = b.harnessId === 'codex-cli'
      ? path.join(b.configHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions')
      : b.harnessId === 'gemini-cli'
        ? path.join(b.configHome ?? path.join(home, '.gemini'), 'tmp')
        : b.configHome ?? path.join(b.projectDir, '.instar', 'state', 'pi-sessions');
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 5000) {
      const item = queue.shift()!;
      let directory;
      try { directory = await opendir(item.dir); } catch { continue; }
      for await (const entry of directory) {
        if (++visited > 5000) return undefined;
        const file = path.join(item.dir, entry.name);
        if (entry.isDirectory() && item.depth < 3) queue.push({ dir: file, depth: item.depth + 1 });
        if (!entry.isFile()) continue;
        const matches = b.harnessId === 'codex-cli' ? entry.name.endsWith(`-${nativeId}.jsonl`)
          : b.harnessId === 'gemini-cli' ? new RegExp(`-${nativeId.replace(/-/g, '').slice(0, 8)}\\.jsonl?$`, 'i').test(entry.name)
            : entry.name.endsWith(`${nativeId}.jsonl`);
        if (matches) return { path: file, nativeSessionId: nativeId, format: file.endsWith('.json') ? 'snapshot' : 'jsonl' };
      }
    }
    return undefined;
  }
}
