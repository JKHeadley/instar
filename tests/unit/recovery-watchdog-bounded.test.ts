import {afterEach,describe,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'recovery-watchdog-bounded.test:cleanup'});});
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog-bounded-'));dirs.push(dir);fs.mkdirSync(path.join(dir,'agents'));const project=path.join(dir,'project');fs.mkdirSync(path.join(project,'.instar','recovery'),{recursive:true});fs.writeFileSync(path.join(project,'.instar','recovery','host.json'),'{}');return{dir,project,env:{...process.env,INSTAR_WATCHDOG_LAUNCH_AGENTS_DIR:path.join(dir,'agents'),INSTAR_WATCHDOG_STATE_DIR:path.join(dir,'state'),INSTAR_WATCHDOG_LOG_FILE:path.join(dir,'log')}};}
const script=path.resolve('src/templates/scripts/instar-watchdog.sh');
describe('actual enrolled watchdog shell guard',()=>{
 it('retains no guard for an inactive enrollment and skips heavy repair under an active rule',()=>{
  const f=fixture(),marker=path.join(f.dir,'heavy');const code=`source "$1"
MODE=active
recovery_rule_state(){ case "$1" in begin) [ "$MODE" = active ] && return 0 || return 4;; check) return 1;; *) return 0;; esac; }
try_self_heal(){ echo heavy >> "$3"; return 0; }
should_attempt_heal(){ return 0; }; mark_heal_attempt(){ :; }; reset_fail_counter(){ :; }; record_recovery_rule_stop(){ :; }; recovery_stop_rule(){ return 0; }; launchctl(){ return 0; }; sleep(){ :; }
# Positional args in the repair stub are function-local, so retain its marker.
HEAVY_MARKER="$3"
try_self_heal(){ echo heavy >> "$HEAVY_MARKER"; return 0; }
recovery_begin_rule "$2" ai.instar.a
printf 'active=%s\\n' "$RECOVERY_RULE_GUARDED"
handle_bind_fail ai.instar.a "$2" /unused/plist invalid
recovery_end_rule
MODE=inactive
recovery_begin_rule "$2" ai.instar.a
printf 'inactive=%s\\n' "$RECOVERY_RULE_GUARDED"
handle_bind_fail ai.instar.a "$2" /unused/plist invalid
`;
  const result=spawnSync('bash',['-c',code,'fixture',script,f.project,marker],{env:f.env,encoding:'utf8',timeout:10000});expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('active=true');expect(result.stdout).toContain('inactive=false');expect(fs.readFileSync(marker,'utf8').trim().split('\n')).toEqual(['heavy']);
 });
 it('routes active-rule launchctl through a bounded owned subprocess with exact arguments',()=>{
  const f=fixture(),event=path.join(f.dir,'event.json'),preload=path.join(f.dir,'preload.cjs'),node=path.join(f.dir,'node');fs.writeFileSync(preload,`require('node:child_process').spawnSync=(file,args,options)=>{require('node:fs').writeFileSync(${JSON.stringify(event)},JSON.stringify({file,args,timeout:options.timeout,killSignal:options.killSignal}));return{status:0,stdout:'',stderr:''};};`);fs.writeFileSync(node,`#!/bin/sh\nexec '${process.execPath}' --require '${preload}' "$@"\n`,{mode:0o700});
  const code='source "$1"; RECOVERY_RULE_GUARDED=true; resolve_node(){ printf "%s" "$TEST_NODE"; }; launchctl list ai.instar.a';const result=spawnSync('bash',['-c',code,'fixture',script],{env:{...f.env,TEST_NODE:node},encoding:'utf8',timeout:10000});expect(result.status,result.stderr).toBe(0);expect(JSON.parse(fs.readFileSync(event,'utf8'))).toEqual({file:'/bin/launchctl',args:['list','ai.instar.a'],timeout:5000,killSignal:'SIGKILL'});
 });
});
