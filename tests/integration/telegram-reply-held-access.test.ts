// safe-fs-allow: test file — tmp state dirs only.
/**
 * Integration test — B17 HELD-ACCESS through the real POST /telegram/reply route
 * (Echo Bugs topic 10000002770).
 *
 * Proves the wiring end-to-end: with no test override the route builds the
 * agent's reach from the SAME registry the /playwright-profiles routes use, reading
 * a REAL encrypted vault in a temp state dir, so the vault's entry names reach the
 * gate (an absent vault reads "none", an undecryptable one "UNKNOWN"); the gate adds the HELD-ACCESS sub-clause with no phrase pre-filter; a
 * B17 verdict holds the founding ask (Apple password or manual upload while the
 * vault held the password); a Secret Drop ask for a missing credential is
 * delivered. Only the IntelligenceProvider (and, in the first block, the profile
 * registry) are faked.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const FOUNDING =
  'The App Store Connect key was refused. To finish I need your Apple ID password, or for you to make the Developer ID certificate yourself and upload it manually.';
const SECRET_DROP_ASK =
  'I hold no lasting key for the signing service. One-time Secret Drop link: https://example.test/secrets/abc. It goes into my vault, so I will not ask again.';

function capture(response: { pass: boolean; rule: string; issue: string; suggestion: string }) {
  const prompts: string[] = [];
  const provider = {
    evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }),
  } as unknown as IntelligenceProvider;
  return { provider, prompts };
}

async function start(toneGate: MessagingToneGate, sent: string[], real?: { projectDir: string; stateDir: string }) {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: real
      ? { authToken: 'test', stateDir: real.stateDir, projectDir: real.projectDir, port: 0, projectName: 'echo', secrets: { forceFileKey: true } }
      : { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'held-access-route-')), port: 0, projectName: 'echo' },
    messagingToneGate: toneGate,
    ...(real ? {} : { playwrightRegistry: () => ({
      listProfiles: () => [
        { id: 'operator-google', accounts: [{ service: 'google', identity: 'operator@example.com', owner: 'operator', vaultRefs: [] }] },
      ],
      vaultNames: () => ['apple_account_operator_password'],
    }) }),
    telegram: {
      sendToTopic: async (topicId: number, text: string) => { sent.push(text); return { messageId: sent.length, topicId }; },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  app.use(createRoutes(ctx));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

async function reply(url: string, text: string) {
  const res = await fetch(`${url}/telegram/reply/141385`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('B17 HELD-ACCESS through POST /telegram/reply', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('the founding ask reaches the gate with the sub-clause and the vault names, and a B17 verdict holds it', async () => {
    const { provider, prompts } = capture({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'asks the operator for Apple access the reach shows the agent already holds',
      suggestion: 'use the signed-in browser profile or the stored credential for Apple',
    });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent);
    const res = await reply(server.url, FOUNDING);
    const p = prompts.find((x) => x.includes('HELD-ACCESS sub-clause')) ?? '';
    expect(p).not.toBe('');
    expect(p).toContain('apple_account_operator_password');
    expect(p).toContain('google / operator@example.com in profile operator-google');
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('a Secret Drop ask for a missing credential is delivered', async () => {
    const { provider, prompts } = capture({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent);
    const res = await reply(server.url, SECRET_DROP_ASK);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(prompts.some((x) => x.includes('HELD-ACCESS sub-clause'))).toBe(true);
  });
});

describe('HELD-ACCESS reach from the production registry and a real vault (no override)', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  function home() {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-access-real-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    return { projectDir, stateDir };
  }

  async function promptFor(real: { projectDir: string; stateDir: string }) {
    const { provider, prompts } = capture({ pass: true, rule: '', issue: '', suggestion: '' });
    server = await start(new MessagingToneGate(provider), [], real);
    await reply(server.url, FOUNDING);
    return prompts.find((x) => x.includes('HELD-ACCESS sub-clause')) ?? '';
  }

  it('lists the real vault entry names, never their values', async () => {
    const real = home();
    const store = new SecretStore({ stateDir: real.stateDir, forceFileKey: true });
    store.set('apple_account_operator_password', 'pw-VALUE-must-never-appear');
    const p = await promptFor(real);
    expect(p).toContain('apple_account_operator_password');
    expect(p).not.toContain('pw-VALUE-must-never-appear');
  });

  it('no vault file reads as an empty vault', async () => {
    const p = await promptFor(home());
    expect(p).toContain('Vault entries not tied to a browser account: none.');
  });

  it('an undecryptable vault reads as UNKNOWN, not empty', async () => {
    const real = home();
    fs.mkdirSync(path.join(real.stateDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(real.stateDir, 'secrets', 'config.secrets.enc'), 'not-a-vault');
    const p = await promptFor(real);
    expect(p).toContain('what it holds is UNKNOWN (not empty)');
  });
});
