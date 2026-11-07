import type {GraphSourceCapacityPolicy} from '../../src/core/GraphSourceCapacityLedger.js';
import {GraphCustodyPeerFrontier} from '../../src/core/GraphCustodyPeerFrontier.js';
import {GraphCustodyBootstrapStore,GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,type GraphCustodyBootstrapPublication} from '../../src/core/GraphCustodyBootstrap.js';
import {GraphCustodyProfileAuthority} from '../../src/core/GraphCustodyProfileAuthority.js';
import {createGraphOwnerRecoveryEnvelope} from '../../src/core/GraphOwnerRecovery.js';
import {GraphOwnerRecoveryStore} from '../../src/core/GraphOwnerRecoveryStore.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {canonicalHash,signGraphRecord,unsigned} from '../../src/core/GraphWitnessTypes.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import express from 'express';
import {afterEach,expect} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {LeaseCoordinator} from '../../src/core/LeaseCoordinator.js';
import {LocalLeaseStore} from '../../src/core/LocalLeaseStore.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {FencedLease} from '../../src/core/FencedLease.js';
import {WriteAdmission} from '../../src/core/WriteAdmission.js';
import {buildWriteDomainRegistry} from '../../src/core/WriteDomainRegistry.js';
import {PeerEndpointResolver} from '../../src/core/PeerEndpointResolver.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {ReplicatedPeerStreamReader} from '../../src/core/ReplicatedPeerStreamReader.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {HybridLogicalClock} from '../../src/core/HybridLogicalClock.js';
import {CoherenceJournal} from '../../src/core/CoherenceJournal.js';
import {GraphWitnessService} from '../../src/core/GraphWitnessService.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {createGraphWitnessRoutes} from '../../src/server/graphWitnessRoutes.js';
import {ConversationGraphReplicationRuntime,type ConversationGraphReplicationRuntimeOptions} from '../../src/server/ConversationGraphReplicationRuntime.js';
import {replicationFixture} from '../unit/conversation-graph-replication.fixtures.js';
export const dirs:string[]=[];const servers:Server[]=[];const peerListeners=new WeakMap<express.Express,Server>();const locks:SingleInstanceLock[]=[];const journals:CoherenceJournal[]=[];export const runtimes:ConversationGraphReplicationRuntime[]=[];export const witnesses:GraphWitnessService[]=[];
async function temp(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-runtime-'));dirs.push(dir);return dir;}
async function listen(app:express.Express){const server=await new Promise<Server>(resolve=>{const server=app.listen(0,'0.0.0.0',()=>resolve(server));});servers.push(server);peerListeners.set(app,server);const address=server.address();if(!address||typeof address==='string')throw new Error('missing-address');return address.port;}
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();for(const journal of journals.splice(0))journal.close();for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));for(const witness of witnesses.splice(0))witness.close();for(const lock of locks.splice(0))lock.release();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-runtime-test:teardown'});});
/** Stop the exact real fixture socket, never manufacture an offline flag. */
export async function stopGraphRuntimeFixturePeer(app:express.Express):Promise<void>{const server=peerListeners.get(app);if(!server||!server.listening)throw new Error('graph-fixture-peer-listener-required');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(server.listening)throw new Error('graph-fixture-peer-still-listening');peerListeners.delete(app);const index=servers.indexOf(server);if(index>=0)servers.splice(index,1);}
export async function setupGraphRuntimeFixture(testOptions:{backupPolicyAuditorPublicKey?:string;ownedCustodyHostIndex?:0|1;localCapacityPolicy?:GraphSourceCapacityPolicy}={}){
 const authorities:GraphCustodyProfileAuthority[]=[];const managers=await Promise.all([temp(),temp()].map(async dir=>{const manager=new MachineIdentityManager(await dir);await manager.generateIdentity();return manager;}));
 for(const manager of managers)for(const peer of managers)if(manager!==peer){const identity=peer.loadIdentity();new IdentityStore({stateDir:manager.baseDir}).apply({identity,scope:'remote',actor:'pairing-trust',path:'pair'});manager.registerMachine(identity,'standby');}
 const material=managers.map(manager=>{const signing=crypto.createPrivateKey(manager.loadSigningKey());const sealing=crypto.createPrivateKey(manager.loadEncryptionKey());return {machineId:manager.loadIdentity().machineId,signing:{privateKey:signing,publicKey:crypto.createPublicKey(signing)},sealing:{privateKey:sealing,publicKey:crypto.createPublicKey(sealing)}};});
 const f=replicationFixture(material,Date.now()-6*60000);const ownerPublicKey=f.owner.publicKey.export({type:'spki',format:'pem'}).toString();const witnessPublicKey=f.witness.publicKey.export({type:'spki',format:'pem'}).toString();
 const {ownedCustodyHostIndex,...enrollmentOptions}=testOptions;const ownedHost=ownedCustodyHostIndex===undefined?undefined:{machineId:material[ownedCustodyHostIndex].machineId,signingPublicKey:material[ownedCustodyHostIndex].signing.publicKey.export({type:'spki',format:'pem'}).toString()};
 if(ownedHost){f.membership.failureDomain='owned-'+ownedHost.machineId;f.membership.custodyProfile=createGraphCustodyProfile(f.membership,{mode:'owned-machine',witnessPublicKey,hostMachineId:ownedHost.machineId},f.owner.privateKey);f.membership.signature=signGraphRecord('graph-membership-v1',unsigned(f.membership),f.owner.privateKey);}
 let bootstrapPublication:GraphCustodyBootstrapPublication|undefined;const bootstrapStores:GraphCustodyBootstrapStore[]=[];
 if(ownedHost){
  const envelope=createGraphOwnerRecoveryEnvelope(f.owner.privateKey,f.membership),raw={v:1 as const,agentId:'echo',principalKey:'owner:echo',admissionId:'native-owned-fixture-owner-request',authenticationMethod:'owner-device' as const,requestId:'native-owned-fixture-bootstrap',ownerRecoveryHash:canonicalHash(envelope),profileHash:canonicalHash(f.membership.custodyProfile),membershipHash:canonicalHash(f.membership),nativeLeaseHash:canonicalHash(f.originalLease),machineId:f.members[0].machineId,acceptedAt:new Date().toISOString()};
  bootstrapPublication={v:1,ownerPublicKey,membership:f.membership,lease:f.lease,originalLease:f.originalLease,admission:{...raw,signature:signGraphRecord(GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,raw,f.members[0].signing.privateKey)}};
  const pins=managers.map(manager=>{const identities=new IdentityStore({stateDir:manager.baseDir}),receipt=new GraphOwnerRecoveryStore({stateDir:manager.baseDir,agentId:'echo',identity:manager,identities}).put(envelope,f.membership,ownerPublicKey),store=new GraphCustodyBootstrapStore(manager.baseDir,'echo');bootstrapStores.push(store);return store.pin(bootstrapPublication!,f.membership.members,manager.loadIdentity().machineId,manager.loadSigningKey(),receipt);});
  for(const store of bootstrapStores)for(const pin of pins)store.receivePin(pin,f.membership.members);
 }
 const databasePath=ownedCustodyHostIndex===undefined?path.join(await temp(),'witness.sqlite'):path.join(managers[ownedCustodyHostIndex].baseDir,'conversation-graph','custody.sqlite');
 const openService=()=>new GraphWitnessService({databasePath,witnessId:'independent-witness',failureDomain:f.membership.failureDomain,signingPrivateKey:f.witness.privateKey,ownedHost,
  enrollments:{echo:{ownerPublicKey,bearerToken:'runtime-test-token',...enrollmentOptions}},installedFailureDomains:['installed-first','installed-second']});
 const service=ownedCustodyHostIndex===undefined?openService():bootstrapStores[ownedCustodyHostIndex].openDatabase(f.membership.members,managers[ownedCustodyHostIndex].loadIdentity().machineId,databasePath,openService);witnesses.push(service);
 const witnessApp=express();witnessApp.use(express.json({limit:'3mb'}));witnessApp.use(createGraphWitnessRoutes(service));const port=await listen(witnessApp);
 const witness=new GraphWitnessClient({baseUrl:`http://127.0.0.1:${port}`,agentId:'echo',bearerToken:'runtime-test-token',witnessId:'independent-witness',witnessPublicKey,ownerPublicKey,expectedFailureDomain:f.membership.failureDomain,allowLoopbackHttpForTests:true,...enrollmentOptions});await witness.registerMembership(f.membership);
 const options:ConversationGraphReplicationRuntimeOptions[]=[];const leaseStores:LocalLeaseStore[]=[];const apps:express.Express[]=[];
 const privateHost=Object.values(os.networkInterfaces()).flat().find(row=>row&&row.family==='IPv4'&&!row.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(row.address))?.address;
 if(!privateHost)throw new Error('actual-private-interface-required-for-real-resolver-test');
 for(const manager of managers){const machineId=manager.loadIdentity().machineId;const lock=new SingleInstanceLock({stateDir:manager.baseDir});expect((await lock.acquire()).acquired).toBe(true);locks.push(lock);
  const localLease=new LocalLeaseStore({filePath:path.join(manager.baseDir,'lease.json')});localLease.casWrite(f.originalLease);leaseStores.push(localLease);
  const native=new FencedLease({selfMachineId:machineId,sign:data=>crypto.sign(null,Buffer.from(data),manager.loadSigningKey()).toString('base64'),verify:(data,signature,holder)=>{const member=f.members.find(row=>row.machineId===holder);return !!member&&crypto.verify(null,Buffer.from(data),member.signing.publicKey,Buffer.from(signature,'base64'));}}, {leaseTtlMs:30*60000,failoverThresholdMs:60*60000});
  const coordinator=new LeaseCoordinator({lease:native,store:localLease,presumedDeadHolders:()=>new Set(),monotonicNow:()=>0});
  const registry=new ReplicatedKindRegistry();let runtime:ConversationGraphReplicationRuntime|null=null;
  const journal=new CoherenceJournal({stateDir:manager.baseDir,machineId,flushIntervalMs:100000,onReplicatedRecordsCommitted:(kind,entries)=>runtime?.onJournalCommit(kind,entries)});journal.setReplicatedKindRegistry(registry);journal.open();journals.push(journal);
  const resolver=new PeerEndpointResolver({config:{enabled:true,hedgeDelayMs:0,priorityLan:1,priorityTailscale:2,priorityCloudflare:3,tailscaleEnabled:true,lanSubnetGate:false,unhealthyAfterFailures:2,endpointEvictionMs:60000,maxProbeBackoffMs:60000,requestTimeoutMs:5000}});
  const option:ConversationGraphReplicationRuntimeOptions={stateDir:manager.baseDir,scopeVerifier:new ScopeVerifier({projectName:'instar',projectDir:manager.baseDir,topicProjects:{'42':{projectName:'instar',projectDir:manager.baseDir}}}),telegramChatId:'-1001',configuration:{...(testOptions.localCapacityPolicy?{localCapacityPolicy:testOptions.localCapacityPolicy}:{}),agentId:'echo',membership:f.membership,ownerPublicKey,witnessPublicKeys:new Map([['independent-witness',witnessPublicKey]]),witness,peerBearerToken:'runtime-peer-auth'},
   identity:manager,identities:new IdentityStore({stateDir:manager.baseDir}),leaseCoordinator:coordinator,instanceLock:lock,endpointResolver:resolver,journal,registry,
   writeAdmission:new WriteAdmission({thisMachineId:machineId,isReadOnly:()=>!coordinator.holdsLease(),isPoolActive:()=>true,registry:buildWriteDomainRegistry({machineId}),dryRun:true,disableTimers:true}),
   peerStreams:new ReplicatedPeerStreamReader({stateDir:manager.baseDir,registry,selfMachineId:machineId}),clock:new HybridLogicalClock({node:machineId,now:Date.now}),droppedOrigins:new DroppedOriginRegistry({stateDir:manager.baseDir}),conflictStore:new ConflictStore({stateDir:manager.baseDir})};
  options.push(option);runtime=await ConversationGraphReplicationRuntime.open(option);if(!runtime)throw new Error('missing-runtime');if(bootstrapPublication){const authority=new GraphCustodyProfileAuthority({stateDir:manager.baseDir,agentId:'echo',publication:bootstrapPublication});authorities.push(authority);runtime.installCustodyAuthority(authority);}runtimes.push(runtime);
  const app=express();app.use('/internal/conversation-graph',runtime.admissionGuard(),express.json({limit:'1mb'}),runtime.router);apps.push(app);const peerPort=await listen(app);
  for(const other of managers)if(other!==manager){const registry=other.loadRegistry();registry.machines[machineId].endpoints=[{kind:'lan',url:`http://${privateHost}:${peerPort}`}];other.saveRegistry(registry);}
 }
 if(bootstrapPublication){const current=runtimes.slice(-managers.length),frontiers=managers.map((manager,index)=>new GraphCustodyPeerFrontier({stateDir:manager.baseDir,identity:manager,identities:new IdentityStore({stateDir:manager.baseDir}),custodyAuthority:authorities[index],publication:bootstrapPublication!}));for(let index=0;index<current.length;index++)current[index].installPeerFrontier(frontiers[index]);for(let index=0;index<frontiers.length;index++)for(let peer=0;peer<frontiers.length;peer++)if(peer!==index){const challenge=frontiers[index].beginProbe(managers[peer].loadIdentity().machineId),snapshot=frontiers[peer].signedSnapshot(challenge);frontiers[index].observeHead(snapshot.head,challenge);frontiers[index].observe(snapshot,challenge);}}
 return {f,managers,options,authorities,runtime:runtimes[0],peer:runtimes[1],witness,apps,service,leaseStores};
}
