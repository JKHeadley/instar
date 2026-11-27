/**
 * ProjectAppCustomSource — the real CustomAppSource (docs/specs/project-apps-sandbox.md §3.1-3.5,
 * §3.7) over in-memory journals, a real WorkBoardService, a real key file and disk blob store.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeHarness, phoneApprove, PROJECT, CONVERGED_SPEC, DRAFT_SPEC, OWNER } from '../helpers/projectAppCustomHarness.js';
import { checkAppVersion, checkSpecConverged, HMAC_SLOT_APP_ID, cardNoteText, isPhoneOnlyCard, CARD_NOTE_MAX } from '../../src/server/ProjectAppCustomSource.js';
import { versionCardId, buildVersionCard, buildKeyRevoked } from '../../src/core/ProjectAppCustomFold.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { cardJson, APP_STOPPED_LINE } from '../../src/core/workBoardViews.js';
import { ProjectAppKeyStore } from '../../src/core/ProjectAppKeys.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ProjectAppCustomSource.test.ts' }); });

const HTML1 = '<!doctype html><title>Pipeline</title><p>v1 of the sales pipeline</p>';
const HTML2 = '<!doctype html><title>Pipeline</title><p>v2 of the sales pipeline</p>';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function created(h = makeHarness({ dirs })) {
  const r = h.source.createApp({ conversationKey: PROJECT, title: 'Sales pipeline', specPath: CONVERGED_SPEC });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { h, appId: r.appId };
}

describe('ProjectAppCustomSource — creating an app', () => {
  it('mints pa_ + 16 hex for a bound project with a converged spec, and refuses the rest', () => {
    const h = makeHarness({ dirs, limits: { maxApps: 2 } });
    const ok = h.source.createApp({ conversationKey: PROJECT, title: 'Sales pipeline', specPath: CONVERGED_SPEC });
    expect(ok).toMatchObject({ ok: true });
    expect((ok as { appId: string }).appId).toMatch(/^pa_[0-9a-f]{16}$/);
    expect((ok as { appId: string }).appId).not.toBe(HMAC_SLOT_APP_ID);
    expect(h.source.createApp({ conversationKey: 'telegram:1', title: 'x', specPath: CONVERGED_SPEC })).toMatchObject({ status: 404, error: 'unknown-project' });
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'x', specPath: DRAFT_SPEC })).toMatchObject({ status: 409, error: 'app-spec-not-converged' });
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'x', specPath: 'outside.md' })).toMatchObject({ status: 400, error: 'bad-spec-path' });
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'x', specPath: 'docs/specs/../../outside.md' })).toMatchObject({ error: 'bad-spec-path' });
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'x'.repeat(61), specPath: CONVERGED_SPEC })).toMatchObject({ status: 400, error: 'bad-title' });
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'Two', specPath: CONVERGED_SPEC })).toMatchObject({ ok: true });
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'Three', specPath: CONVERGED_SPEC })).toMatchObject({ status: 409, error: 'too-many-apps' });
    expect(h.source.apps().map((a) => a.title).sort()).toEqual(['Sales pipeline', 'Two']);
  });

  it('a spec symlinked out of docs/specs is refused (realpath confinement)', () => {
    const h = makeHarness({ dirs });
    fs.symlinkSync(path.join(h.dir, 'outside.md'), path.join(h.dir, 'docs', 'specs', 'link.md'));
    expect(checkSpecConverged(h.dir, 'docs/specs/link.md')).toMatchObject({ ok: false, error: 'bad-spec-path' });
    expect(checkSpecConverged(h.dir, CONVERGED_SPEC)).toEqual({ ok: true, specPath: CONVERGED_SPEC });
  });

  it('only the lease holder writes; elsewhere the refusal names the holder', () => {
    const h = makeHarness({ dirs });
    h.lease.holds = false; h.lease.holder = 'm_mini';
    expect(h.source.createApp({ conversationKey: PROJECT, title: 'Sales', specPath: CONVERGED_SPEC })).toMatchObject({ status: 409, error: 'not-lease-holder', holder: 'm_mini' });
  });
});

describe('ProjectAppCustomSource — source, the version card and the served version', () => {
  it('a source write opens exactly one card, sends one notice, and nothing serves until the owner\'s phone approves', () => {
    const { h, appId } = created();
    const w = h.source.writeSource(appId, HTML1, 'First version: ten made-up deals');
    expect(w).toMatchObject({ ok: true, contentSha: sha(HTML1), card: { state: 'opened', cardId: versionCardId(appId, 'serve') } });
    const card = h.svc.view(versionCardId(appId, 'serve'))!.card;
    expect(card.title).toBe('Run Sales pipeline new version for Example: sales pipeline?');
    expect(card.need).toContain('First version: ten made-up deals');
    expect(card.need).toContain(`For support: app ${appId}, version ${sha(HTML1)}, request 1`);
    // The record keeps outward (it is what makes the card need its own approve under every policy);
    // the display drops the outward wording for phone-only cards (see the cardJson test below).
    expect(card.outward).toBe(true);
    expect(card.doneWhen).toEqual([{ id: 'approved', text: 'You approved this version on your phone', certify: 'agent-may-certify' }]);
    expect(card.carrier).toEqual({ personKey: OWNER });
    expect(h.source.isVersionCard(versionCardId(appId, 'serve'))).toBe(true);
    expect(h.notices).toHaveLength(1);
    expect(h.source.servedVersion(appId)).toEqual({ state: 'none' });

    // The same content again: no new card generation, no notice.
    const again = h.source.writeSource(appId, HTML1, 'same');
    expect(again).toMatchObject({ ok: true, card: { state: 'none' } });

    // A PIN (console) approve never serves.
    expect(phoneApprove(h, versionCardId(appId, 'serve'), 'pin')).toMatchObject({ ok: true });
    expect(h.source.servedVersion(appId).state).toBe('none');

    const e0 = h.source.epoch(appId);
    expect(phoneApprove(h, versionCardId(appId, 'serve'))).toMatchObject({ ok: true });
    expect(h.source.servedVersion(appId)).toEqual({ state: 'served', contentSha: sha(HTML1), html: HTML1 });
    expect(h.source.epoch(appId)).toBeGreaterThan(e0);
  });

  it('a newer version rewrites the one card (no second notice); the old version keeps running until the rewrite is approved', () => {
    const { h, appId } = created();
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, versionCardId(appId, 'serve'));
    expect(h.source.servedVersion(appId)).toMatchObject({ state: 'served', contentSha: sha(HTML1) });
    const w2 = h.source.writeSource(appId, HTML2, 'v2: adds a stage column');
    expect(w2).toMatchObject({ ok: true, card: { state: 'rewritten' } });
    expect(h.notices).toHaveLength(1);
    expect(h.svc.cardIds().filter((id) => id === versionCardId(appId, 'serve'))).toHaveLength(1);
    expect(h.source.servedVersion(appId)).toMatchObject({ contentSha: sha(HTML1) });
    const e1 = h.source.epoch(appId);
    phoneApprove(h, versionCardId(appId, 'serve'));
    expect(h.source.servedVersion(appId)).toEqual({ state: 'served', contentSha: sha(HTML2), html: HTML2 });
    expect(h.source.epoch(appId)).toBeGreaterThan(e1);
  });

  it('a withdraw-approval tap from any surface stops the app and bumps the epoch', () => {
    const { h, appId } = created();
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, versionCardId(appId, 'serve'));
    const e = h.source.epoch(appId);
    h.svc.tap({ kind: 'person', personKey: OWNER, proof: 'pin', isOwner: true }, versionCardId(appId, 'serve'), { action: 'withdraw-approval' });
    h.source.invalidate();
    expect(h.source.servedVersion(appId)).toEqual({ state: 'disabled' });
    expect(h.source.epoch(appId)).toBeGreaterThan(e);
  });

  it('source chunks are stored encrypted, in the journal and in the disk store; another reader serves from them', () => {
    const { h, appId } = created();
    // A long plaintext sentinel: a short needle like 'v1' turns up in random ciphertext/ids by chance.
    const NOTE_SENTINEL = 'change-note-sentinel-QZX-must-never-appear-in-plaintext';
    h.source.writeSource(appId, HTML1, NOTE_SENTINEL);
    phoneApprove(h, versionCardId(appId, 'serve'));
    const journal = JSON.stringify(h.blobs) + JSON.stringify(h.records);
    expect(journal).not.toContain('sales pipeline');
    expect(journal).not.toContain(NOTE_SENTINEL);
    const disk = path.join(h.stateDir, 'state', 'project-app-blobs', appId, 'source');
    const files = fs.readdirSync(path.join(disk, '1'));
    expect(files).toEqual([sha(HTML1)]);
    expect(fs.readFileSync(path.join(disk, '1', files[0])).toString('latin1')).not.toContain('sales pipeline');
    // A fresh reader (another boot) with the journal's chunks removed still serves from the disk store.
    const chunklessBlobs = h.blobs.filter((e) => e.data.recordType !== 'project-app-chunk');
    const reader = h.rebuild({ loadBlobs: () => chunklessBlobs });
    expect(reader.servedVersion(appId)).toMatchObject({ state: 'served', html: HTML1 });
    // Without the key (a machine the key fetch has not reached), the version is reported as still copying.
    const keyless = h.rebuild({ stateDir: path.join(h.dir, 'other-machine') });
    expect(keyless.servedVersion(appId)).toEqual({ state: 'copying' });
  });

  it('per-write size: a source over the limit answers 413 naming it', () => {
    const { h, appId } = created(makeHarness({ dirs, limits: { sourceBytes: 100 } }));
    expect(h.source.writeSource(appId, '<p>' + 'x'.repeat(200) + '</p>', 'big')).toMatchObject({ status: 413, error: 'too-large', limit: 100 });
  });
});

describe('ProjectAppCustomSource — the version card closes once the phone\'s approve serves it', () => {
  const OWNER_VIEW = { personKey: OWNER, isOwner: true, isAgent: false };
  const json = (h: ReturnType<typeof makeHarness>, cardId: string) => cardJson(h.svc, h.svc.view(cardId)!, OWNER_VIEW, (k) => k, { phoneOnly: h.source.isVersionCard(cardId) });

  it('approve → done and out of Needs you; v2 → needs approval again; v2 approve → done again', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    expect(h.svc.view(cardId)!.status).toBe('needs-approval');
    expect(json(h, cardId)).toMatchObject({ lane: 'waiting-on-you', needLine: 'Approve this version on your phone to run it', outward: false, outwardWords: null });
    expect(JSON.stringify(json(h, cardId))).not.toContain('before the agent starts');
    // An ordinary card (no phone-only signal) keeps the Work Board's own words.
    expect(cardJson(h.svc, h.svc.view(cardId)!, OWNER_VIEW, (k) => k)).toMatchObject({ needLine: 'Needs your approval before the agent starts', outward: true });
    // Nothing to close before the approve.
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });

    phoneApprove(h, cardId);
    expect(h.svc.view(cardId)!.status).toBe('with-person'); // approved, served, not yet closed
    expect(h.source.settleApprovedCards()).toEqual({ closed: [cardId], refused: [] });
    let v = h.svc.view(cardId)!;
    expect(v.status).toBe('done');
    expect(v.card.done).toBe(true);
    expect(v.card.needsConfirm).toBe(false);
    expect(v.card.evidence.map((e) => e.text)).toEqual(['Approved on your phone; this version is now running.']);
    expect(v.card.workable).toBe(false); // carried by the owner: no agent pickup, ever
    expect(v.pickups).toEqual([]);
    expect(json(h, cardId)).toMatchObject({ lane: 'done', needLine: 'Approved on your phone; this version is running' });
    expect(h.svc.lane(v, { isOwner: true, personKey: OWNER })).toBe('done');

    // Idempotent: a second pass (and a rebuilt source) writes nothing.
    const n = h.board.length;
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    h.source.invalidate();
    expect(h.rebuild().settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect(h.board.length).toBe(n);

    // v2 rewrites the finished card: it needs approval again; v1 keeps running.
    const w2 = h.source.writeSource(appId, HTML2, 'v2');
    expect(w2).toMatchObject({ ok: true, card: { state: 'rewritten', cardId } });
    h.source.invalidate();
    v = h.svc.view(cardId)!;
    expect(v.status).toBe('needs-approval');
    expect(v.card.done).toBe(false);
    expect(json(h, cardId)).toMatchObject({ lane: 'waiting-on-you', needLine: 'Approve this version on your phone to run it' });
    expect(h.source.servedVersion(appId)).toMatchObject({ contentSha: sha(HTML1) });
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });

    phoneApprove(h, cardId);
    expect(h.source.servedVersion(appId)).toMatchObject({ state: 'served', contentSha: sha(HTML2) });
    expect(h.source.settleApprovedCards()).toEqual({ closed: [cardId], refused: [] });
    v = h.svc.view(cardId)!;
    expect(v.status).toBe('done');
    expect(v.card.needsConfirm).toBe(false);
    expect(json(h, cardId)).toMatchObject({ lane: 'done' });
  });

  it('"Stop this app": the card says it was stopped (no restart in this build), leaves Needs you, and the closer never writes "running"', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId);
    expect(h.source.settleApprovedCards().closed).toEqual([cardId]);
    expect(h.source.stoppedServeCard(cardId)).toBe(false);
    expect(h.svc.isStoppedAppCard(cardId)).toBe(false);

    h.svc.tap({ kind: 'person', personKey: OWNER, proof: 'pin', isOwner: true }, cardId, { action: 'withdraw-approval' });
    h.source.invalidate();
    expect(h.source.servedVersion(appId)).toEqual({ state: 'disabled' });
    expect(h.source.stoppedServeCard(cardId)).toBe(true);
    expect(h.svc.isStoppedAppCard(cardId)).toBe(true);
    const v = h.svc.view(cardId)!;
    expect(v.status).toBe('needs-approval'); // the Work Board's own fold is unchanged
    expect(h.svc.lane(v, { isOwner: true, personKey: OWNER })).toBe('done');
    expect(h.svc.waitingOnOwnerCount()).toBe(0);
    expect(json(h, cardId)).toMatchObject({ lane: 'done', needLine: APP_STOPPED_LINE, appStopped: true });
    expect(JSON.stringify(json(h, cardId))).not.toContain('Approve this version');
    // Without the phone-only signal the card is an ordinary one (no app words).
    expect(cardJson(h.svc, v, OWNER_VIEW, (k) => k)).not.toHaveProperty('appStopped');

    // An approve recorded past the route (a stale phone): the card reads approved again, but the app is
    // still off, so the closer finishes nothing and nothing says it is running.
    phoneApprove(h, cardId);
    expect(h.source.servedVersion(appId)).toEqual({ state: 'disabled' });
    const n = h.board.length;
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect(h.board.length).toBe(n);
    expect(json(h, cardId)).toMatchObject({ needLine: APP_STOPPED_LINE, lane: 'done' });
  });

  it('stoppedServeCard is false for an unknown card, a running app and a never-approved app', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    expect(h.source.stoppedServeCard('wc_0000000000000000')).toBe(false);
    h.source.writeSource(appId, HTML1, 'v1');
    expect(h.source.stoppedServeCard(cardId)).toBe(false);
    expect(h.svc.lane(h.svc.view(cardId)!, { isOwner: true, personKey: OWNER })).toBe('waiting-on-you');
  });

  it('a failing stopped-app check leaves the card where the Work Board folds it, and is logged', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    h.svc.setStoppedAppCardCheck(() => { throw new Error('fold unreadable'); });
    expect(h.svc.isStoppedAppCard(cardId)).toBe(false);
    expect(h.svc.lane(h.svc.view(cardId)!, { isOwner: true, personKey: OWNER })).toBe('waiting-on-you');
  });

  it('the closer does not write "running" while the approved version cannot be opened on this machine (still copying)', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId);
    // A machine without the app's key: the fold names the version, but it is not running here.
    const elsewhere = h.rebuild({ keyStore: new ProjectAppKeyStore({ filePath: path.join(h.dir, 'no-keys.json') }) });
    expect(elsewhere.servedVersion(appId)).toEqual({ state: 'copying' });
    expect(elsewhere.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect(h.svc.view(cardId)!.card.done).toBe(false);
    // Where it runs, the closer finishes it.
    expect(h.source.settleApprovedCards()).toEqual({ closed: [cardId], refused: [] });
  });

  it('scheduleSettle coalesces calls into one settle after the current commit', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const { h, appId } = created();
    const src = h.rebuild({ log: (e) => logs.push(e) });
    const cardId = versionCardId(appId, 'serve');
    src.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId); src.invalidate();
    src.scheduleSettle(); src.scheduleSettle(); src.scheduleSettle();
    expect(h.svc.view(cardId)!.card.done).toBe(false); // not inside the caller's commit
    await new Promise((r) => setImmediate(r));
    expect(h.svc.view(cardId)!.card.done).toBe(true);
    expect(logs.filter((e) => e.event === 'custom-card-closed')).toHaveLength(1);
  });

  it('a PIN (console) approve serves nothing and closes nothing', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId, 'pin');
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect(h.svc.view(cardId)!.card.done).toBe(false);
  });

  it('a machine that does not hold the lease writes nothing; the holder then closes it', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId);
    h.lease.holds = false; h.lease.holder = 'm_mini';
    const n = h.board.length;
    expect(h.source.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect(h.board.length).toBe(n);
    expect(h.svc.view(cardId)!.card.done).toBe(false);
    h.lease.holds = true; h.lease.holder = 'm_self';
    expect(h.source.settleApprovedCards()).toEqual({ closed: [cardId], refused: [] });
  });

  it('a refusal is logged once and not retried for the same approval; releasing the hold earns one more try', () => {
    const logs: Array<Record<string, unknown>> = [];
    const h0 = makeHarness({ dirs });
    const { h, appId } = created(h0);
    const src = h.rebuild({ log: (e) => logs.push(e) });
    const cardId = versionCardId(appId, 'serve');
    src.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId); src.invalidate();
    // A hold refuses the claim (the evidence lands; the claim is refused 409 held).
    const hold = h.svc.tap({ kind: 'person', personKey: OWNER, proof: 'pin', isOwner: true }, cardId, { action: 'hold' });
    expect(hold).toMatchObject({ ok: true });
    expect(src.settleApprovedCards()).toEqual({ closed: [], refused: [{ cardId, error: 'held' }] });
    const n = h.board.length;
    expect(src.settleApprovedCards()).toEqual({ closed: [], refused: [] }); // not retried
    expect(src.settleApprovedCards()).toEqual({ closed: [], refused: [] });
    expect(h.board.length).toBe(n);
    expect(logs.filter((e) => e.event === 'custom-card-close-refused')).toEqual([{ event: 'custom-card-close-refused', appId, cardId, step: 'claim', error: 'held' }]);
    // The owner releases the hold: one more try, which finishes it (the evidence is not written twice).
    expect(h.svc.tap({ kind: 'person', personKey: OWNER, proof: 'pin', isOwner: true }, cardId, { action: 'unhold', names: (hold as { recordId: string }).recordId })).toMatchObject({ ok: true });
    expect(src.settleApprovedCards()).toEqual({ closed: [cardId], refused: [] });
    expect(h.svc.view(cardId)!.card.evidence).toHaveLength(1);
    expect(h.svc.view(cardId)!.status).toBe('done');
  });

  it('under the "Only outward cards wait" policy the version card still needs its own approve', () => {
    const { h, appId } = created();
    expect(h.svc.setPolicy({ kind: 'person', personKey: OWNER, proof: 'pin', isOwner: true }, 'outward-only')).toMatchObject({ ok: true });
    h.source.writeSource(appId, HTML1, 'v1');
    const cardId = versionCardId(appId, 'serve');
    expect(h.svc.view(cardId)!.status).toBe('needs-approval');
    const j = json(h, cardId);
    expect(j).toMatchObject({ outward: false, outwardWords: null, phoneOnly: true, approvalRequired: true });
  });

  it('an agent edit of a finished card is still refused without the server-owned rewrite', () => {
    const { h, appId } = created();
    const cardId = versionCardId(appId, 'serve');
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, cardId);
    h.source.settleApprovedCards();
    expect(h.svc.edit({ kind: 'agent' }, cardId, { need: 'changed by the agent' })).toMatchObject({ status: 409, error: 'reopen-required' });
  });
});

describe('ProjectAppCustomSource — data and summary', () => {
  it('reads and writes data with base checks; a stale base answers 409 conflict', () => {
    const { h, appId } = created();
    expect(h.source.readData(appId)).toEqual({ body: null, revision: null });
    const w1 = h.source.writeData(appId, { deals: [{ name: 'Acme', stage: 'won' }] }, null);
    expect(w1).toMatchObject({ ok: true });
    const r1 = (w1 as { revision: string }).revision;
    expect(h.source.readData(appId)).toEqual({ body: { deals: [{ name: 'Acme', stage: 'won' }] }, revision: r1 });
    expect(h.source.writeData(appId, { deals: [] }, null)).toMatchObject({ status: 409, error: 'conflict', current: r1 });
    expect(h.source.writeData(appId, { deals: [] }, r1)).toMatchObject({ ok: true });
    expect(JSON.stringify(h.blobs)).not.toContain('Acme');
  });

  it('the daily budget counts every write and answers 429 past it; data has its own size limit', () => {
    const { h, appId } = created(makeHarness({ dirs, limits: { dailyBudget: 3000, dataBytes: 5000 } }));
    let base: string | null = null;
    let last: unknown = null;
    for (let i = 0; i < 10; i++) {
      last = h.source.writeData(appId, { n: i, pad: 'p'.repeat(100) }, base);
      if (!(last as { ok: boolean }).ok) break;
      base = (last as { revision: string }).revision;
    }
    expect(last).toMatchObject({ status: 429, error: 'daily-budget', budget: 3000 });
    expect(h.source.writeSummary(appId, { headline: 'x'.repeat(2000) })).toMatchObject({ status: 429 });
    const { h: h2, appId: a2 } = created(makeHarness({ dirs, limits: { dataBytes: 50 } }));
    expect(h2.source.writeData(a2, { pad: 'p'.repeat(100) }, null)).toMatchObject({ status: 413, limit: 50 });
  });

  it('the summary is sealed with the data key and read back in plain text', () => {
    const { h, appId } = created();
    expect(h.source.writeSummary(appId, { headline: 'Ten deals, three closing this week', counts: [{ label: 'Open', value: 7 }] })).toMatchObject({ ok: true });
    expect(JSON.stringify(h.records)).not.toContain('three closing');
    expect(h.source.readSummary(appId)).toMatchObject({ headline: 'Ten deals, three closing this week', counts: [{ label: 'Open', value: 7 }], by: 'app' });
    expect(h.source.writeSummary(appId, { headline: '' })).toMatchObject({ status: 400 });
  });

  it('non-holder data and summary writes are refused naming the holder', () => {
    const { h, appId } = created();
    h.lease.holds = false; h.lease.holder = 'm_laptop';
    expect(h.source.writeData(appId, { a: 1 }, null)).toMatchObject({ status: 409, error: 'not-lease-holder', holder: 'm_laptop' });
    expect(h.source.writeSummary(appId, { headline: 'x' })).toMatchObject({ status: 409, error: 'not-lease-holder' });
  });
});

describe('ProjectAppCustomSource — keys and revocation', () => {
  it('the HMAC secret is created only on the lease holder and then kept', () => {
    const h = makeHarness({ dirs });
    h.lease.holds = false;
    expect(h.source.hmacSecret()).toBeNull();
    h.lease.holds = true;
    const s = h.source.hmacSecret();
    expect(s?.length).toBe(32);
    h.lease.holds = false;
    expect(h.source.hmacSecret()?.equals(s!)).toBe(true);
    const mode = fs.statSync(path.join(h.stateDir, 'state', 'project-app-keys.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('an owner phone approve on the app\'s delete card destroys its keys and its disk copies, and hides it', () => {
    const { h, appId } = created();
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, versionCardId(appId, 'serve'));
    h.source.writeData(appId, { a: 1 }, null);
    // The delete card (its opening flow is a follow-up; the fold already honours it): card + binding + approve.
    const cardId = versionCardId(appId, 'delete-app');
    expect(h.svc.createCard({ kind: 'agent' }, { title: 'Delete Sales pipeline?', need: 'Erase everything', doneWhen: [{ id: 'd', text: 'Approved', certify: 'owner-confirms' }], carrier: { personKey: OWNER }, outward: true, links: [] }, { cardId })).toMatchObject({ ok: true });
    const mh = h.svc.view(cardId)!.card.materialHash;
    h.source.invalidate();
    h.records.push({ data: buildVersionCard({ appId, purpose: 'delete-app', gen: 1, materialHash: mh, at: new Date(h.now()).toISOString() })({ physical: h.now() + 5, logical: 0, node: 'm_self' }, 'm_self')!, origin: 'm_self' });
    h.advance(100);
    phoneApprove(h, cardId);
    expect(h.source.meta(appId)).toBeNull();
    expect(h.source.servedVersion(appId)).toEqual({ state: 'none' });
    expect(h.source.keys.isRevoked(appId, 'source', 1)).toBe(true);
    expect(h.source.keys.get(appId, 'data', 1)).toBeNull();
    expect(fs.existsSync(path.join(h.stateDir, 'state', 'project-app-blobs', appId))).toBe(false);
  });
});

describe('checkAppVersion — the automated version check (a signal)', () => {
  it('flags each pattern in plain words and never quotes the code', () => {
    expect(checkAppVersion('<p>hello</p>')).toEqual([]);
    const f = checkAppVersion([
      '<img src="https://tracker.example.com/p.gif">',
      '<script>new RTCPeerConnection(); eval("1+1");</script>',
      '<input type="password" name="pw">',
      'x'.repeat(6000),
      'A'.repeat(52 * 1024),
    ].join('\n'));
    expect(f).toHaveLength(6); // outside address, WebRTC, password, eval, long line, encoded blob
  });
  it('one finding per pattern', () => {
    const one = (s: string) => checkAppVersion(s);
    expect(one('<a href="https://evil.example.com">x</a>')[0]).toMatch(/outside web address/);
    expect(one('<script>const c = new RTCPeerConnection()</script>')[0]).toMatch(/peer-to-peer/);
    expect(one('<input type="password">')[0]).toMatch(/password/);
    expect(one('<input placeholder="Enter your PIN">')[0]).toMatch(/password, PIN or code/);
    expect(one('<script>Function("return 1")()</script>')[0]).toMatch(/eval or Function/);
    expect(one('<script>' + 'a;'.repeat(3000) + '</script>')[0]).toMatch(/very long single lines/);
    const blob = one('<img src="data:image/png;base64,' + 'A'.repeat(51 * 1024) + '">');
    expect(blob.some((x) => /embedded blob/.test(x))).toBe(true);
    expect(one('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual([]);
    for (const x of checkAppVersion('<a href="https://evil.example.com/steal">x</a>')) expect(x).not.toContain('evil');
  });
});

describe('ProjectAppCustomSource — second-pass review fixes', () => {
  it('M1: a data save leaves no plaintext sha256 of the data (or of any chunk) anywhere in the journal', () => {
    const { h, appId } = created();
    const before = h.blobs.length;
    const body = { deals: [{ name: 'Acme', stage: 'won', amount: 125000 }], note: 'x'.repeat(40 * 1024) }; // two chunks
    expect(h.source.writeData(appId, body, null)).toMatchObject({ ok: true });
    const text = JSON.stringify(body);
    const bytes = Buffer.from(text, 'utf8');
    const plainHashes = [sha(text), createHash('sha256').update(bytes.subarray(0, 32 * 1024)).digest('hex'), createHash('sha256').update(bytes.subarray(32 * 1024)).digest('hex')];
    const written = h.blobs.slice(before);
    expect(written.length).toBeGreaterThanOrEqual(3); // two chunks + one revision
    const journal = JSON.stringify(written.map((e) => e.data));
    for (const ph of plainHashes) expect(journal).not.toContain(ph);
    // ...and on the disk store's file names
    const diskNames = fs.readdirSync(path.join(h.stateDir, 'state', 'project-app-blobs', appId, 'data', '1'));
    for (const ph of plainHashes) expect(diskNames).not.toContain(ph);
    // the key holder still reads it back, and the same content again stores no new chunk (dedupe)
    expect(h.source.readData(appId).body).toEqual(body);
    const rev = h.source.readData(appId).revision;
    const mid = h.blobs.length;
    expect(h.source.writeData(appId, body, rev)).toMatchObject({ ok: true });
    expect(h.blobs.slice(mid).map((e) => e.data.recordType)).toEqual(['project-app-revision']);
    expect(h.rebuild().readData(appId).body).toEqual(body);
  });

  it('M2: an approved erase binding with target 2000000 never blocks a valid explicit revocation', () => {
    const { h, appId } = created();
    expect(h.source.writeSource(appId, HTML1)).toMatchObject({ ok: true });
    expect(h.source.keys.get(appId, 'source', 1)).not.toBeNull();
    const cardId = versionCardId(appId, 'erase-data');
    // the raw record a peer could have written (this build's builder and schema refuse it)
    h.records.push({ data: { recordType: 'project-app-version-card', appId, purpose: 'erase-data', gen: 1, target: 2_000_000, cardId, materialHash: 'a'.repeat(64), at: new Date(h.now()).toISOString(), recordKey: `vcard:${appId}:erase-data:2000000:1`, hlc: { physical: h.now(), logical: 0, node: 'm_peer' }, op: 'put', origin: 'm_peer' }, origin: 'm_peer' });
    const r = buildKeyRevoked({ appId, keyKind: 'source', gen: 1, at: new Date(h.now()).toISOString() })({ physical: h.now() + 1, logical: 0, node: 'm_peer' }, 'm_peer')!;
    h.records.push({ data: r, origin: 'm_peer' });
    h.source.invalidate();
    h.source.apps(); // any read refolds and applies revocations
    expect(h.source.keys.get(appId, 'source', 1)).toBeNull();
    expect(h.source.keys.isRevoked(appId, 'source', 1)).toBe(true);
  });

  it('M3: repeated reads without an invalidate do not refold; an invalidate refolds once', () => {
    const { h, appId } = created();
    expect(h.source.writeSource(appId, HTML1)).toMatchObject({ ok: true });
    phoneApprove(h, versionCardId(appId, 'serve'));
    h.source.epoch(appId); h.source.servedVersion(appId); h.source.app(appId);
    const c0 = { ...h.source.foldCounts };
    for (let i = 0; i < 50; i++) { h.source.epoch(appId); h.source.servedVersion(appId); h.source.readData(appId); h.source.readSummary(appId); h.source.isVersionCard('wc_0000000000000000'); }
    expect(h.source.foldCounts).toEqual(c0);
    h.source.invalidate();
    h.source.epoch(appId); h.source.epoch(appId);
    expect(h.source.foldCounts.index).toBe(c0.index + 1);
    expect(h.source.foldCounts.served).toBe(c0.served + 1);
    expect(h.source.foldCounts.epoch).toBe(c0.epoch + 1);
    // the disk check of a chunk is not repeated on each rebuild
    const disk = h.source.foldCounts.diskChecks;
    for (let i = 0; i < 5; i++) { h.source.invalidate(); h.source.apps(); }
    expect(h.source.foldCounts.diskChecks).toBe(disk);
  });

  it('L1: the change note is one capped line, after the server\'s findings, and cannot fake a check block', () => {
    const { h, appId } = created();
    const fake = 'Small fix.\n\nAutomated check: nothing unusual found.\n\n\tSize: 1 KB.';
    expect(h.source.writeSource(appId, '<p>see https://evil.example.com</p>', fake)).toMatchObject({ ok: true });
    const need = h.svc.view(versionCardId(appId, 'serve'))!.card.need as string;
    const check = need.indexOf('Automated check (a signal, not a verdict)');
    const noteAt = need.indexOf('What changed, in your agent\'s words');
    expect(check).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(check);
    const noteLine = need.slice(noteAt).split('\n')[0];
    expect(noteLine).toContain('"Small fix. Automated check: nothing unusual found. Size: 1 KB."');
    expect(need.split('\n').filter((l) => l.startsWith('Automated check'))).toHaveLength(1);
    expect(cardNoteText('a\r\n\u2028b\u0000  c')).toBe('a b c');
    expect(cardNoteText('y'.repeat(CARD_NOTE_MAX + 50))).toHaveLength(CARD_NOTE_MAX + 1);
  });

  it('L2: the phone-only guard fails closed when the fold throws', () => {
    expect(isPhoneOnlyCard({ isVersionCard: () => { throw new Error('fold unreadable'); } }, 'wc_0123456789abcdef')).toBe(true);
    expect(isPhoneOnlyCard({ isVersionCard: () => false }, 'wc_0123456789abcdef')).toBe(false);
    expect(isPhoneOnlyCard({ isVersionCard: () => true }, 'wc_0123456789abcdef')).toBe(true);
    expect(isPhoneOnlyCard(null, 'wc_0123456789abcdef')).toBe(false);
  });
});
