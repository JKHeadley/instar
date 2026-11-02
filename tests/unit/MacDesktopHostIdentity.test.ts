import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import type { DesktopHelperRetention } from '../../src/core/DesktopHelperRetention.js';
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

/** A second helper, standing in for the kept copy. */
function kept(installed: { host: MacDesktopHost }, inherited: Grants, own: Grants | 'fails', change: unknown = null) {
  const donor = helper(inherited, own);
  const notes = { granted: 0, broken: 0 };
  let broken = false;
  const retention = {
    resolve: () => broken
      ? { path: 'packaged', source: 'packaged', reason: 'disabled' }
      : { path: donor.host['binary'], source: 'retained' },
    noteGranted: () => { notes.granted++; },
    markBroken: () => { notes.broken++; broken = true; },
    permissionChange: () => change,
  } as unknown as DesktopHelperRetention;
  return { host: new MacDesktopHost(installed.host['binary'], retention), spawns: donor.spawns, notes };
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

  it('runs the kept copy and records that it holds its own grant', async () => {
    const installed = helper({ screen: false, input: false }, { screen: false, input: false });
    const { host, spawns, notes } = kept(installed, { screen: false, input: false }, { screen: true, input: true });
    expect(await host.probe()).toMatchObject({ screenGrant: 'own', inputGrant: 'own', helperSource: 'retained' });
    expect(spawns()).toEqual(expect.arrayContaining(['probe:inherited', 'probe:own']));
    expect(installed.spawns).toThrow();
    expect(notes.granted).toBe(1);
  });

  it('keeps a grant the installed copy still holds until the kept copy has its own', async () => {
    const installed = helper({ screen: false, input: false }, { screen: true, input: true });
    const { host } = kept(installed, { screen: false, input: false }, { screen: false, input: false });
    expect(await host.probe()).toMatchObject({ screenPermission: true, inputPermission: true,
      screenGrant: 'own', helperSource: 'packaged' });
    await host.capture();
    expect(installed.spawns()).toContain('capture-stream:own');
    host.stopIndicator();
    host.cancelInput();
  });

  it('says what changed when neither copy holds the permission', async () => {
    const change = { kind: 'source-changed', version: '1.3.1580', helperPath: '/k' };
    const installed = helper({ screen: false, input: false }, { screen: false, input: false });
    const { host } = kept(installed, { screen: false, input: false }, { screen: false, input: false }, change);
    expect(await host.probe()).toMatchObject({ screenGrant: 'none', helperChange: change, helperSource: 'retained' });
  });

  it('never reports a change on a Mac that still works on an inherited grant', async () => {
    const change = { kind: 'source-changed', version: '1.3.1580', helperPath: '/k' };
    const installed = helper({ screen: false, input: false }, { screen: false, input: false });
    const { host } = kept(installed, { screen: true, input: true }, { screen: false, input: false }, change);
    const probe = await host.probe();
    expect(probe.screenGrant).toBe('inherited');
    expect(probe.helperChange).toBeUndefined();
  });

  it('survives one failed kept-copy start, and gives up only if it keeps failing', async () => {
    const installed = helper({ screen: true, input: true }, { screen: true, input: true });
    const { host, notes } = kept(installed, { screen: false, input: false }, { screen: true, input: true });
    const keptPath = (host['retention']!.resolve() as { path: string }).path;
    const realProbeAs = host['probeAs'];
    host['probeAs'] = function (this: MacDesktopHost, identity: 'own' | 'inherited', binary?: string) {
      if (binary === keptPath) return Promise.reject(new Error('timeout'));
      return realProbeAs.call(this, identity, binary);
    } as typeof realProbeAs;
    for (const broken of [0, 0, 1]) {
      expect(await host.probe()).toMatchObject({ screenPermission: true });
      expect(notes.broken).toBe(broken);
    }
  });

  it('keeps a live session on the granted installed copy', async () => {
    const installed = helper({ screen: false, input: false }, { screen: true, input: true });
    const { host } = kept(installed, { screen: false, input: false }, { screen: false, input: false });
    await host.probe();
    await host.input({ kind: 'keyDown', key: 'Shift' });
    host['lastPackagedOwnProbe'] = null;
    expect(await host.probe()).toMatchObject({ screenPermission: true, inputPermission: true, helperSource: 'packaged' });
    await host.cancelInput();
    expect(installed.spawns()).toContain('release:own');
  });

  it('asks for permission only under the helper identity', async () => {
    const { host, spawns } = helper({ screen: false, input: false }, { screen: false, input: false });
    expect(await host.requestPermission()).toEqual({ screenPermission: false, inputPermission: true });
    expect(spawns()).toEqual(['request-permission:own']);
  });
});
