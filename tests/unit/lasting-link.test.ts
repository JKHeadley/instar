import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLastingEndpoint, LastingLinkLedger, lastingEndpoints, lastingLinkUnproved, mergeEndpoints } from '../../src/core/lastingLink.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const inTempDir = (run: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasting-link-'));
  try {
    run(dir);
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lasting-link.test.ts' });
  }
};

describe('which addresses last', () => {
  it('a quick tunnel does not; a named tunnel, a LAN and Tailscale do', () => {
    expect(isLastingEndpoint('cloudflare', 'https://worlds-luck-regime-trinity.trycloudflare.com')).toBe(false);
    expect(isLastingEndpoint('cloudflare', 'https://echo.example.com')).toBe(true);
    expect(isLastingEndpoint('lan', 'http://10.0.0.5:4040')).toBe(true);
    expect(isLastingEndpoint('tailscale', 'http://100.64.0.5:4040')).toBe(true);
  });
  it('a host that only contains the quick-tunnel name still counts as named', () => {
    expect(isLastingEndpoint('cloudflare', 'https://trycloudflare.com.example.com')).toBe(true);
  });
  it('what a peer sends is cleaned first: junk is dropped and a non-list is empty', () => {
    expect(lastingEndpoints([
      { kind: 'lan', url: 'http://10.0.0.5:4040' },
      { kind: 'cloudflare', url: 'https://a-b-c-d.trycloudflare.com' },
      { kind: 'lan', url: 'http://8.8.8.8:4040' },
      { kind: 'lan', url: 'http://169.254.169.254:4040' },
    ])).toEqual([{ kind: 'lan', url: 'http://10.0.0.5:4040' }]);
    expect(lastingEndpoints('http://10.0.0.5:4040')).toEqual([]);
    expect(lastingEndpoints(undefined)).toEqual([]);
  });
});

describe('the proof', () => {
  it('survives a restart, because the moment it is needed the peer is gone', () => {
    inTempDir((dir) => {
      new LastingLinkLedger(dir).record('m_peer', 'lan', 'http://10.0.0.5:4040');
      const reborn = new LastingLinkLedger(dir);
      expect(reborn.provenWith('m_peer')).toBe(true);
      expect(reborn.provenWith('m_other')).toBe(false);
    });
  });
  it('a quick tunnel that works proves nothing', () => {
    inTempDir((dir) => {
      const ledger = new LastingLinkLedger(dir);
      ledger.record('m_peer', 'cloudflare', 'https://a-b-c-d.trycloudflare.com');
      expect(ledger.provenWith('m_peer')).toBe(false);
      expect(fs.existsSync(path.join(dir, 'state', 'lasting-link.json'))).toBe(false);
    });
  });
  it('an unreadable file is no proof, not a crash', () => {
    inTempDir((dir) => {
      fs.mkdirSync(path.join(dir, 'state'));
      fs.writeFileSync(path.join(dir, 'state', 'lasting-link.json'), '{not json');
      expect(new LastingLinkLedger(dir).provenWith('m_peer')).toBe(false);
    });
  });
});

describe('pairing again', () => {
  it('clears the old proof, and a later signed answer proves it afresh', () => {
    inTempDir((dir) => {
      const ledger = new LastingLinkLedger(dir);
      ledger.record('m_peer', 'lan', 'http://10.0.0.5:4040');
      ledger.record('m_other', 'lan', 'http://10.0.0.6:4040');
      new LastingLinkLedger(dir).forget('m_peer');
      expect(ledger.provenWith('m_peer')).toBe(false);
      expect(ledger.provenWith('m_other')).toBe(true);
      ledger.record('m_peer', 'tailscale', 'http://100.64.0.5:4040');
      expect(ledger.provenWith('m_peer')).toBe(true);
    });
  });
  it('a machine id shaped like a built-in property is not proof', () => {
    inTempDir((dir) => {
      expect(new LastingLinkLedger(dir).provenWith('constructor')).toBe(false);
    });
  });
  it('keeps an address already found to work and takes the new ones first', () => {
    const observed = { kind: 'tailscale', url: 'http://100.64.0.9:4040', origin: 'observed' } as never;
    const lan = { kind: 'lan' as const, url: 'http://10.0.0.5:4040' };
    expect(mergeEndpoints([observed, lan], [lan])).toEqual([lan, observed]);
    expect(mergeEndpoints(undefined, [lan])).toEqual([lan]);
  });
});

describe('who must wait for proof', () => {
  const base = { enabled: true, requireLastingLink: true, preferredNamed: false, pairedWith: 'm_a', livePeerIds: ['m_a'], provenWith: () => false };
  it('waits while the first partner is live and unproved', () => {
    expect(lastingLinkUnproved(base)).toBe(true);
    expect(lastingLinkUnproved({ ...base, provenWith: () => true })).toBe(false);
  });
  it('proof with a third machine does not lift it, so a lost first partner cannot split the pool', () => {
    expect(lastingLinkUnproved({ ...base, livePeerIds: ['m_a', 'm_c'], provenWith: (id) => id === 'm_c' })).toBe(true);
  });
  it('a replacement added later cannot stop a machine proved with its partner', () => {
    expect(lastingLinkUnproved({ ...base, livePeerIds: ['m_a', 'm_c'], provenWith: (id) => id === 'm_a' })).toBe(false);
  });
  it('a partner since revoked no longer holds anything up', () => {
    expect(lastingLinkUnproved({ ...base, livePeerIds: ['m_c'] })).toBe(false);
  });
  it('does not apply on a hand-set switch, an off switch or a named preferred machine', () => {
    expect(lastingLinkUnproved({ ...base, requireLastingLink: false })).toBe(false);
    expect(lastingLinkUnproved({ ...base, enabled: false })).toBe(false);
    expect(lastingLinkUnproved({ ...base, preferredNamed: true })).toBe(false);
  });
  it('with no partner on record it waits on every peer', () => {
    expect(lastingLinkUnproved({ ...base, pairedWith: undefined })).toBe(true);
  });
});
