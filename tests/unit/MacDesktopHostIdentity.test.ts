import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Helpers sit beside the real binary so the production path and trust check run.
const files: string[] = [];
let serial = 0;
interface Grants { screen: boolean; input: boolean; }
function helper(inherited: Grants, own: Grants | 'fails'): { host: MacDesktopHost; spawns(): string[] } {
  const filename = path.resolve('dist/native', `instar-desktop-identity-test-${process.pid}-${serial++}`);
  const log = `${filename}.log`;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const script = `#!${process.execPath}
import fs from 'node:fs';
const own = process.env.INSTAR_DESKTOP_OWN_IDENTITY === '1';
const verb = process.argv[2];
fs.appendFileSync(${JSON.stringify(log)}, verb + ':' + (own ? 'own' : 'inherited') + '\\n');
const grants = own ? ${JSON.stringify(own)} : ${JSON.stringify(inherited)};
if (verb === 'probe') {
  if (grants === 'fails') process.exit(71);
  process.stdout.write(JSON.stringify({ screenPermission: grants.screen, inputPermission: grants.input,
    displayCount: 1, sessionActive: true, consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: false }));
} else if (verb === 'release') {
  process.stdout.write('{"ok":true}\\n');
} else if (verb === 'request-permission') {
  process.stdout.write(own ? '{"screenPermission":false,"inputPermission":true}' : 'not-own');
} else {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  process.stdin.on('data', () => {
    if (verb === 'capture-stream') { const head = Buffer.alloc(4); head.writeUInt32BE(4); process.stdout.write(Buffer.concat([head, jpeg])); }
    else process.stdout.write('{"ok":true}\\n');
  });
}
`;
  fs.writeFileSync(filename, script, { mode: 0o700 });
  files.push(filename, log);
  return {
    host: new MacDesktopHost(filename),
    spawns: () => fs.readFileSync(log, 'utf8').trim().split('\n'),
  };
}

describe.skipIf(process.platform !== 'darwin')('MacDesktopHost permission identity', () => {
  afterEach(() => {
    for (const filename of files.splice(0)) {
      if (!fs.existsSync(filename)) continue;
      const marker = `${path.sep}.worktrees${path.sep}.verify${path.sep}`;
      const at = filename.indexOf(marker);
      SafeFsExecutor.safeUnlinkSync(filename, {
        operation: 'tests/unit/MacDesktopHostIdentity.test.ts:cleanup',
        ...(at < 0 ? {} : { localVerifyScopeOk: { verifyRoot: filename.slice(0, at + marker.length - 1) } }),
      });
    }
  });

  it('keeps a Mac working on its inherited grant until the helper has its own', async () => {
    const { host, spawns } = helper({ screen: true, input: true }, { screen: false, input: false });
    expect(await host.probe()).toMatchObject({ screenPermission: true, inputPermission: true,
      screenGrant: 'inherited', inputGrant: 'inherited' });
    await host.capture();
    await host.input({ kind: 'move', x: 0.5, y: 0.5 });
    expect(spawns()).toEqual(expect.arrayContaining(['capture-stream:inherited', 'input-stream:inherited']));
    host.stopIndicator();
    host.cancelInput();
  });

  it('prefers the helper grant per capability, which is the Laptop case', async () => {
    // Reproduces the observed state: the responsible Node is denied Screen
    // Recording but allowed Accessibility, and the helper was granted directly.
    const { host, spawns } = helper({ screen: false, input: true }, { screen: true, input: false });
    expect(await host.probe()).toMatchObject({ screenPermission: true, inputPermission: true,
      screenGrant: 'own', inputGrant: 'inherited' });
    await host.capture();
    await host.input({ kind: 'move', x: 0.5, y: 0.5 });
    expect(spawns()).toEqual(expect.arrayContaining(['capture-stream:own', 'input-stream:inherited']));
    host.stopIndicator();
    host.cancelInput();
  });

  it('reports neither grant as none and never claims ready', async () => {
    const { host } = helper({ screen: false, input: false }, { screen: false, input: false });
    expect(await host.probe()).toMatchObject({ screenPermission: false, inputPermission: false,
      screenGrant: 'none', inputGrant: 'none' });
  });

  it('leaves the inherited reading intact when own identity cannot start', async () => {
    const { host } = helper({ screen: true, input: true }, 'fails');
    expect(await host.probe()).toMatchObject({ screenPermission: true, screenGrant: 'inherited' });
  });

  it('keeps own input identity through a held control and a failed own probe', async () => {
    const { host, spawns } = helper({ screen: true, input: false }, { screen: true, input: true });
    await host.probe();
    await host.input({ kind: 'keyDown', key: 'Shift' });
    const log = host['binary'] + '.log';
    // A later own probe fails: the grant must not read as lost, and the key
    // must be released under the identity that pressed it.
    host['probeAs'] = (original => (identity: 'own' | 'inherited') =>
      identity === 'own' ? Promise.reject(new Error('slow')) : original.call(host, identity))(host['probeAs']);
    expect(await host.probe()).toMatchObject({ inputPermission: true, inputGrant: 'own' });
    await host.cancelInput();
    expect(spawns()).toContain('release:own');
    expect(fs.existsSync(log)).toBe(true);
  });

  it('asks for permission only under the helper identity', async () => {
    const { host, spawns } = helper({ screen: false, input: false }, { screen: false, input: false });
    expect(await host.requestPermission()).toEqual({ screenPermission: false, inputPermission: true });
    expect(spawns()).toEqual(['request-permission:own']);
  });
});
