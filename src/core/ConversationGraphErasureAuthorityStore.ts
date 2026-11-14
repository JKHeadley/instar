import {GraphCustodyProfileAuthority} from './GraphCustodyProfileAuthority.js';
/** Durable verified negative authority. Pins alone never authorize deletion. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {canonicalHash,canonicalJson,exactFields,hash,type GraphMembershipEpoch,type GraphWitnessErasure} from './GraphWitnessTypes.js';
import {verifyGraphErasureAuthority,type GraphErasureAuthority} from './GraphErasureProtocol.js';
const MAX_ROLE=32*1024*1024,MAX_INDEX=65536;
export class ConversationGraphErasureAuthorityStore {
 private custodyAuthority:GraphCustodyProfileAuthority|null=null;
 private readonly known=new Map<string,GraphErasureAuthority>();
 constructor(private readonly directory:string,private readonly anchor:GraphMembershipEpoch|undefined,private readonly owner:crypto.KeyLike,private readonly keys:ReadonlyMap<string,crypto.KeyLike>){}
 installCustodyAuthority(authority:GraphCustodyProfileAuthority):void{
  const owner=this.owner instanceof crypto.KeyObject&&this.owner.type==='public'?this.owner:crypto.createPublicKey(this.owner);
  if(!(authority instanceof GraphCustodyProfileAuthority)||authority.agentId!==this.anchor?.agentId||!crypto.createPublicKey(authority.ownerPublicKey).export({type:'spki',format:'der'}).equals(owner.export({type:'spki',format:'der'}))||this.custodyAuthority&&this.custodyAuthority!==authority)throw new Error('graph-erasure-actual-authority-mismatch');this.custodyAuthority=authority;
 }
 verificationKey(witnessId:string):crypto.KeyLike|undefined{return this.currentKeys().get(witnessId);}
 context(proof:GraphWitnessErasure):GraphErasureAuthority|null{const known=this.known.get(canonicalHash(proof));return known?structuredClone(known):null;}
 private currentKeys():ReadonlyMap<string,crypto.KeyLike>{if(!this.custodyAuthority)return this.keys;const lineage=this.custodyAuthority.verifiedNegativeRoleLineage(),keys=new Map(this.keys);for(const membership of [lineage.genesis,...[...lineage.activations,...lineage.memberLossActivations].map(row=>row.certificate.newMembership)])if(membership.custodyProfile)keys.set(membership.witnessId,membership.custodyProfile.witnessPublicKey);return keys;}
 has(proof:GraphWitnessErasure):boolean{return this.known.has(canonicalHash(proof));}
 async accept(proof:GraphWitnessErasure,authority?:GraphErasureAuthority):Promise<void>{
  if(!authority){if(this.has(proof))return;throw new Error('graph-erasure-authority-missing');}
  const anchor=this.custodyAuthority?.verifiedNegativeRoleLineage().current??this.anchor;if(!anchor||!verifyGraphErasureAuthority(authority,proof,anchor,this.owner,this.currentKeys()))throw new Error('graph-erasure-issuer-authority-invalid');
  const role={membership:authority.membership,activations:authority.activations},roleHash=canonicalHash(role);
  await this.publish(`${roleHash}.role.json`,role,MAX_ROLE,true);
  await this.publish(`${canonicalHash(proof)}.authority.json`,{v:1,roleHash,endorsement:authority.endorsement},MAX_INDEX,false);
  this.known.set(canonicalHash(proof),structuredClone(authority));
 }
 async restore(proof:GraphWitnessErasure):Promise<void>{
  const index=await this.read(`${canonicalHash(proof)}.authority.json`,MAX_INDEX) as {v:1;roleHash:string;endorsement:GraphErasureAuthority['endorsement']};
  if(!exactFields(index,['v','roleHash','endorsement'])||index.v!==1||!hash(index.roleHash))throw new Error('graph-erasure-authority-index-invalid');
  const role=await this.read(`${index.roleHash}.role.json`,MAX_ROLE) as Pick<GraphErasureAuthority,'membership'|'activations'>;
  if(!exactFields(role,['membership','activations'])||canonicalHash(role)!==index.roleHash)throw new Error('graph-erasure-role-archive-invalid');
  const authority={...role,endorsement:index.endorsement};
  // This replays an already persisted negative fact, never admits a fresh
  // request from a retired signer. Full historical activation is still proved.
  if(!verifyGraphErasureAuthority(authority,proof,role.membership,this.owner,this.keys))throw new Error('graph-erasure-role-archive-untrusted');
  this.known.set(canonicalHash(proof),structuredClone(authority));
 }
 private async read(name:string,limit:number):Promise<unknown>{const file=await fs.open(path.join(this.directory,name),'r');try{const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw new Error('graph-erasure-authority-capacity');return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}}
 private async publish(name:string,value:unknown,limit:number,immutable:boolean):Promise<void>{
  const bytes=canonicalJson(value);if(Buffer.byteLength(bytes)>limit)throw new Error('graph-erasure-authority-capacity');
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});const parent=await fs.open(path.dirname(this.directory),'r');try{await parent.sync();}finally{await parent.close();}
  const target=path.join(this.directory,name),temporary=`${target}.${crypto.randomUUID()}.tmp`,file=await fs.open(temporary,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  try{if(immutable){try{await fs.link(temporary,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||canonicalHash(await this.read(name,limit))!==canonicalHash(value))throw error;}}else await fs.rename(temporary,target);
   const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
  }finally{try{await SafeFsExecutor.safeUnlink(temporary,{operation:'graph-erasure:authority-scratch-cleanup'});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 }
}
