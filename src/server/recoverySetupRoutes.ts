/** Operator entry point. Machine keys and admission authority are never supplied by HTTP callers. */
import { Router, type Request } from 'express';
import { recoveryCanonical, validRecoveryId, validateRecoveryPrincipals, type RecoveryPrincipal } from '../recovery/RecoveryProtocol.js';

export interface RecoveryGrantRequest {
  action:'grant'; agentId:string; machineId:string; machineName:string; publicKey:string; principals:RecoveryPrincipal[]; peerNames?:Record<string,string>;
}
export interface RecoverySetupDeps {
  verifyOperator(req:Request):boolean;
  /** Must derive from installed release pin + host manifest; scrub all endpoints and keys. */
  status():unknown;
  relayOrigin():string|null;
  agentId:string;
  /** Verified MachineAuth adverts / current pairing ledger only; no request-selected keys. */
  grantRequest():Promise<RecoveryGrantRequest>;
  prepare():Promise<unknown>;
  /** Validated authority checkpoint and exact locally prepared config only. */
  install():Promise<unknown>;
}
export function recoveryOwnerLink(relayOrigin:string,request:RecoveryGrantRequest):string {
  const url=new URL(relayOrigin);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('recovery-setup-relay-invalid');
  if(!validRecoveryId(request.agentId)||!validRecoveryId(request.machineId)||typeof request.machineName!=='string'||request.machineName.length>200||request.action!=='grant')throw new Error('recovery-setup-request-invalid');
  validateRecoveryPrincipals(request.principals,[]);
  url.pathname='/v1/recovery/phone';
  url.hash=new URLSearchParams({agent:request.agentId,request:Buffer.from(recoveryCanonical(request)).toString('base64url')}).toString();
  return url.toString();
}
export function createRecoverySetupRoutes(deps:RecoverySetupDeps):Router {
  const router=Router();
  router.use('/recovery/setup',(req,res,next)=>{
    if(!deps.verifyOperator(req)){res.status(403).json({error:'operator-session-required',detail:'Unlock the dashboard to set up recovery.'});return;}next();
  });
  router.get('/recovery/setup',(_req,res)=>res.json({setup:deps.status(),phonePath:'/dashboard/recovery.html'}));
  const action=(name:'prepare'|'install')=>async(_req:Request,res:import('express').Response)=>{
    try {res.json(await deps[name]());}catch(error){const reason=error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-setup-unavailable';res.status(409).json({error:reason,detail:'Recovery setup is incomplete. This machine continues serving ordinary work.'});}
  };
  router.post('/recovery/setup/prepare',action('prepare'));
  router.post('/recovery/setup/install',action('install'));
  router.post('/recovery/setup/owner-link',async(_req,res)=>{
    try {const origin=deps.relayOrigin();if(!origin)throw new Error('recovery-authority-setup-required');const request=await deps.grantRequest();if(request.agentId!==deps.agentId)throw new Error('recovery-setup-agent-mismatch');res.json({url:recoveryOwnerLink(origin,request),state:'owner-approval-required',scope:'fixed-recovery-verbs-only'});}
    catch(error){res.status(409).json({error:error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-setup-unavailable'});}
  });
  return router;
}
