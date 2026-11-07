/**
 * Every non-Telegram reply script answers a tone-gate advisory (attribution live test, 2026-11-06:
 * slack-reply.sh took `--tone-ack` for the channel id, so an advisory could not be answered).
 * Runs the REAL templates under bash with a fake `curl`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { slackSessionMetadata, slackSessionMetadataAllowed } from '../../src/server/slackSessionMetadata.js';

const run = promisify(execFile);
const script = (name: string) => path.resolve(__dirname, `../../src/templates/scripts/${name}`);
const REF = 'd-m_abc-12345678-1234-1234-1234-123456789012';
const ADVISORY = JSON.stringify({ error: 'tone-gate-advisory', rule: 'B23_UNSOURCED_ATTRIBUTION', issue: 'no source', suggestion: 'cite it', decisionRef: REF });

const CASES: Array<{ name: string; target: string[]; env?: Record<string, string> }> = [
  { name: 'slack-reply.sh', target: ['C0123ABCD'] },
  { name: 'slack-reply.sh', target: [], env: { INSTAR_CONVERSATION_ID: '-5', INSTAR_BIND_TOKEN: 'b' } },
  { name: 'whatsapp-reply.sh', target: ['1@s.whatsapp.net'] },
  { name: 'imessage-reply.sh', target: ['+15550001111'] },
  { name: 'app-reply.sh', target: [], env: { INSTAR_CONVERSATION_ID: '-5', INSTAR_BIND_TOKEN: 'b' } },
];

describe.each(CASES)('$name', ({ name, target, env }) => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-tone-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/reply-scripts-tone-reaction.test.ts' }); });

  function send(code: string, body: string, flags: string[]) {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
prev=""; for a in "$@"; do [ "$prev" = "-d" ] && printf '%s\\n' "$a" >> "${dir}/bodies"; prev="$a"; done
printf '%s\\n%s' '${body.replace(/'/g, "'\\''")}' '${code}'
`, { mode: 0o755 });
    return run('bash', [script(name), ...flags, ...target, 'hello'], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTAR_PORT: '4099', INSTAR_AUTH_TOKEN: 't', INSTAR_AGENT_ID: 'a', ...env },
    }).then((r) => ({ ...r, code: 0 }), (e) => e as { stderr: string; code: number });
  }
  const firstBody = () => JSON.parse(fs.readFileSync(path.join(dir, 'bodies'), 'utf8').split('\n')[0]);

  it('prints the advisory with how to answer it, and reports not sent', async () => {
    const r = await send('422', ADVISORY, []);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('ADVISORY');
    expect(r.stderr).toContain(`--tone-complied B23_UNSOURCED_ATTRIBUTION --tone-decision-ref ${REF}`);
    expect(r.stderr).toContain('--tone-ack B23_UNSOURCED_ATTRIBUTION --tone-reason');
  });

  it('carries an override with its reason and decision ref as metadata', async () => {
    await send('422', '{}', ['--tone-ack', 'B23_UNSOURCED_ATTRIBUTION', '--tone-reason', 'he said "so" here', '--tone-decision-ref', REF]);
    expect(firstBody()).toMatchObject({ text: expect.stringContaining('hello'), metadata: { toneAdvisoryAck: 'B23_UNSOURCED_ATTRIBUTION', toneAdvisoryAckReason: 'he said "so" here', toneAdvisoryDecisionRef: REF } });
  });

  it('carries a compliance, and drops a decision ref of the wrong shape', async () => {
    await send('422', '{}', ['--tone-complied', 'B23_UNSOURCED_ATTRIBUTION', '--tone-decision-ref', 'x"; echo hostile']);
    const { metadata } = firstBody();
    expect(metadata).toEqual({ toneAdvisoryComplied: 'B23_UNSOURCED_ATTRIBUTION' });
  });

  it('adds no metadata when no reaction is given', async () => {
    await send('422', '{}', []);
    expect(firstBody().metadata).toBeUndefined();
  });
});

describe('slackSessionMetadata: what a spawned session may set', () => {
  it('passes the four tone fields and the native references', () => {
    expect(slackSessionMetadata({ nativeReferences: ['C1'], metadata: { toneAdvisoryAck: 'R', toneAdvisoryAckReason: 'why', toneAdvisoryComplied: 'R', toneAdvisoryDecisionRef: 'd' } }))
      .toEqual({ nativeReferences: ['C1'], toneAdvisoryAck: 'R', toneAdvisoryAckReason: 'why', toneAdvisoryComplied: 'R', toneAdvisoryDecisionRef: 'd' });
  });

  it('drops everything else a session might send', () => {
    expect(slackSessionMetadata({ metadata: { allowDuplicate: true, allowDebugText: true, formatMode: 'legacy-passthrough', toneAdvisoryAck: 5 } })).toBeUndefined();
    expect(slackSessionMetadata({ metadata: ['x'] })).toBeUndefined();
    expect(slackSessionMetadata({})).toBeUndefined();
  });

  it('the route refuses metadata holding anything but the tone reaction', () => {
    expect(slackSessionMetadataAllowed(undefined)).toBe(true);
    expect(slackSessionMetadataAllowed({ toneAdvisoryAck: 'R', toneAdvisoryAckReason: 'why' })).toBe(true);
    expect(slackSessionMetadataAllowed({ toneAdvisoryAck: 'R', allowDuplicate: true })).toBe(false);
    expect(slackSessionMetadataAllowed(['x'])).toBe(false);
    expect(slackSessionMetadataAllowed(null)).toBe(false);
  });
});
