// safe-fs-allow: test file — temporary cleanup uses SafeFsExecutor.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import request from 'supertest'; import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { exactHandoffFixture } from '../helpers/merge-line-exact-handoff-fixture.js';
const clean: Array<() => void> = []; afterEach(() => { for (const fn of clean.splice(0)) fn(); });
it('real status HTTP route observes the exact green handoff despite an empty discovery list, and preserves a later hold', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exact-handoff-http-'))), f = exactHandoffFixture(home);
  clean.push(() => { f.watcher.stop(); SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'exact-handoff-http' }); });
  expect((await request(f.app).post('/green-pr-automerge/tick')).status).toBe(200); // normal warm-up
  const before = f.calls.length;
  expect(await f.watcher.tick({ handoff: { pr: 3714, head: 'a'.repeat(40) } })).toEqual({ acted: true, reason: 'merged' });
  expect(f.lookupCount()).toBe(1); expect(f.attempts).toHaveLength(1);
  expect(f.calls.slice(before).filter((a) => a.includes('graphql')).every((a) => a.includes('number=3714'))).toBe(true);
  const status = await request(f.app).get('/green-pr-automerge'); expect(status.status).toBe(200);
  expect(status.body.snapshot.entries).toEqual([]); // a direct read cannot pretend to refresh the discovery snapshot
  f.hold(); expect(await f.watcher.tick({ handoff: { pr: 3714, head: 'a'.repeat(40) } })).toEqual({ acted: false, reason: 'handoff-not-eligible:held' });
  expect(f.attempts).toHaveLength(1);
});
