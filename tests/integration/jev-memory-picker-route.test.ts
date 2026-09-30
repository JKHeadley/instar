// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Jev memory picker — integration tier (spec: docs/specs/jev-memory-picker.md).
 * POST /memory-picker/session-context over real HTTP, through createRoutes,
 * with a real picker (fake vendor fetch) and a real on-disk index.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { JevMemoryPicker, INJECT_HEADER, type JevMemoryPickerConfig } from '../../src/core/JevMemoryPicker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const servers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of servers.splice(0)) await c();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'jev-memory-picker-int.cleanup' });
});

function indexOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `- [Memory ${i + 1}](m.md) — ` + 'x'.repeat(180)).join('\n') + '\n';
}

async function setup(opts: { cfg?: JevMemoryPickerConfig | null; fetchImpl?: () => Promise<Response>; picker?: false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mem-int-')));
  dirs.push(home);
  const configDir = path.join(home, '.claude');
  const projectDir = path.join(home, 'agent');
  const memDir = path.join(configDir, 'projects', projectDir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), indexOf(160));
  const logPath = path.join(home, 'logs', 'jev-memory-picker.jsonl');
  const vendorBodies: string[] = [];
  const picker = new JevMemoryPicker({
    getConfig: () => (opts.cfg === null ? { enabled: false } : { enabled: true, ...(opts.cfg ?? {}) }),
    readKey: () => 'k',
    logPath,
    homeDir: home,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      vendorBodies.push(String(init.body));
      return opts.fetchImpl ? opts.fetchImpl() : ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { b150: { noul: 0.9 }, c150: { noul: 0.8 }, b140: { noul: 0.3 } } }) } as unknown as Response);
    }) as never,
  });
  const topicMemory = {
    getTopicContext: (id: number) => ({ topicName: `Topic ${id}`, totalMessages: 2, summary: null, recentMessages: [{ fromUser: true, text: 'please switch this lane to Sol', timestamp: '' }] }),
  };
  const app = express();
  app.use(express.json());
  app.use(createRoutes({ config: { authToken: 'test', stateDir: path.join(home, '.instar'), port: 0 }, topicMemory, jevMemoryPicker: opts.picker === false ? null : picker } as never));
  const url = await new Promise<string>((resolve) => {
    const srv = app.listen(0, () => {
      servers.push(() => new Promise<void>((r) => srv.close(() => r())));
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
  });
  const post = (body: unknown) => fetch(`${url}/memory-picker/session-context`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rows = async () => { await picker.flush(); return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []; };
  return { home, configDir, projectDir, post, rows, picker, vendorBodies };
}

describe('POST /memory-picker/session-context', () => {
  it('503 when not constructed, and when disabled by the kill switch', async () => {
    const a = await setup({ picker: false });
    expect((await a.post({})).status).toBe(503);
    const b = await setup({ cfg: null });
    expect((await b.post({ configDir: b.configDir, projectDir: b.projectDir, topicId: 1 })).status).toBe(503);
    expect(b.vendorBodies).toHaveLength(0);
  });

  it('400 on a config dir outside the home directory', async () => {
    const e = await setup();
    const res = await e.post({ configDir: '/etc/.claude', projectDir: e.projectDir, topicId: 1 });
    expect(res.status).toBe(400);
    expect(e.vendorBodies).toHaveLength(0);
  });

  it('shadow (default): 202 at once, then one ranked row built from the topic context; nothing to inject is returned', async () => {
    const e = await setup();
    const res = await e.post({ configDir: e.configDir, projectDir: e.projectDir, topicId: 77, source: 'startup' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ mode: 'shadow' });
    await e.picker.lastRun;
    const [row] = await e.rows();
    expect(row).toMatchObject({ outcome: 'ranked', mode: 'shadow', source: 'startup', entries: 160 });
    expect(row.inject.map((x: { id: string }) => x.id.split('-')[0])).toEqual(['L150', 'L140']);
    const sent = JSON.parse(e.vendorBodies[0]);
    expect(sent.state).toContain('Topic: Topic 77');
    expect(sent.state).toContain('please switch this lane to Sol');
  });

  it('inject: 200 with the ranked block past the cut', async () => {
    const e = await setup({ cfg: { mode: 'inject' } });
    const res = await e.post({ configDir: e.configDir, projectDir: e.projectDir, topicId: 77 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ mode: 'inject', present: true, outcome: 'ranked' });
    expect(body.block).toContain(INJECT_HEADER);
    expect(body.block.indexOf('Memory 150')).toBeLessThan(body.block.indexOf('Memory 140'));
    expect(body.block).not.toContain('Memory 1 ');
  });

  it('inject on a vendor error: 200, nothing to print (today\'s load)', async () => {
    const e = await setup({ cfg: { mode: 'inject' }, fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response });
    const body = await (await e.post({ configDir: e.configDir, projectDir: e.projectDir, topicId: 77 })).json();
    expect(body).toMatchObject({ mode: 'inject', present: false, block: '', outcome: 'fallback', reason: 'http-error' });
  });

  it('inject with a missing index: nothing to print, a no-index row', async () => {
    const e = await setup({ cfg: { mode: 'inject' } });
    const body = await (await e.post({ configDir: e.configDir, projectDir: path.join(e.home, 'other'), topicId: 77 })).json();
    expect(body).toMatchObject({ present: false, outcome: 'skipped', reason: 'no-index' });
    expect(e.vendorBodies).toHaveLength(0);
  });

  it('no topic and no context: skipped without a vendor call', async () => {
    const e = await setup({ cfg: { mode: 'inject' } });
    const body = await (await e.post({ configDir: e.configDir, projectDir: e.projectDir })).json();
    expect(body).toMatchObject({ present: false, reason: 'no-context' });
    expect(e.vendorBodies).toHaveLength(0);
  });
});
