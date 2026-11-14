import {verifyGraphCustodyRetirement,type GraphOwnedTransitionProof} from './GraphCustodyProfileAuthority.js';
/** Same protocol handlers and cryptographic client, without opening a local port. */
import {graphWitnessEndpoints} from './GraphWitnessDispatcher.js';
import {GraphWitnessError,type GraphWitnessService} from './GraphWitnessService.js';
import {canonicalHash,canonicalJson,verifyMembershipEpoch,verifyMembershipActivation,type GraphMembershipActivationCertificate,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
/** These endpoints can admit or endorse positive custody. Historical metadata,
 * owner-signed transition plumbing and priority negative erasure stay reachable. */
export function graphCustodyRequiresRoleFrontier(method:'GET'|'POST',requestPath:string):boolean{
 if(method!=='POST')return false;const url=new URL(requestPath,'https://custody.invalid'),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);if(parts[0]!=='v1'||parts[1]!=='agents')return false;
 return ['lease','recovered-source','native-source-uploads'].includes(parts[3])||parts[3]==='adopt-pending'||parts[3]==='operations'&&['prepare','commit'].includes(parts[5]);
}
export interface GraphCustodyTransport {
 readonly agentId:string;readonly witnessId:string;readonly profileHash:string;readonly membershipEpoch:number;
 request(method:'GET'|'POST',path:string,body?:unknown):Promise<{status:number;json:string}>;
}
export function createInProcessGraphCustodyTransport(options:{service:GraphWitnessService;membership:GraphMembershipEpoch;ownerPublicKey:string;bearerToken:string}):GraphCustodyTransport {
 const {service,membership,ownerPublicKey,bearerToken}=options,profile=membership.custodyProfile;
 if(!profile||profile.mode!=='owned-machine'||!verifyMembershipEpoch(membership,ownerPublicKey)||profile.witnessPublicKey!==service.publicKey||!service.authenticate(membership.agentId,bearerToken)||canonicalHash(service.membershipProof(membership.agentId,membership.epoch))!==canonicalHash(membership))throw new Error('owned-custody-transport-authority-invalid');
 return custodyDispatchTransport(service,membership,bearerToken,false);
}
/** Bootstrap-only transport for a new role whose old role is durably retired.
 * A proposed profile alone is insufficient; positive methods remain unavailable. */
export function createStagedGraphCustodyTransport(options:{service:GraphWitnessService;membership:GraphMembershipEpoch;ownerPublicKey:string;bearerToken:string;transition:GraphOwnedTransitionProof}):GraphCustodyTransport{
 const {service,membership,ownerPublicKey,bearerToken,transition}=options,profile=membership.custodyProfile;
 if(!profile||profile.mode!=='owned-machine'||!verifyMembershipEpoch(membership,ownerPublicKey)||canonicalHash(membership)!==canonicalHash(transition.stage.newMembership)||!verifyGraphCustodyRetirement(transition.retirement,transition.stage,transition.holds,ownerPublicKey)||profile.witnessPublicKey!==service.publicKey||!service.authenticate(membership.agentId,bearerToken))throw new Error('owned-staged-custody-authority-invalid');
 return custodyDispatchTransport(service,membership,bearerToken,true);
}
/** Loss ACT is a distinct authority domain; this transport remains negative
 * until physical pins/settlement unlock the actual Core at promotion. */
export function createMemberLossStagedGraphCustodyTransport(options:{service:GraphWitnessService;membership:GraphMembershipEpoch;ownerPublicKey:string;bearerToken:string;activation:GraphMembershipActivationCertificate}):GraphCustodyTransport{
 const {service,membership,ownerPublicKey,bearerToken,activation}=options,profile=membership.custodyProfile;
 if(!profile||profile.mode!=='owned-machine'||!activation.memberLoss||!verifyMembershipActivation(activation,ownerPublicKey,profile.witnessPublicKey)||canonicalHash(activation.newMembership)!==canonicalHash(membership)||canonicalHash(service.membershipActivation(membership.agentId,membership.epoch))!==canonicalHash(activation)||profile.witnessPublicKey!==service.publicKey||!service.authenticate(membership.agentId,bearerToken))throw new Error('owned-loss-staged-custody-authority-invalid');
 return custodyDispatchTransport(service,membership,bearerToken,'member-loss');
}
function custodyDispatchTransport(service:GraphWitnessService,membership:GraphMembershipEpoch,bearerToken:string,bootstrapOnly:boolean|'member-loss'):GraphCustodyTransport{
 const endpoints=graphWitnessEndpoints(service),agentId=membership.agentId,profileHash=canonicalHash(membership.custodyProfile),witnessId=membership.witnessId;
 return Object.freeze({agentId,witnessId,profileHash,membershipEpoch:membership.epoch,async request(method:'GET'|'POST',requestPath:string,body?:unknown){
  try{
   if(!service.authenticate(agentId,bearerToken))throw new GraphWitnessError('witness-auth-required',401);
   if(graphCustodyRequiresRoleFrontier(method,requestPath)&&canonicalHash(service.activeMembershipProof(agentId))!==canonicalHash(membership))throw new GraphWitnessError('owned-custody-profile-epoch-inactive',409);
   if(body!==undefined&&Buffer.byteLength(canonicalJson(body))>3*1024*1024)throw new GraphWitnessError('witness-request-too-large',413);
   const url=new URL(requestPath,'https://custody.invalid');if(url.origin!=='https://custody.invalid'||url.hash)throw new GraphWitnessError('witness-path-invalid',400);
   let value:unknown;
   if(method==='GET'&&url.pathname==='/health')value=service.health();
   else{
    const parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts[0]!=='v1'||parts[1]!=='agents'||parts[2]!==agentId)throw new GraphWitnessError('agent-scope-mismatch',403);
    const negative=parts[3]==='fleet-erasures'||parts[3]==='erasures'&&parts.length===6&&['authority','checkpoint'].includes(parts[5])||method==='GET'&&['memberships','membership-activations'].includes(parts[3]);if(bootstrapOnly===true&&parts[3]!=='bootstrap-transfers'&&!negative)throw new GraphWitnessError('owned-custody-stage-positive-unavailable',409);
    if(bootstrapOnly==='member-loss'){
     const metadata=method==='GET'&&(['memberships','membership-activations','recovery-contexts','pending','inventory-exports'].includes(parts[3])||parts[3]==='operations'&&parts.length===5);
     const b=body as {revalidations?:Array<{proof?:{decision?:string};rewrap?:unknown}>}|undefined,refusal=parts[3]==='adopt-pending'&&Array.isArray(b?.revalidations)&&b.revalidations.every(row=>row.proof?.decision==='refuse'&&row.rewrap===null);
     const cancellation=parts[3]==='operations'&&['cancel','certify-cancellation','certificate-receipt'].includes(parts[5]);
     if(!metadata&&!negative&&!refusal&&!cancellation&&!['settle-member-loss','erased-control'].includes(parts[3]))throw new GraphWitnessError('owned-custody-stage-positive-unavailable',409);
    }
    const endpoint=endpoints.find(candidate=>{const pattern=candidate.path.split('/').filter(Boolean);return candidate.method===method&&pattern.length===parts.length&&pattern.every((part,index)=>part.startsWith(':')||part===parts[index]);});
    if(!endpoint)throw new GraphWitnessError('witness-route-unknown',404);
    const params:Record<string,string>={};endpoint.path.split('/').filter(Boolean).forEach((part,index)=>{if(part.startsWith(':'))params[part.slice(1)]=parts[index];});
    value=endpoint.handle({params,query:Object.fromEntries(url.searchParams),body:body===undefined?undefined:JSON.parse(canonicalJson(body))});
   }
   const json=canonicalJson(value);if(Buffer.byteLength(json)>3*1024*1024)throw new GraphWitnessError('witness-response-too-large',413);return {status:200,json};
  }catch(error){return {status:error instanceof GraphWitnessError?error.status:400,json:canonicalJson({code:error instanceof GraphWitnessError?error.code:'witness-request-invalid'})};}
 }});
}
/** The caller supplies the existing signed registered-peer request channel.
 * Returned bytes still pass the identical client cryptographic verifiers. */
export function createPeerGraphCustodyTransport(options:{membership:GraphMembershipEpoch;ownerPublicKey:string;request:(hostMachineId:string,payload:{method:'GET'|'POST';path:string;body?:unknown})=>Promise<unknown>}):GraphCustodyTransport {
 const membership=JSON.parse(canonicalJson(options.membership)) as GraphMembershipEpoch,profile=membership.custodyProfile;
 if(!profile||profile.mode!=='owned-machine'||!profile.hostMachineId||!verifyMembershipEpoch(membership,options.ownerPublicKey))throw new Error('owned-peer-custody-profile-invalid');
 const agentId=membership.agentId,witnessId=membership.witnessId,host=profile.hostMachineId,profileHash=canonicalHash(profile);
 return Object.freeze({agentId,witnessId,profileHash,membershipEpoch:membership.epoch,async request(method:'GET'|'POST',requestPath:string,body?:unknown){
  if(body!==undefined&&Buffer.byteLength(canonicalJson(body))>3*1024*1024)throw new Error('witness-request-too-large');
  const url=new URL(requestPath,'https://custody.invalid'),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if(url.origin!=='https://custody.invalid'||url.hash||(url.pathname!=='/health'&&(parts[0]!=='v1'||parts[1]!=='agents'||parts[2]!==agentId)))throw new Error('custody-peer-scope-invalid');
  const result=await options.request(host,{method,path:requestPath,...(body===undefined?{}:{body:JSON.parse(canonicalJson(body))})}) as {status:number;json:string};
  if(!result||Object.keys(result).sort().join(',')!=='json,status'||!Number.isSafeInteger(result.status)||result.status<100||result.status>599||typeof result.json!=='string'||Buffer.byteLength(result.json)>3*1024*1024)throw new Error('custody-peer-response-invalid');
  return {status:result.status,json:result.json};
 }});
}
