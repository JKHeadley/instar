/**
 * SEC-163: switching the agent's public exposure on through the API key alone was not a raise. The
 * public tunnel and the agent-network relay (and widening its visibility) could be switched on by any
 * token holder with no approval. Switching exposure on now needs the owner's
 * approval card, like SEC-162's guard-off; switching it off stays free. The product's own setup writes
 * the settings file directly and is unaffected.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { configPatchRaises, approvableConfigPatch } from '../../src/core/TrustRaiseGuard.js';
import { bearerConfigWriteRefusal } from '../../src/config/bearerConfigWrite.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { PATCHABLE_CONFIG_KEYS, OPERATOR_ONLY_SESSION_KEYS } from '../../src/server/routes.js';

const off = { tunnel: { enabled: false }, threadline: { relayEnabled: false }, publishing: { enabled: false } };

describe('SEC-163: switching exposure on is a raise', () => {
  it('the public tunnel and the relay switched on', () => {
    expect(configPatchRaises(off, { tunnel: { enabled: true } })).not.toEqual([]);
    expect(configPatchRaises(off, { threadline: { relayEnabled: true } })).not.toEqual([]);
    expect(configPatchRaises({}, { threadline: { relayEnabled: true } })).not.toEqual([]); // the relay is off unless true
  });

  it('a block replaced so the default (on) takes over', () => {
    expect(configPatchRaises(off, { tunnel: 'on' })).not.toEqual([]); // the block replaced; tunnel is on unless false
    expect(configPatchRaises(off, { tunnel: { type: 'quick' } })).toEqual([]); // the one-level merge keeps enabled:false
  });

  it('widening the relay visibility while it is on', () => {
    const on = { threadline: { relayEnabled: true, visibility: 'unlisted' } };
    expect(configPatchRaises(on, { threadline: { relayEnabled: true, visibility: 'public' } })).not.toEqual([]);
    expect(configPatchRaises({ threadline: { relayEnabled: true, visibility: 'private' } }, { threadline: { relayEnabled: true, visibility: 'unlisted' } })).not.toEqual([]);
  });

  it('the single-path writer refuses the same', () => {
    const opts = { fileConfig: off, patchableKeys: PATCHABLE_CONFIG_KEYS, operatorOnlySessionKeys: OPERATOR_ONLY_SESSION_KEYS };
    expect(bearerConfigWriteRefusal('tunnel.enabled', true, opts)).toMatch(/raise trust or autonomy/);
    expect(bearerConfigWriteRefusal('threadline.relayEnabled', true, opts)).toMatch(/raise trust or autonomy/);
  });
});

describe('SEC-163: what stays free', () => {
  it('switching exposure off, narrowing visibility, and a tunnel already on by default', () => {
    const on = { tunnel: { enabled: true }, threadline: { relayEnabled: true, visibility: 'public' }, publishing: { enabled: true } };
    expect(configPatchRaises(on, { tunnel: { enabled: false } })).toEqual([]);
    expect(configPatchRaises(on, { threadline: { relayEnabled: false } })).toEqual([]);
    expect(configPatchRaises(on, { publishing: { enabled: false } })).toEqual([]);
    expect(configPatchRaises(off, { publishing: { enabled: true } })).toEqual([]); // publishing is not judged: it publishes nothing by itself
    expect(configPatchRaises(on, { threadline: { relayEnabled: true, visibility: 'unlisted' } })).toEqual([]);
    expect(configPatchRaises({}, { tunnel: { enabled: true } })).toEqual([]); // already on by default
    expect(configPatchRaises({}, { publishing: { enabled: true } })).toEqual([]);
  });

  it('tuning settings beside the switches', () => {
    expect(configPatchRaises(off, { threadline: { relayEnabled: false, autoAck: false } })).toEqual([]);
  });
});

describe('SEC-163: the owner card can carry exactly the exposure switches', () => {
  it('only the switch leaves of tunnel and threadline are approvable', () => {
    expect(approvableConfigPatch({ tunnel: { enabled: true } })).toBe(true);
    expect(approvableConfigPatch({ threadline: { relayEnabled: true, visibility: 'public' } })).toBe(true);
    expect(approvableConfigPatch({ publishing: { enabled: true } })).toBe(false); // not a raise, so never on a card
    // never a relay address, a tunnel token, a hostname or anything else under those blocks
    expect(approvableConfigPatch({ threadline: { relayEnabled: true, relayUrl: 'wss://x' } })).toBe(false);
    expect(approvableConfigPatch({ tunnel: { enabled: true, token: 'x' } })).toBe(false);
    expect(approvableConfigPatch({ tunnel: { enabled: true, hostname: 'x' } })).toBe(false);
    expect(approvableConfigPatch({ tunnel: 'on' })).toBe(false);
    // the SEC-162 blocks are unchanged
    expect(approvableConfigPatch({ monitoring: { watchdog: { enabled: false } } })).toBe(true);
    expect(approvableConfigPatch({ sessions: { maxSessions: 1 } })).toBe(false);
  });
});

describe('SEC-163: which feature switches are affected', () => {
  it('only switching the relay or the tunnel on asks (the guard-off ones are SEC-162)', () => {
    const needs: string[] = [];
    for (const f of BUILTIN_FEATURES) {
      for (const [dir, action] of [['enable', f.enableAction], ['disable', f.disableAction]] as const) {
        if (!action || action.method !== 'PATCH' || action.path !== '/config') continue;
        // Each switch judged from the state it changes: enable from off, disable from on.
        const from = dir === 'enable'
          ? { ...off, inputGuard: { enabled: false }, responseReview: { enabled: false }, externalOperations: { enabled: false } }
          : { tunnel: { enabled: true }, threadline: { relayEnabled: true }, publishing: { enabled: true }, inputGuard: { enabled: true }, responseReview: { enabled: true }, externalOperations: { enabled: true } };
        if (configPatchRaises(from, action.body as Record<string, unknown>).length > 0) needs.push(`${f.id}:${dir}`);
      }
    }
    expect(needs.sort()).toEqual([
      'cloudflare-tunnel:enable',
      'external-operation-gate:disable', // before SEC-162
      'input-guard:disable', // SEC-162
      'response-review:disable', // SEC-162
      'threadline-relay:enable',
    ].sort());
  });
});

describe('SEC-163: the two direct writers go through the card', () => {
  it('the connect-to-network route and the agent-network tool never switch the relay on by themselves', () => {
    const routes = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes.ts'), 'utf-8');
    const i = routes.indexOf("router.post('/threadline/pairing/enable'");
    expect(routes.slice(i, i + 2500)).toContain('relayNeedsOwnerApproval(');
    const mcp = fs.readFileSync(path.resolve(__dirname, '../../src/threadline/ThreadlineMCPServer.ts'), 'utf-8');
    const j = mcp.indexOf("case 'enable': {");
    expect(mcp.slice(j, j + 2500)).toContain('this.deps.openOwnerApproval');
  });
});
