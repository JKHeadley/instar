// Browser-local pending sends. The server remains the authority for effects and delivery.
// See docs/specs/web-chat-durable-outbox.md. No received conversation content is persisted here.
import { createBrowserDevice, sameDeviceIdentity, setBrowserDeviceCleanup, newRequestId, keyDecision, deleteRecord } from './browser-device.js';
import { getChatOutbox } from './chat-outbox.js';
import { declaredKindFor, parseConversationRef, sendOutcome, UNFINISHED_KEY } from './chats-model.js';

const WORK_LOCK = 'instar-chat-outbox-active-work-v1';
const REQUEST_MS = 20_000;
const enc = new TextEncoder();
const actorOf = (r) => ({ machineId: r.machineId, deviceId: r.deviceId, host: r.host, keyHash: r.keyHash });
const online = () => globalThis.navigator?.onLine !== false;
const exactStop = (text, support) => Array.isArray(support?.stopPhrases)
  ? support.stopPhrases.includes(String(text).trim().toLowerCase()) : null;
const messagePath = (ref) => ref.kind === 'app' ? `/mobile/chat/app/${encodeURIComponent(ref.id)}`
  : ref.kind === 'telegram' ? `/mobile/chat/${encodeURIComponent(ref.id)}` : `/mobile/chat/slack/${encodeURIComponent(ref.id)}`;
const copyFiles = (entry, index, patch) => entry.files.map((file, i) => i === index ? { ...file, ...patch } : file);
const neverAuto = new Set(['stop', 'legacy', 'generation', 'identity', 'expired', 'conflict', 'unknown', 'refused', 'exhausted', 'storage']);

const UNREADABLE_FENCE = Symbol('unreadable-sign-in-fence');
export function captureSignInFence() {
  try { return globalThis.localStorage ? localStorage.getItem('instar_console_logout_fence') : undefined; }
  catch { return UNREADABLE_FENCE; }
}
export function signInFenceMatches(fence) { return fence !== UNREADABLE_FENCE && captureSignInFence() === fence; }
export function isOutboxStorageFailure(error) {
  if (typeof error?.code === 'string') return ['indexeddb-unavailable', 'outbox-open-failed', 'outbox-storage-blocked', 'outbox-transaction-aborted'].includes(error.code);
  return ['QuotaExceededError', 'UnknownError', 'NotReadableError', 'InvalidStateError', 'AbortError'].includes(error?.name);
}

// Registered before Chats can take a definitive key-removal path; the store opens lazily.
setBrowserDeviceCleanup((record) => getChatOutbox().clearScope(record));
let current = null;
export function getConsoleOutbox() { return current; }
export async function beginConsoleOutbox(options = {}) {
  current?.dispose();
  const runner = new OutboxRunner(options);
  current = runner;
  try { await runner.bind(); } catch (error) { runner.dispose(); throw error; }
  void runner.reconnect();
  return runner;
}

// A current user's emergency action must not depend on the new pending-content database.
// There is one signed attempt, no timer/replay grant, and no successful-save claim.
export async function tryLiveStop({ device, record, path, text, requestId, slackHolder = null, isCurrent = () => true }) {
  if (!online() || !isCurrent() || !sameDeviceIdentity(record, device.record)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_MS);
  try {
    const st = await device.status(record.keyHash, { signal: controller.signal });
    if (!st?.ok || st.data.machineId !== record.machineId || st.data.key?.state !== 'active'
      || exactStop(text, st.data.outbox) !== true || !isCurrent()) return null;
    if (slackHolder && slackHolder !== st.data.machineId) return null;
    if (/^\/mobile\/chat\/[^/]+$/.test(path) && st.data.telegramSend !== true) return null;
    const json = { text, requestId, ...(slackHolder ? { machine: slackHolder } : {}) };
    let result;
    try {
      result = await device.call('POST', path, { json, signal: controller.signal, expectedRecord: record,
        isCurrent, beforeFetch: async () => { if (!isCurrent()) throw new Error('sign-in-ended'); } });
    } catch {
      throw Object.assign(new Error('The stop may have reached the session. Check the conversation before sending another stop.'), { code: 'live-stop-outcome-unknown' });
    }
    if (result.ok && result.status !== 202 && result.data?.messageId) return { ...result.data, requestId };
    const uncertain = result.status === 0 || result.status === 202 || result.status >= 500 || result.ok;
    throw Object.assign(new Error(uncertain ? 'The stop may have reached the session. Check the conversation before sending another stop.'
      : result.data?.detail || 'The stop was refused. Your text is still in the composer.'), { code: uncertain ? 'live-stop-outcome-unknown' : 'live-stop-refused' });
  } finally { clearTimeout(timer); }
}

export class OutboxRunner {
  constructor({ bearer = () => '', fetchFn, store = getChatOutbox(), locks = globalThis.navigator?.locks,
    now = null, setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = (id) => globalThis.clearTimeout(id) } = {}) {
    this.store = store; this.locks = locks; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.device = createBrowserDevice({ bearer, ...(fetchFn ? { fetchFn } : {}) });
    this.now = now || (() => this.device.clock.now());
    this.authFence = captureSignInFence();
    this.active = true; this.session = null; this.record = null; this.status = null;
    this.entries = []; this.listeners = new Set(); this.timers = new Map(); this.controllers = new Set();
    this.checked = new Set(); this.manual = new Set(); this.running = null; this.again = false;
    this.onOnline = () => { void this.reconnect(); };
    globalThis.addEventListener?.('online', this.onOnline);
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('instar-chat-outbox-v1') : null;
    if (this.channel) this.channel.onmessage = () => { if (this.active) void this.reconnect(); };
  }
  async bind() { this.session = await this.store.bindSession(); return this; }
  subscribe(fn) { this.listeners.add(fn); fn(this.snapshot()); return () => this.listeners.delete(fn); }
  snapshot() { return { entries: this.entries, record: this.record, status: this.status, error: this.error || null, metrics: this.metrics || null, accepted: this.lastAccepted || null }; }
  emit() { for (const fn of this.listeners) { try { fn(this.snapshot()); } catch (error) { console.error('Pending-send view failed', error?.name || 'error'); } } }
  changed() { try { this.channel?.postMessage({ kind: 'changed' }); } catch { /* disposed receiver; local state is still authoritative */ } }
  dispose() {
    this.active = false;
    if (current === this) current = null;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    globalThis.removeEventListener?.('online', this.onOnline);
    this.channel?.close();
    this.listeners.clear();
  }
  async clearAll() {
    this.dispose();
    await this.store.clearAll();
    try { sessionStorage.removeItem(UNFINISHED_KEY); } catch { /* durable retirement still prevents import */ }
    this.changed();
  }
  async deadline(fn) {
    const c = new AbortController(); this.controllers.add(c);
    const timer = this.setTimer(() => c.abort(), REQUEST_MS);
    try { return await fn(c.signal); }
    finally { this.clearTimer(timer); this.controllers.delete(c); }
  }
  async fresh(record) {
    if (!this.active || !this.session || !record) return null;
    const st = await this.deadline((signal) => this.device.status(record.keyHash, { signal }));
    if (!this.active || !st?.ok) return null;
    const decision = keyDecision(st.data, record);
    if (decision.action === 'delete') {
      this.entries = [];
      this.error = new Error('This browser was removed. Saved-message cleanup must complete before recovery.');
      this.emit();
      await deleteRecord(record.machineId, record);
      this.record = null;
      return null;
    }
    if (st.data.machineId !== record.machineId || st.data.key?.state !== 'active') return null;
    this.status = st.data;
    return st.data;
  }
  async refreshView() {
    if (!this.session || !this.record || !this.active) return;
    try {
      this.entries = await this.store.list(this.session, this.record);
      this.metrics = await this.store.metrics(this.session, this.record);
      this.error = null;
    } catch (error) { this.error = error; this.metrics = null; }
    this.emit();
  }
  schedule(id, at) {
    if (!this.active || this.timers.has(id)) return;
    // Very long server cooldowns are honored without overflowing the browser timer range.
    const remaining = Math.max(0, at - this.now());
    const timer = this.setTimer(() => {
      this.timers.delete(id);
      if (!this.active) return;
      if (this.now() < at) this.schedule(id, at);
      else void this.reconnect();
    }, Math.min(remaining, 2_147_000_000));
    this.timers.set(id, timer);
  }
  async owned(fn, manual = false) {
    if (this.locks?.request) {
      const c = new AbortController(); this.controllers.add(c);
      try { return await this.locks.request(WORK_LOCK, { signal: c.signal }, () => this.active ? fn() : null); }
      finally { this.controllers.delete(c); }
    }
    return manual && this.active ? fn() : null;
  }
  async hold(entry, code, reason, extra = {}) {
    if (entry.phase === 'held' && entry.holdCode === code && entry.reason === reason
      && Object.entries(extra).every(([key, value]) => JSON.stringify(entry[key]) === JSON.stringify(value))) return entry;
    const updated = await this.store.update(this.session, this.record, entry,
      { phase: 'held', holdCode: code, reason, ...extra });
    if (updated) this.changed();
    return updated;
  }
  allowed(entry, status, immediate = false) {
    if (!sameDeviceIdentity(entry.actor, this.record) || status.machineId !== entry.actor.machineId) return ['identity', 'This saved message belongs to a different browser identity.'];
    const support = status.outbox;
    if (support?.version !== 1 || support.enabled !== true || typeof support.recoveryGeneration !== 'string') return ['unsupported', 'The agent needs a compatible update before this saved message can resume.'];
    if (entry.recoveryGeneration !== support.recoveryGeneration) return ['generation', 'Review this saved message before resuming it after the server recovery.'];
    const isStop = entry.stopEvidence !== 'unmatched' || exactStop(entry.text, support) !== false;
    if (isStop && !immediate) return ['stop', 'A saved stop needs a new, current Send action.'];
    const ref = parseConversationRef(entry.ref);
    if (!ref) return ['refused', 'The saved destination is not recognized.'];
    if (ref.kind === 'slack' && entry.slackHolder !== status.machineId) return ['identity', 'Open the machine that holds this Slack conversation to review the saved message.'];
    if (ref.kind === 'telegram' && status.telegramSend !== true) return ['unsupported', 'Waiting for the machine serving Telegram.'];
    if (!immediate && support.text !== true) return ['unsupported', 'Sending is switched off here. Your message is still saved.'];
    if (entry.files?.length && support.media !== true) return ['media-off', 'Files are switched off here. Your selected files are still saved.'];
    return null;
  }
  async submit({ record, status, ref, text, files = [], slackHolder = null, mediaRef = null, requestTime, isCurrent = () => true }) {
    if (!this.active || !this.session || !signInFenceMatches(this.authFence) || !isCurrent()) throw Object.assign(new Error('This sign-in has ended. Your draft was not saved.'), { code: 'outbox-session-ended' });
    const captured = actorOf(record);
    const requestId = newRequestId(Number.isFinite(requestTime) ? requestTime : this.device.clock.now());
    const path = messagePath(parseConversationRef(ref));
    const match = exactStop(text, status?.outbox);
    const entry = { requestId, ref, text, actor: captured, slackHolder, mediaRef, path,
      firstSentAt: Number.isFinite(requestTime) ? requestTime : this.now(), recoveryGeneration: status?.outbox?.recoveryGeneration ?? null,
      stopEvidence: match === null ? 'unknown' : match ? 'matched' : 'unmatched',
      phase: match === false ? 'prepared' : 'held', ...(match !== false ? { holdCode: 'stop', reason: 'A saved stop needs a current Send action.' } : {}) };
    await this.device.load(record.machineId);
    if (!sameDeviceIdentity(captured, this.device.record) || !isCurrent()) throw new Error('This browser identity changed. Your draft was not saved.');
    this.record = this.device.record;
    let saved;
    try {
      saved = await this.store.admit(this.session, this.record, entry, files,
        { chunkBytes: status?.limits?.chunkBytes || 1024 * 1024, maxMessageBytes: status?.limits?.maxMessageBytes || 64 * 1024 * 1024 });
    } catch (error) {
      if (isOutboxStorageFailure(error) && match === true && !files.length && online() && this.active && signInFenceMatches(this.authFence) && isCurrent()) {
        const accepted = await this.directStop(entry, isCurrent);
        if (accepted) return { entry: null, direct: accepted };
      }
      throw error;
    }
    this.changed();
    await this.refreshView();
    if (match === true && !files.length && online() && isCurrent()) await this.immediateStop(saved, isCurrent);
    else void this.reconnect();
    return { entry: saved };
  }
  async directStop(entry, isCurrent) {
    return tryLiveStop({ device: this.device, record: entry.actor, path: entry.path, text: entry.text,
      requestId: entry.requestId, slackHolder: entry.slackHolder, isCurrent: () => this.active && signInFenceMatches(this.authFence) && isCurrent() });
  }
  async freeze(entry) {
    if (entry.finalBody) return entry;
    const attachments = (entry.files || []).map((f) => ({ uploadId: f.uploadId, sha256: f.sha256, size: f.size,
      declaredKind: f.declaredKind || declaredKindFor(f.declaredType || f.type || 'application/octet-stream'),
      declaredType: f.declaredType || f.type || 'application/octet-stream', filename: f.filename || f.name || 'file' }));
    const body = { text: entry.text || '', requestId: entry.requestId, ...(attachments.length ? { attachments } : {}),
      ...(entry.slackHolder ? { machine: entry.slackHolder } : {}) };
    return this.store.update(this.session, this.record, entry, { finalPath: entry.path, finalBody: JSON.stringify(body), phase: 'ready' });
  }
  async immediateStop(entry, isCurrent) {
    if (!this.active || !isCurrent()) return;
    const row = await this.freeze(entry);
    if (!row) return;
    try {
      const accepted = await this.directStop(row, isCurrent);
      if (accepted && await this.store.remove(this.session, this.record, row, { acceptedAt: this.now(), messageId: String(accepted.messageId) })) {
        this.lastAccepted = { entry: row, data: accepted }; this.changed();
      }
    } catch (error) {
      await this.hold(row, 'stop', error.message);
    }
    await this.refreshView();
  }
  async step(entry, keySpec, request, { final = false, immediate = false, manual = false, bypassOrdering = false,
    isCurrent = () => true, reconcileConflict = false, needed = null } = {}) {
    const run = async () => {
      if (!this.active || !isCurrent()) return { kind: 'gone' };
      let row = await this.store.get(this.session, this.record, entry.requestId);
      if (!row || row.admissionId !== entry.admissionId) return { kind: 'gone' };
      const key = typeof keySpec === 'function' ? keySpec(row) : keySpec;
      const reconcilingWrite = row.holdCode === 'exhausted' && String(row.exhaustedStep || '').startsWith('part:') && key.startsWith('status:');
      if (!immediate && neverAuto.has(row.holdCode) && !reconcilingWrite) return { kind: 'held', entry: row };
      if (needed && !needed(row)) return { kind: 'progress', entry: row };
      const status = await this.fresh(this.record);
      if (!status) return { kind: 'waiting' }; // Existing connection recovery owns the next reachability trigger.
      const refusal = this.allowed(row, status, immediate);
      if (refusal) { await this.hold(row, ...refusal); return { kind: 'held' }; }
      const claim = await this.store.claimAttempt(this.session, this.record, row, key,
        { now: this.now(), deadlineMs: REQUEST_MS, final: final && !bypassOrdering });
      if (claim.kind === 'wait') { this.schedule(row.requestId, claim.nextEligibleAt); return { kind: 'waiting' }; }
      if (claim.kind === 'blocked') {
        await this.hold(row, 'ordering', 'Waiting for an earlier saved message.', { predecessorId: claim.predecessorId });
        return { kind: 'held' };
      }
      if (claim.kind === 'exhausted') {
        await this.hold(row, 'exhausted', row.finalBody ? 'The original request needs review. Check the conversation before resuming.' : 'Recovery paused after repeated failures. Your content is still saved.', { exhaustedStep: key });
        return { kind: 'exhausted' };
      }
      if (claim.kind !== 'claimed') return { kind: 'stale' };
      row = claim.entry;
      let r;
      try { r = await this.deadline((signal) => request(row, { signal, expectedRecord: row.actor,
        isCurrent: () => this.active && signInFenceMatches(this.authFence) && isCurrent(), beforeFetch: async () => {
          if (!this.active || !signInFenceMatches(this.authFence) || !isCurrent() || !await this.store.verifyClaim(this.session, this.record, row, claim.token)) throw new Error('saved-send-no-longer-current');
        } })); } catch (error) {
        if (!this.active) return { kind: 'gone' };
        if (error?.name === 'OperationError' || String(error?.code || '').startsWith('outbox-')) {
          await this.store.finishAttempt(this.session, this.record, row, claim.token, { patch: { phase: 'held', holdCode: 'storage', reason: 'The saved file could not be read. Its original operation will not be changed.' } });
          return { kind: 'held' };
        }
        r = { ok: false, status: 0, data: null, networkError: true };
      }
      if (!this.active) return { kind: 'gone' };
      if (final && r.ok && r.status !== 202 && r.data?.messageId) {
        const removed = await this.store.remove(this.session, this.record, row, { acceptedAt: this.now(), messageId: String(r.data.messageId) });
        if (removed) { this.lastAccepted = { entry: row, data: r.data }; this.changed(); }
        return { kind: 'accepted', response: r, entry: row };
      }
      if (immediate) {
        await this.store.finishAttempt(this.session, this.record, row, claim.token,
          { patch: { phase: 'held', holdCode: 'stop', reason: 'The stop may have reached the session. Check the conversation; it will not replay automatically.' } });
        return { kind: 'held', response: r };
      }
      const code = r.data?.error;
      const transient = r.status === 0 || r.status === 202 || r.status === 429 || r.status >= 500 || r.status === 401 || (key.startsWith('status:') && r.ok && r.data?.state === 'assembling');
      const count = row.attempts?.[key]?.count || 1;
      const delay = Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0 ? r.retryAfterMs : Math.min(2000 * 2 ** Math.max(0, count - 1), 30_000);
      const retryAt = transient ? this.now() + delay : 0;
      const patch = final ? { phase: 'submitted' } : { phase: 'uploading' };
      const updated = await this.store.finishAttempt(this.session, this.record, row, claim.token, { nextEligibleAt: retryAt, patch });
      if (transient) {
        if (updated) this.schedule(row.requestId, retryAt);
        return { kind: 'waiting', response: r, entry: updated };
      }
      if (!r.ok && !(reconcileConflict && r.status === 409)) {
        if (updated) await this.hold(updated, code === 'outcome-unknown' ? 'unknown' : code === 'payload-conflict' ? 'conflict'
          : r.status === 410 || code === 'request-id-too-old' ? 'expired' : 'refused', r.data?.detail || 'This saved operation was refused. Check the conversation.');
        return { kind: 'held', response: r, entry: updated };
      }
      return { kind: 'ok', response: r, entry: updated };
    };
    return immediate ? run() : this.owned(run, manual);
  }
  async statusFor(entry, i, manual) {
    const f = entry.files[i];
    const keyFor = (fresh) => `status:${i}:${[...new Set(fresh.files[i].received || [])].sort((a, b) => a - b).join(',')}`;
    const r = await this.step(entry, keyFor, (_row, opts) => this.device.call('GET', `/mobile/media/uploads/${encodeURIComponent(f.uploadId)}`, opts),
      { manual, needed: (fresh) => !fresh.finalBody && !fresh.files[i].complete });
    if (r?.kind === 'progress' && r.entry) {
      const clear = r.entry.holdCode === 'exhausted' && String(r.entry.exhaustedStep || '').startsWith('part:');
      if (clear) r.entry = await this.store.update(this.session, this.record, r.entry, { holdCode: null, reason: null, exhaustedStep: null });
      return r;
    }
    if (r?.kind !== 'ok' || !r.entry) return r;
    const d = r.response.data;
    if (!d || !Array.isArray(d.received)) { await this.hold(r.entry, 'unknown', 'The upload status could not be read.'); return { kind: 'held' }; }
    if (d.state === 'complete') {
      const clear = r.entry.holdCode === 'exhausted' && String(r.entry.exhaustedStep || '').startsWith('part:');
      const updated = await this.store.update(this.session, this.record, r.entry, { files: copyFiles(r.entry, i, { complete: true }), ...(clear ? { holdCode: null, reason: null, exhaustedStep: null } : {}) });
      return { kind: 'progress', entry: updated };
    }
    if (d.state === 'assembling') {
      const delay = r.response.retryAfterMs || 2000;
      this.schedule(entry.requestId, this.now() + delay);
      return { kind: 'waiting' };
    }
    if (d.state !== 'open') { await this.hold(r.entry, 'expired', 'The original upload is no longer available. Your file is still saved.'); return { kind: 'held' }; }
    const progressed = d.received.some((n) => !(r.entry.files[i].received || []).includes(n));
    const clear = progressed && r.entry.holdCode === 'exhausted' && String(r.entry.exhaustedStep || '').startsWith('part:');
    const updated = await this.store.update(this.session, this.record, r.entry, { files: copyFiles(r.entry, i, { received: d.received }), ...(clear ? { holdCode: null, reason: null, exhaustedStep: null } : {}) });
    this.checked.add(`${entry.requestId}:${i}`);
    return { kind: 'status', entry: updated, progressed };
  }
  async process(entry, manual = false) {
    if (neverAuto.has(entry.holdCode)) {
      if (entry.holdCode === 'exhausted' && String(entry.exhaustedStep || '').startsWith('part:')) {
        const i = Number(entry.exhaustedStep.split(':')[1]);
        if (!Number.isInteger(i) || !entry.files[i]?.uploadId) return false;
        const result = await this.statusFor(entry, i, manual);
        return result?.kind === 'progress' || (result?.kind === 'status' && result.progressed);
      }
      return false;
    }
    let row = entry;
    if (!row.finalBody) {
      for (let i = 0; i < row.files.length; i++) {
        let f = row.files[i];
        if (f.complete) continue;
        if (!f.uploadId) {
          const meta = { conversationRef: row.mediaRef, size: f.size, sha256: f.sha256,
            declaredKind: f.declaredKind || declaredKindFor(f.declaredType || f.type || 'application/octet-stream'),
            declaredType: f.declaredType || f.type || 'application/octet-stream', filename: f.filename || f.name || 'file', requestId: f.startRequestId };
          const started = await this.step(row, `start:${i}`, (_e, opts) => this.device.call('POST', '/mobile/media/uploads', { ...opts, json: meta }), { manual, needed: (fresh) => !fresh.finalBody && !fresh.files[i].uploadId });
          if (started?.kind === 'progress') return true;
          if (started?.kind !== 'ok' || !started.entry) return false;
          if (!started.response.data?.uploadId || started.response.data.chunkSize !== f.chunkSize) {
            await this.hold(started.entry, 'unknown', 'The original upload format is unavailable. Your file is still saved.'); return false;
          }
          row = await this.store.update(this.session, this.record, started.entry,
            { files: copyFiles(started.entry, i, { uploadId: started.response.data.uploadId }) });
          return !!row;
        }
        if (!this.checked.has(`${row.requestId}:${i}`)) {
          const status = await this.statusFor(row, i, manual);
          if (status?.kind === 'progress') return true;
          if (status?.kind !== 'status' || !status.entry) return false;
          row = status.entry; f = row.files[i];
        }
        const have = new Set(f.received || []);
        const next = Array.from({ length: f.partCount }, (_, n) => n).find((n) => !have.has(n));
        if (next === undefined) {
          this.checked.delete(`${row.requestId}:${i}`);
          const status = await this.statusFor(row, i, manual);
          return status?.kind === 'progress';
        }
        const put = await this.step(row, `part:${i}:${next}`, async (claimed, opts) => {
          // Active-work ownership and durable attempt admission precede decryption. No whole file is read here.
          const bytes = await this.store.part(this.session, this.record, claimed, i, next);
          return this.device.call('PUT', `/mobile/media/uploads/${encodeURIComponent(claimed.files[i].uploadId)}/chunks/${next}`, { ...opts, bytes });
        }, { manual, reconcileConflict: true, needed: (fresh) => !fresh.finalBody && !fresh.files[i].complete && !(fresh.files[i].received || []).includes(next) });
        if (put?.kind === 'progress') return true;
        if (put?.kind === 'ok' && put.response?.ok && put.entry) {
          const updated = await this.store.update(this.session, this.record, put.entry,
            { files: copyFiles(put.entry, i, { received: [...new Set([...(put.entry.files[i].received || []), next])] }) });
          return !!updated;
        }
        this.checked.delete(`${row.requestId}:${i}`);
        // A lost final-chunk acknowledgment can be reconciled even when its PUT budget is exhausted.
        if (put?.entry || put?.kind === 'exhausted') {
          const currentRow = await this.store.get(this.session, this.record, row.requestId);
          if (currentRow) {
            const result = await this.statusFor(currentRow, i, manual);
            return result?.kind === 'progress' || (result?.kind === 'status' && result.progressed);
          }
        }
        return false;
      }
      row = await this.freeze(row);
      if (!row) return false;
    }
    const result = await this.step(row, 'final', (claimed, opts) => this.device.call('POST', claimed.finalPath,
      { ...opts, bytes: enc.encode(claimed.finalBody), contentType: 'application/json' }), { final: true, manual });
    return result?.kind === 'accepted';
  }
  async reconnect() {
    if (!this.active || !this.session) return false;
    if (!signInFenceMatches(this.authFence)) { this.entries = []; this.record = null; this.status = null; this.lastAccepted = null; this.emit(); this.dispose(); return false; }
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        const initial = await this.deadline((signal) => this.device.status(null, { signal }));
        if (!this.active || !initial?.ok) { await this.refreshView(); return false; }
        const record = await this.device.load(initial.data.machineId);
        if (!this.active) return false;
        if (!record || (this.record && !sameDeviceIdentity(this.record, record))) {
          this.entries = []; this.record = null; this.status = null; this.lastAccepted = null; this.metrics = null;
          this.error = new Error('Saved messages remain bound to their original browser identity.'); this.emit();
          if (!record) return false;
        }
        this.record = record;
        const status = await this.fresh(record);
        if (!status) { await this.refreshView(); return false; }
        this.status = status;
        await this.importLegacy();
        if (!online()) { await this.refreshView(); return false; }
        let progress;
        do {
          progress = false;
          const entries = await this.store.list(this.session, record);
          for (const entry of entries) {
            if (!this.active) return false;
            const manual = this.manual.has(entry.requestId);
            if (!manual && !this.locks?.request) continue;
            if (await this.process(entry, manual)) { progress = true; await this.refreshView(); this.changed(); }
          }
        } while (progress && this.active);
        await this.refreshView();
        return true;
      } catch (error) {
        if (this.active) { this.error = error; this.emit(); }
        return false;
      }
    })();
    try { return await this.running; }
    finally { this.running = null; if (this.again && this.active) { this.again = false; void this.reconnect(); } }
  }
  async resume(entry, { bypassPredecessorIds = [] } = {}) {
    const status = await this.fresh(this.record);
    if (!status || !sameDeviceIdentity(entry.actor, this.record)) return false;
    if (entry.stopEvidence !== 'unmatched' || exactStop(entry.text, status.outbox) !== false || entry.holdCode === 'legacy') return false;
    let row = await this.store.get(this.session, this.record, entry.requestId);
    if (!row) return false;
    row = await this.store.update(this.session, this.record, row, { recoveryGeneration: status.outbox?.recoveryGeneration,
      phase: row.finalBody ? 'submitted' : 'prepared', holdCode: null, reason: null,
      bypassPredecessorIds: [...new Set([...(row.bypassPredecessorIds || []), ...bypassPredecessorIds])] });
    if (!row) return false;
    row = await this.store.resetAttempts(this.session, this.record, row, { now: this.now() });
    if (!row) return false;
    this.manual.add(row.requestId); this.changed();
    return this.reconnect();
  }
  async recoverFile(entry, index) {
    return this.owned(async () => {
      if (!this.active || !signInFenceMatches(this.authFence)) throw new Error('This sign-in has ended.');
      const row = await this.store.get(this.session, this.record, entry.requestId);
      if (!row || row.admissionId !== entry.admissionId) throw new Error('The saved copy changed. Check the conversation.');
      const file = row.files?.[index];
      if (!file) throw new Error('That local file is not available.');
      const parts = [];
      for (let n = 0; n < file.partCount; n++) parts.push(await this.store.part(this.session, this.record, row, index, n));
      const current = await this.store.assertLive(this.session, this.record, row);
      if (!current || !this.active || !signInFenceMatches(this.authFence)) throw new Error('This saved copy is no longer current.');
      // Download semantics only: even an HTML/SVG filename must not become an active inline document.
      return { filename: file.filename || 'file', blob: new Blob(parts, { type: 'application/octet-stream' }) };
    }, true);
  }
  async remove(entry) {
    return this.owned(async () => {
      const latest = await this.store.get(this.session, this.record, entry.requestId);
      if (!latest) { await this.refreshView(); return true; }
      if (latest.admissionId !== entry.admissionId) return false;
      const removed = await this.store.remove(this.session, this.record, latest);
      if (removed) { this.manual.delete(entry.requestId); this.changed(); await this.refreshView(); void this.reconnect(); }
      return removed;
    }, true);
  }
  async importLegacy() {
    let raw;
    try { raw = sessionStorage.getItem(UNFINISHED_KEY); } catch { return; }
    if (!raw) return;
    if (!this.active || !signInFenceMatches(this.authFence)) { sessionStorage.removeItem(UNFINISHED_KEY); return; }
    if (!await this.store.legacyAllowed(this.session)) { sessionStorage.removeItem(UNFINISHED_KEY); return; }
    let rows;
    try { rows = JSON.parse(raw); } catch { this.error = new Error('An older saved send could not be read.'); return; }
    if (!Array.isArray(rows)) return;
    const remaining = [];
    for (const e of rows) {
      if (!this.active || !signInFenceMatches(this.authFence)) { sessionStorage.removeItem(UNFINISHED_KEY); return; }
      if (!e || typeof e.requestId !== 'string' || typeof e.text !== 'string' || !parseConversationRef(e.ref)
        || e.deviceId !== this.record.deviceId || e.machineId !== this.record.machineId) { remaining.push(e); continue; }
      try {
        const ref = parseConversationRef(e.ref);
        await this.store.admit(this.session, this.record, { ...e, actor: actorOf(this.record), path: messagePath(ref), files: [],
          legacyUploads: e.uploads || [], stopEvidence: 'unknown', recoveryGeneration: null, phase: 'held', holdCode: 'legacy',
          reason: 'Saved by an older dashboard. Check the conversation before making a new send.' }, [],
        { importId: e.requestId, chunkBytes: this.status?.limits?.chunkBytes || 1024 * 1024, maxMessageBytes: this.status?.limits?.maxMessageBytes || 64 * 1024 * 1024 });
      } catch { remaining.push(e); }
    }
    if (!this.active || !signInFenceMatches(this.authFence) || !await this.store.isLive(this.session) || !await this.store.legacyAllowed(this.session)) { sessionStorage.removeItem(UNFINISHED_KEY); return; }
    // No await between the final live-fence check and the tab-local write.
    if (!this.active || !signInFenceMatches(this.authFence)) { sessionStorage.removeItem(UNFINISHED_KEY); return; }
    if (remaining.length) sessionStorage.setItem(UNFINISHED_KEY, JSON.stringify(remaining));
    else sessionStorage.removeItem(UNFINISHED_KEY);
  }
}
