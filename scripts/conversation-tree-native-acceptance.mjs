/** Disposable, read-only loopback fixture for one simulator's public key. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { AppConversationService } from '../dist/core/AppConversationService.js';
import { identityKeyLookup, loadMachineSigner } from '../dist/core/AppRecordSignatures.js';
import { ConversationListPinStore } from '../dist/core/ConversationListPins.js';
import { readerKeyFor } from '../dist/core/ConversationReadMarkers.js';
import { ConversationRegistry } from '../dist/core/ConversationRegistry.js';
import { nodeKey } from '../dist/core/conversationGraph.js';
import { ConversationGraphReadModel } from '../dist/core/conversationGraphRead.js';
import { MachineIdentityManager } from '../dist/core/MachineIdentity.js';
import { MobileDeviceKeyLedger } from '../dist/core/MobileDeviceKeyLedger.js';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';
import { AppCreationHierarchyProjection } from '../dist/server/appCreationHierarchy.js';
import { createConversationGraphRouter } from '../dist/server/conversationGraphRoutes.js';
import { createConversationGraphViewerResolver } from '../dist/server/conversationGraphViewer.js';
import { authMiddleware } from '../dist/server/middleware.js';
import { createMobileConversationRouter } from '../dist/server/mobileConversationRoutes.js';
import { MobilePairingService, deviceAuthenticator, devicePersonOf } from '../dist/server/mobilePairingRoutes.js';
import { conversationRef } from '../dist/core/workBoardViews.js';
import { mountProjectsRoutes } from '../dist/server/workProjectsRoutes.js';

const [keyFile, ...extra] = process.argv.slice(2);
if (!keyFile || extra.length) throw new Error('Usage: node scripts/conversation-tree-native-acceptance.mjs <P-256 public key file>');
const publicKey = fs.readFileSync(keyFile, 'utf8').trim();
const raw = Buffer.from(publicKey, 'base64url');
if (raw.length !== 65 || raw[0] !== 4 || raw.toString('base64url') !== publicKey) throw new Error('Invalid P-256 public key');
crypto.ECDH.convertKey(raw, 'prime256v1');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-conversation-tree-native-'));
let pairing;
let service;
let listener;
function clean() {
  pairing?.stop();
  service?.stop();
  listener?.close();
  listener?.closeAllConnections();
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'conversation-tree-native-acceptance:cleanup' });
}
const routes = ['/mobile/conversations', '/mobile/work/projects', '/mobile/conversation-graph/tree'];
try {
  const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Disposable conversation tree' });
  const machineId = () => identity.machineId;
  const config = { projectName: 'tree-fixture', projectDir: stateDir, stateDir, port: 0,
    authToken: crypto.randomBytes(32).toString('hex'), developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } }, threadline: { ownerName: 'Fixture owner' } };
  pairing = new MobilePairingService({ config, stateDir, selfMachineId: identity.machineId,
    holdsLease: () => true, telegramOwnerId: () => 42 });
  pairing.nativeOn = true;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir, signer: loadMachineSigner(stateDir), keyLookup: identityKeyLookup(stateDir) });
  service = new AppConversationService({ stateDir, machineId,
    registry: new ConversationRegistry({ stateDir, machineId, isRecordingEnabled: () => true }),
    requests: pairing.chatRequests(), holdsLease: () => true, ownerName: () => 'Fixture owner',
    killSession: () => false, dispatch: () => async () => 'refused' });
  pairing.useAppConversationStore(service.store);

  const topics = [[41, 'Chief of Staff'], [42, 'Fixture Project'], [43, 'Saved Group Chat'], [44, 'Ordinary Chat']];
  const telegram = (topicId) => ({ kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId });
  const project = { conversationKey: 'telegram:42', goal: 'Fixture project goal', title: 'Fixture Project',
    lastVerdict: null, lastCheckAt: null, nextCheckAt: null, restartsWithoutProgress: 0, parked: false, doneDefinition: [], doneItems: null };
  const parents = new Map([['telegram:42', 'telegram:41']]);
  const at = '2026-11-26T09:00:00.000Z';
  const child = crypto.randomUUID();
  const hidden = crypto.randomUUID();
  for (const [key, title] of [[child, 'Generated Project Chat'], [hidden, 'Internal Worker Chat']]) {
    service.store.append({ eventId: crypto.randomUUID(), kind: 'created', conversationKey: key, title, at, machineId: machineId(),
      creationContext: { v: 1, source: { kind: 'session', requestId: 'tree-fixture', originMachineId: machineId() },
        parentConversationKey: 'telegram:42', parentBasis: 'explicit' } });
    parents.set(`app:${key}`, 'telegram:42');
  }
  const cardConversation = crypto.randomUUID();
  const card = { id: 'wc_0000000000000042', title: 'Fixture Linked Card', lane: 'with-agent',
    conversationKey: cardConversation, projectKey: 'telegram:42' };
  const cardContext = { v: 1, source: { kind: 'work-board-card', cardId: card.id, originMachineId: machineId(),
    projectKey: card.projectKey }, parentConversationKey: `app:${child}`, parentBasis: 'explicit' };
  service.store.append({ eventId: crypto.randomUUID(), kind: 'created', conversationKey: cardConversation,
    title: card.title, at, machineId: machineId(), creationContext: cardContext });
  parents.set(`app:${cardConversation}`, `app:${child}`);
  service.store.hiddenConversationKeys = () => new Set([hidden]);
  const group = { kind: 'effort', id: '012fdaec-70de-4324-9ef3-22b616fc83ce' };
  const nested = { kind: 'effort', id: '012fdaec-70de-4324-9ef3-22b616fc83cf' };
  const event = (n, fields) => ({ schemaVersion: 1, eventId: `tree-fixture-${n}`, authority: 'owner',
    principal: 'owner', receipt: { kind: 'owner-proof', id: `r${n}` }, machineId: machineId(),
    createdAt: `2026-11-26T09:0${n}:00.000Z`, ...fields });
  const events = [group, nested].map((subject, n) => event(n + 1, { subject, op: 'create-effort',
    projectScope: [], headerId: `hdr-${subject.id.replaceAll('-', '')}` }));
  events.push(event(3, { subject: nested, op: 'set-primary-placement', parent: group, relation: 'contains', replacesPlacementEventIds: [] }));
  events.push(event(4, { subject: telegram(43), op: 'set-primary-placement', parent: nested, relation: 'coordinates', replacesPlacementEventIds: [] }));
  const cardRef = { kind: 'conversation', platform: 'app', conversationKey: cardConversation };
  const generatedRef = { kind: 'conversation', platform: 'app', conversationKey: child };
  const model = new ConversationGraphReadModel({
    readiness: () => ({ ready: true }), certifiedEvents: () => events, verify: () => true,
    conversations: () => [...topics.map(([id, title]) => ({ ref: telegram(id), conversationId: id, title, lastActivity: at })),
      { ref: generatedRef, conversationId: child, title: 'Generated Project Chat', lastActivity: at },
      { ref: cardRef, conversationId: cardConversation, title: card.title, lastActivity: at }],
    treeProjectMembership: () => new Map([
      ...topics.map(([id]) => [nodeKey(telegram(id)), id === 42 ? 'telegram:42' : null]),
      [nodeKey(generatedRef), 'telegram:42'], [nodeKey(cardRef), { projectConversationKey: card.projectKey, parentNodeKey: nodeKey(generatedRef) }],
    ]),
    effortTitle: (ref) => ref.id === group.id ? 'Fixture Group' : 'Nested Group',
    replication: () => ({ replicaLag: false, eventGap: false, evidenceMissing: false }), now: () => new Date(),
  }, { rootConversation: () => telegram(41) });

  const source = { version: 'fixture', complete: true, parents, confirmedProjects: new Set(['telegram:42']),
    cardEvidence: [{ conversationKey: cardConversation, cardId: card.id, creationContext: cardContext, conflict: false }],
    resolveRef: (ref) => parents.has(ref) || topics.some(([id]) => ref === `telegram:${id}`) ? ref : null };
  const creationProjection = new AppCreationHierarchyProjection(service.store, () => source);
  const authorizationVersion = 'disposable-single-owner';
  const listPins = new ConversationListPinStore({ stateDir });
  const app = express();
  app.use(authMiddleware(() => config.authToken, config.projectName, undefined, deviceAuthenticator(pairing)));
  app.use(createMobileConversationRouter({ config, pairing, service, machineId, listPins,
    chiefOfStaff: () => ({ pinnedKey: 'telegram:41', parents }),
    telegramTopics: () => topics.map(([topicId, topicName]) => ({ topicId, topicName, lastActivity: at })),
    creationHierarchySource: () => source, creationHierarchyProjection: creationProjection,
    creationAuthorizationVersion: () => authorizationVersion,
  }));
  const projects = express.Router();
  mountProjectsRoutes(projects, { bearerOk: () => false, projects: () => [project], boardFor: () => ({ status: 200, body: { lanes: [{ lane: card.lane, cards: [card] }] } }) });
  app.use(projects);
  app.use(createConversationGraphRouter({ model, resolveViewer: createConversationGraphViewerResolver({
    agentId: config.projectName, pairing, verifyDashboardOwner: () => false,
  }), projects: () => [{ ...project, ref: telegram(42) }] }));

  const boardRoute = '/mobile/work-board';
  const detailRoute = `${boardRoute}/cards/${card.id}`;
  const cardDetail = { ...card, status: 'open', turn: 'agent', started: false, newestAt: at,
    agentInternal: false, conversationAvailable: true, conversation: conversationRef(card.conversationKey),
    need: 'Verify the conversation backlink.', links: [], questions: [], evidence: [] };
  const ownerRead = (body) => (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (devicePersonOf(req)?.role !== 'owner') { res.status(403).json({ error: 'owner-only' }); return; }
    res.json(body);
  };
  app.get(boardRoute, ownerRead({ lanes: [{ lane: card.lane, cards: [cardDetail], total: 1, more: 0 }],
    viewer: { isOwner: true, canTap: false }, behind: null }));
  app.get(detailRoute, ownerRead({ card: cardDetail }));
  routes.push(boardRoute, detailRoute);

  let ready = false;
  listener = http.createServer((req, res) => {
    if (ready && req.method === 'GET' && routes.includes(req.url?.split('?')[0])) app(req, res);
    else res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
  }).listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const host = `127.0.0.1:${listener.address().port}`;
  const pending = pairing.devices.createPending({ deviceName: 'Tree fixture device', label: null, publicKey, host });
  if (!pending.ok) throw new Error('Cannot register supplied simulator key');
  const device = pairing.devices.applyConfirm(pending.device.id, { ok: true, approvedVia: 'telegram-dm' });
  if (!device) throw new Error('Cannot confirm disposable device');
  pairing.keyLedger.recordActivation(device, 'telegram-dm', new Date().toISOString());
  const reader = readerKeyFor(pairing.personOfDevice(device), pairing.machineId());
  if (!reader || listPins.setPinned(reader, `app:${child}`, true).outcome !== 'changed')
    throw new Error('Cannot pin disposable project descendant');
  // Make the first simulator read deterministic. The single fixture owner
  // can read all seeded topics; the hidden worker is excluded from discovery.
  await creationProjection.settled({ key: `device:${device.id}`, source, authorizationVersion,
    mayRead: (ref) => source.resolveRef(ref) !== null && ref !== `app:${hidden}` });
  process.once('SIGTERM', clean);
  process.once('SIGINT', clean);
  ready = true;
  process.stdout.write(JSON.stringify({ type: 'conversation-tree-native-acceptance-ready',
    protocol: 'http', host, deviceId: device.id, routes, projectConversationKey: 'telegram:42', child, hidden }) + '\n');
} catch (error) {
  clean();
  throw error;
}
