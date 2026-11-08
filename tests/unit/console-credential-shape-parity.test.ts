/**
 * Acceptance condition 4 (dashboard-conversations-browser-device.md, binding on the build): the
 * browser composer's credential question uses a copy of the server's detectOutboundCredential.
 * Both run on one fixture set and must agree on every case, including invisible-character,
 * oversize and the deliberately excluded kinds (jwt, bearer-token, labeled-secret).
 */
import { describe, it, expect } from 'vitest';
import { detectOutboundCredential, HARD_WALL_CREDENTIAL_KINDS, MAX_SCAN_BYTES as SERVER_MAX } from '../../src/messaging/outbound-credential-guard.js';
import { DURABLE_SECRET_PATTERNS } from '../../src/core/durableSecretScrub.js';
import { detectCredentialShape, CREDENTIAL_PATTERNS, MAX_SCAN_BYTES, CREDENTIAL_QUESTION } from '../../dashboard/console/credential-shape.js';

const ZWSP = '​';
const FIXTURES: Array<[string, string]> = [
  ['plain prose', 'Disable password authentication in the sshd config.'],
  ['empty', ''],
  ['anthropic', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx here'],
  ['stripe', 'sk_live_ABCDEFGHIJKLMNOP'],
  ['openai generic', 'use sk-ABCDEFGHIJKLMNOP1234'],
  ['openai project', 'MY_KEY_sk-proj-' + 'a'.repeat(40)],
  ['kebab slug not a key', 'task-proj-' + 'a'.repeat(40)],
  ['github classic', 'ghp_' + 'A'.repeat(36)],
  ['github fine-grained', 'github_pat_' + 'B'.repeat(60)],
  ['google', 'AIza' + 'C'.repeat(35)],
  ['slack', 'xoxb-1234567890-abcdef'],
  ['aws', 'AKIAABCDEFGHIJKLMNOP'],
  ['telegram bot', '123456789:' + 'D'.repeat(35)],
  ['pem', '-----BEGIN PRIVATE KEY-----\nMIIBVQ==\n-----END PRIVATE KEY-----'],
  ['url credential', 'https://user:hunter2@example.com/x'],
  ['jwt excluded', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstu'],
  ['bearer excluded', 'Authorization: Bearer YOUR_DASHBOARD_TOKEN_HERE_LONG'],
  ['labeled excluded', 'password: correcthorsebatterystaple'],
  ['invisible inside key', 'ghp_' + 'A'.repeat(10) + ZWSP + 'A'.repeat(26)],
  ['invisible separating', 'ENV' + ZWSP + 'ghp_' + 'A'.repeat(36)],
  ['bom inside aws', 'AKIA﻿ABCDEFGHIJKLMNOP'],
  ['variation selector', 'xoxb-12345️67890-abc'],
  ['oversize', 'a'.repeat(1_000_001)],
  ['at the size limit', 'a'.repeat(1_000_000)],
];

describe('browser credential-shape check matches detectOutboundCredential', () => {
  it('uses the same size limit', () => { expect(MAX_SCAN_BYTES).toBe(SERVER_MAX); });

  it('covers exactly the hard-wall kinds, with the same regex sources', () => {
    const serverHard = DURABLE_SECRET_PATTERNS.filter((p) => HARD_WALL_CREDENTIAL_KINDS.has(p.kind));
    expect(CREDENTIAL_PATTERNS.map((p: { kind: string }) => p.kind)).toEqual(serverHard.map((p) => p.kind));
    expect(CREDENTIAL_PATTERNS.map((p: { regex: RegExp }) => p.regex.source)).toEqual(serverHard.map((p) => p.regex.source));
    for (const k of ['jwt', 'bearer-token', 'labeled-secret']) expect(CREDENTIAL_PATTERNS.some((p: { kind: string }) => p.kind === k)).toBe(false);
  });

  for (const [name, text] of FIXTURES) {
    it(`agrees on: ${name}`, () => {
      const server = detectOutboundCredential(text);
      const browser = detectCredentialShape(text);
      expect(browser.detected).toBe(server.detected);
      expect(browser.kind).toBe(server.kind);
    });
  }

  it('flags the expected cases (the fixtures are not all trivially negative)', () => {
    const hits = FIXTURES.filter(([, t]) => detectCredentialShape(t).detected).map(([n]) => n);
    expect(hits).toEqual(expect.arrayContaining(['anthropic', 'invisible inside key', 'invisible separating', 'bom inside aws', 'oversize', 'url credential']));
    for (const n of ['jwt excluded', 'bearer excluded', 'labeled excluded', 'plain prose', 'kebab slug not a key', 'at the size limit']) expect(hits).not.toContain(n);
  });

  it('asks the phone\'s question word for word', () => {
    expect(CREDENTIAL_QUESTION).toBe('This looks like a password or key. If you send it, it is saved in this conversation\'s history on every machine of this agent, in plain text. Send it through a Secret Drop link instead, or send as written?');
  });
});
