import { describe, expect, it } from 'vitest';
import { desktopPeerUrlAllowed } from '../../src/server/DesktopPeerUrlGate.js';

const peer = { kind: 'tailscale' as const, url: 'http://100.101.95.10:4040' };
const status = (online: boolean, ips: string[] = ['100.101.95.10']) => JSON.stringify({
  BackendState: 'Running', Peer: { 'nodekey:abc': {
    PublicKey: 'nodekey:abc', Online: online, TailscaleIPs: ips,
  } },
});

describe('desktop-only Tailscale route', () => {
  it('admits only an exact online peer reported by the local tailnet daemon', async () => {
    expect(await desktopPeerUrlAllowed(peer, async () => status(true))).toBe(true);
    expect(await desktopPeerUrlAllowed(peer, async () => status(false))).toBe(false);
    expect(await desktopPeerUrlAllowed(peer, async () => status(true, ['100.101.95.11']))).toBe(false);
    expect(await desktopPeerUrlAllowed(peer, async () => JSON.stringify({ BackendState: 'Stopped',
      Peer: JSON.parse(status(true)).Peer }))).toBe(false);
  });

  it('never widens a mislabeled or malformed address', async () => {
    expect(await desktopPeerUrlAllowed({ ...peer, kind: 'last-known-url' }, async () => status(true))).toBe(false);
    expect(await desktopPeerUrlAllowed({ ...peer, url: 'http://100.101.95.10:4040/redirect' },
      async () => status(true))).toBe(false);
    expect(await desktopPeerUrlAllowed({ ...peer, url: 'http://100.101.95.10.evil.test:4040' },
      async () => status(true))).toBe(false);
    expect(await desktopPeerUrlAllowed({ ...peer, url: 'http://user:pass@100.101.95.10:4040' },
      async () => status(true))).toBe(false);
    expect(await desktopPeerUrlAllowed(peer, async () => { throw new Error('daemon offline'); })).toBe(false);
  });
});
