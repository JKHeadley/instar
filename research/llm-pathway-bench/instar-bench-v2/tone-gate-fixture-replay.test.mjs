import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFixtureCapture, replayFixture } from './tone-gate-fixture-replay.mjs';

test('scores a serialized fixture through the command entry point', () => {
  const entry = fileURLToPath(new URL('./tone-gate-fixture-replay.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.pass, true);
  assert.equal(receipt.requestBytes, 36583);
  const refused = spawnSync(process.execPath, [entry, '--route', 'live'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
});

test('refuses changed bytes even when the capture digest is recalculated', () => {
  const capture = createFixtureCapture();
  const request = Buffer.from(capture.requestBase64, 'base64');
  request[0] ^= 1;
  capture.requestBase64 = request.toString('base64');
  assert.throws(() => replayFixture(capture), /frozen digest/);
  capture.requestSha256 = createHash('sha256').update(request).digest('hex');
  assert.throws(() => replayFixture(capture), /frozen fixture attempt/);
});

test('refuses captures with missing digest or mismatched attempt', () => {
  const capture = createFixtureCapture();
  assert.throws(() => replayFixture({ ...capture, requestSha256: undefined }), /frozen fixture attempt/);
  assert.throws(() => replayFixture({ ...capture, attemptId: 'another-attempt' }), /frozen fixture attempt/);
});
