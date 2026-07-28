/**
 * The user channels report LIVENESS, not configuration.
 *
 * The defect these pin: `/capabilities` answers `telegram: { configured: true }` — which stays true
 * after the poll loop dies, because the config file still says so. Every test below is written so
 * that a probe which fell back to reading configuration would FAIL it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildUserChannelDefinitions,
  telegramStateFrom,
  slackStateFrom,
  type TelegramLiveStatus,
} from '../../src/core/userChannels.js';
import { resolveChannels, type ChannelDefinition } from '../../src/core/channelRegistry.js';
import { buildChannelDefinitions } from '../../src/core/instarChannels.js';

const REPO_ROOT = join(__dirname, '..', '..');

/** A Telegram that is polling happily. */
const healthy: TelegramLiveStatus = {
  started: true,
  fatalReason: null,
  consecutivePollErrors: 0,
  lastError: null,
  stoppedAt: null,
};

/**
 * REGRESSION (2026-07-27, found by live-checking the shipped feature on the running agent).
 *
 * The `unknown` verdict said "the Telegram poll loop is not running" without naming WHOSE poll loop.
 * What it measures is the SERVER process's adapter. On a lifeline deployment inbound Telegram never
 * goes through that adapter — a separate lifeline process polls and forwards, and the server logs
 * "Telegram relay wired (via lifeline callback forwarding)". There a stopped server poller is NORMAL.
 *
 * Observed live: this row read `unknown` while inbound was healthy. Same scope error the
 * threadline-relay row was fixed for hours earlier — a true statement whose subject is unstated, so
 * the reader concludes something about a path that was never measured.
 */
describe('the unknown verdict names its subject', () => {
  it('says it measured the SERVER adapter, not inbound generally', () => {
    const r = telegramStateFrom({
      started: false, fatalReason: null, consecutivePollErrors: 0, lastError: null, stoppedAt: null,
    });
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/server adapter/i);
    // And it must say what that does NOT establish — the part a reader would otherwise infer.
    expect(r.detail).toMatch(/lifeline/i);
    expect(r.detail).toMatch(/does not|not mean/i);
  });

  it('still refuses to call it healthy — naming the subject must not soften the verdict', () => {
    // The failure direction that matters: an unnamed subject was bad, but a reassuring one is worse.
    const r = telegramStateFrom({
      started: false, fatalReason: null, consecutivePollErrors: 0, lastError: null, stoppedAt: null,
    });
    expect(r.state).not.toBe('working');
    expect(r.direction).toBe('none');
  });
});

describe('user channel liveness — the refusals', () => {
  it('THE FIX: a configured-but-DEAD Telegram is never reported as working', () => {
    // This is the whole point. Config still says the bot is set up; the loop is dead.
    const dead: TelegramLiveStatus = {
      started: false,
      fatalReason: '401',
      consecutivePollErrors: 7,
      lastError: 'Unauthorized',
      stoppedAt: '2026-07-27T05:00:00.000Z',
    };
    const r = telegramStateFrom(dead);
    expect(r.state).not.toBe('working');
    expect(r.direction).not.toBe('bidirectional');
    // And it names WHY, because "broken" alone does not tell the operator what to do.
    expect(r.state).toBe('reachable-no-credential');
    expect(r.detail).toMatch(/401|reject/i);
  });

  it('a missing bot token is a credential verdict, not a network one', () => {
    const r = telegramStateFrom({ ...healthy, started: false, fatalReason: 'no-usable-bot-token' });
    expect(r.state).toBe('reachable-no-credential');
  });

  it('a network death is broken — distinct from a credential problem', () => {
    const r = telegramStateFrom({
      ...healthy,
      started: false,
      fatalReason: 'network',
      lastError: 'ETIMEDOUT',
      stoppedAt: '2026-07-27T05:00:00.000Z',
    });
    expect(r.state).toBe('broken');
    expect(r.detail).toMatch(/network/i);
  });

  it('stopped for NO recorded reason is unknown — never working, never a confident broken', () => {
    // The adapter cannot tell a deliberate stop from a silent death. Saying either would be a claim
    // nothing established.
    const r = telegramStateFrom({ ...healthy, started: false, fatalReason: null, stoppedAt: null });
    expect(r.state).toBe('unknown');
    expect(r.state).not.toBe('working');
    expect(r.detail).toMatch(/cannot tell/i);
  });

  it('an absent adapter is not-configured — off is not broken', () => {
    const r = telegramStateFrom(null);
    expect(r.state).toBe('not-configured');
  });

  it('still polling WITH transient errors is working-but-degraded, and says so', () => {
    const r = telegramStateFrom({ ...healthy, consecutivePollErrors: 3, lastError: 'ECONNRESET' });
    expect(r.state).toBe('working');
    expect(r.detail).toMatch(/degraded/i);
    expect(r.detail).toMatch(/3/);
  });

  it('a clean poll loop is working', () => {
    expect(telegramStateFrom(healthy).state).toBe('working');
  });
});

describe('slack liveness uses the flag that CLEARS on disconnect', () => {
  it('a live socket is working', () => {
    expect(slackStateFrom(true, true).state).toBe('working');
  });

  it('THE TRAP: enabled with the socket DOWN is broken, not working', () => {
    // `started` on the adapter means "ever connected" and would still be true here. Reading it
    // instead of `isConnected()` would report a long-dead workspace as healthy forever.
    const r = slackStateFrom(true, false);
    expect(r.state).toBe('broken');
    expect(r.direction).toBe('none');
  });

  it('enabled but no adapter constructed is unknown — enabled is not working', () => {
    const r = slackStateFrom(true, null);
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/not the same as working/i);
  });

  it('not enabled is not-configured', () => {
    expect(slackStateFrom(false, null).state).toBe('not-configured');
  });
});

describe('registry integration — absence stays impossible', () => {
  const ctx = {
    telegramStatus: () => healthy,
    slackConnected: () => true,
    slackEnabled: () => true,
  };

  it('user channels are tagged user, peer channels stay tagged peer, in ONE report', async () => {
    const peerDefs = buildChannelDefinitions({
      relayStatus: () => null,
      mutualSshConstructed: () => false,
      mutualSshEnabled: () => false,
      peerHttp: async () => ({ reachable: false, haveCredential: false, detail: 'none' }),
    });
    const report = await resolveChannels([...peerDefs, ...buildUserChannelDefinitions(ctx)]);

    const audiences = new Map(report.channels.map((c) => [c.id, c.audience]));
    expect(audiences.get('threadline-relay')).toBe('peer');
    expect(audiences.get('user-telegram')).toBe('user');
    expect(audiences.get('user-slack')).toBe('user');
    // One question, one surface: both audiences present in the same report.
    expect(new Set(report.channels.map((c) => c.audience))).toEqual(new Set(['peer', 'user']));
  });

  it('a THROWING user probe still yields a row, reported unknown — never an omission', async () => {
    const exploding: ChannelDefinition = {
      id: 'user-telegram',
      audience: 'user',
      purpose: 'p',
      whenPreferred: 'w',
      cost: 'c',
      probe: async () => {
        throw new Error('adapter exploded');
      },
    };
    const report = await resolveChannels([exploding]);
    expect(report.channels).toHaveLength(1);
    expect(report.channels[0].state).toBe('unknown');
    expect(report.channels[0].probeFailed).toBe(true);
    // The invariant that makes the registry trustworthy: a failure cannot remove itself from view.
    expect(report.summary.total).toBe(1);
    expect(report.summary.working).toBe(0);
  });

  it('every user channel carries the user-experience rationale, not just a cost', () => {
    // Justin's point: a user channel is the only surface that shows what the user actually sees.
    // If someone rewrites these to be cost-only, the routing judgement is lost and this fails.
    for (const def of buildUserChannelDefinitions(ctx)) {
      expect(def.whenPreferred.length).toBeGreaterThan(40);
      expect(def.cost).toMatch(/attention/i);
    }
    const tg = buildUserChannelDefinitions(ctx).find((d) => d.id === 'user-telegram')!;
    expect(tg.whenPreferred).toMatch(/what the user genuinely experiences|proxy/i);
  });
});

describe('source ratchet — the probes must not drift back to reading config', () => {
  it('userChannels.ts never consults configuration for liveness', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'core', 'userChannels.ts'), 'utf-8');
    // `configured` is the exact word whose truthiness caused the defect. It may appear in prose
    // explaining the trap, but never as a property read.
    expect(src).not.toMatch(/\.configured\b/);
    expect(src).not.toMatch(/config\.\w/);
  });

  it('the route reads isConnected() for Slack, never started', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'server', 'routes.ts'), 'utf-8');
    const wiring = src.slice(src.indexOf('buildUserChannelDefinitions({'));
    const block = wiring.slice(0, wiring.indexOf('resolveChannels'));
    expect(block).toMatch(/isConnected\(\)/);
    // `slackAdapter.started` would be the "ever connected" trap.
    expect(block).not.toMatch(/slackAdapter\.started/);
  });
});
