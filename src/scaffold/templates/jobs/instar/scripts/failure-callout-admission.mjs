#!/usr/bin/env node
/** Durable pre-model reservations; queued work reuses its authenticated receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const agentHome = process.env.INSTAR_AGENT_HOME || process.cwd();
const stateDir = process.env.INSTAR_STATE_DIR || path.join(agentHome, '.instar');
const file = process.env.INSTAR_GATE_RECEIPT_FILE || path.join(stateDir, 'state', 'failure-callout-admission.json');
const token = process.env.INSTAR_AUTH_TOKEN;
const agentId = process.env.INSTAR_AGENT_ID;
const base = `http://127.0.0.1:${process.env.INSTAR_PORT || '4042'}`;
const headers = { Authorization: `Bearer ${token}`, 'X-Instar-AgentId': agentId, 'X-Instar-Request': '1', 'Content-Type': 'application/json' };
function save(receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(receipt) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function endpoint(row, action) {
  const origin = row.machineId ? `?machineId=${encodeURIComponent(row.machineId)}` : '';
  return `${base}/corrections/${encodeURIComponent(row.id)}/failure-investigation/${action}${origin}`;
}
let admitted = [];
try {
  if (!token || !agentId) throw new Error('missing local authentication');
  let pending;
  try { if (fs.statSync(file).size <= 16384) pending = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no earlier reservation */ }
  // A queued reservation may wait for capacity, but an unavailable holder
  // must not hold the entire queue forever. Expiry never refunds an attempt.
  const pendingAt = Date.parse(pending?.at || '');
  const pendingFresh = Number.isFinite(pendingAt) && Date.now() - pendingAt < 30 * 60_000;
  if (pendingFresh && pending && typeof pending.batchId === 'string' && !pending.consumed && Array.isArray(pending.admitted) && pending.admitted.length > 0 && pending.admitted.length <= 3) {
    let unknown = false;
    await Promise.all(pending.admitted.map(async row => {
      try {
        const check = await fetch(endpoint(row, 'check'), { method: 'POST', headers, body: JSON.stringify({ token: row.token }), signal: AbortSignal.timeout(2000) });
        if (!check.ok) { unknown = true; return; }
        if ((await check.json()).valid === true) admitted.push(row);
      } catch { unknown = true; }
    }));
    // Unknown holder/opt-out retains the pending reservation without a model or
    // a new attempt. Invalidated reservations are discarded on the next gate.
    if (unknown) process.exit(1); // keep the whole original batch until its bounded expiry
    save({ ...pending, admitted });
    process.exit(admitted.length ? 0 : 1);
  }
  const batchId = randomUUID();
  save({ batchId, at: new Date().toISOString(), consumed: false, admitted });
  const response = await fetch(`${base}/corrections?scope=pool&severity=failure-callout&unresolved=true&investigable=true&limit=1000`, { headers, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`queue HTTP ${response.status}`);
  const queue = await response.json();
  if (!Array.isArray(queue.records)) throw new Error('invalid queue');
  const eligible = queue.records.filter(row => row && typeof row.id === 'string' && row.id.length <= 256).filter(row => {
    if (row.severity !== 'failure-callout' || row.failureState === 'verified' || row.replication?.readOnly || row.stale || row.readOnly) return false;
    if (row.investigationAdmission?.paused) return false;
    if (row.investigationAdmission?.nextAttemptAt && Date.parse(row.investigationAdmission.nextAttemptAt) > Date.now()) return false;
    return true;
  }).slice(0, 3);
  await Promise.allSettled(eligible.map(async row => {
    // No retry: a timeout may have committed its reservation at the origin.
    const claim = await fetch(endpoint(row, 'claim'), { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(2000) });
    if (!claim.ok) return;
    const receipt = await claim.json();
    if (receipt.admitted) {
      const a = receipt.admission;
      admitted.push({ id: row.id, machineId: row.machineId ?? null, token: receipt.token,
        admission: { occurrenceCount: a.occurrenceCount, attempts: a.attempts, maxAttempts: a.maxAttempts, nextAttemptAt: a.nextAttemptAt, paused: a.paused } });
    }
  }));
  save({ batchId, at: new Date().toISOString(), consumed: false, admitted });
} catch (error) {
  console.error(`[failure-callout-admission] ${error instanceof Error ? error.message : 'admission unavailable'}`);
}
process.exitCode = admitted.length ? 0 : 1;
