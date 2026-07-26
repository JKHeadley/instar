/**
 * The registry's static claims must not rot.
 *
 * One channel's verdict is asserted rather than probed: the agent-to-agent-over-Telegram protocol is
 * reported `half-built / receive-only` because its outbound function has no executing caller. That is
 * a build-time property no runtime probe can see.
 *
 * An unguarded assertion in a registry is precisely the failure this registry exists to prevent — a
 * confident label that was true once. Eight times in one evening I classified something by its label
 * rather than by its consumer, and a stale registry entry would institutionalise exactly that error
 * and hand it to my future self mid-outage, when I am least able to check.
 *
 * So: if someone wires the sender, this test fails and forces the verdict to be corrected.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChannelDefinitions, type ChannelProbeContext } from '../../src/core/instarChannels.js';
import { resolveChannels } from '../../src/core/channelRegistry.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so prose describing the call does not count as a caller. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('registry static claims are still true', () => {
  it('a2a-telegram: the send function STILL has no executing caller', () => {
    // The moment this fails, the registry entry is lying and must be updated to reflect a real sender.
    const callers: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('AgentTelegramComms.ts')) continue; // its own definition
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      if (/\bsendAgentMessage\s*\(/.test(code)) callers.push(path.relative(SRC, file));
    }
    expect(
      callers,
      callers.length
        ? `sendAgentMessage now has caller(s): ${callers.join(', ')}. The channel registry reports ` +
          `a2a-telegram as half-built/receive-only — update src/core/instarChannels.ts to match reality.`
        : '',
    ).toEqual([]);
  });

  it('the scanner would actually notice a caller (dead-check)', () => {
    // Guards the guard: an always-empty scan would pass the assertion above forever.
    const code = stripComments('const x = sendAgentMessage({to: "peer"});');
    expect(/\bsendAgentMessage\s*\(/.test(code)).toBe(true);
    // …and prose describing it must NOT count.
    expect(/\bsendAgentMessage\s*\(/.test(stripComments('// calls sendAgentMessage(foo)'))).toBe(false);
  });
});

describe('instar channel definitions resolve honestly', () => {
  const baseCtx = (over: Partial<ChannelProbeContext> = {}): ChannelProbeContext => ({
    relayStatus: () => ({ ready: true, connected: true }),
    mutualSshConstructed: () => true,
    mutualSshEnabled: () => true,
    peerHttp: async () => ({ reachable: true, haveCredential: true, detail: 'reachable with credential' }),
    ...over,
  });

  it('scopes to PEER channels only — the upstream poller and the trust input are excluded', async () => {
    const ids = buildChannelDefinitions(baseCtx()).map(d => d.id);
    expect(ids).toEqual(['threadline-relay', 'a2a-telegram', 'mutual-ssh', 'peer-http']);
    expect(ids).not.toContain('auto-dispatch');
    expect(ids).not.toContain('moltbridge');
  });

  it('reproduces the incident state honestly: relay down, sender missing, ssh never constructed', async () => {
    const report = await resolveChannels(buildChannelDefinitions(baseCtx({
      relayStatus: () => ({ ready: false, connected: false }),
      mutualSshConstructed: () => false,
      peerHttp: async () => ({ reachable: true, haveCredential: false, detail: 'peer /health answers; no credential held' }),
    })));

    const by = Object.fromEntries(report.channels.map(c => [c.id, c]));
    expect(by['threadline-relay'].state).toBe('broken');
    expect(by['a2a-telegram'].state).toBe('half-built');
    expect(by['mutual-ssh'].state).toBe('broken');
    expect(by['peer-http'].state).toBe('reachable-no-credential');
    // The honest headline for that night: nothing usable, and it says so instead of showing four rows of green.
    expect(report.summary).toEqual({ total: 4, working: 0, unusable: 4, unknown: 0 });
  });

  it('mutual-ssh reports construction WITHOUT claiming a completed round-trip', async () => {
    // The scope limit that bit me: loading is not functioning. The detail must say so.
    const report = await resolveChannels(buildChannelDefinitions(baseCtx()));
    const ssh = report.channels.find(c => c.id === 'mutual-ssh')!;
    expect(ssh.state).toBe('working');
    expect(ssh.detail.toLowerCase()).toContain('not a completed round-trip');
  });

  it('distinguishes never-constructed from switched-off', async () => {
    const off = await resolveChannels(buildChannelDefinitions(baseCtx({ mutualSshEnabled: () => false })));
    expect(off.channels.find(c => c.id === 'mutual-ssh')!.state).toBe('not-configured');

    const noThreadline = await resolveChannels(buildChannelDefinitions(baseCtx({ relayStatus: () => null })));
    expect(noThreadline.channels.find(c => c.id === 'threadline-relay')!.state).toBe('not-configured');
  });

  it('a probe that throws leaves the channel visible as undetermined', async () => {
    const report = await resolveChannels(buildChannelDefinitions(baseCtx({
      peerHttp: async () => { throw new Error('connect ECONNREFUSED'); },
    })));
    expect(report.channels).toHaveLength(4);
    const peer = report.channels.find(c => c.id === 'peer-http')!;
    expect(peer.state).toBe('unknown');
    expect(peer.detail).toContain('ECONNREFUSED');
  });
});
