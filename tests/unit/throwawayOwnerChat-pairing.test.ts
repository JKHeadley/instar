/**
 * A throwaway home that ran the stand-in owner chat is never paired with another machine
 * (docs/specs/throwaway-owner-chat.md §2.4): POST /api/pair refuses before reading anything, and
 * the lifetime marker is the stand-in's state file.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { standInEverUsed, STAND_IN_STATE } from '../../src/server/throwawayOwnerChat.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/throwawayOwnerChat-pairing.test.ts' }); });

const appWith = (pairBlocked: () => string | null) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-pair-'));
  dirs.push(base);
  const app = express();
  app.use(express.json());
  app.use(createMachineRoutes({
    identityManager: { baseDir: base }, heartbeatManager: {}, securityLog: { append: () => undefined }, authDeps: {}, localMachineId: 'm1', localSigningKeyPem: 'x',
    onDemote: () => undefined, onPromote: () => undefined, pairBlocked,
  } as never));
  return app;
};

describe('machine pairing on a home that ran the stand-in', () => {
  it('POST /api/pair refuses with a plain reason before reading the code', async () => {
    const r = await request(appWith(() => 'stand-in-owner-chat-used')).post('/api/pair').send({ pairingCode: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('stand-in-owner-chat-used');
    expect(r.body.detail).toMatch(/never paired with another machine/);
  });

  it('with no block, pairing goes on to its ordinary checks', async () => {
    const r = await request(appWith(() => null)).post('/api/pair').send({});
    expect(r.status).toBe(400);
  });

  it('the lifetime marker is the state file', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toc-mark-'));
    dirs.push(stateDir);
    expect(standInEverUsed(stateDir)).toBe(false);
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, STAND_IN_STATE), JSON.stringify({ firstBuiltAt: new Date().toISOString(), off: { at: 'x', condition: 'real-owner', detail: '' } }));
    expect(standInEverUsed(stateDir)).toBe(true);
  });
});
