import crypto from 'node:crypto';
import { MessageChannel, Worker, isMainThread, workerData } from 'node:worker_threads';

const SCHEMA = 'phaseB-authenticated-execution-receipt/v1';
const liveAuthenticatedReceipts = new WeakSet();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeObservation(authorityId, issuer, observation) {
  if (!observation || typeof observation !== 'object') throw new Error('execution observation must be an object');
  if (!Number.isSafeInteger(observation.childPid) || observation.childPid <= 0) throw new Error('execution observation childPid is invalid');
  if (!Number.isSafeInteger(observation.childExitCode) || observation.childExitCode < 0) throw new Error('execution observation childExitCode is invalid');
  if (!Array.isArray(observation.argv) || observation.argv.length === 0 || observation.argv.some((item) => typeof item !== 'string')) {
    throw new Error('execution observation argv is invalid');
  }
  const argvHash = crypto.createHash('sha256').update(canonical(observation.argv)).digest('hex');
  return {
    schema: SCHEMA,
    authorityId,
    issuer,
    nonce: crypto.randomUUID(),
    guardId: String(observation.guardId ?? ''),
    kind: String(observation.kind ?? 'child-exit'),
    observerPid: Number.isSafeInteger(observation.observerPid) ? observation.observerPid : null,
    childPid: observation.childPid,
    childExitCode: observation.childExitCode,
    signal: observation.signal == null ? null : String(observation.signal),
    argv: observation.argv,
    argvHash,
    startedAt: String(observation.startedAt ?? ''),
    childExitedAt: String(observation.childExitedAt ?? ''),
    emittedAfterChildExit: observation.emittedAfterChildExit === true,
  };
}

function startAuthorityWorker(port) {
  let key = null;
  let authorityId = null;
  let issuer = null;
  const issued = new Map();
  const consumed = new Set();
  const reply = (requestId, result, error = null) => port.postMessage({ requestId, result, error });
  port.on('message', (message) => {
    try {
      if (message?.type === 'initialize') {
        if (key) throw new Error('receipt authority was already initialized');
        key = Buffer.from(message.key);
        if (key.length !== 32) throw new Error('receipt authority key must be 32 bytes');
        authorityId = String(message.authorityId);
        issuer = String(message.issuer);
        reply(message.requestId, { ready: true, authorityId });
        return;
      }
      if (!key) throw new Error('receipt authority is unavailable');
      if (message?.type === 'issue') {
        const payload = normalizeObservation(authorityId, issuer, message.observation);
        const mac = crypto.createHmac('sha256', key).update(canonical(payload)).digest('hex');
        issued.set(payload.nonce, mac);
        reply(message.requestId, { ...payload, mac });
        return;
      }
      if (message?.type === 'verify') {
        const receipt = message.receipt;
        const expected = message.expected ?? {};
        const payload = receipt && typeof receipt === 'object'
          ? Object.fromEntries(Object.entries(receipt).filter(([field]) => field !== 'mac'))
          : null;
        const expectedMac = payload ? crypto.createHmac('sha256', key).update(canonical(payload)).digest('hex') : '';
        const actualMac = typeof receipt?.mac === 'string' && /^[a-f0-9]{64}$/.test(receipt.mac) ? receipt.mac : '';
        const macValid = actualMac.length === expectedMac.length
          && actualMac.length > 0
          && crypto.timingSafeEqual(Buffer.from(actualMac), Buffer.from(expectedMac));
        const issuedValid = issued.get(receipt?.nonce) === actualMac && !consumed.has(receipt?.nonce);
        const expectedValid = Object.entries(expected).every(([field, value]) => canonical(receipt?.[field]) === canonical(value));
        const valid = Boolean(payload)
          && receipt.schema === SCHEMA
          && receipt.authorityId === authorityId
          && receipt.issuer === issuer
          && receipt.emittedAfterChildExit === true
          && macValid
          && issuedValid
          && expectedValid;
        if (valid) consumed.add(receipt.nonce);
        reply(message.requestId, { valid });
        return;
      }
      if (message?.type === 'close') {
        key.fill(0);
        key = null;
        issued.clear();
        consumed.clear();
        reply(message.requestId, { closed: true });
        port.close();
        return;
      }
      throw new Error('unknown receipt authority request');
    } catch (error) {
      reply(message?.requestId, null, error instanceof Error ? error.message : String(error));
    }
  });
  port.start();
}

if (!isMainThread && workerData?.role === 'phaseB-execution-receipt-authority') {
  startAuthorityWorker(workerData.port);
}

export async function createAuthenticatedReceiptAuthority({ issuer }) {
  if (typeof issuer !== 'string' || issuer.length === 0) throw new Error('receipt authority issuer is required');
  const authorityId = crypto.randomUUID();
  const key = new Uint8Array(crypto.randomBytes(32));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { role: 'phaseB-execution-receipt-authority', port: port2 },
    transferList: [port2],
  });
  let requestSequence = 0;
  const pending = new Map();
  let workerFailure = null;
  port1.on('message', (message) => {
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message.result);
  });
  worker.on('error', (error) => {
    workerFailure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  const request = (type, fields = {}, transferList = []) => new Promise((resolve, reject) => {
    if (workerFailure) { reject(workerFailure); return; }
    const requestId = ++requestSequence;
    pending.set(requestId, { resolve, reject });
    port1.postMessage({ type, requestId, ...fields }, transferList);
  });
  const keyBuffer = key.buffer;
  await request('initialize', { authorityId, issuer, key }, [keyBuffer]);

  let closed = false;
  return {
    authorityId,
    issuer,
    async issue(observation) {
      if (closed) throw new Error('receipt authority is unavailable');
      return request('issue', { observation });
    },
    async authenticate(receipt, expected = {}) {
      if (closed) return false;
      const result = await request('verify', { receipt, expected });
      if (result.valid && receipt && typeof receipt === 'object') liveAuthenticatedReceipts.add(receipt);
      return result.valid;
    },
    async close() {
      if (closed) return;
      closed = true;
      try { await request('close'); } finally {
        port1.close();
        await worker.terminate();
      }
    },
  };
}

export function isLiveAuthenticatedReceipt(receipt) {
  return Boolean(receipt && typeof receipt === 'object' && liveAuthenticatedReceipts.has(receipt));
}

export const AUTHENTICATED_RECEIPT_SCHEMA = SCHEMA;
