// safe-fs-allow: test fixture — caller owns SafeFsExecutor temporary cleanup.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { LocalVerifyService, type LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import { buildLocalVerifyService } from '../../src/localVerify/localVerifyWiring.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
export function timingFixture(home: string, production: boolean) {
  const stateDir=path.join(home,'.instar');fs.mkdirSync(stateDir,{recursive:true});fs.mkdirSync(path.join(home,'.git'));fs.mkdirSync(path.join(home,'scripts'));
  fs.writeFileSync(path.join(home,'scripts/safe-merge.mjs'),'// test source checkout\n');
  let now=Date.now(),busy=true,baseSha='b'.repeat(40);
  const children: Array<{resultPath:string;resolve:(x:{status:number;signal:null})=>void;headSha:string;baseSha:string;pr:number}> = [];
  const seams: LocalVerifyServiceSeams={
    now:()=>now, prView:async(pr)=>({author:{login:'EchoOfDawn'},isCrossRepository:false,headRefName:`echo/test-${pr}`,headRefOid:pr.toString(16).padStart(4,'0').repeat(10),baseRefName:'main',baseRefOid:'b'.repeat(40)}),
    isPrOpen:async()=>true,baseHead:async()=> baseSha,foreignSuiteHolders:()=>busy?[{pid:1}]:[],suiteCapacity:()=>1,setTimer:()=>{},
    spawnRun:(args)=>{const input=JSON.parse(fs.readFileSync(args.args[args.args.indexOf('--input')+1],'utf8'));let resolve!:(x:{status:number;signal:null})=>void;
      const exited=new Promise<{status:number;signal:null}>((r)=>{resolve=r;});children.push({...input,resultPath:args.args[args.args.indexOf('--result')+1],resolve});return{pid:90001,exited};},
    isGroupAlive:()=>false,killGroup:()=>{},readProcessArgs:async()=>null,
  };
  let svc:LocalVerifyService;
  if(production){
    const built=buildLocalVerifyService({config:{enabled:true,operatorGhLogin:'JKHeadley'},expectedGhLogin:'EchoOfDawn',repo:'JKHeadley/instar',repoPath:home,stateDir,agentHome:home,machineId:'m_timing',mainEntry:process.execPath});
    if(!built.service)throw new Error(`production builder refused:${built.reason}`);svc=built.service;Object.assign((svc as unknown as {seams:LocalVerifyServiceSeams}).seams,seams);
  }else svc=new LocalVerifyService({repo:'JKHeadley/instar',stateDir,agentHome:home,expectedGhLogin:'EchoOfDawn',operatorGhLogin:'JKHeadley',verifierVersion:'v1',nodePath:process.execPath,mainEntry:process.execPath,remoteUrl:'https://github.com/JKHeadley/instar.git',machineId:'m_timing',nodeVersion:'v24',protectedList:[],baseEnv:{PATH:process.env.PATH!},nice:false},seams);
  const ctx={config:{projectName:'timing',projectDir:home,stateDir,port:0},sessionManager:{listRunningSessions:()=>[]},state:{getJobState:()=>null,getSession:()=>null},scheduler:null,telegram:null,relationships:null,feedback:null,dispatches:null,updateChecker:null,autoUpdater:null,autoDispatcher:null,quotaTracker:null,publisher:null,viewer:null,tunnel:null,evolution:null,watchdog:null,triageNurse:null,topicMemory:null,feedbackAnomalyDetector:null,discoveryEvaluator:null,greenPrAutoMerger:null,guardLatchStore:null,localVerify:svc,localVerifyStatus:null,startTime:new Date()} as unknown as RouteContext;
  const app=express();app.use(express.json());app.use(createRoutes(ctx));
  const rows=()=>JSON.parse(fs.readFileSync(path.join(stateDir,'state/local-verify/throughput-metrics.json'),'utf8')).rows;
  return{app,svc,rows,stateDir,children,setBase:(value:string)=>{baseSha=value;},setBusy:(v:boolean)=>{busy=v;},advance:()=>{now+=1000;},finish:async()=>{
    const c=children[0];if(!c)throw new Error('no actual child seam invoked');now+=1000;
    const record:LocalVerifyRecord={repo:'JKHeadley/instar',pr:c.pr,headSha:c.headSha,baseSha:c.baseSha,baseRefName:'main',mergeTree:'c'.repeat(40),lanes:[],inventoryCoverage:{expectedFiles:3,reportedFiles:3,complete:true},nodeVersion:'v24',machineId:'m_timing',startedAt:new Date(now-1000).toISOString(),finishedAt:new Date(now).toISOString(),outcome:'failure',harnessChanging:false,protectedPath:false,skipsAdded:false,testsRemoved:false,verifierVersion:'v1',policyHash:'p1'};
    // Only the child process boundary is simulated; completion imports its real result file.
    fs.writeFileSync(c.resultPath,JSON.stringify({kind:'record',record,reasons:['test failure'],overlaps:[],keptWorktree:null}));c.resolve({status:0,signal:null});await svc.whenIdle();
  }};
}
