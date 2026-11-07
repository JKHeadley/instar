/**
 * A confirmed no with "switch it off" (docs/specs/recommended-services.md, No: `shutdown: authorized`).
 * Each recipe undoes only what its setup did on this machine, and says so in plain words.
 */
import { describe, expect, it } from 'vitest';
import { SETUP_RECIPES, type StopDeps, type TailscaleStatusRead } from '../../src/recommended/recipes.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

const jev = SETUP_RECIPES.find((r) => r.id === 'jev-v1')!;
const tailscale = SETUP_RECIPES.find((r) => r.id === 'tailscale-v1')!;
const signedIn = loadCapturedFixture('tailscale-status', 'status-full');
const signedOut = loadCapturedFixture('tailscale-status', 'status-needslogin');

const deps = (over: Partial<StopDeps>): StopDeps => ({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: true, ...over });

describe('Jev: switching off', () => {
  it('removes the key its own setup stored, which is what every feature here reads, and leaves the account to the person', async () => {
    const deleted: string[] = [];
    const out = await jev.stop(deps({ readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null), deleteSecret: (n) => { deleted.push(n); } }));
    expect(deleted).toEqual(['typesafe_api_key']);
    expect(out.stopped).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.detail).toMatch(/switched off on this machine/);
    expect(out.detail).toMatch(/account and any credits on it stay yours/);
  });

  it('leaves a key the person had before setup, like Tailscale leaves their sign-in, and says so', async () => {
    let deleted = 0;
    const out = await jev.stop(deps({ setUpHere: false, readSecret: () => 'k', deleteSecret: () => { deleted++; } }));
    expect(deleted).toBe(0);
    expect(out.stopped).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.detail).toMatch(/yours before I set anything up/);
  });

  it('with no key there is nothing to do, and nothing is deleted', async () => {
    let deleted = 0;
    const out = await jev.stop(deps({ deleteSecret: () => { deleted++; } }));
    expect(deleted).toBe(0);
    expect(out).toEqual({ stopped: true, changed: false, detail: 'Jev was not switched on here, so there was nothing to switch off.' });
  });
});

describe('Tailscale: switching off', () => {
  const status = (reads: TailscaleStatusRead[]) => async () => reads.length > 1 ? reads.shift()! : reads[0];

  it('leaves a Tailscale the person already had exactly as it was, and never runs logout', async () => {
    let logouts = 0;
    const out = await tailscale.stop(deps({ setUpHere: false, tailscaleStatus: status([{ kind: 'ok', stdout: signedIn }]), tailscaleLogout: async () => { logouts++; return true; } }));
    expect(logouts).toBe(0);
    expect(out).toMatchObject({ stopped: true, changed: false });
    expect(out.detail).toMatch(/already yours before I set anything up/);
  });

  it('signs out a machine its own setup signed in, and confirms from the status that follows', async () => {
    let logouts = 0;
    const out = await tailscale.stop(deps({
      tailscaleStatus: status([{ kind: 'ok', stdout: signedIn }, { kind: 'ok', stdout: signedOut }]),
      tailscaleLogout: async () => { logouts++; return true; },
    }));
    expect(logouts).toBe(1);
    expect(out).toEqual({ stopped: true, changed: true, detail: 'This machine is signed out of Tailscale. Your Tailscale account and your other devices are untouched.' });
  });

  it('says so when logout is refused or did not take, so a still-signed-in machine is never called off', async () => {
    const refused = await tailscale.stop(deps({ tailscaleStatus: status([{ kind: 'ok', stdout: signedIn }]), tailscaleLogout: async () => false }));
    expect(refused.stopped).toBe(false);
    expect(refused.detail).toMatch(/still signed in/);
    const stuck = await tailscale.stop(deps({ tailscaleStatus: status([{ kind: 'ok', stdout: signedIn }]), tailscaleLogout: async () => true }));
    expect(stuck.stopped).toBe(false);
    expect(stuck.detail).toMatch(/still shows as signed in/);
  });

  it('a machine that is not signed in, or has no Tailscale, has nothing to switch off', async () => {
    let logouts = 0;
    const logout = async () => { logouts++; return true; };
    expect((await tailscale.stop(deps({ tailscaleStatus: status([{ kind: 'ok', stdout: signedOut }]), tailscaleLogout: logout }))).stopped).toBe(true);
    expect((await tailscale.stop(deps({ tailscaleStatus: status([{ kind: 'missing' }]), tailscaleLogout: logout }))).detail).toMatch(/isn't installed/);
    expect(logouts).toBe(0);
  });

  it('the words never carry an address, device or account name', async () => {
    const outs = await Promise.all([
      tailscale.stop(deps({ setUpHere: false, tailscaleStatus: status([{ kind: 'ok', stdout: signedIn }]) })),
      tailscale.stop(deps({ tailscaleStatus: status([{ kind: 'ok', stdout: signedIn }, { kind: 'ok', stdout: signedOut }]), tailscaleLogout: async () => true })),
    ]);
    for (const out of outs) expect(out.detail).not.toMatch(/100\.|fd7a|ts\.net|xxxx|@/);
  });
});
