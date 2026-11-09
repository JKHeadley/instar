/** Increment C route composition. Not mounted until the increment-A release
 * proofs pass. Mobile mounting also requires the device-signed route allowlist. */
import {Router,type Request,type Response} from 'express';
import {exactFields} from '../core/GraphWitnessTypes.js';
import type {GraphViewer} from '../core/conversationGraphRead.js';
import type {ConversationGraphOwnerChanges,GraphChangeReply} from './ConversationGraphOwnerChanges.js';

export function createConversationGraphChangeRouter(deps:{changes:ConversationGraphOwnerChanges;
 resolveViewer(req:Request,surface:'dashboard'|'mobile'):GraphViewer|null}):Router{
 const router=Router();
 for(const [prefix,surface] of [['/conversation-graph','dashboard'],['/mobile/conversation-graph','mobile']] as const){
  const run=(handler:(req:Request)=>GraphChangeReply|Promise<GraphChangeReply>)=>async(req:Request,res:Response)=>{
   // A request queued behind a long pass can reach the route after the request timeout already answered 408; the client retries with the same requestId.
   if(res.headersSent)return;
   res.setHeader('Cache-Control','no-store');
   const owner=deps.resolveViewer(req,surface);if(!owner)return void res.status(403).json({code:'hierarchy-owner-only'});
   try{
    const result=await handler(req);
    // E2E-PAIRING: EXEMPT — only the post-408 reply path changed; the normal path is unchanged and exercised by tests/e2e/conversation-graph-surface-alive.test.ts, the post-408 path by tests/unit/conversation-graph-change-route-late-reply.test.ts.
    // The request timeout may already have answered 408 while the change was
    // being saved. The change itself still stands; only the reply is dropped.
    if(res.headersSent)return;
    const current=deps.resolveViewer(req,surface);
    if(!current||current.principalKey!==owner.principalKey||current.grantVersion!==owner.grantVersion)return void res.status(403).json({code:'hierarchy-owner-only'});
    if(result.privateMayServe&&!result.privateMayServe())return void res.status(503).json({code:'conversation-graph-not-current'});
    res.status(result.status).json(result.body);
   }catch(error){if(res.headersSent){console.warn(`conversation-graph ${req.method} ${req.path} failed after the request timeout answered: ${error instanceof Error?error.message:String(error)}`);return;}res.status(503).json({code:'conversation-graph-unavailable'});}
  };
  router.post(`${prefix}/changes`,run(req=>exactFields(req.body,['requestId','change'])
   ?deps.changes.submit(req,surface,req.body.requestId,req.body.change):{status:400,body:{code:'invalid-change-request'}}));
  router.get(`${prefix}/changes/:requestId`,run(req=>deps.changes.statusWithLocal(req,surface,req.params.requestId)));
  router.get(`${prefix}/pending`,run(req=>deps.changes.pending(req,surface)));
  router.post(`${prefix}/preview`,run(req=>deps.changes.preview(req,surface,req.body)));
  router.post(`${prefix}/changes/:operationKey/cancel`,run(req=>exactFields(req.body??{},[])
   ?deps.changes.cancel(req,surface,req.params.operationKey):{status:400,body:{code:'invalid-cancel-request'}}));
  for(const action of ['discover','ensure'] as const)router.post(`${prefix}/forget-header/${action}`,run(req=>exactFields(req.body,['effort'])
   ?deps.changes.discoverHeaderErasure(req,surface,req.body.effort,action==='ensure'):{status:400,body:{code:'invalid-erasure-request'}}));
  router.post(`${prefix}/forget-header`,run(req=>exactFields(req.body,['requestId','effort'])
   ?deps.changes.forgetEffortHeader(req,surface,req.body.requestId,req.body.effort):{status:400,body:{code:'invalid-erasure-request'}}));
  router.get(`${prefix}/erasures/:requestId`,run(req=>deps.changes.erasureStatus(req,surface,req.params.requestId,req.query.offset)));
  router.post(`${prefix}/undo`,run(req=>exactFields(req.body,['requestId','undoToken'])
   ?deps.changes.undo(req,surface,req.body.requestId,req.body.undoToken):{status:400,body:{code:'invalid-undo-request'}}));
 }
 return router;
}
