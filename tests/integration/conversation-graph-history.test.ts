import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationGraphHistoryRoutes, type ConversationGraphHistoryDeps } from '../../src/server/conversationGraphHistoryRoutes.js';

afterEach(()=>vi.unstubAllGlobals());
function boot(overrides:Partial<ConversationGraphHistoryDeps>={}) {
  const deps:ConversationGraphHistoryDeps={ready:()=>true,verifyOwner:req=>req.get('X-Instar-Operator-Session')==='live-proof',
    resolveSource:()=>({platform:'slack',conversationId:-7,machine:'studio'}),selfMachineId:'m5',localBaseUrl:()=> 'http://127.0.0.1:4062',
    peers:()=>[{machineId:'studio',url:'http://192.168.87.47:4042',kind:'lan'}],authToken:()=> 'test-token',agentId:'echo',...overrides};
  const app=express();app.use(createConversationGraphHistoryRoutes(deps));return {app,deps};
}
const route='/conversation-graph/nodes/eyJraW5kIjoiY29udmVyc2F0aW9uIn0/messages';
describe('owner graph original-history gateway',()=>{
  it('resolves negative Slack ids through their registered holder and ignores supplied machine/URL',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{text:'Original Slack history'}]}),{headers:{'Content-Type':'application/json'}}));
    vi.stubGlobal('fetch',fetcher);const {app}=boot();
    const response=await request(app).get(route+'?machine=attacker&url=https://attacker.example&before=2026-11-05T08%3A00%3A00Z&beforeMessageId=9').set('X-Instar-Operator-Session','live-proof');
    expect(response.status).toBe(200);expect(response.body.messages[0].text).toBe('Original Slack history');
    expect(fetcher).toHaveBeenCalledOnce();const [url,options]=fetcher.mock.calls[0];
    expect(String(url)).toContain('http://192.168.87.47:4042/mobile/chat/slack/-7/messages?');
    expect(String(url)).toContain('machine=studio');expect(String(url)).not.toContain('attacker');
    expect(options.redirect).toBe('error');expect(options.headers.Authorization).toBe('Bearer test-token');
  });
  it('does not fetch private history without current owner proof and certified readiness',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect((await request(boot().app).get(route)).status).toBe(403);
    expect((await request(boot({ready:()=>false}).app).get(route).set('X-Instar-Operator-Session','live-proof')).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('discards a fetched body if ownership expires or the resolved source changes',async()=>{
    let owner=true;
    vi.stubGlobal('fetch',vi.fn(async()=>{owner=false;return new Response(JSON.stringify({messages:[{text:'PRIVATE-CANARY'}]}));}));
    const expired=await request(boot({verifyOwner:()=>owner}).app).get(route);
    expect(expired.status).toBe(403);expect(expired.text).not.toContain('PRIVATE-CANARY');
    let calls=0;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({messages:[{text:'PRIVATE-CANARY'}]}))));
    const changed=await request(boot({resolveSource:()=>({platform:'slack',conversationId:++calls===1?-7:-8,machine:'studio'})}).app).get(route).set('X-Instar-Operator-Session','live-proof');
    expect(changed.status).toBe(404);expect(changed.text).not.toContain('PRIVATE-CANARY');
  });
  it('refuses a fallback credentialed dial after owner expiry without poisoning rope health',async()=>{
    let owner=true;const health=vi.fn();
    const fetcher=vi.fn(async()=>{owner=false;throw new Error('first-rope-unreachable');});
    vi.stubGlobal('fetch',fetcher);
    const {app}=boot({verifyOwner:()=>owner,recordRopeResult:health,peers:()=>[{machineId:'studio',url:'http://192.168.87.47:4042',kind:'lan',
      ropes:[{url:'http://192.168.87.47:4042',kind:'lan'},{url:'https://echo-studio.dawn-tunnel.dev',kind:'cloudflare'}]}]});
    const response=await request(app).get(route);
    expect(response.status).toBe(403);expect(fetcher).toHaveBeenCalledOnce();expect(health).not.toHaveBeenCalled();
  });
  it('withholds fetched history when custody is held during the final source recheck',async()=>{
    let ready=true,calls=0;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({messages:[{text:'PRIVATE-CANARY'}]}))));
    const {app}=boot({ready:()=>ready,resolveSource:async()=>{
      if(++calls===2){await Promise.resolve();ready=false;}
      return {platform:'slack',conversationId:-7,machine:'studio'};
    }});
    const response=await request(app).get(route).set('X-Instar-Operator-Session','live-proof');
    expect(calls).toBe(2);expect(response.status).toBe(503);expect(response.text).not.toContain('PRIVATE-CANARY');
  });
  it('refuses a holder URL before attaching credentials',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const {app}=boot({peers:()=>[{machineId:'studio',url:'https://attacker.example',kind:'last-known-url'}]});
    expect((await request(app).get(route).set('X-Instar-Operator-Session','live-proof')).status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
