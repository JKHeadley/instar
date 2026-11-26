import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexFollowupFixture } from '../helpers/codexFollowupFixture.js';

let fixture: ReturnType<typeof codexFollowupFixture> | undefined;
afterEach(() => { vi.restoreAllMocks(); fixture?.cleanup(); fixture = undefined; });

function defaultDecoy() {
  if (!fixture) throw new Error('fixture missing');
  const decoy = path.join(fixture.project.dir, '.codex/sessions/2026/11/23/rollout-decoy-native-rollout.jsonl');
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  fs.writeFileSync(decoy, 'default-account-decoy\n');
  vi.spyOn(os, 'homedir').mockReturnValue(fixture.project.dir);
  return decoy;
}

it('resolves the actual running Codex account home before accepting owner input', () => {
  fixture = codexFollowupFixture();
  const { seam } = fixture.boot();
  defaultDecoy();
  expect(seam.codexRolloutPathForSession(fixture.session)).toBe(fixture.rollout);
});

it('preserves a trailing space in the explicit account directory', () => {
  fixture = codexFollowupFixture();
  const { seam } = fixture.boot();
  const spacedHome = `${fixture.accountHome} `;
  const spacedRollout = path.join(spacedHome, 'sessions/2026/11/23/rollout-spaced-native-rollout.jsonl');
  fs.mkdirSync(path.dirname(spacedRollout), { recursive: true });
  fs.writeFileSync(spacedRollout, 'exact-account\n');
  fs.writeFileSync(fixture.envFile, `CODEX_HOME=${spacedHome}\n`);
  expect(seam.codexRolloutPathForSession(fixture.session)).toBe(spacedRollout);
});

it('does not resolve a missing rollout from another account', () => {
  fixture = codexFollowupFixture();
  fs.writeFileSync(fixture.envFile, `CODEX_HOME=${fixture.project.dir}/different-account\n`);
  const { manager, paste } = fixture.boot();
  defaultDecoy();
  expect(manager.injectTelegramMessage('pooled-session', 42, 'Please continue.', 'Fixture', 'Owner', 123, 1)).toBe(false);
  expect(paste).not.toHaveBeenCalled();
});

it('refuses unverifiable account environment without a physical effect', () => {
  fixture = codexFollowupFixture();
  fs.writeFileSync(fixture.envFile, 'CODEX_HOME=relative-account\n');
  const { manager, paste } = fixture.boot();
  defaultDecoy();
  expect(manager.injectTelegramMessage('pooled-session', 42, 'Please continue.', 'Fixture', 'Owner', 123, 2)).toBe(false);
  expect(paste).not.toHaveBeenCalled();
});

it.each(['!missing', '-CODEX_HOME', 'CODEX_HOME='])('uses the normal Codex home for documented absent/unset value %s', (value) => {
  fixture = codexFollowupFixture();
  const { seam } = fixture.boot();
  fs.writeFileSync(fixture.envFile, `${value}\n`);
  const decoy = defaultDecoy();
  expect(seam.codexRolloutPathForSession(fixture.session)).toBe(decoy);
});

it.each(['!error', 'OTHER_KEY=/wrong', 'CODEX_HOME=/one\nCODEX_HOME=/two'])('does not fall back after an uncertain environment result %s', (value) => {
  fixture = codexFollowupFixture();
  const { manager, paste } = fixture.boot();
  fs.writeFileSync(fixture.envFile, `${value}\n`);
  defaultDecoy();
  expect(manager.injectTelegramMessage('pooled-session', 42, 'Please continue.', 'Fixture', 'Owner', 123, 3)).toBe(false);
  expect(paste).not.toHaveBeenCalled();
});
