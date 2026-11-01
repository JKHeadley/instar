import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const binary = path.resolve('dist/native/instar-desktop-host');
const skip = process.platform !== 'darwin' || !fs.existsSync(binary);

// The private macOS call behind own identity is the part a mock cannot prove:
// exit 71 means the re-exec failed. Permission values depend on the machine.
describe.skipIf(skip)('packaged macOS helper own identity', () => {
  const probe = (env: NodeJS.ProcessEnv) => {
    const result = spawnSync(binary, ['probe'], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { screenPermission: boolean; displayCount: number };
  };

  it('answers a real probe under both identities', () => {
    const inherited = probe({});
    const own = probe({ INSTAR_DESKTOP_OWN_IDENTITY: '1' });
    expect(typeof own.screenPermission).toBe('boolean');
    expect(own.displayCount).toBe(inherited.displayCount);
  });

  it('refuses to request permission outside its own identity', () => {
    const result = spawnSync(binary, ['request-permission'], { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 });
    expect(result.status).toBe(64);
  });
});
