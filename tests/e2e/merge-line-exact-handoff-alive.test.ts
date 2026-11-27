// safe-fs-allow: test file — temporary cleanup uses SafeFsExecutor.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import request from 'supertest'; import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { exactHandoffFixture } from '../helpers/merge-line-exact-handoff-fixture.js';
const clean: Array<() => void> = []; afterEach(() => { for (const fn of clean.splice(0)) fn(); });
it('production watcher start and rebuilt disk state retain exact lookup wiring and refuse a moved verified head', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exact-handoff-alive-'))), f = exactHandoffFixture(home);
  clean.push(() => { f.watcher.stop(); SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'exact-handoff-alive' }); });
  f.watcher.start(); expect(f.watcher.configurationView().ok).toBe(true);
  expect((await request(f.app).post('/green-pr-automerge/tick')).status).toBe(200);
  expect(await f.watcher.tick({ handoff: { pr: 3714, head: 'a'.repeat(40) } })).toEqual({ acted: true, reason: 'merged' });
  f.watcher.stop(); const restored = exactHandoffFixture(home); restored.watcher.start(); clean.push(() => restored.watcher.stop());
  restored.move();
  expect(await restored.watcher.tick({ handoff: { pr: 3714, head: 'a'.repeat(40) } })).toEqual({ acted: false, reason: 'handoff-not-eligible:head-moved' });
  expect(restored.lookupCount()).toBe(1); expect(restored.attempts).toEqual([]);
  expect((await request(restored.app).get('/green-pr-automerge')).status).toBe(200);
});
