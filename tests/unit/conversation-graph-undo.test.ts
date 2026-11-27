import {describe,expect,it} from 'vitest';
import crypto from 'node:crypto';
import {issueGraphUndo,readGraphUndo,type GraphUndoClaim} from '../../src/core/ConversationGraphUndo.js';

describe('signed placement undo description',()=>{
 it('binds the exact prior parent, principal, machine and operation and rejects changes, expiry and another key',()=>{
  const keys=crypto.generateKeyPairSync('ed25519'),other=crypto.generateKeyPairSync('ed25519');
  const now=Date.now();
  const claim:GraphUndoClaim={v:1,principal:'owner:echo',machineId:'machine-a',operationKey:'graph-event:change-abcdefgh',
   subject:{kind:'conversation',platform:'slack',channelId:'C0123ABCD'},parent:{kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'},expiresAt:now+60000};
  const token=issueGraphUndo(claim,keys.privateKey);
  expect(readGraphUndo(token,keys.publicKey,now)).toEqual(claim);
  expect(readGraphUndo(token,other.publicKey,now)).toBeNull();
  expect(readGraphUndo(token,keys.publicKey,now+60000)).toBeNull();
  const tampered=JSON.parse(Buffer.from(token,'base64url').toString());tampered.claim.parent=null;
  expect(readGraphUndo(Buffer.from(JSON.stringify(tampered)).toString('base64url'),keys.publicKey,now)).toBeNull();
  expect(readGraphUndo(`${token}=`,keys.publicKey,now)).toBeNull();
 });
 it('refuses excessively long validity and malformed destination refs',()=>{
  const keys=crypto.generateKeyPairSync('ed25519'),now=Date.now();
  const claim:GraphUndoClaim={v:1,principal:'owner:echo',machineId:'machine-a',operationKey:'graph-event:change-abcdefgh',
   subject:{kind:'effort',id:'012fdaec-70de-4324-9ef3-22b616fc83ce'},parent:null,expiresAt:now+600001};
  expect(readGraphUndo(issueGraphUndo(claim,keys.privateKey),keys.publicKey,now)).toBeNull();
  expect(()=>issueGraphUndo({...claim,parent:{kind:'effort',id:''}},keys.privateKey)).toThrow();
 });
});
