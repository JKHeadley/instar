// Browser-local pending sends. Crypto/File awaits stay outside IndexedDB transactions.
// docs/specs/web-chat-durable-outbox.md: the server remains the effect authority.
export const CHAT_OUTBOX_DB = 'instar-chat-outbox';
const VERSION = 1;
const STORES = ['epochs', 'keys', 'entries', 'parts'];
const enc = new TextEncoder();
const dec = new TextDecoder();
const GLOBAL = 'global';
const blankGlobal = () => ({ id: GLOBAL, epoch: 1, cleanupPending: false, legacyRetired: false });
const blankScope = (scope) => ({ id: `scope:${scope}`, epoch: 1, retired: false, cleanupPending: false });
const error = (code) => Object.assign(new Error(code), { code });
const hex = (v) => Array.from(new Uint8Array(v), (b) => b.toString(16).padStart(2, '0')).join('');
const copy = (v) => JSON.parse(JSON.stringify(v));
const entryKey = (scope, requestId) => [scope, requestId];
const identityFields = ['host', 'machineId', 'deviceId', 'keyHash'];

export function outboxIdentity(record, host) {
  const actor = {};
  for (const key of identityFields) {
    const value = key === 'host' ? record?.host || host : record?.[key];
    if (typeof value !== 'string' || !value) throw error('outbox-identity-unavailable');
    actor[key] = value;
  }
  return actor;
}
export async function identityScope(record, crypto = globalThis.crypto, host) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(outboxIdentity(record, host)))));
}
export function outboxAdditionalData(scope, requestId, admissionId, kind = 'entry', file = null, part = null) {
  return enc.encode(JSON.stringify([VERSION, scope, requestId, admissionId, kind, file, part]));
}
export async function sealOutboxBytes(crypto, key, aad, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, bytes);
  return { iv, ciphertext };
}
export async function openOutboxBytes(crypto, key, aad, sealed) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: aad, tagLength: 128 }, key, sealed.ciphertext));
}

export function createChatOutbox(options = {}) {
  // Dependency lookup is deferred: importing the module never opens storage or captures a stale login.
  const factory = () => options.indexedDB ?? globalThis.indexedDB;
  const crypt = () => options.crypto ?? globalThis.crypto;
  const ranges = () => options.IDBKeyRange ?? globalThis.IDBKeyRange;
  const uuid = () => crypt().randomUUID();
  const freshRequestId = (time) => `${Math.floor(time)}-${uuid()}`;
  const unknownMetrics = new Set();
  const readActor = (record) => outboxIdentity(record, options.host);
  const scopeOf = (record) => identityScope(record, crypt(), options.host);

  function open() {
    return new Promise((resolve, reject) => {
      if (!factory()) { reject(error('indexeddb-unavailable')); return; }
      const request = factory().open(CHAT_OUTBOX_DB, VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('epochs', { keyPath: 'id' });
        db.createObjectStore('keys', { keyPath: 'scope' });
        const entries = db.createObjectStore('entries', { keyPath: ['scope', 'requestId'] });
        entries.createIndex('scope', 'scope');
        entries.createIndex('order', ['scope', 'conversation', 'sequence']);
        const parts = db.createObjectStore('parts', { keyPath: ['scope', 'requestId', 'admissionId', 'file', 'part'] });
        parts.createIndex('scope', 'scope');
        parts.createIndex('entry', ['scope', 'requestId']);
      };
      request.onerror = () => reject(request.error || error('outbox-open-failed'));
      request.onblocked = () => { blocked = true; reject(error('outbox-storage-blocked')); };
      request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }

  async function transaction(names, mode, body) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(names, mode);
        let out, failed;
        const fail = (e) => { failed = e; try { t.abort(); } catch { reject(e); } };
        const safe = (fn) => (...args) => { try { fn(...args); } catch (e) { fail(e); } };
        const cx = {
          store: (name) => t.objectStore(name),
          get(name, key, fn) { const r = t.objectStore(name).get(key); r.onsuccess = safe(() => fn(r.result)); },
          put(name, value) { t.objectStore(name).put(value); },
          delete(name, key) { t.objectStore(name).delete(key); },
          set(value) { out = value; }, safe, fail,
        };
        t.oncomplete = () => resolve(out);
        t.onerror = () => { failed ||= t.error; };
        t.onabort = () => reject(failed || t.error || error('outbox-transaction-aborted'));
        safe(() => body(cx))();
      });
    } finally { db.close(); }
  }

  function globalLive(g, session) { return !!session && !!g && g.epoch === session.epoch && !g.cleanupPending; }
  function rowLive(g, s, session, row) {
    return globalLive(g, session) && !!s && !s.retired && !s.cleanupPending && !!row
      && row.epoch === session.epoch && row.scopeEpoch === s.epoch;
  }
  function state(cx, scope, fn) {
    cx.get('epochs', GLOBAL, (g) => cx.get('epochs', `scope:${scope}`, (s) => fn(g, s || blankScope(scope))));
  }
  function liveState(cx, session, scope, fn) {
    state(cx, scope, (g, s) => {
      if (!globalLive(g, session)) throw error('outbox-session-ended');
      if (s.retired || s.cleanupPending) throw error('outbox-identity-retired');
      fn(g, s);
    });
  }
  function liveRow(cx, session, scope, entry, fn) {
    state(cx, scope, (g, s) => cx.get('entries', entryKey(scope, entry.requestId), (row) => {
      if (!rowLive(g, s, session, row) || row.revision !== entry.revision || row.admissionId !== entry.admissionId) { cx.set(null); return; }
      fn(row, s);
    }));
  }
  function deleteCursor(cx, store, index, query, done = () => {}) {
    const r = cx.store(store).index(index).openCursor(query);
    r.onsuccess = cx.safe(() => { const c = r.result; if (!c) { done(); return; } c.delete(); c.continue(); });
  }

  async function finishCleanup(epoch) {
    return transaction(STORES, 'readwrite', (cx) => cx.get('epochs', GLOBAL, (g) => {
      if (!g || g.epoch !== epoch || !g.cleanupPending) { cx.set(false); return; }
      cx.store('entries').clear(); cx.store('parts').clear(); cx.store('keys').clear();
      cx.put('epochs', { ...g, cleanupPending: false }); cx.set(true);
    }));
  }
  async function bindSession() {
    for (;;) {
      const g = await transaction(['epochs'], 'readwrite', (cx) => cx.get('epochs', GLOBAL, (old) => {
        const value = old || blankGlobal(); if (!old) cx.put('epochs', value); cx.set(value);
      }));
      if (g.cleanupPending) {
        try { await finishCleanup(g.epoch); } catch (e) { e.phase = 'erase'; e.invalidated = true; throw e; }
        continue;
      }
      return Object.freeze({ epoch: g.epoch });
    }
  }
  async function isLive(session) {
    return transaction(['epochs'], 'readonly', (cx) => cx.get('epochs', GLOBAL, (g) => cx.set(globalLive(g, session))));
  }
  async function legacyAllowed(session) {
    return transaction(['epochs'], 'readonly', (cx) => cx.get('epochs', GLOBAL, (g) => cx.set(globalLive(g, session) && !g.legacyRetired)));
  }
  async function clearAll() {
    let epoch;
    try {
      epoch = await transaction(['epochs'], 'readwrite', (cx) => cx.get('epochs', GLOBAL, (old) => {
        const g = old || blankGlobal();
        const next = { ...g, epoch: g.epoch + 1, cleanupPending: true, legacyRetired: true };
        cx.put('epochs', next); cx.set(next.epoch);
      }));
    } catch (e) { e.phase = 'invalidate'; e.invalidated = false; throw e; }
    try { return await finishCleanup(epoch); } catch (e) { e.phase = 'erase'; e.invalidated = true; throw e; }
  }
  async function clearScope(record) {
    const scope = await scopeOf(record);
    let epoch;
    try {
      epoch = await transaction(['epochs'], 'readwrite', (cx) => cx.get('epochs', `scope:${scope}`, (old) => {
        const s = old || blankScope(scope);
        const next = { ...s, epoch: s.epoch + 1, retired: true, cleanupPending: true };
        cx.put('epochs', next); cx.set(next.epoch);
      }));
    } catch (e) { e.phase = 'invalidate'; e.invalidated = false; throw e; }
    try {
      return await transaction(STORES, 'readwrite', (cx) => cx.get('epochs', `scope:${scope}`, (s) => {
        if (!s || s.epoch !== epoch || !s.cleanupPending) { cx.set(false); return; }
        cx.delete('keys', scope);
        deleteCursor(cx, 'entries', 'scope', scope, () => deleteCursor(cx, 'parts', 'scope', scope, () => {
          cx.put('epochs', { ...s, cleanupPending: false }); cx.set(true);
        }));
      }));
    } catch (e) { e.phase = 'erase'; e.invalidated = true; throw e; }
  }

  async function ensureKeys(session, record) {
    const scope = await scopeOf(record);
    const found = await transaction(['epochs', 'keys'], 'readonly', (cx) => liveState(cx, session, scope, (_g, s) => {
      cx.get('keys', scope, (k) => cx.set(k ? { ...k, scopeEpoch: s.epoch } : { scope, scopeEpoch: s.epoch }));
    }));
    if (found.key) return found;
    const key = await crypt().subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const indexKey = await crypt().subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return transaction(['epochs', 'keys'], 'readwrite', (cx) => liveState(cx, session, scope, (_g, s) => {
      if (s.epoch !== found.scopeEpoch) throw error('outbox-identity-retired');
      cx.get('keys', scope, (winner) => {
        const selected = winner || { scope, scopeEpoch: s.epoch, key, indexKey, keyId: uuid() };
        if (!winner) { cx.put('keys', selected); cx.put('epochs', s); }
        cx.set(selected);
      });
    }));
  }
  const aad = (row, kind, file, part) => outboxAdditionalData(row.scope, row.requestId, row.admissionId, kind, file, part);
  async function encode(row, value, key) { return sealOutboxBytes(crypt(), key, aad(row, 'entry'), enc.encode(JSON.stringify(value))); }
  async function decode(row, keys) {
    const value = JSON.parse(dec.decode(await openOutboxBytes(crypt(), keys.key, aad(row, 'entry'), row.sealed)));
    return { ...value, scope: row.scope, epoch: row.epoch, scopeEpoch: row.scopeEpoch, revision: row.revision, sequence: row.sequence, admissionId: row.admissionId, conversation: row.conversation };
  }
  function metricsKey(session, scope) { return `metrics:${session.epoch}:${scope}`; }
  function changeMetrics(cx, session, scope, changes) {
    const id = metricsKey(session, scope);
    cx.get('epochs', id, (old) => {
      const m = old || { id, admitted: 0, accepted: 0, held: 0, failure: 0, acceptanceDurationMs: 0 };
      for (const [key, value] of Object.entries(changes)) m[key] = (m[key] || 0) + value;
      cx.put('epochs', m);
    });
  }
  async function get(session, record, requestId) {
    const keys = await ensureKeys(session, record);
    const row = await transaction(['epochs', 'entries'], 'readonly', (cx) => liveState(cx, session, keys.scope, (_g, s) => {
      cx.get('entries', entryKey(keys.scope, requestId), (r) => cx.set(r && r.epoch === session.epoch && r.scopeEpoch === s.epoch ? r : null));
    }));
    if (!row) return null;
    const decoded = await decode(row, keys);
    return await assertLive(session, record, decoded) ? decoded : null;
  }
  async function list(session, record) {
    const keys = await ensureKeys(session, record);
    const rows = await transaction(['epochs', 'entries'], 'readonly', (cx) => liveState(cx, session, keys.scope, (_g, s) => {
      const out = []; const r = cx.store('entries').index('scope').openCursor(keys.scope);
      r.onsuccess = cx.safe(() => {
        const c = r.result; if (!c) { cx.set(out); return; }
        if (c.value.epoch === session.epoch && c.value.scopeEpoch === s.epoch) out.push(c.value);
        c.continue();
      });
    }));
    const out = [];
    for (const row of rows) out.push(await decode(row, keys));
    await transaction(['epochs'], 'readonly', (cx) => liveState(cx, session, keys.scope, () => cx.set(true)));
    return out.sort((a, b) => a.sequence - b.sequence);
  }

  function sameAdmission(existing, captured, proposedFiles, explicitFileIds) {
    for (const field of ['ref', 'text', 'mediaRef', 'slackHolder', 'path', 'stopEvidence', 'finalPath', 'finalBody']) {
      const proposed = field === 'text' ? captured.text || '' : captured[field];
      // A result may have frozen its final body after admission; an absent initial field is not a mutation.
      if (field in captured && JSON.stringify(existing[field]) !== JSON.stringify(proposed)) throw error('outbox-request-id-reused');
    }
    if ((existing.files || []).length !== proposedFiles.length) throw error('outbox-request-id-reused');
    proposedFiles.forEach((file, index) => {
      for (const field of ['sha256', 'filename', 'size', 'declaredType', 'declaredKind']) {
        if (JSON.stringify(existing.files[index][field]) !== JSON.stringify(file[field])) throw error('outbox-request-id-reused');
      }
      if (explicitFileIds?.[index] && existing.files[index].startRequestId !== explicitFileIds[index]) throw error('outbox-request-id-reused');
    });
  }
  async function selectedIdentities(selected) {
    const identities = [];
    for (const source of selected) {
      const bytes = await source.arrayBuffer();
      const type = source.type || 'application/octet-stream';
      identities.push({ sha256: hex(await crypt().subtle.digest('SHA-256', bytes)), filename: (source.name || 'file').slice(0, 255), size: source.size, declaredType: type,
        declaredKind: type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'voice' : 'file' });
    }
    return identities;
  }

  async function admitEntry(session, record, input, files = [], limits = {}) {
    const actor = readActor(record);
    const captured = copy(input);
    if (typeof captured.requestId !== 'string' || !captured.requestId || typeof captured.ref !== 'string') throw error('outbox-entry-invalid');
    if (captured.actor && JSON.stringify(captured.actor) !== JSON.stringify(actor)) {
      if (!identityFields.every((k) => captured.actor[k] === actor[k])) throw error('outbox-identity-mismatch');
    }
    const fileIds = files.map((_f, i) => captured.fileRequestIds?.[i] || freshRequestId(Number(captured.requestId.slice(0, 13)) || Date.now()));
    const selected = files.map((f) => f.file || f);
    const chunkSize = limits.chunkBytes ?? 1024 * 1024;
    const total = selected.reduce((n, f) => n + Number(f.size), 0);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || selected.length > (limits.maxFiles ?? 10) || total > (limits.maxMessageBytes ?? 64 * 1024 * 1024)) throw error('outbox-files-invalid');
    const keys = await ensureKeys(session, record);
    const receiptId = limits.importId ? `receipt:${keys.scope}:${hex(await crypt().subtle.digest('SHA-256', enc.encode(String(limits.importId))))}` : null;
    const prior = await transaction(['epochs', 'entries'], 'readonly', (cx) => liveState(cx, session, keys.scope, () => {
      cx.get('entries', entryKey(keys.scope, captured.requestId), (row) => {
        if (row) { cx.set({ row }); return; }
        if (receiptId) cx.get('epochs', receiptId, (receipt) => cx.set(receipt ? { receipt } : null)); else cx.set(null);
      });
    }));
    if (prior?.row) {
      const existing = await decode(prior.row, keys);
      sameAdmission(existing, captured, selected.length ? await selectedIdentities(selected) : (captured.files || []), captured.fileRequestIds);
      if (!await assertLive(session, record, existing)) throw error('outbox-entry-changed');
      return existing;
    }
    if (prior?.receipt) return { alreadyImported: true, requestId: captured.requestId, scope: keys.scope };
    const row = { scope: keys.scope, requestId: captured.requestId, admissionId: uuid(), epoch: session.epoch, scopeEpoch: keys.scopeEpoch, revision: 1, sequence: 0 };
    row.conversation = hex(await crypt().subtle.sign('HMAC', keys.indexKey, enc.encode(captured.ref)));
    const parts = []; const descriptors = [];
    for (let file = 0; file < selected.length; file++) {
      const source = selected[file];
      if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > (limits.maxFileBytes ?? 50 * 1024 * 1024)) throw error('outbox-files-invalid');
      let bytes = new Uint8Array(await source.arrayBuffer());
      if (bytes.length !== source.size) throw error('outbox-file-size-changed');
      const sha256 = hex(await crypt().subtle.digest('SHA-256', bytes));
      const type = source.type || 'application/octet-stream';
      const count = Math.ceil(bytes.length / chunkSize);
      for (let part = 0; part < count; part++) {
        const sealed = await sealOutboxBytes(crypt(), keys.key, aad(row, 'part', file, part), bytes.subarray(part * chunkSize, Math.min(bytes.length, (part + 1) * chunkSize)));
        parts.push({ scope: row.scope, requestId: row.requestId, admissionId: row.admissionId, file, part, sealed });
      }
      bytes = null;
      descriptors.push({ startRequestId: fileIds[file], sha256, filename: (source.name || 'file').slice(0, 255), size: source.size, declaredType: type,
        declaredKind: type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'voice' : 'file', chunkSize, partCount: count, received: [], uploadId: null, complete: false });
    }
    const value = { ...captured, actor, text: captured.text || '', firstSentAt: captured.firstSentAt || Date.now(), files: selected.length ? descriptors : (captured.files || []), phase: captured.phase || 'prepared', attempts: {}, lastClaimToken: null };
    row.sealed = await encode(row, value, keys.key);
    const saved = await transaction(STORES, 'readwrite', (cx) => liveState(cx, session, row.scope, (_g, s) => {
      if (s.epoch !== row.scopeEpoch) throw error('outbox-identity-retired');
      cx.get('keys', row.scope, (k) => {
        if (!k || k.keyId !== keys.keyId) throw error('outbox-key-changed');
        cx.get('entries', entryKey(row.scope, row.requestId), (existing) => {
          if (existing) { cx.set(existing); return; }
          const afterReceipt = (receipt) => {
            if (receipt) { cx.set(null); return; }
            const sequenceId = `sequence:${session.epoch}:${row.scope}:${row.conversation}`;
            cx.get('epochs', sequenceId, (counter) => {
              row.sequence = (counter?.value || 0) + 1;
              cx.put('epochs', { id: sequenceId, value: row.sequence });
              cx.put('entries', row);
              for (const part of parts) cx.put('parts', part);
              if (receiptId) cx.put('epochs', { id: receiptId, requestId: row.requestId });
              changeMetrics(cx, session, row.scope, { admitted: 1, held: value.phase === 'held' ? 1 : 0 });
              cx.set(row);
            });
          };
          if (receiptId) cx.get('epochs', receiptId, afterReceipt); else afterReceipt(null);
        });
      });
    }));
    if (!saved) return { alreadyImported: true, requestId: row.requestId, scope: row.scope };
    const decoded = await decode(saved, keys);
    sameAdmission(decoded, captured, value.files, captured.fileRequestIds);
    if (!await assertLive(session, record, decoded)) throw error('outbox-entry-changed');
    return decoded;
  }

  async function recordFailure(session, record) {
    const scope = await scopeOf(record);
    try {
      await transaction(['epochs'], 'readwrite', (cx) => liveState(cx, session, scope, () => changeMetrics(cx, session, scope, { failure: 1 })));
    } catch (e) { unknownMetrics.add(scope); throw e; }
  }
  async function admit(session, record, input, files = [], limits = {}) {
    try { return await admitEntry(session, record, input, files, limits); }
    catch (e) {
      try { await recordFailure(session, record); } catch { /* The save still fails; metrics explicitly remain unknown. */ }
      throw e;
    }
  }

  function validatePatch(entry, patch) {
    for (const key of ['requestId', 'ref', 'text', 'actor', 'mediaRef', 'slackHolder', 'path', 'fileRequestIds', 'stopEvidence', 'scope', 'epoch', 'scopeEpoch', 'sequence', 'admissionId', 'conversation']) {
      if (key in patch && JSON.stringify(patch[key]) !== JSON.stringify(entry[key])) throw error('outbox-immutable-field');
    }
    for (const key of ['finalPath', 'finalBody']) if (entry[key] != null && key in patch && patch[key] !== entry[key]) throw error('outbox-frozen-send');
    if (patch.files) {
      if (patch.files.length !== entry.files.length) throw error('outbox-immutable-file');
      entry.files.forEach((file, i) => {
        for (const key of ['startRequestId', 'sha256', 'filename', 'size', 'declaredType', 'declaredKind', 'chunkSize', 'partCount']) {
          if (JSON.stringify(file[key]) !== JSON.stringify(patch.files[i][key])) throw error('outbox-immutable-file');
        }
        if (file.uploadId && patch.files[i].uploadId !== file.uploadId) throw error('outbox-immutable-upload');
      });
    }
  }
  async function prepareUpdate(session, record, entry, patch) {
    validatePatch(entry, patch);
    const keys = await ensureKeys(session, record);
    if (keys.scope !== entry.scope) throw error('outbox-identity-mismatch');
    const value = { ...entry, ...copy(patch) };
    const row = { scope: entry.scope, requestId: entry.requestId, admissionId: entry.admissionId, epoch: entry.epoch, scopeEpoch: entry.scopeEpoch, revision: entry.revision + 1, sequence: entry.sequence, conversation: entry.conversation, claimToken: value.lastClaimToken || null };
    row.sealed = await encode(row, value, keys.key);
    return { row, keys, value };
  }
  async function update(session, record, entry, patch) {
    const prepared = await prepareUpdate(session, record, entry, patch);
    const saved = await transaction(['epochs', 'entries'], 'readwrite', (cx) => liveRow(cx, session, entry.scope, entry, (old) => {
      cx.put('entries', prepared.row);
      if (patch.phase === 'held' && entry.phase !== 'held') changeMetrics(cx, session, entry.scope, { held: 1 });
      cx.set(prepared.row);
    }));
    return saved ? decode(saved, prepared.keys) : null;
  }
  function predecessor(cx, entry, fn) {
    if (entry.sequence <= 1) { fn(null); return; }
    const query = ranges().bound([entry.scope, entry.conversation, 0], [entry.scope, entry.conversation, entry.sequence], false, true);
    const r = cx.store('entries').index('order').openCursor(query);
    r.onsuccess = cx.safe(() => {
      const c = r.result;
      if (!c) { fn(null); return; }
      if (c.value.epoch === entry.epoch && c.value.scopeEpoch === entry.scopeEpoch && !(entry.bypassPredecessorIds || []).includes(c.value.requestId)) { fn(c.value.requestId); return; }
      c.continue();
    });
  }
  async function allowFinal(session, record, entry) {
    const scope = await scopeOf(record);
    if (scope !== entry.scope) return false;
    return (await transaction(['epochs', 'entries'], 'readonly', (cx) => liveRow(cx, session, scope, entry, () => predecessor(cx, entry, (id) => cx.set(!id))))) === true;
  }
  async function claimAttempt(session, record, entry, stepKey, config = {}) {
    if (!await assertLive(session, record, entry)) return { kind: 'stale' };
    const now = config.now ?? Date.now();
    const attempts = copy(entry.attempts || {});
    const previous = attempts[stepKey] || { count: 0, nextEligibleAt: 0 };
    if (previous.count >= 7) return { kind: 'exhausted' };
    if (previous.nextEligibleAt > now) return { kind: 'wait', nextEligibleAt: previous.nextEligibleAt };
    const token = uuid();
    attempts[stepKey] = { count: previous.count + 1, nextEligibleAt: now + (config.deadlineMs ?? 20_000), token };
    const prepared = await prepareUpdate(session, record, entry, { attempts, lastClaimToken: token });
    const saved = await transaction(['epochs', 'entries'], 'readwrite', (cx) => liveRow(cx, session, entry.scope, entry, () => {
      const commit = (id) => {
        if (id) { cx.set({ kind: 'blocked', predecessorId: id }); return; }
        cx.put('entries', prepared.row); cx.set({ kind: 'claimed', row: prepared.row });
      };
      if (config.final) predecessor(cx, entry, commit); else commit(null);
    }));
    if (!saved) return { kind: 'stale' };
    return saved.kind === 'claimed' ? { kind: 'claimed', entry: await decode(saved.row, prepared.keys), token } : saved;
  }
  async function finishAttempt(session, record, entry, token, result = {}) {
    if (!token || entry.lastClaimToken !== token) return null;
    const attempts = copy(entry.attempts || {});
    const matched = Object.keys(attempts).find((step) => attempts[step].token === token);
    if (!matched) return null;
    attempts[matched] = { ...attempts[matched], nextEligibleAt: result.nextEligibleAt ?? 0 };
    return update(session, record, entry, { ...(result.patch || {}), attempts, lastClaimToken: null });
  }
  async function resetAttempts(session, record, entry, { now = Date.now() } = {}) {
    const attempts = {};
    for (const [key, prior] of Object.entries(entry.attempts || {})) {
      // An explicit retry renews the failure budget, never the server's not-before time.
      if (prior.nextEligibleAt > now) attempts[key] = { count: 0, nextEligibleAt: prior.nextEligibleAt, token: null };
    }
    return update(session, record, entry, { attempts, lastClaimToken: null });
  }
  async function assertLive(session, record, entry, token) {
    const scope = await scopeOf(record);
    if (scope !== entry.scope) return false;
    return (await transaction(['epochs', 'entries'], 'readonly', (cx) => liveRow(cx, session, scope, entry, (row) => cx.set(!token || row.claimToken === token)))) === true;
  }
  const verifyClaim = assertLive;
  async function part(session, record, entry, file, index) {
    const keys = await ensureKeys(session, record);
    if (keys.scope !== entry.scope) throw error('outbox-identity-mismatch');
    const found = await transaction(['epochs', 'entries', 'parts'], 'readonly', (cx) => liveRow(cx, session, entry.scope, entry, () => {
      cx.get('parts', [entry.scope, entry.requestId, entry.admissionId, file, index], (p) => cx.set(p || null));
    }));
    if (!found) throw error('outbox-part-unavailable');
    const bytes = await openOutboxBytes(crypt(), keys.key, aad(entry, 'part', file, index), found.sealed);
    if (!await assertLive(session, record, entry)) throw error('outbox-entry-changed');
    return bytes;
  }
  async function remove(session, record, entry, acceptance = {}) {
    const scope = await scopeOf(record);
    if (scope !== entry.scope) return false;
    return transaction(['epochs', 'entries', 'parts'], 'readwrite', (cx) => liveRow(cx, session, scope, entry, () => {
      cx.delete('entries', entryKey(scope, entry.requestId));
      deleteCursor(cx, 'parts', 'entry', entryKey(scope, entry.requestId));
      if (acceptance.messageId && Number.isFinite(acceptance.acceptedAt)) changeMetrics(cx, session, scope, { accepted: 1, acceptanceDurationMs: Math.max(0, acceptance.acceptedAt - entry.firstSentAt) });
      cx.set(true);
    }));
  }
  async function metrics(session, record) {
    const scope = await scopeOf(record);
    return transaction(['epochs'], 'readonly', (cx) => liveState(cx, session, scope, () => cx.get('epochs', metricsKey(session, scope), (m) => cx.set({ ...(m || { admitted: 0, accepted: 0, held: 0, failure: 0, acceptanceDurationMs: 0 }), unknown: unknownMetrics.has(scope) }))));
  }
  return { bindSession, isLive, legacyAllowed, identityScope: scopeOf, admit, list, get, update, part, remove, allowFinal, claimAttempt, finishAttempt, resetAttempts, assertLive, verifyClaim, clearAll, clearScope, metrics, recordFailure };
}

let singleton;
export function getChatOutbox() { return singleton ||= createChatOutbox(); }
