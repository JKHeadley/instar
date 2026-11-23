import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../../src/server/routes.js';
import { TopicProfileStore } from '../../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface, type ProfileWriteRegime } from '../../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../../src/core/topicProfileIngress.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { buildNeverSilent } from '../../../src/monitoring/neverSilent/neverSilentWiring.js';
export async function settlementFixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-response-settlement-'));
 const stateDir = path.join(root, '.instar'); fs.mkdirSync(path.join(stateDir,'state'),{recursive:true});
interface Bundle {
  store: TopicProfileStore;
  resolver: TopicProfileResolver;
  surface: TopicProfileWriteSurface;
  confirmSlots: ProfileConfirmSlots;
  respawns: string[];
  disclosures: Array<{ topic: string; text: string }>;
  bindOperatorLookup: (lookup: (key: string) => { platform: string; uid: string } | null) => void;
}

function buildBundle(regime: ProfileWriteRegime, opts: { boundOperator?: boolean; now?: () => number; proposalTtlMs?: () => number } = {}): Bundle {
  const store = new TopicProfileStore({
    stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
    legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
    isDryRun: () => regime.dryRun,
  });
  const resolver = new TopicProfileResolver({
    store,
    defaultFramework: () => 'claude-code',
    configTopicFrameworks: () => ({}),
    configProfileDefaults: () => ({}),
    frameworkDefaultModels: () => ({}),
    tierEscalationConfig: () => undefined,
    localModelBinding: () => null,
    frameworkBinaryPath: () => null,
  });
  const respawns: string[] = [];
  const disclosures: Array<{ topic: string; text: string }> = [];
  let operatorLookup = (_key: string): { platform: string; uid: string } | null => opts.boundOperator === false
    ? null : { platform: 'telegram', uid: '777' };
  const surface = new TopicProfileWriteSurface({
    store,
    resolver,
    regime: () => regime,
    boundOperator: key => operatorLookup(key),
    localModelBinding: () => null,
    legacyFrameworkRespawn: async (k) => { respawns.push(k); return { respawned: true }; },
    disclose: async (topic, text) => { disclosures.push({ topic, text }); },
    audit: () => 'seq-test',
  });
  const confirmSlots = new ProfileConfirmSlots({ ttlMs: () => 300_000, now: opts.now, proposalTtlMs: opts.proposalTtlMs });
  return { store, resolver, surface, confirmSlots, respawns, disclosures,
    bindOperatorLookup: lookup => { operatorLookup = lookup; } };
}

function buildApp(bundle: Bundle | null, extra: Record<string, unknown> = {}): express.Express {
  const ctx = {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as Record<string, never>,
      scheduler: {} as Record<string, never>,
    },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    feedbackAnomalyDetector: null,
    discoveryEvaluator: null,
    topicProfile: bundle
      ? { store: bundle.store, resolver: bundle.resolver, surface: bundle.surface, confirmSlots: bundle.confirmSlots }
      : null,
    startTime: new Date(),
    ...extra,
  } as unknown as RouteContext;
  // The route and write surface share the same operator source, as in server initialization.
  if (bundle && ctx.topicOperatorStore) bundle.bindOperatorLookup(key => ctx.topicOperatorStore!.getOperator(key));
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}


 let now = 1000;
 let monitoringEnabled=true;
 const bundle = buildBundle({enabled:false,dryRun:true},{now:()=>now}); await bundle.store.ready();
 const notices: string[] = [];
 const monitor = buildNeverSilent({ stateDir, logsDir:path.join(stateDir,'logs'), now:()=>now,
 config:()=>({enabled:monitoringEnabled,judge:false,actions:false,frameworkFallback:false,confidenceFloor:0.9,noticeAfterMs:10}),
 sessionForTelegramTopic:()=>null, sessionForSlackChannel:()=>null, sessionFacts:()=>null,
 isProtected:()=>true,capturePane:()=>null,poolAccounts:()=>[],loginCheck:()=>null,
 observeLoginExpired:async()=>{},repairStarted:()=>false,swap:async()=>({swapped:false,reason:'fixture'}),
 profileFor:()=>null,writeFramework:async()=>false,respawnTopic:async()=>false,
 readJevKey:()=>null,refereeFor:()=>null,
 sendTelegramNotice:async(_topic,text)=>{notices.push(text);return String(800+notices.length);},sendSlackNotice:async()=>null,
 verifyRegisteredReplyProof:(proof:unknown)=>bundle.confirmSlots.proposals.ownsRegisteredReplyProof(proof),
 });
 bundle.confirmSlots.proposals.setRegisteredReplyHandler(proof=>monitor.observeRegisteredReply(proof));
 let delivery: 'positive'|'unknown'|'quiet'|'refused'|'inactive' = 'positive';
 const sends:Array<{topic:number;text:string;messageId:number}>=[];
 const app=buildApp(bundle,{
 config:{projectName:'settlement-fixture',projectDir:root,stateDir,port:0,sessions:{},scheduler:{},developmentAgent:true},
 telegram:{getOwnerUserId:()=>777,getChatId:()=>'-1001',getNativeTopicDestination:(topicId:number)=>({chatId:'-1001',threadId:topicId}),
 getTopicName:(id:number)=>`Conversation ${id}`,
 sendToTopic:async(topic:number,text:string)=>{
   if(delivery==='unknown')throw new Error('no acceptance evidence');
   if(delivery==='quiet')return {recorded:true,delivered:false,quietId:'fixture'};
   if(delivery==='refused')return {delivered:false,refused:true,reason:'lease-not-held-at-send'};
   const messageId=900+sends.length; sends.push({topic,text,messageId});
   if(delivery==='inactive')now+=86_400_001;
   return {messageId};
 }},
 topicOperatorStore:{getOperator:()=>({platform:'telegram',uid:'777'}),getBinding:()=>null,allBindings:()=>[],everVerifiedOperatorUids:()=>[]},
 });
 const accept=(id:string,text='1) yes',source='1001')=>monitor.observeLogged('telegram',source,{messageId:id,text,fromUser:true});
 const claim=(id:string,source='1001',principal='telegram:777')=>({ownerTurnHandle:bundle.confirmSlots.ownerTurns.issue({source,principal,inboundId:id}),ownerTurnInboundId:id});
 return {app,bundle,monitor,root,stateDir,sends,notices,accept,claim,setDelivery:(value:typeof delivery)=>{delivery=value;},
 setMonitoringEnabled:(enabled:boolean)=>{monitoringEnabled=enabled;},
 advance:()=>{now+=1000;},close:()=>{monitor.stop();SafeFsExecutor.safeRmSync(root,{recursive:true,force:true,operation:'tests/profile-response-settlement:close'});}};
}
