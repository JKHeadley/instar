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
    expect(card.outward).toBe(true);
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
    h.source.writeSource(appId, HTML1, 'v1');
    phoneApprove(h, versionCardId(appId, 'serve'));
    const journal = JSON.stringify(h.blobs) + JSON.stringify(h.records);
    expect(journal).not.toContain('sales pipeline');
    expect(journal).not.toContain('v1');
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
