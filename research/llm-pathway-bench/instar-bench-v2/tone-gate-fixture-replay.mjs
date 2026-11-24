import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scoreCase } from './score2.mjs';

const caseId = 'canon-clean-pass';
const attemptId = 'tone-gate-fixture-1';
// Frozen from the benchmark corpus at a25223a00.
const requestSha256 = '3517180d4ee3b64b5c2889f2d3d63b71f94e2cc4e8734747085dcff4ed07bebf';

function loadCase() {
  const task = JSON.parse(readFileSync(new URL('./tasks/tone-gate.json', import.meta.url), 'utf8'));
  return { task, fixture: task.cases.find(candidate => candidate.id === caseId) };
}

export function createFixtureCapture() {
  const { fixture } = loadCase();
  const template = readFileSync(new URL('./tasks/tone-gate.template.txt', import.meta.url), 'utf8');
  const request = template.replaceAll('{{INPUT}}', fixture.input);
  return { attemptId, requestSha256, requestBase64: Buffer.from(request).toString('base64') };
}

export function replayFixture(capture) {
  if (capture.attemptId !== attemptId || capture.requestSha256 !== requestSha256) {
    throw new Error('Capture does not match the frozen fixture attempt');
  }
  const request = Buffer.from(capture.requestBase64, 'base64');
  const actualDigest = createHash('sha256').update(request).digest('hex');
  if (actualDigest !== requestSha256 || request.toString('base64') !== capture.requestBase64) {
    throw new Error('Captured request bytes do not match the frozen digest');
  }

  // The only response source is a canned fixture. It has no access to labels.
  const response = '{"pass":true,"rule":null,"issue":null,"suggestion":null}';
  const { task, fixture } = loadCase();
  const score = scoreCase(task, fixture, response);
  return { caseId, attemptId, requestBytes: request.length, requestSha256, pass: score.pass };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This fixture entry takes no arguments');
  const capture = JSON.parse(JSON.stringify(createFixtureCapture()));
  const result = replayFixture(capture);
  console.log(JSON.stringify(result));
  process.exitCode = result.pass ? 0 : 1;
}
