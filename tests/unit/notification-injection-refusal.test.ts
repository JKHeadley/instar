import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { createTempProject, type TempProject } from '../helpers/setup.js';

let project: TempProject;
beforeEach(() => {
  project = createTempProject();
  vi.spyOn(os, 'tmpdir').mockReturnValue(project.dir);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); project.cleanup(); });

function fixture(kind: 'inline' | 'private-file' | 'inline-fallback', accepted: boolean) {
  if (kind === 'inline-fallback') {
    // The real writer rejects a non-directory and uses its documented inline fallback.
    fs.writeFileSync(path.join(project.dir, `instar-${process.getuid?.() ?? 'user'}-paste`), 'fixture obstruction');
  }
  const manager = Object.create(SessionManager.prototype) as SessionManager;
  const inject = vi.spyOn(manager, 'injectMessage').mockReturnValue(accepted);
  const capture = vi.spyOn(manager, 'captureOutput').mockReturnValue('idle pane, no notification');
  vi.spyOn(manager as unknown as { tmuxSessionExists(s: string): boolean }, 'tmuxSessionExists').mockReturnValue(true);
  return { manager, inject, capture, text: kind === 'inline' ? 'Owner follow-up notification' : 'Private notification '.repeat(40) };
}

it.each(['inline', 'private-file', 'inline-fallback'] as const)('propagates an explicit %s injection refusal to direct callers', (kind) => {
  const { manager, inject, text } = fixture(kind, false);
  expect(() => manager.injectPasteNotification('fixture-session', text)).toThrow('Notification input was refused');
  expect(inject).toHaveBeenCalledTimes(1);
});

it.each(['inline', 'private-file', 'inline-fallback'] as const)('never labels a refused %s notification submitted because its marker is absent', async (kind) => {
  const { manager, inject, capture, text } = fixture(kind, false);
  const pending = manager.injectPasteNotificationObserved('fixture-session', text);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toEqual({ state: 'stuck' });
  expect(inject).toHaveBeenCalledTimes(1);
  expect(capture).not.toHaveBeenCalled();
});

it.each(['inline', 'private-file', 'inline-fallback'] as const)('preserves the successful %s notification reference', (kind) => {
  const { manager, inject, text } = fixture(kind, true);
  const reference = manager.injectPasteNotification('fixture-session', text);
  expect(reference).toBe(inject.mock.calls[0][1]);
  if (kind === 'private-file') expect(reference).toContain('[paste] Content notification saved to');
  else expect(reference).toBe(text);
  expect(inject).toHaveBeenCalledTimes(1);
});
