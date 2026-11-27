import {describe,it,expect} from 'vitest';
import crypto from 'node:crypto';
import {SecretProvisioner,SecretShareHandler,buildSecretShareCommand,filterSecretsForSync,type SecretShareCommand} from '../../src/core/SecretSync.js';
import {decryptFromSync,type Secrets} from '../../src/core/SecretStore.js';

function peerKeys(){const pair=crypto.generateKeyPairSync('x25519');return{privateKey:pair.privateKey,
 publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64')};}
const localNames=['conversation_graph_owner_control_key','conversation_graph_custody_role_key',
 'conversation_graph_peer_bearer','conversation_graph_peer_bearer_scope','conversation_graph_owned_publication',
 'conversation_graph_owner_intent_policy_key','conversation_graph_custody_agent_id'];

describe('ordinary vault sync cannot distribute graph authority',()=>{
 it('encrypts only ordinary secrets even when the source returns the whole vault',async()=>{
  const peer=peerKeys(),role=crypto.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const vault:Secrets={ordinary:'synthetic ordinary value',conversation_graph_owner_control_key:{privateKey:role},
   conversation_graph_custody_role_key:role,conversation_graph_peer_bearer:'synthetic graph-only token',
   nested:{conversation_graph_owner_intent_policy_key:'synthetic local grant key',allowed:'ordinary nested'}};
  let sent:SecretShareCommand|null=null;
  await new SecretProvisioner({secretsToSync:()=>vault,listPeers:()=>[{machineId:'m_fixture',encryptionPublicKey:peer.publicKey}],
   send:async(_machine,command)=>{sent=command;return{ok:true};}}).provisionAll();
  expect(sent).not.toBeNull();
  expect(decryptFromSync(JSON.parse(sent!.encrypted),peer.privateKey)).toEqual({ordinary:'synthetic ordinary value',nested:{allowed:'ordinary nested'}});
  expect(vault.conversation_graph_custody_role_key).toBe(role);
 });
 it('sends nothing if a vault contains only reserved graph material',async()=>{
  let sends=0;const peer=peerKeys();
  const result=await new SecretProvisioner({secretsToSync:()=>Object.fromEntries(localNames.map(key=>[key,'synthetic'])),
   listPeers:()=>[{machineId:'m_fixture',encryptionPublicKey:peer.publicKey}],send:async()=>{sends++;return{ok:true};}}).provisionAll();
  expect(result).toEqual([]);expect(sends).toBe(0);
 });
 it.each(localNames)('refuses an older sender attempting to replace %s before any store writes',key=>{
  const peer=peerKeys(),writes:string[]=[];
  const handler=new SecretShareHandler({ownEncryptionPrivateKey:()=>peer.privateKey,store:{set:path=>{writes.push(path);}}});
  const command=buildSecretShareCommand({ordinary:'synthetic', [key]:'synthetic local-only value'},{machineId:'m_fixture',encryptionPublicKey:peer.publicKey});
  expect(()=>handler.handle(command,'m_fixture')).toThrow(/machine-local/);expect(writes).toEqual([]);
 });
 it.each([{},[],{privateKey:'synthetic'}])('refuses reserved containers rather than overwriting local keys',value=>{
  const peer=peerKeys(),writes:string[]=[];
  const handler=new SecretShareHandler({ownEncryptionPrivateKey:()=>peer.privateKey,store:{set:key=>{writes.push(key);}}});
  const command=buildSecretShareCommand({nested:{conversation_graph_owner_control_key:value}},{machineId:'m_fixture',encryptionPublicKey:peer.publicKey});
  expect(()=>handler.handle(command,'m_fixture')).toThrow(/machine-local/);expect(writes).toEqual([]);
 });
 it('filters reserved nested paths without changing legacy namespace rules',()=>{
  expect(filterSecretsForSync({nested:{conversation_graph_custody_role_key:'synthetic',normal:'keep'},
   machineIdentityRecovery:{privateKey:'synthetic recovery'},ordinary:'keep'})).toEqual({nested:{normal:'keep'},ordinary:'keep'});
 });
});
