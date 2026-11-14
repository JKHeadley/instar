import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const body = fs.readFileSync(new URL('../../src/scaffold/templates/jobs/instar/failure-callout-investigator.md', import.meta.url), 'utf8');
const meta = yaml.load(body.split('---')[1]) as { gate: string; enabled: boolean };

async function admit(records: unknown[], claimStatus = 200, checkStatus = 200) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-gate-'));
  const scripts = path.join(root, '.instar', 'jobs', 'instar', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(new URL('../../src/scaffold/templates/jobs/instar/scripts/failure-callout-admission.mjs', import.meta.url), path.join(scripts, 'failure-callout-admission.mjs'));
  let claims = 0; let checks = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer gate-test-token' || req.headers['x-instar-agentid'] !== 'gate-test') { res.writeHead(401); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      expect(req.url).toContain('scope=pool'); expect(req.url).toContain('investigable=true');
      res.end(JSON.stringify({ records }));
    } else if (req.url?.includes('/check')) {
      checks++; res.writeHead(checkStatus); res.end(JSON.stringify({ valid: checkStatus === 200 }));
    } else {
      claims++;
      expect(req.headers['x-instar-request']).toBe('1');
      expect(req.url).toContain('/failure-investigation/claim');
      res.writeHead(claimStatus);
      res.end(JSON.stringify({ admitted: claimStatus === 200, token: 'receipt-only', admission: { attempts: 1, paused: false } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const run = () => new Promise<boolean>(resolve => execFile('/bin/sh', ['-c', meta.gate], { timeout: 10000, env: { PATH: process.env.PATH, INSTAR_AUTH_TOKEN: 'gate-test-token', INSTAR_AGENT_ID: 'gate-test', INSTAR_PORT: String(port), INSTAR_AGENT_HOME: root } }, error => resolve(!error)));
    const passed = await run();
    const secondPassed = passed ? await run() : undefined;
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.instar', 'state', 'failure-callout-admission.json'), 'utf8'));
    expect(JSON.stringify(receipt)).not.toContain('gate-test-token');
    return { passed, secondPassed, claims, checks, receipt };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-admission-gate-test' });
  }
}
const row = { id: 'failure-1', machineId: 'holder', severity: 'failure-callout', failureState: 'captured' };
describe('failure investigator zero-token admission gate', () => {
  it('does not admit empty queues or old servers ignoring the filter', async () => {
    expect((await admit([])).passed).toBe(false);
    expect((await admit([{ id: 'ordinary-old-server-record' }])).claims).toBe(0);
  });
  it('skips verified, paused, not-due and stale read-only cases before spending attempts', async () => {
    const result = await admit([{ ...row, failureState: 'verified' }, { ...row, investigationAdmission: { paused: true } }, { ...row, investigationAdmission: { nextAttemptAt: '2999-01-01T00:00:00Z' } }, { ...row, replication: { state: 'stale', readOnly: true } }]);
    expect(result).toMatchObject({ passed: false, claims: 0 });
  });
  it('reserves at most three attempts before allowing a model session', async () => {
    const result = await admit(Array.from({ length: 10 }, (_, i) => ({ ...row, id: `failure-${i}` })));
    expect(result).toMatchObject({ passed: true, claims: 3 });
    expect(result.receipt.admitted).toHaveLength(3);
  });
  it('reuses valid pending reservations across capacity retries without spending another attempt', async () => {
    expect(await admit([row])).toMatchObject({ passed: true, secondPassed: true, claims: 1, checks: 1 });
  });
  it('retains an unknown or opted-out pending receipt without starting a new session', async () => {
    const result = await admit([row], 200, 503);
    expect(result).toMatchObject({ passed: true, secondPassed: false, claims: 1, checks: 1 });
    expect(result.receipt.admitted).toHaveLength(1);
  });
  it('never retries uncertain or rejected reservations', async () => {
    expect(await admit([row], 502)).toMatchObject({ passed: false, claims: 1 });
  });
});
