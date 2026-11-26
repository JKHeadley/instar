/**
 * doorway-scan.mjs prober logic — unit tests (DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC §Testing).
 *
 * Drives the exported pure functions of the deterministic prober directly:
 * clamp/sanitize, the exhaustive scan-state read-funnel + coverage, the P20/L5
 * probeStatus mapping, the asymmetric debounce, the change diff, the zero-doors
 * breaker + backoff, the fail-closed money gate (D8/D9/D10 + pricing staleness +
 * self-standing scheduled refusal), tone-gate-safe attention body + private-view
 * XSS neutralization, and the delivery-robustness baseline planner.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain ESM script, no types
import * as P from '../../scripts/doorway-scan.mjs';

describe('clamp/sanitize (untrusted remote + on-disk values)', () => {
  it('clampModelId keeps a conforming id, drops metachars / oversize', () => {
    expect(P.clampModelId('anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
    expect(P.clampModelId('gpt-5.5')).toBe('gpt-5.5');
    expect(P.clampModelId('evil; rm -rf /')).toBeNull();     // spaces + ;
    expect(P.clampModelId('<script>')).toBeNull();
    expect(P.clampModelId('a'.repeat(200))).toBeNull();      // oversize
    expect(P.clampModelId(123)).toBeNull();
  });

  it('clampDoorId cross-checks the known candidate set + charset', () => {
    expect(P.clampDoorId('codex-cli', ['codex-cli', 'pi-cli'])).toEqual({ id: 'codex-cli', known: true });
    expect(P.clampDoorId('unknown-door', ['codex-cli'])).toEqual({ id: 'unknown-door', known: false });
    expect(P.clampDoorId('<img src=x>', ['codex-cli'])).toBeNull(); // markup dropped
  });

  it('sanitizeChangeText strips control chars, clamps length, and HTML-escapes (private-view sink)', () => {
    const out = P.sanitizeChangeText('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&gt;');
    // control chars removed
    expect(P.sanitizeChangeText('a\u0000b')).toBe('a  b');
  });

  it('escapeHtml neutralizes the XSS-relevant chars', () => {
    expect(P.escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('scan-state read-validation funnel (§1.3) — untrusted-on-every-read', () => {
  it('a well-formed-but-poisoned file is clamped field-by-field on load', () => {
    const poisoned = {
      schemaVersion: 99,
      machineId: 'mac\u0000mini' + 'x'.repeat(500),
      lastScanAt: 'not-a-date',
      scanScope: 'evil-scope',
      consecutiveCompleteFailures: -7,
      doorways: [
        {
          id: 'codex-cli',
          reachable: 'yes',                        // non-boolean → null (unknown)
          probeStatus: 'totally-made-up',          // → malformed-response
          topModels: ['ok-id', 'bad id; rm', '<script>'],
          lastScannedAt: 'nope',
          pendingFlip: { to: false, since: 'x' },  // forged — surfaces nothing without live probe
          changeHistory: [{ ts: 'bad', change: '<img src=x onerror=1>' }],
        },
        { id: '<injection>', reachable: true, probeStatus: 'ok', topModels: [] }, // bad id → dropped
      ],
      surfacedBaseline: { doorways: [{ id: 'pi-cli', probeStatus: 'ok', reachable: true, topModels: [] }], at: '2026-07-03' },
      lastDeliveryFailedAt: 12345,                 // not a string → null
    };
    const s = P.loadScanState(poisoned, { knownCandidates: ['codex-cli', 'pi-cli'] });
    expect(s.schemaVersion).toBe(P.SCAN_STATE_SCHEMA_VERSION);
    expect(s.machineId.length).toBeLessThanOrEqual(P.MACHINE_ID_MAX);
    expect(s.machineId).not.toContain('\u0000');
    expect(s.lastScanAt).toBeNull();
    expect(s.scanScope).toBe('free-probes');
    expect(s.consecutiveCompleteFailures).toBe(0);
    // Door with markup id dropped; only the valid door survives.
    expect(s.doorways).toHaveLength(1);
    const d = s.doorways[0];
    expect(d.id).toBe('codex-cli');
    expect(d.reachable).toBe(null);                // non-boolean is unknown, not down
    expect(d.probeStatus).toBe('malformed-response');
    expect(d.topModels).toEqual(['ok-id']);        // bad ids dropped
    expect(d.lastScannedAt).toBeNull();
    expect(d.changeHistory[0].change).toContain('&lt;img'); // escaped
    expect(s.lastDeliveryFailedAt).toBeNull();
    expect(s.surfacedBaseline.at).toBe('2026-07-03');
  });

  it('a corrupt/unreadable input starts fresh (never crashes)', () => {
    let msg = '';
    const s = P.loadScanState('this is not json at all', { onCorrupt: () => { msg = 'seen'; } });
    // A raw string is treated as an object source; non-JSON path only for file reads,
    // but a non-object still yields a fresh state.
    expect(s.doorways).toEqual([]);
    expect(s.surfacedBaseline.at).toBeNull();
    // and an explicit non-object:
    const s2 = P.loadScanState(null, { onCorrupt: () => { msg = 'seen2'; } });
    expect(s2.doorways).toEqual([]);
    expect(msg).toBe('seen2');
  });

  it('caps changeHistory to the ring-buffer size and every array to ARRAY_CAP', () => {
    const bigHistory = Array.from({ length: 100 }, (_, i) => ({ ts: '2026-07-03', change: `c${i}` }));
    const bigModels = Array.from({ length: 500 }, (_, i) => `m${i}`);
    const s = P.loadScanState(
      { doorways: [{ id: 'pi-cli', probeStatus: 'ok', reachable: true, topModels: bigModels, changeHistory: bigHistory }] },
      { knownCandidates: ['pi-cli'] },
    );
    expect(s.doorways[0].changeHistory.length).toBe(P.CHANGE_HISTORY_CAP);
    expect(s.doorways[0].topModels.length).toBeLessThanOrEqual(P.ARRAY_CAP);
  });

  it('COVERAGE: SCAN_STATE_FIELDS lists every field freshScanState() produces (clamp cannot regrow holes)', () => {
    const fresh = P.freshScanState();
    const topLevel = Object.keys(fresh);
    for (const k of topLevel) {
      expect(P.SCAN_STATE_FIELDS, `scan-state field "${k}" is not in SCAN_STATE_FIELDS — add its clamp + list it`).toContain(k);
    }
    // And loadScanState output keys match freshScanState (no field silently added un-clamped).
    const loaded = P.loadScanState({}, {});
    expect(Object.keys(loaded).sort()).toEqual(topLevel.sort());
  });
});

describe('probeStatus → reachable → diff mapping (P20 + L5, §1.3)', () => {
  it('transient/no-answer → UNKNOWN (null), never wentUnreachable', () => {
    for (const st of ['timeout', 'dns-fail', 'http-5xx', 'not-probed-this-scope', 'not-probed-this-run', 'not-probed-budget-refused']) {
      expect(P.probeStatusToReachable(st)).toBeNull();
    }
  });
  it('definitive unreachable → false (may surface)', () => {
    expect(P.probeStatusToReachable('not-installed')).toBe(false);
    expect(P.probeStatusToReachable('http-4xx')).toBe(false);
  });
  it('parse-drift on a door that answered → stays reachable:true AND is an L5 canary', () => {
    expect(P.probeStatusToReachable('malformed-response')).toBe(true);
    expect(P.probeStatusToReachable('oversize-response')).toBe(true);
    expect(P.isParseDrift('malformed-response')).toBe(true);
    expect(P.isParseDrift('ok')).toBe(false);
  });
});

describe('debounce — asymmetric by direction (§2.3)', () => {
  it('alarming true→false needs TWO scans (first records pendingFlip, surfaces nothing)', () => {
    const first = P.applyDebounce(true, false, null, '2026-07-03');
    expect(first.surfacedUnreachable).toBe(false);
    expect(first.pendingFlip).toEqual({ to: false, since: '2026-07-03' });
    const second = P.applyDebounce(true, false, { to: false, since: '2026-07-03' }, '2026-07-04');
    expect(second.surfacedUnreachable).toBe(true);
    expect(second.effectiveReachable).toBe(false);
  });
  it('recovery false→true flips IMMEDIATELY, un-debounced, surfaces no alarm', () => {
    const r = P.applyDebounce(false, true, { to: false, since: 'x' }, '2026-07-05');
    expect(r.effectiveReachable).toBe(true);
    expect(r.pendingFlip).toBeNull();
    expect(r.surfacedUnreachable).toBe(false);
  });
  it('unknown (null) never flips and clears any pendingFlip', () => {
    const r = P.applyDebounce(true, null, { to: false, since: 'x' }, 'now');
    expect(r.pendingFlip).toBeNull();
    expect(r.surfacedUnreachable).toBe(false);
  });
  it('flip-then-flip-back-before-next-cadence → recovery clears + no false stale (the §2.6 guarantee)', () => {
    // Scan 1: divergent → pendingFlip, not surfaced.
    const s1 = P.applyDebounce(true, false, null, 't1');
    expect(s1.surfacedUnreachable).toBe(false);
    // Scan 2: recovered before corroboration → immediate true, no surface.
    const s2 = P.applyDebounce(true, true, s1.pendingFlip, 't2');
    expect(s2.effectiveReachable).toBe(true);
    expect(s2.surfacedUnreachable).toBe(false);
    // Diff of recovered-observed vs an unchanged last-surfaced (reachable:true) → empty.
    const diff = P.computeDiff(
      [{ id: 'pi-cli', probeStatus: 'ok', topModels: [], surfacedUnreachable: false }],
      [{ id: 'pi-cli', probeStatus: 'ok', topModels: [] }],
    );
    expect(P.isDiffEmpty(diff)).toBe(true);
  });
});

describe('computeDiff — only real changes', () => {
  it('surfaces topModelChanged, wentUnreachable, parseDrift, newDoorways', () => {
    const observed = [
      { id: 'gemini-cli', probeStatus: 'ok', topModels: ['gemini-3.1-pro'], surfacedUnreachable: false },
      { id: 'codex-cli', probeStatus: 'not-installed', topModels: [], surfacedUnreachable: true },
      { id: 'pi-cli', probeStatus: 'malformed-response', topModels: ['x'], surfacedUnreachable: false },
      { id: 'openrouter', probeStatus: 'ok', topModels: [], surfacedUnreachable: false, surfacedNew: true },
    ];
    const lastSurfaced = [
      { id: 'gemini-cli', probeStatus: 'ok', topModels: ['gemini-2.5-pro'] },
      { id: 'codex-cli', probeStatus: 'ok', topModels: [] },
      { id: 'pi-cli', probeStatus: 'ok', topModels: ['x'] },
    ];
    const diff = P.computeDiff(observed, lastSurfaced);
    expect(diff.topModelChanged).toContain('gemini-cli');
    expect(diff.wentUnreachable).toContain('codex-cli');
    expect(diff.parseDrift).toContain('pi-cli');
    expect(diff.newDoorways).toContain('openrouter');
  });
  it('an unchanged scan is empty', () => {
    const same = [{ id: 'pi-cli', probeStatus: 'ok', topModels: ['a'], surfacedUnreachable: false }];
    expect(P.isDiffEmpty(P.computeDiff(same, [{ id: 'pi-cli', probeStatus: 'ok', topModels: ['a'] }]))).toBe(true);
  });
});

describe('zero-doors breaker + backoff (P19/P22, §2.3)', () => {
  it('escalates ONCE at the 3rd consecutive complete failure, not before', () => {
    expect(P.advanceBreaker(0, 0)).toEqual({ consecutiveCompleteFailures: 1, escalate: false });
    expect(P.advanceBreaker(1, 0)).toEqual({ consecutiveCompleteFailures: 2, escalate: false });
    expect(P.advanceBreaker(2, 0)).toEqual({ consecutiveCompleteFailures: 3, escalate: true });
    // stays quiet on further failures (Eternal-Sentinel — deduped elsewhere)
    expect(P.advanceBreaker(3, 0).escalate).toBe(false);
  });
  it('any answered door resets the counter', () => {
    expect(P.advanceBreaker(5, 2)).toEqual({ consecutiveCompleteFailures: 0, escalate: false });
  });
  it('failure backoff widens then caps', () => {
    expect(P.backoffCadencesToSkip(0)).toBe(0);
    expect(P.backoffCadencesToSkip(1)).toBe(0);
    expect(P.backoffCadencesToSkip(3)).toBe(2);
    expect(P.backoffCadencesToSkip(50)).toBe(4);
  });
});

describe('money gate — fail-closed (D8/D9/D10, §2.2)', () => {
  const fresh = '2026-07-03';
  it('free-probes never pays; a metered-only door is skipped, never charged (D8)', () => {
    expect(P.meteredScopeGate({ scope: 'free-probes', isMeteredDoor: true }).reason).toBe('free-scope');
  });
  it('a scheduled session is refused self-standingly, even with marker + cap + price (D10)', () => {
    const v = P.meteredScopeGate({ scope: '+liveness', isScheduledSession: true, manualMarker: true, budgetCapUsd: 5, price: 0.01, priceVerifiedAt: fresh });
    expect(v).toEqual({ permitted: false, reason: 'scheduled-session-refused' });
  });
  it('refuses without the manual marker (D10)', () => {
    expect(P.meteredScopeGate({ scope: '+liveness', manualMarker: false, budgetCapUsd: 5, price: 0.01, priceVerifiedAt: fresh }).reason).toBe('manual-marker-missing');
  });
  it('refuses on absent / zero / negative / non-finite budget (D9)', () => {
    const base = { scope: '+liveness', manualMarker: true, price: 0.01, priceVerifiedAt: fresh };
    expect(P.meteredScopeGate({ ...base }).reason).toBe('budget-absent');
    expect(P.meteredScopeGate({ ...base, budgetCapUsd: 0 }).reason).toBe('budget-nonpositive');
    expect(P.meteredScopeGate({ ...base, budgetCapUsd: -1 }).reason).toBe('budget-nonpositive');
    expect(P.meteredScopeGate({ ...base, budgetCapUsd: Infinity }).reason).toBe('budget-nonpositive');
  });
  it('refuses an unknown/null price even under a positive cap (D9)', () => {
    expect(P.meteredScopeGate({ scope: '+liveness', manualMarker: true, budgetCapUsd: 5, price: null, priceVerifiedAt: fresh }).reason).toBe('price-unknown');
  });
  it('refuses a stale price exactly like an unknown price', () => {
    expect(P.meteredScopeGate({ scope: '+liveness', manualMarker: true, budgetCapUsd: 5, price: 0.01, priceVerifiedAt: '2020-01-01', now: new Date('2026-07-03') }).reason).toBe('price-stale');
  });
  it('refuses when the estimated cost exceeds the cap', () => {
    expect(P.meteredScopeGate({ scope: '+liveness', manualMarker: true, budgetCapUsd: 0.001, price: 5, priceVerifiedAt: fresh, now: new Date('2026-07-03') }).reason).toBe('over-cap');
  });
  it('PERMITS only when marker + positive cap + known, fresh price under cap, non-scheduled', () => {
    expect(P.meteredScopeGate({ scope: '+liveness', manualMarker: true, budgetCapUsd: 5, price: 0.01, priceVerifiedAt: '2026-06-25', now: new Date('2026-07-03') })).toEqual({ permitted: true, reason: 'ok' });
  });
});

describe('attention body + private-view (tone-gate-safe, §2.6)', () => {
  const diff = { newDoorways: [], topModelChanged: ['gemini-cli'], wentStaleOrDeprecated: [], wentUnreachable: ['codex-cli'], parseDrift: [], frontierSuspicions: [] };
  it('body is jargon-safe: no raw path / config key / CLI command', () => {
    const { body } = P.buildAttentionBody(diff, {});
    expect(body).not.toMatch(/scripts\/|\.mjs|\.json|topModels|instar-dev|node /);
  });
  it('NO link without a public tunnel (degrades to a link-free summary — never localhost)', () => {
    const { body, hasLink } = P.buildAttentionBody(diff, { viewId: 'dw-mac' });
    expect(hasLink).toBe(false);
    expect(body).not.toMatch(/localhost|127\.0\.0\.1|http:\/\//);
  });
  it('a public https tunnel yields a bare token-free /view/:id link (no token)', () => {
    const { body, hasLink } = P.buildAttentionBody(diff, { tunnelUrl: 'https://x.trycloudflare.com', viewId: 'dw-mac' });
    expect(hasLink).toBe(true);
    expect(body).toContain('https://x.trycloudflare.com/view/dw-mac');
    expect(body).not.toMatch(/token|auth|bearer|[?]/i);
  });
  it('a localhost tunnel is refused as a link (degrades)', () => {
    const { hasLink } = P.buildAttentionBody(diff, { tunnelUrl: 'http://localhost:4040', viewId: 'dw-mac' });
    expect(hasLink).toBe(false);
  });
  it('private-view markdown HTML-escapes planted markup (stored-XSS neutralized, defense-in-depth at the sink)', () => {
    // Pass RAW markup — the private-view composer escapes at the sink (in addition
    // to the read-funnel escaping changeHistory[].change on load, tested above).
    const md = P.buildPrivateViewMarkdown({ ...P.emptyDiff(), topModelChanged: ['<img src=x onerror=1>'] }, 'mac');
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;img');
  });
});

describe('delivery robustness — baseline planner (§2.6)', () => {
  it('INITIAL SEED: a fresh (never-surfaced) state surfaces NOTHING and seeds, no delivery', () => {
    expect(P.planBaselineAdvance(null, { ...P.emptyDiff(), newDoorways: ['a', 'b'] })).toEqual({ action: 'seed', shouldDeliver: false });
  });
  it('an empty diff after a baseline exists is a no-op', () => {
    expect(P.planBaselineAdvance('2026-07-03', P.emptyDiff())).toEqual({ action: 'noop', shouldDeliver: false });
  });
  it('a non-empty diff after a baseline must be delivered (baseline advances only on 2xx)', () => {
    expect(P.planBaselineAdvance('2026-07-03', { ...P.emptyDiff(), wentUnreachable: ['x'] })).toEqual({ action: 'surface', shouldDeliver: true });
  });
});

describe('parseModelIds — clamp on parse', () => {
  it('parses CLI stdout + drops metachar ids', () => {
    expect(P.parseModelIds('gpt-5.5 gemini-3.1-pro\nbad;id')).toEqual(['gpt-5.5', 'gemini-3.1-pro']);
  });
  it('parses an API list body ({data:[{id}]}) ', () => {
    expect(P.parseModelIds({ data: [{ id: 'anthropic/claude-opus-4-8' }, { id: 'x y' }] })).toEqual(['anthropic/claude-opus-4-8']);
  });
});

describe('network probes — classified probeStatus (injected deps, no real IO)', () => {
  it('probeCliDoor: which fails → not-installed', async () => {
    const r = await P.probeCliDoor({ id: 'codex', probe: { bin: 'codex' } }, { exec: async (f) => { if (f === 'which') throw new Error('not found'); return { stdout: '' }; } });
    expect(r.probeStatus).toBe('not-installed');
  });
  it('probeCliDoor: which ok + --version ok → ok', async () => {
    const r = await P.probeCliDoor({ id: 'claude', probe: { bin: 'claude' } }, { exec: async () => ({ stdout: '1.2.3' }) });
    expect(r.probeStatus).toBe('ok');
  });
  it('probeCliDoor: a model-list subcommand → ok + parsed ids', async () => {
    const r = await P.probeCliDoor(
      { id: 'gemini', probe: { bin: 'gemini', listArgs: ['models', 'list'] } },
      { exec: async (f, a) => (Array.isArray(a) && a[0] === 'models' ? { stdout: 'gemini-3.1-pro gemini-2.5-pro' } : { stdout: '' }) },
    );
    expect(r.probeStatus).toBe('ok');
    expect(r.topModels).toContain('gemini-3.1-pro');
  });
  it('probeCliDoor: a killed (timeout) exec → timeout', async () => {
    const r = await P.probeCliDoor({ id: 'x', probe: { bin: 'x' } }, { exec: async (f) => { if (f === 'which') return { stdout: '/x' }; const e = new Error('t'); e.killed = true; throw e; } });
    expect(r.probeStatus).toBe('timeout');
  });
  it('probeHttpModelListDoor: 404 → http-4xx; 503 → http-5xx', async () => {
    const d = { probe: { listUrl: 'https://api/models' } };
    expect((await P.probeHttpModelListDoor(d, { fetch: async () => ({ status: 404 }) })).probeStatus).toBe('http-4xx');
    expect((await P.probeHttpModelListDoor(d, { fetch: async () => ({ status: 503 }) })).probeStatus).toBe('http-5xx');
  });
  it('probeHttpModelListDoor: ok json → ok + ids; oversize body → oversize-response', async () => {
    const d = { probe: { listUrl: 'https://api/models' } };
    const ok = await P.probeHttpModelListDoor(d, { fetch: async () => ({ status: 200, text: async () => JSON.stringify({ data: [{ id: 'gpt-5.5' }] }) }) });
    expect(ok.probeStatus).toBe('ok');
    expect(ok.topModels).toContain('gpt-5.5');
    const big = 'x'.repeat(P.RESPONSE_SIZE_CAP_BYTES + 10);
    const over = await P.probeHttpModelListDoor(d, { fetch: async () => ({ status: 200, text: async () => big }) });
    expect(over.probeStatus).toBe('oversize-response');
  });
  it('probeHttpModelListDoor: an aborted fetch → timeout; a header value is used but never echoed', async () => {
    const d = { probe: { listUrl: 'https://api/models' } };
    let seenHeader;
    const to = await P.probeHttpModelListDoor(d, {
      authHeaderValue: 'Bearer SECRET',
      fetch: async (_u, opts) => { seenHeader = opts.headers.Authorization; const e = new Error('a'); e.name = 'AbortError'; throw e; },
    });
    expect(to.probeStatus).toBe('timeout');
    expect(seenHeader).toBe('Bearer SECRET');       // used in-process header only
    expect(JSON.stringify(to)).not.toContain('SECRET'); // never in the result
  });
});
