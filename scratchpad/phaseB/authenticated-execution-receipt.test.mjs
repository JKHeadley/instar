import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  AUTHENTICATED_OBSERVER_EVENT_SCHEMA,
  createAuthenticatedReceiptAuthority,
  isLiveAuthenticatedObserverEvent,
  isLiveAuthenticatedReceipt,
} from './authenticated-execution-receipt.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function signObserverEvent(keyPair, fields) {
  const event = {
    eventSchema: AUTHENTICATED_OBSERVER_EVENT_SCHEMA,
    source: 'fix-verifier-observer',
    ...fields,
  };
  return {
    ...event,
    signature: crypto.sign(null, Buffer.from(canonical(event)), keyPair.privateKey).toString('base64'),
  };
}

async function pinObserverFixture(authority) {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const identity = {
    observerSession: crypto.randomUUID(),
    guardId: 'H3-fixture-guard',
    nodeEntry: 'guard.mjs',
    observerPid: process.pid,
    argv: ['guard.mjs'],
  };
  const readyFields = {
    ...identity,
    sequence: 1,
    kind: 'observer-ready',
    publicKey,
  };
  const ready = signObserverEvent(keyPair, readyFields);
  assert.equal(await authority.pinObserverEvent(ready, {
    kind: 'observer-ready',
    guardId: identity.guardId,
    nodeEntry: identity.nodeEntry,
    observerPid: identity.observerPid,
  }), true);
  assert.equal(isLiveAuthenticatedObserverEvent(ready), true);
  return { keyPair, identity, readyFields };
}

function rejectedEventResult(authenticated) {
  return {
    authenticatedEvents: authenticated ? 1 : 0,
    verdict: authenticated ? 'PROVEN' : 'UNKNOWN',
  };
}

function runChild(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = child.pid;
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ pid, code, signal }));
  });
}

test('C1 private-channel authority issues and authenticates a real child receipt', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H1-C1' });
  try {
    const argv = [process.execPath, '-e', 'process.exit(0)'];
    const startedAt = new Date().toISOString();
    const child = await runChild(argv);
    const receipt = await authority.issue({
      guardId: 'real-child', kind: 'child-exit', observerPid: process.pid,
      childPid: child.pid, childExitCode: child.code, signal: child.signal,
      argv, startedAt, childExitedAt: new Date().toISOString(), emittedAfterChildExit: true,
    });
    assert.equal(await authority.authenticate(receipt, {
      guardId: 'real-child', childPid: child.pid, childExitCode: 0,
    }), true);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.argv), true);
    assert.equal(isLiveAuthenticatedReceipt(receipt), true);
    console.log(`H1_C1 realChildPid=${child.pid} childExit=0 authenticated=true channel=MessagePort`);
  } finally {
    await authority.close();
  }
});

test('C3 same-user stand-in cannot forge or replay a receipt from disk-visible values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-c3-standin-'));
  const forgedPath = path.join(root, 'forged-receipt.json');
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H1-C3' });
  try {
    const honest = await authority.issue({
      guardId: 'declared-real-child', kind: 'child-exit', observerPid: process.pid,
      childPid: process.pid, childExitCode: 0, signal: null,
      argv: [process.execPath, 'declared-real-child.mjs'],
      startedAt: new Date().toISOString(), childExitedAt: new Date().toISOString(), emittedAfterChildExit: true,
    });
    assert.equal(await authority.authenticate(honest, { guardId: 'declared-real-child' }), true);

    const diskVisibleForgery = {
      ...honest,
      nonce: 'candidate-chosen-nonce',
      childPid: process.pid + 10_000,
      argv: [process.execPath, 'stand-in-that-does-not-run-the-child.mjs'],
    };
    const standIn = await runChild([
      process.execPath,
      '-e',
      "require('fs').writeFileSync(process.argv[1], process.argv[2])",
      forgedPath,
      JSON.stringify(diskVisibleForgery),
    ]);
    assert.equal(standIn.code, 0);
    const forged = JSON.parse(fs.readFileSync(forgedPath, 'utf8'));
    assert.equal(await authority.authenticate(forged, { guardId: 'declared-real-child' }), false);
    assert.equal(isLiveAuthenticatedReceipt(forged), false);

    const replay = JSON.parse(JSON.stringify(honest));
    assert.equal(await authority.authenticate(replay, { guardId: 'declared-real-child' }), false);
    assert.equal(isLiveAuthenticatedReceipt(replay), false);
    console.log(`H1_C3 standInExit=${standIn.code} realChildRan=false forgedAuthenticated=false replayAuthenticated=false verdict=NOT-PROVEN`);
  } finally {
    await authority.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unavailable private authority never authenticates evidence', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H1-unavailable' });
  await authority.close();
  assert.equal(await authority.authenticate({}, {}), false);
  await assert.rejects(() => authority.issue({}), /unavailable/);
});

test('H3 duplicate observer-ready fixture fails closed after the session is pinned', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H3-duplicate-ready' });
  try {
    const { keyPair, readyFields } = await pinObserverFixture(authority);
    const duplicate = signObserverEvent(keyPair, readyFields);
    const result = rejectedEventResult(await authority.pinObserverEvent(duplicate, {
      kind: 'observer-ready',
      guardId: readyFields.guardId,
      nodeEntry: readyFields.nodeEntry,
      observerPid: readyFields.observerPid,
    }));
    assert.equal(isLiveAuthenticatedObserverEvent(duplicate), false);
    assert.deepEqual(result, { authenticatedEvents: 0, verdict: 'UNKNOWN' });
    console.log('H3_DUPLICATE_READY setupPinned=true candidateEvents=1 authenticatedEvents=0 verdict=UNKNOWN');
  } finally {
    await authority.close();
  }
});

test('H3 unsigned post-pinning observer event fixture fails closed', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H3-unsigned' });
  try {
    const { identity } = await pinObserverFixture(authority);
    const unsigned = {
      eventSchema: AUTHENTICATED_OBSERVER_EVENT_SCHEMA,
      source: 'fix-verifier-observer',
      ...identity,
      sequence: 2,
      kind: 'child-start',
      childPid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const result = rejectedEventResult(await authority.authenticateObserverEvent(unsigned, identity));
    assert.equal(isLiveAuthenticatedObserverEvent(unsigned), false);
    assert.deepEqual(result, { authenticatedEvents: 0, verdict: 'UNKNOWN' });
    console.log('H3_UNSIGNED_EVENT setupPinned=true candidateEvents=1 authenticatedEvents=0 verdict=UNKNOWN');
  } finally {
    await authority.close();
  }
});

test('H3 replayed post-pinning observer event fixture fails closed', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H3-replay' });
  try {
    const { keyPair, identity } = await pinObserverFixture(authority);
    const first = signObserverEvent(keyPair, {
      ...identity,
      sequence: 2,
      kind: 'child-start',
      childPid: process.pid,
      startedAt: new Date().toISOString(),
    });
    assert.equal(await authority.authenticateObserverEvent(first, identity), true);
    const replay = JSON.parse(JSON.stringify(first));
    const result = rejectedEventResult(await authority.authenticateObserverEvent(replay, identity));
    assert.equal(isLiveAuthenticatedObserverEvent(replay), false);
    assert.deepEqual(result, { authenticatedEvents: 0, verdict: 'UNKNOWN' });
    console.log('H3_REPLAYED_EVENT setupPinned=true setupSequence2=true candidateEvents=1 authenticatedEvents=0 verdict=UNKNOWN');
  } finally {
    await authority.close();
  }
});

test('H3 out-of-order post-pinning observer event fixture fails closed', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H3-out-of-order' });
  try {
    const { keyPair, identity } = await pinObserverFixture(authority);
    const outOfOrder = signObserverEvent(keyPair, {
      ...identity,
      sequence: 3,
      kind: 'child-exit',
      childPid: process.pid,
      childExitCode: 0,
      emittedAfterChildExit: true,
    });
    const result = rejectedEventResult(await authority.authenticateObserverEvent(outOfOrder, identity));
    assert.equal(isLiveAuthenticatedObserverEvent(outOfOrder), false);
    assert.deepEqual(result, { authenticatedEvents: 0, verdict: 'UNKNOWN' });
    console.log('H3_OUT_OF_ORDER_EVENT setupPinned=true attemptedSequence=3 expectedSequence=2 authenticatedEvents=0 verdict=UNKNOWN');
  } finally {
    await authority.close();
  }
});

test('H3 identity-mismatched post-pinning observer event fixture fails closed', async () => {
  const authority = await createAuthenticatedReceiptAuthority({ issuer: 'H3-identity-mismatch' });
  try {
    const { keyPair, identity } = await pinObserverFixture(authority);
    const mismatch = signObserverEvent(keyPair, {
      ...identity,
      guardId: 'candidate-replaced-guard',
      sequence: 2,
      kind: 'child-start',
      childPid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const result = rejectedEventResult(await authority.authenticateObserverEvent(mismatch, identity));
    assert.equal(isLiveAuthenticatedObserverEvent(mismatch), false);
    assert.deepEqual(result, { authenticatedEvents: 0, verdict: 'UNKNOWN' });
    console.log('H3_IDENTITY_MISMATCH setupPinned=true mismatchedField=guardId authenticatedEvents=0 verdict=UNKNOWN');
  } finally {
    await authority.close();
  }
});
