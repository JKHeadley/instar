/** Private producer facts for two synthetic GET probes; no HTTP evidence endpoint or consent authority. */
import { randomBytes, createHash } from 'node:crypto';
export const RESPONSE_EVIDENCE_HEADER = 'x-instar-design-response-id';
export const DECLARED_HEADER_PROBES = Object.freeze(['/mobile/browser-devices/status', '/work-board']);
const providers = new WeakMap();
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function canonicalOrigin(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Expected the exact synthetic loopback origin');
  return origin;
}
export function isDeclaredHeaderProbe(method, value, origin) {
  try { const url = new URL(value); return method === 'GET' && url.origin === origin && !url.username && !url.password && !url.search && !url.hash && DECLARED_HEADER_PROBES.includes(url.pathname) && value === origin + url.pathname; } catch { return false; }
}
export function providerBinding(provider, origin) {
  const state = typeof provider === 'function' ? providers.get(provider) : null;
  if (!state || state.origin !== canonicalOrigin(origin)) throw new Error('The response provider is not this fixture instance');
  const seedState = state.seedState();
  if (!['busy', 'empty', 'error'].includes(seedState)) throw new Error('Invalid trusted fixture seed state');
  return Object.freeze({ origin: state.origin, runId: state.runId, seedState, ...(state.loading ? { loading: state.loading.binding } : {}) });
}
export function createFixtureResponseEvidence({ seedState = () => 'busy', loading } = {}) {
  const state = { seedState, loading, origin: null, runId: randomBytes(16).toString('hex'), records: new Map() };
  let sequence = 0;
  const provider = id => {
    const row = state.records.get(id);
    return row ? { ...row, bytes: row.bytes ? Buffer.from(row.bytes) : null } : null;
  };
  providers.set(provider, state);
  const bindOrigin = origin => { canonicalOrigin(origin); if (state.origin && state.origin !== origin) throw new Error('A fixture evidence provider cannot change origins'); state.origin = origin; };
  const middleware = (req, res, next) => {
    const requestTarget = req.originalUrl ?? req.url;
    if (!state.origin || !isDeclaredHeaderProbe(req.method, state.origin + requestTarget, state.origin)) { next(); return; }
    const id = `${state.runId}-${++sequence}`;
    const row = { id, runId: state.runId, origin: state.origin, method: req.method, url: state.origin + requestTarget, finished: false, aborted: false, bytes: null };
    state.records.set(id, row); res.setHeader(RESPONSE_EVIDENCE_HEADER, id);
    const chunks = [], write = res.write, end = res.end;
    let withinEnd = false;
    const capture = (chunk, encoding) => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      try { chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk)); }
      catch { row.captureError = true; } // Delegate unchanged so the native operation retains its own behavior.
    };
    res.write = function(chunk, ...args) { if (!withinEnd) capture(chunk, args[0]); return Reflect.apply(write, this, [chunk, ...args]); };
    res.end = function(chunk, ...args) { capture(chunk, args[0]); withinEnd = true; try { return Reflect.apply(end, this, [chunk, ...args]); } finally { withinEnd = false; } };
    res.once('finish', () => {
      row.bytes = Buffer.concat(chunks); row.sha256 = digest(row.bytes); row.byteLength = row.bytes.length;
      row.status = res.statusCode; row.contentType = String(res.getHeader('Content-Type') ?? '');
      const length = res.getHeader('Content-Length'); row.contentLength = length === undefined ? null : String(length);
      row.finished = true;
    });
    res.once('close', () => { if (!row.finished) row.aborted = true; });
    next();
  };
  return { provider, bindOrigin, middleware };
}
export function joinFixtureProbeEvidence(provider, origin, observation) {
  const binding = providerBinding(provider, origin);
  if (!isDeclaredHeaderProbe(observation.method, observation.url, origin) || observation.status !== 200
    || observation.bodyEvidence?.kind !== 'awaiting-parent-evidence' || observation.bodyEvidence.browserConsumption !== 'not-observed') throw new Error('This response cannot use emitted-not-consumed evidence');
  const id = observation.bodyEvidence.responseId;
  const row = typeof id === 'string' ? provider(id) : null;
  if (!row || row.id !== id || row.runId !== binding.runId || row.origin !== origin || !row.finished || row.aborted || row.captureError
    || (observation.contentLength ?? null) !== row.contentLength || row.method !== observation.method || row.url !== observation.url || row.status !== observation.status || row.contentType !== observation.contentType || !Buffer.isBuffer(row.bytes)
    || row.byteLength !== row.bytes.length || row.sha256 !== digest(row.bytes)
    || row.contentLength !== null && (!/^\d+$/.test(row.contentLength) || Number(row.contentLength) !== row.bytes.length)) throw new Error('Actual response evidence is missing, incomplete or mismatched');
  return { bytes: Buffer.from(row.bytes), evidence: { kind: 'fixture-emitted', responseId: id, method: row.method, url: row.url, status: row.status,
    contentType: row.contentType, bytes: row.bytes.length, sha256: row.sha256, producerFinished: true, browserConsumption: 'not-observed' } };
}

export function providerLoadingAction(provider, origin, action, payload) {
 providerBinding(provider, origin); const hold=providers.get(provider)?.loading;
 if(!hold)throw new Error('This fixture has no loading scenario');
 if(action==='check')return hold.checkPending(payload);
 if(action==='release'){hold.release(payload);return {released:true};}
 if(action==='cancel'){hold.cancel();return {canceled:true};}
 if(action==='assess')return hold.assess({before:hold.snapshot(payload?.before?.token),after:hold.snapshot(payload?.after?.token)});
 throw new Error('Unknown loading action');
}
