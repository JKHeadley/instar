/** Installs isolation BEFORE AgentServer construction. Only dispatch implementation is inert. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { MacDesktopHost } from '../../../src/core/MacDesktopHost.js';

export function isolateNativeObservation(home: string) {
  const realRoot = path.join(os.homedir(), '.instar', 'desktop-helper');
  const root = path.join(home, '.instar', 'desktop-helper', 'locked');
  const helper = path.join(home, 'inert-native-helper');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'locked-state.json'), JSON.stringify({ markers: {} }));
  // The status route probes the helper first; a reply the probe parser rejects
  // turns GET /desktop/locked/status into a 503, so answer with a valid, unready probe.
  fs.writeFileSync(helper, `#!${process.execPath}\nconst verb = process.argv[2];\nif (verb === 'state-op') { process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({state:{markers:{}},attempts:{count:0},loginSession:'inert-login'}))); } else if (verb === 'probe') { console.log(JSON.stringify({screenPermission:false,inputPermission:false,sessionActive:false,displayCount:0})); } else if (verb === 'relock-guard') { if (process.argv[3] !== ${JSON.stringify(root)} || !process.env.INSTAR_GUARD_OBSERVATION) process.exit(3); } else { console.log('{}'); }\n`, { mode: 0o700 });
  const attemptedRealPaths: string[] = [];
  const mocks: Array<{ mockRestore(): void }> = [];
  // Fail before touching the operator's desktop store, including failed-* flags.
  for (const method of ['existsSync', 'readFileSync', 'readdirSync', 'openSync', 'statSync', 'lstatSync', 'unlinkSync', 'rmSync', 'writeFileSync'] as const) {
    const original = fs[method] as (...args: any[]) => any;
    const mock = vi.spyOn(fs, method as any).mockImplementation((...args: any[]) => {
      const value = typeof args[0] === 'string' ? path.resolve(args[0]) : Buffer.isBuffer(args[0]) ? path.resolve(args[0].toString()) : '';
      if (value === realRoot || value.startsWith(realRoot + path.sep)) {
        attemptedRealPaths.push(value);
        throw new Error('inert native fixture refused real desktop store access');
      }
      return original(...args);
    });
    mocks.push(mock);
  }
  mocks.push(vi.spyOn(os, 'homedir').mockReturnValue(home));
  // Covers every native verb before startup can schedule its first sweep. Preserve
  // actual MacDesktopHost construction, ledger, spawn funnel and controller wiring.
  mocks.push(vi.spyOn(MacDesktopHost.prototype as any, 'packagedBinary').mockImplementation(function (this: MacDesktopHost) {
    // Keep this constructed instance pinned to the inert path even after mocks are
    // restored. A delayed task would then fail normal path validation, never use
    // the packaged production helper.
    (this as any).binary = helper;
    return helper;
  }));
  return { root, helper, attemptedRealPaths, restore: () => { for (const mock of mocks.reverse()) mock.mockRestore(); } };
}
