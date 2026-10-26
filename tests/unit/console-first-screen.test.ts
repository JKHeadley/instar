/**
 * The operator's first-screen rule, enforced over the SHIPPED console in jsdom:
 * "Everything in the immediate view on each page should be ONLY what the user needs
 * to see or would find helpful. All other details should be hidden by default and only
 * shown if the user dives in deeper."
 *
 * For every page this boots console.js against fixture routes that make the page render
 * in its ordinary (not failed) mode, takes the text the operator would see WITHOUT a tap
 * (closed <details> bodies, hidden nodes and sheets excluded), and asserts that the
 * strings the four-perspective QA review listed under "first-screen items to remove"
 * are gone. It also checks that no headline is a raw 32-hex id and that hub pages carry
 * no "Now inside …" pointer tiles.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (min: number) => iso(NOW - min * 60_000);
const FP = 'd5d07ce5f9b199abac3a90ea3c90d269'; // an unpaired, history-only contact: never a headline
const PP = '0123456789abcdef0123456789abcdef';

const machines = [
  { machineId: 'm1', nickname: 'Mac Studio', isSelf: true, online: true, routerReceivedAt: ago(0), loadAvg: 2, hardware: { cpuCores: 16, cpuModel: 'Apple M4 Max', totalMemBytes: 64 * 2 ** 30, instarVersion: '1.3.1446' } },
  { machineId: 'm2', nickname: 'Mama PC', online: true, routerReceivedAt: ago(0), loadAvg: 1, hardware: { cpuCores: 8 } },
];
const promise = (over: Record<string, unknown>) => ({ id: 'CMT-1', status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: ago(60), agentResponse: 'I will report back.', ...over });
const session = (over: Record<string, unknown>) => ({ id: 'u1', name: 'echo-fix', tmuxSession: 'echo-fix', status: 'running', startedAt: ago(40), model: 'opus', platform: 'telegram', machineId: 'm1', machineNickname: 'Mac Studio', telemetry: { lastActivity: ago(1), toolsUsed: [], eventCount: 1, subagentsSpawned: [] }, ...over });
const job = (over: Record<string, unknown>) => ({ slug: 'git-sync', name: 'Git sync', description: 'Sync', schedule: '0 */4 * * *', priority: 'medium', enabled: true, execute: { type: 'skill', value: 'git-sync' }, origin: 'instar', runsOnThisMachine: true, state: { slug: 'git-sync', lastRun: ago(120), lastResult: 'success', nextScheduled: iso(NOW + 7200_000), consecutiveFailures: 0 }, ...over });
const guard = (key: string, effective = 'off') => ({ key, effective, offClass: effective === 'off' ? 'diverged-from-default' : null, loadBearing: false });

const ROUTES: Record<string, { status?: number; body: unknown }> = {
  '/sessions': { body: { sessions: [] } },
  '/health': { body: { project: { name: 'echo' }, telegramOrigin: { heldForward: { count: 0, observedAt: NOW, expiredUnreported: 0 } }, multiMachine: { syncStatus: { ropeHealth: [] } } } },
  '/pool': { body: { enabled: true, selfMachineId: 'm1', router: { holder: 'm1' }, machines } },
  '/attention?scope=pool': { body: { items: [{ id: 'agent:echo-disk-cleanup-2026-10-23', title: 'Clean up 51 reap-eligible worktrees (~27 GB) on thread 5b0959f4 after Justin approves attention item agent:echo-disk-cleanup-2026-10-23', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: ago(30), description: 'the long story' }], pool: { failed: [{ machineId: 'm2', nickname: 'Mama PC' }] } } },
  '/commitments?scope=mesh': { body: { enabled: true, scope: 'mesh', commitments: [
    promise({ id: 'CMT-2', owner: 'user', blockedOn: 'user-authorization', agentResponse: 'Told Dawn (thread-3e84d9ed) I will report when the pairing reads mutual-verified (21:03Z 2026-10-25); merge PR 2350 only after Justin confirms in topic 9210.' }),
    promise({ id: 'CMT-3', status: 'violated', agentResponse: 'Changing the schedule now' }),
    promise({ id: 'CMT-4', viewSource: 'replica', originMachineId: 'm2', stalenessMs: 20 * 60_000 }),
  ] } },
  '/sessions?scope=pool': { body: { sessions: [session({}), session({ id: 'u2', name: 'feedback-feedback-b26e90ab-3a37-4-828b1f71-a2', tmuxSession: 'feedback-feedback-b26e90ab-3a37-4-828b1f71-a2', platform: null })], pool: { enabled: true, selfMachineId: 'm1', selfMachineNickname: 'Mac Studio', machines, failed: [], duplicateTopics: [] } } },
  '/guards': { body: { summary: { onConfirmed: 70, onUnverified: 2, onStale: 0, onBlind: 0, onDryRun: 5, offDeviant: 8, offDarkDefault: 15, offRuntimeDivergent: 0, errored: 0, missing: 0, loadBearingGapKeys: ['x'] }, guards: [guard('models.tierEscalation.dryRun'), guard('monitoring.greenPrAutoMerge.enabled')] } },
  '/guards?scope=pool': { body: { machineId: 'm1', nickname: 'Mac Studio', guards: [guard('models.tierEscalation.dryRun'), guard('monitoring.greenPrAutoMerge.enabled'), guard('scheduler.enabled', 'on-confirmed')], machines: [] } },
  '/mandate': { body: { mandates: [] } },
  '/mandate/audit?limit=200': { body: { entries: [], chain: { ok: true }, total: 0 } },
  '/authorization-requests?status=pending': { body: { requests: [] } },
  '/permissions/users': { body: { users: [] } },
  '/threadline/health': { body: { status: 'ok', relay: { state: 'connected', recoverable: true }, fingerprint: 'ab'.repeat(16), mutualVerifiedCount: 1 } },
  '/threadline/pairing': { body: { pairings: [{ peerFp: PP, peerName: 'PP', state: 'mutual-verified', verifiedAt: ago(500) }, { peerFp: 'c'.repeat(32), peerName: 'b2lead', state: 'pending-verification' }] } },
  '/threadline/pairing/invites': { body: { invites: [], pendingAccepts: [], knownPeers: [{ fp: PP, name: 'PP' }], restartNotices: [] } },
  '/threadline/peers/health?scope=pool': { body: { peers: [
    { peerFp: PP, peerName: 'PP', lastSentAt: ago(4), lastAckedAt: ago(4), lastInboundAt: ago(30), pendingCount: 0, lastRelayStatus: 'delivered', stale: false, dark: false, queuedCount: 0, connectedNow: true, connectedAsOf: ago(2) },
    { peerFp: FP, lastSentAt: ago(15 * 24 * 60), lastAckedAt: null, lastInboundAt: null, pendingCount: 1, lastRelayStatus: 'queued', stale: false, dark: true, darkSince: ago(15 * 24 * 60), queuedCount: 1, connectedNow: false },
  ], pool: { failed: [{ machineId: 'm2' }] } } },
  '/threadline/conversations?scope=mesh': { body: { scope: 'mesh', conversations: [{ kind: 'own', conversationId: 'thread-x', peerFingerprint: FP, holderMachineId: 'm1', status: 'open', stalenessMs: 0 }] } },
  '/threadline/observability/threads': { body: { threads: [] } },
  '/telegram/origins/status': { status: 403, body: { error: 'operator session required' } },
  '/telegram/origin-display': { status: 403, body: { error: 'operator session required' } },
  '/secrets/pending': { body: { pending: [] } },
  '/self-knowledge/session-context?full=1': { body: { names: ['openai_api_key'], factCount: 0, vaultState: 'ok' } },
  '/secrets/sync-status': { body: { mode: 'full', syncTargets: [{ machineId: 'm2', nickname: 'Mama PC', reachable: true }] } },
  '/telegram/topics': { body: { topics: [] } },
  '/autonomy': { body: { profile: 'autonomous', resolved: { autoApplyUpdates: true, autoRestart: true, trustAutoElevate: true }, availableProfiles: [] } },
  '/autonomy/history': { body: { history: [] } },
  '/features': { body: { features: [] } },
  '/preferences': { body: { scope: 'mesh', entries: [{ learning: 'The user wants focused dashboard summaries.', confidence: 0.8, dedupeCount: 2, recordedAt: ago(10), dedupeKey: 'k1' }], total: 1 } },
  '/corrections?limit=20': { body: { records: [{ id: 'c1', kind: 'user-preference', status: 'open', occurrenceCount: 1, scrubbedSummary: 'The user prefers the dashboard theme to match the main site.', detectedAt: ago(5), updatedAt: ago(5) }], count: 1, totalRecords: 1, nextBefore: null } },
  '/state/conflicts': { status: 503, body: { error: 'off' } },
  '/api/files/config': { body: { enabled: true, allowedPaths: ['./'], editablePaths: ['./'] } },
  '/api/files/list?path=': { body: { path: '', entries: [{ name: '.git', type: 'directory' }, { name: '.claude', type: 'directory' }, { name: 'node_modules', type: 'directory' }, { name: 'docs', type: 'directory' }, { name: 'CLAUDE.md', type: 'file', size: 90 }] } },
  '/jobs': { body: { jobs: [job({}), job({ slug: 'off-job', name: 'Off job', enabled: false })], queue: [] } },
  '/jobs?scope=pool': { body: { jobs: [job({ machineId: 'm1' }), job({ slug: 'off-job', name: 'Off job', enabled: false, machineId: 'm1' })], count: 2, pool: { enabled: true, selfMachineId: 'm1', peersQueried: 0, peersOk: 0, failed: [] } } },
  '/jobs/history?limit=500': { body: { runs: [], total: 0, stats: [] } },
  '/jobs/migration-status': { body: { hasLegacyJobsJson: false, hasMigrationComplete: true, canConfirm: false, canAbandon: false, scheduleEntryCount: 0 } },
  '/jobs/reconcile': { body: { findings: [], summary: { total: 0, byKind: {} } } },
  '/systems/status': { body: { activeCapabilities: [{ label: 'Session Recovery', status: 'active', metric: '5 recovered · 21481 interventions' }, { label: 'Safety & Trust', status: 'active', metric: 'All gates active' }], issues: [] } },
  '/resources/summary?sinceHours=1': { body: { sources: [{ source: 'aggregate', currentCpuPercent: 25, currentRssBytes: 12e9, peakCpuPercent: 110 }, { source: 'session:u1', currentCpuPercent: 77, currentRssBytes: 3e8 }] } },
};

/** What the page shows without a tap: closed folds, hidden nodes and any sheet are left out. */
function firstScreenText(root: Element): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) { out.push(n.textContent || ''); return; }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (e.hasAttribute('hidden') || e.classList.contains('sheet-root') || e.tagName === 'SCRIPT' || e.tagName === 'STYLE') return;
    if (e.tagName === 'DETAILS' && !e.hasAttribute('open')) { const s = e.querySelector(':scope > summary'); if (s) out.push(s.textContent || ''); return; }
    for (const k of e.childNodes) walk(k);
  };
  walk(root);
  return out.join(' ').replace(/\s+/g, ' ');
}

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 25));

async function open(hash: string) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://localhost:4040/dashboard/console/${hash}` });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
  g.WebSocket = class { readyState = 0; constructor() { setTimeout(() => { (this as unknown as { onclose?: () => void }).onclose?.(); }, 0); } send() {} close() {} };
  dom.window.localStorage.setItem('instar_token', 't');
  g.fetch = async (url: string) => {
    const r = ROUTES[url];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) } as unknown as Response;
    const status = r.status || 200;
    return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(r.body)) } as unknown as Response;
  };
  vi.resetModules();
  await import('../../dashboard/console/console.js');
  for (let i = 0; i < 16; i++) await flush();
  return dom.window.document;
}
afterEach(() => { dom?.window.close(); });

// Page → the review's "first-screen items to remove" (must not appear without a tap).
const FORBIDDEN: Record<string, string[]> = {
  '#/home': ['partial', 'Some machines may not be shown', 'This is the new Instar console', 'thread-3e84d9ed', 'agent:echo-disk-cleanup', '(21:03Z', 'Checked on this machine'],
  '#/work': ['Each of these opens in the dashboard', 'This is the new Instar console', 'Now inside'],
  '#/capacity': ['Each of these opens in the dashboard', 'This is the new Instar console', 'Now inside'],
  '#/people': ['Each of these opens in the dashboard', 'This is the new Instar console', 'Now inside'],
  '#/settings': ['Each of these opens in the dashboard', 'This is the new Instar console', 'Now inside', 'This looks like a development agent', 'This only decides what this browser shows'],
  '#/people/agents': ['No delivery records from', 'Started with the old word check', FP, 'History only'],
  '#/people/mandates': ['every agent-to-agent action is refused', 'intact', 'people with grants', 'Record intact', 'mandates'],
  '#/work/promises': ['Includes', "Only this machine's promises", 'not represented', 'thread-3e84d9ed'],
  '#/capacity/machines': ['last evidence just now', 'no load reading', 'Identity reviews and SSH pairing'],
  '#/work/sessions': ['version not recorded', 'feedback-feedback-b26e90ab-3a37-4-828b1f71-a2', 'model not recorded'],
  '#/people/messages': ['From the quick check', 'One unlock lasts', 'Who wrote each message is private'],
  '#/people/secrets': ['Once someone submits', 'Each machine keeps its own', 'Sends my keys', 'When the agent needs a password'],
  '#/settings/allowed': ['Models tier Escalation', 'Green Pr Auto', 'I ask before raising my own trust', 'Cautious', 'Supervised', 'Collaborative', 'Updates install themselves'],
  '#/settings/learned': ['The user ', 'Includes what my other machines', 'These are signals', 'twice'],
  '#/settings/files': ['Each machine has its own', '.git', '.claude', 'node_modules'],
  '#/work/schedule': ['1 off', '0 running', 'Jobs across'],
};

describe('first-screen rule over the shipped console (jsdom)', () => {
  for (const [hash, words] of Object.entries(FORBIDDEN)) {
    it(`${hash}: none of the review's first-screen items is visible without a tap`, async () => {
      const doc = await open(hash);
      const main = doc.querySelector('#main')!;
      expect(main, 'the page rendered').not.toBeNull();
      const text = firstScreenText(main);
      expect(text.length, 'the page has content').toBeGreaterThan(40);
      for (const w of words) expect(text, `"${w}" must not be on the first screen of ${hash}`).not.toContain(w);
      // Headlines name things; a raw 32-hex id is never a headline.
      for (const h of doc.querySelectorAll('h1, .page-title, .need-title, .card-value')) expect(h.textContent).not.toMatch(/[0-9a-f]{32}/i);
    });
  }

  it('hub pages have no "Now inside" tiles, keep one quiet legacy link, and the moved tabs are one tap away', async () => {
    for (const hash of ['#/work', '#/capacity', '#/people', '#/settings']) {
      const doc = await open(hash);
      const tiles = [...doc.querySelectorAll('a.tile .t-desc')].map((n) => n.textContent || '');
      expect(tiles.some((d) => /^Now /.test(d)), `${hash} shows a pointer tile`).toBe(false);
      expect(doc.querySelectorAll('a[href="/dashboard"]').length, `${hash} keeps a legacy link`).toBeGreaterThan(0);
      expect(doc.querySelector('.moved-link')).not.toBeNull();
      (doc.querySelector('.moved-link') as HTMLButtonElement).click();
      expect(doc.querySelectorAll('.sheet a.moved-row').length).toBeGreaterThan(0);
      dom.window.close();
    }
  });

  it('what moved behind a tap is still there: coverage, explanations, ids and the chooser open on demand', async () => {
    let doc = await open('#/work/promises');
    expect(doc.querySelector('.more-fold')!.textContent).toContain('out of date');
    dom.window.close();
    doc = await open('#/people/agents');
    expect(doc.querySelector('#sec-others')!.querySelector('button.list-head')!.getAttribute('aria-expanded')).toBe('false');
    expect(doc.querySelector('.more-fold')!.textContent).toContain('No delivery records from Mama PC');
    expect(doc.querySelector('.page-title')!.textContent).toBe('2 agents, 1 answered recently.'); // PP and the unfinished b2lead pairing; the history-only fingerprint is not counted
    dom.window.close();
    doc = await open('#/settings/allowed');
    expect(doc.querySelector('.profile-now .profile-level')!.textContent).toBe('Autonomous');
    (doc.querySelector('[data-change-profile]') as HTMLButtonElement).click();
    expect(doc.querySelectorAll('.sheet .seg-step')).toHaveLength(4);
    expect([...doc.querySelectorAll('#sec-guards-look .row-title')].map((n) => n.textContent)).toEqual(['Model escalation (watch-only mode)', 'Green PR auto-merge']);
    dom.window.close();
    doc = await open('#/settings/learned');
    expect(doc.querySelector('.pref-quote')!.textContent).toBe('“You want focused dashboard summaries.”');
    expect(doc.querySelector('#sec-watching .row-title')!.textContent).toBe('You prefer the dashboard theme to match the main site.');
    dom.window.close();
    doc = await open('#/home');
    const needs = doc.querySelector('#card-needs')!;
    for (const t of needs.querySelectorAll('.row-title')) expect(t.textContent).not.toMatch(/thread-|agent:|\d{2}:\d{2}Z/);
    const details = [...needs.querySelectorAll('.row-detail')].map((d) => d.textContent).join('\n');
    expect(details).toContain('thread-3e84d9ed'); // the original text, behind the tap
    expect(details).toContain('agent:echo-disk-cleanup-2026-10-23');
    expect(needs.querySelector('.card-age')!.textContent).not.toContain('partial');
    expect(doc.querySelector('#card-promised .card-age')!.textContent).not.toContain('failing');
  });
});
