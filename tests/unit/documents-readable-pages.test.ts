/**
 * The old-link guarantee (docs/specs/instar-document-viewer.md §3.9b): while documents can serve,
 * new readable pages are documents, the viewer refuses new pages, and outgoing old-style links are
 * signalled to the tone gate. When documents cannot serve, nothing changes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService } from '../../src/documents/service.js';
import type { TeamView } from '../../src/documents/access.js';
import { placeMatches } from '../../src/server/memorySessionGuard.js';
import { callerHasDocumentHome, detectOldViewLink, documentsReplaceViews, publishAsDocument, replaceVerdict, safeVerdict, systemDocumentLink, type ReadablePageDeps } from '../../src/documents/readablePages.js';
import { DocError } from '../../src/documents/service.js';
import { signViewPath } from '../../src/server/middleware.js';
import { PrivateViewer, ViewsReplacedByDocumentsError } from '../../src/publishing/PrivateViewer.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/documents-readable-pages.test.ts' }); });

const OWN = 'telegram:7';
const COS = 'telegram:41';
const SHARED = 'telegram:500';

function setup(over: Partial<ReadablePageDeps> = {}, ownerOnly: (ref: string) => boolean = (ref) => ref === OWN || ref === COS) {
  const kp = generateSigningKeyPair();
  const signer: MachineSigner = { machineId: () => 'A', signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: 'A', signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-')); tmp.push(dir);
  const store = new DocumentStore(dir, { signer, keyLookup: () => ({ status: 'ok', publicKeyPem: kp.publicKey }), standing: () => 'ok' });
  const team: TeamView = { personMay: () => false, ownerOnly, sessionInPlace: (k, ref) => placeMatches(ref, k), teamRefusal: () => null, sendReachesOwner: () => false };
  const service = new DocumentService(store, team);
  const deps: ReadablePageDeps = {
    config: () => ({ developmentAgent: true }), service: () => service, teamVector: () => ({}),
    ownerConversation: () => OWN, linkOrigin: () => 'https://echo.example.dev', ...over,
  };
  return { deps, service };
}

const bearer = { principal: { kind: 'bearer' as const }, actor: { type: 'agent' as const, placeKey: 'x' }, access: {}, reader: { kind: 'owner' as const } };

describe('replaceVerdict: documents replace pages only when they can serve', () => {
  it('replaces on a development agent with a service, an address and an owner conversation', () => {
    const { deps } = setup();
    expect(replaceVerdict(deps)).toBe('replace');
    expect(documentsReplaceViews(deps)).toBe(true);
  });
  it('changes nothing on a fleet config (documents off)', () => {
    const { deps } = setup({ config: () => ({}) });
    expect(replaceVerdict(deps)).toBe('documents-off');
    expect(publishAsDocument(deps, 't', 'm')).toBeNull();
  });
  it('keeps pages when there is no permanent address, no service or no owner conversation', () => {
    expect(replaceVerdict(setup({ linkOrigin: () => null }).deps)).toBe('no-address');
    expect(replaceVerdict(setup({ linkOrigin: undefined }).deps)).toBe('no-address');
    expect(replaceVerdict(setup({ service: () => null }).deps)).toBe('no-service');
    expect(replaceVerdict(setup({ ownerConversation: () => null }).deps)).toBe('no-owner-conversation');
  });
  it('a throwing check leaves pages working and reads as fault', () => {
    const { deps } = setup({ config: () => { throw new Error('boom'); } });
    expect(documentsReplaceViews(deps)).toBe(false);
    expect(safeVerdict(deps)).toBe('fault');
  });
});

describe('publishAsDocument: system pages become documents', () => {
  it('puts the document in the preferred owner-only conversation and links it on the permanent address', () => {
    const { deps, service } = setup();
    const out = publishAsDocument(deps, 'Chief of Staff — first-run triage', '# Triage\n\nRows.\n', COS)!;
    expect(out.primary).toBe(COS);
    expect(out.url).toBe(`https://echo.example.dev/docs/${out.id}`);
    expect(service.facts(out.id)?.primary).toBe(COS);
    expect(service.read(out.id, bearer).state.primary).toBe(COS);
  });
  it('falls back to the owner conversation when the preferred one is shared (the agent never widens)', () => {
    const { deps, service } = setup();
    const out = publishAsDocument(deps, 'Report', '# R\n', SHARED)!;
    expect(out.primary).toBe(OWN);
    expect(service.facts(out.id)?.primary).toBe(OWN);
  });
  it('uses the owner conversation with no preference or a malformed one', () => {
    const { deps } = setup();
    expect(publishAsDocument(deps, 'R', '# R\n')!.primary).toBe(OWN);
    expect(publishAsDocument(deps, 'R', '# R\n', 'not-a-ref')!.primary).toBe(OWN);
  });
});

describe('publishAsDocument: fallbacks and placement', () => {
  it('falls back to the owner conversation on any refusal of the preferred one', () => {
    const { deps, service } = setup();
    const real = service.create.bind(service);
    (service as unknown as { create: typeof service.create }).create = (c, input) => { if (input.primary === COS) throw new DocError(409, 'conversation-unknown'); return real(c, input); };
    expect(publishAsDocument(deps, 'R', '# R\n', COS)!.primary).toBe(OWN);
  });
  it('onlyPreferred links nothing when the preferred conversation is shared or missing', () => {
    const { deps } = setup();
    expect(publishAsDocument(deps, 'R', '# R\n', SHARED, { onlyPreferred: true })).toBeNull();
    expect(publishAsDocument(deps, 'R', '# R\n', null, { onlyPreferred: true })).toBeNull();
    expect(publishAsDocument(deps, 'R', '# R\n', COS, { onlyPreferred: true })!.primary).toBe(COS);
  });
  it('systemDocumentLink answers only for a document that exists, on the current address', () => {
    let origin = 'https://echo.example.dev';
    const { deps } = setup({ linkOrigin: () => origin });
    const out = publishAsDocument(deps, 'T', '# T\n', COS)!;
    origin = 'https://moved.example.dev';
    expect(systemDocumentLink(deps, out.id)).toBe(`https://moved.example.dev/docs/${out.id}`);
    expect(systemDocumentLink(deps, '11111111-1111-4111-8111-111111111111')).toBeNull();
  });
});

describe('callerHasDocumentHome', () => {
  it('the agent itself and owner-reach sessions always have one', () => {
    expect(callerHasDocumentHome(null)).toBe(true);
    expect(callerHasDocumentHome({ placeKey: 'slack:C1', ownerReach: true })).toBe(true);
  });
  it('any Telegram or app place has one (a confined topic, a group key, an app conversation)', () => {
    expect(callerHasDocumentHome({ placeKey: 'telegram:topic:500', ownerReach: false })).toBe(true);
    expect(callerHasDocumentHome({ placeKey: 'telegram:-1001234567890', ownerReach: false })).toBe(true);
    expect(callerHasDocumentHome({ placeKey: 'app:11111111-1111-4111-8111-111111111111', ownerReach: false })).toBe(true);
  });
  it('a place a document cannot live keeps pages (Slack, another service, no place)', () => {
    expect(callerHasDocumentHome({ placeKey: 'slack:C123:1700000000.1', ownerReach: false })).toBe(false);
    expect(callerHasDocumentHome({ placeKey: 'whatsapp:123', ownerReach: false })).toBe(false);
    expect(callerHasDocumentHome({ placeKey: null, ownerReach: false })).toBe(false);
  });
});

describe('every page writer is known (the guard covers callers that do not know about documents)', () => {
  it('pins the callers of PrivateViewer create and update, and who may pass noDocumentHome', () => {
    const root = path.resolve(__dirname, '../../src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts')) {
          const t = fs.readFileSync(f, 'utf8');
          for (const m of t.matchAll(/viewer!?\??\.(create|update)\(|noDocumentHome: true/g)) hits.push(`${path.relative(root, f)}:${m[0]}`);
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([
      'server/AgentServer.ts:viewer!.create(',
      'server/routes.ts:noDocumentHome: true',
      'server/routes.ts:noDocumentHome: true',
      'server/routes.ts:viewer.create(',
      'server/routes.ts:viewer.create(',
      'server/routes.ts:viewer.update(',
    ].sort());
  });
});

describe('PrivateViewer new-view guard (the backstop)', () => {
  function viewer() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-')); tmp.push(dir);
    return new PrivateViewer({ viewsDir: dir });
  }
  it('refuses new pages while documents replace them, and keeps serving and editing existing ones', () => {
    const v = viewer();
    const old = v.create('Old', '# old');
    let on = true;
    v.setNewViewGuard(() => on);
    expect(() => v.create('New', '# new')).toThrow(ViewsReplacedByDocumentsError);
    expect(v.get(old.id)?.title).toBe('Old');
    // Rewriting an old page is new content on an old link: refused too.
    expect(() => v.update(old.id, 'Old, edited', '# old 2')).toThrow(ViewsReplacedByDocumentsError);
    // A caller with nowhere a document could live still gets its page.
    expect(v.create('Slack page', '# s', undefined, undefined, { noDocumentHome: true }).title).toBe('Slack page');
    expect(v.update(old.id, 'Old, edited', '# old 2', { noDocumentHome: true })?.title).toBe('Old, edited');
    on = false;
    expect(v.create('Allowed', '# ok').title).toBe('Allowed');
  });
  it('a throwing guard never stops pages', () => {
    const v = viewer();
    v.setNewViewGuard(() => { throw new Error('boom'); });
    expect(v.newViewsAreRefused()).toBe(false);
    expect(v.create('Still', '# ok').title).toBe('Still');
  });
  it('the error names the replacement', () => {
    const e = new ViewsReplacedByDocumentsError();
    expect(e.code).toBe('documents-replace-views');
    expect(e.message).toContain('POST /docs');
  });
});

describe('detectOldViewLink (signal only)', () => {
  const id = '87217124-385f-4047-a28c-8eecfc82d279';
  it('finds a tunnel link and drops the signature', () => {
    const r = detectOldViewLink(`The full list:\nhttps://echo-mini.dawn-tunnel.dev/view/${id}?sig=940d7b14165a8275a2e955e6a802d9dd90a92e215fe40d7545ea22e24cb97004\nThanks`);
    expect(r).toEqual({ detected: true, match: `https://echo-mini.dawn-tunnel.dev/view/${id}`, ownership: 'unknown' });
  });
  it('finds a local path link, which is this agent\'s own', () => {
    expect(detectOldViewLink(`see /view/${id}`)).toMatchObject({ detected: true, ownership: 'this-agent' });
  });
  it('decides ownership from facts: a signature made with this agent\'s key, or an own host', () => {
    const key = 'agent-key';
    const sigValid = (p: string, sig: string) => signViewPath(p, key) === sig;
    const good = signViewPath(`/view/${id}`, key);
    const bad = signViewPath(`/view/${id}`, 'someone-else');
    expect(detectOldViewLink(`https://peer.example.dev/view/${id}?sig=${good}`, { sigValid }).ownership).toBe('this-agent');
    expect(detectOldViewLink(`https://peer.example.dev/view/${id}?sig=${bad}`, { sigValid }).ownership).toBe('unknown');
    expect(detectOldViewLink(`https://other.example.org/x/view/${id}`, { sigValid }).ownership).toBe('unknown');
    expect(detectOldViewLink(`https://Echo.Example.dev/view/${id}`, { ownHosts: ['echo.example.dev'] }).ownership).toBe('this-agent');
    // A later link that is ours decides it, while the match stays the first link.
    const two = detectOldViewLink(`https://other.example.org/view/${id} and https://peer.example.dev/view/${id}?sig=${good}`, { sigValid });
    // The match and its ownership describe the same link: the owned one.
    expect(two).toMatchObject({ match: `https://peer.example.dev/view/${id}`, ownership: 'this-agent' });
    // A host with a port (or userinfo) still matches an own host.
    expect(detectOldViewLink(`http://localhost:4040/view/${id}`, { ownHosts: ['localhost'] }).ownership).toBe('this-agent');
    expect(detectOldViewLink(`http://u@echo.example.dev:8443/view/${id}`, { ownHosts: ['echo.example.dev'] }).ownership).toBe('this-agent');
  });
  it('ignores document links, a views list and plain words', () => {
    expect(detectOldViewLink(`https://echo.example.dev/docs/${id}`).detected).toBe(false);
    expect(detectOldViewLink('the /views page lists them').detected).toBe(false);
    expect(detectOldViewLink('an old-style page from the view').detected).toBe(false);
    expect(detectOldViewLink('').detected).toBe(false);
  });
});
