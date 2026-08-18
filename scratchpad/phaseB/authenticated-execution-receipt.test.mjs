import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  createAuthenticatedReceiptAuthority,
  isLiveAuthenticatedReceipt,
} from './authenticated-execution-receipt.mjs';

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
