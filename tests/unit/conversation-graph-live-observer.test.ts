import {it,expect} from 'vitest';import http from 'node:http';import express from 'express';
// Test-only JS observer; it reads evidence and grants no authority.
import {observeGraphFixtureRequest} from '../helpers/conversation-graph-live-observer.mjs';
it('records the original mounted POST path once and distinguishes closed from completed responses',async()=>{
 const observations:any[]=[],app=express();app.use(express.json());app.use('/mobile/conversation-graph',(req,res)=>{if(req.path==='/changes'){req.url='/changes';res.json({ok:true});}else{res.writeHead(200);res.write('partial');setImmediate(()=>res.destroy());}});
 const server=http.createServer((req,res)=>{observeGraphFixtureRequest(req,res,{bind:'127.0.0.1',observations,deviceAdmittedAt:()=>null,deviceAdmissionIdentity:()=>null,deviceAdmittedHost:()=>null,erasureIds:new Set()});app(req,res);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address() as any).port}`;
 try{const r=await fetch(url+'/mobile/conversation-graph/changes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'actual-post-observation'})});await r.json();expect(observations).toHaveLength(1);expect(observations[0]).toMatchObject({method:'POST',path:'/mobile/conversation-graph/changes',requestId:'actual-post-observation',responseCompleted:true,responseClosedBeforeFinish:false});
  try{const unfinished=await fetch(url+'/mobile/conversation-graph/unfinished');await unfinished.text();}catch{/* actual socket close is the expected transport result */}
  await new Promise(resolve=>setTimeout(resolve,20));expect(observations).toHaveLength(2);expect(observations[1]).toMatchObject({path:'/mobile/conversation-graph/unfinished',responseCompleted:false,responseClosedBeforeFinish:true,deviceAdmittedAt:null});
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
