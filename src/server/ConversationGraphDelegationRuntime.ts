import {DegradationReporter} from '../monitoring/DegradationReporter.js';
/** Conversations v3 §7.2/§8.1: actual post-success spawn hook. The hook reads
 * the launched child's tmux bootstrap capability, not an invented replacement.
 * Prepared-local is durable source intake, never witnessed commitment/Saved.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConversationGraphDelegationSource, ConversationGraphDelegationIngress, validDelegationConversationRef,
  type DelegationSourceDeps, type DelegationIngressDeps, type DelegationResult, type GraphDelegationConversationRef } from '../core/ConversationGraphDelegation.js';
import type { BindTokenPayload } from '../core/conversationBindToken.js';

export interface ConversationGraphDelegationRuntimeDeps {
  source: DelegationSourceDeps;
  verifiedHeadsFor: DelegationIngressDeps['verifiedHeadsFor'];
  parentProjectScope: DelegationIngressDeps['parentProjectScope'];
  tmuxPath: string;
  establishOwnership?:(refs:readonly GraphDelegationConversationRef[])=>void;
  /** Root's actual coordinator may consume the immutable prepared intent. This
   * notification does not assert witness certification or final member receipts. */
  onPrepared?: (prepared: Extract<DelegationResult, { status: 'proposed' }>) => Promise<void>;
}
export type SpawnDelegationHookResult =
  | { status: 'prepared-local'; eventId: string; coordinatorNotified: boolean }
  | { status: 'suggestion'; reason: string }
  | { status: 'refused'; reason: string };

export class ConversationGraphDelegationRuntime {
  private readonly capture: ConversationGraphDelegationSource;
  private readonly ingress: ConversationGraphDelegationIngress;
  constructor(private readonly deps: ConversationGraphDelegationRuntimeDeps) {
    this.capture = new ConversationGraphDelegationSource(deps.source);
    this.ingress = new ConversationGraphDelegationIngress({ ...deps.source, stateDir: deps.source.state.baseDir,
      verifiedHeadsFor: deps.verifiedHeadsFor, parentProjectScope: deps.parentProjectScope,
      currentProjectForConversation: deps.source.projectForConversation });
  }
  private timer:ReturnType<typeof setInterval>|null=null;
  private replaying=false;
  start():void{if(this.timer)return;this.timer=setInterval(()=>{void this.replay();},15000);this.timer.unref();void this.replay();}
  close():void{if(this.timer)clearInterval(this.timer);this.timer=null;}
  async replay():Promise<void>{if(this.replaying||!this.deps.onPrepared)return;this.replaying=true;try{
    for(const source of this.capture.capturedSources()){
      try{const prepared=this.ingress.prepare(source);if(prepared.status==='proposed')await this.deps.onPrepared(prepared);}catch{DegradationReporter.getInstance().report({feature:'Conversations.delegation',primary:'Verified delegation intake',fallback:'Retain pending source without claiming Saved',reason:'delegation-intake-unavailable',impact:'Delegation remains unavailable until repair',internalOnly:true});}
    }
  }catch{DegradationReporter.getInstance().report({feature:'Conversations.delegation',primary:'Verified delegation intake',fallback:'Retain pending source without claiming Saved',reason:'delegation-intake-unavailable',impact:'Delegation remains unavailable until repair',internalOnly:true});}finally{this.replaying=false;}}
  async environment(tmuxSession: string, key: 'INSTAR_BIND_TOKEN' | 'INSTAR_SESSION_ID'): Promise<string | null> {
    try {
      const result = await promisify(execFile)(this.deps.tmuxPath, ['show-environment', '-t', `=${tmuxSession}`, key],
        { timeout: 5000, encoding: 'utf8', maxBuffer: 8192 });
      const row = result.stdout.trim();
      return row.startsWith(`${key}=`) && !row.includes('\n') ? row.slice(key.length + 1) : null;
    } catch { DegradationReporter.getInstance().report({feature:'Conversations.delegation',primary:'Verified delegation intake',fallback:'Retain pending source without claiming Saved',reason:'delegation-intake-unavailable',impact:'Delegation remains unavailable until repair',internalOnly:true}); return null; } // absent/stopped child is refused below, never guessed
  }
  refFor(proof: BindTokenPayload): GraphDelegationConversationRef | null {
    const live = this.deps.source.conversationIdsForSession(proof.sessionName);
    const refs = new Map<string, GraphDelegationConversationRef>();
    for (const alias of proof.bootstrapConversationIds) {
      if (!live.includes(alias)) continue;
      const descriptor = this.deps.source.conversations.resolve(alias);
      if (!descriptor) continue;
      let ref: GraphDelegationConversationRef | null = null;
      if (descriptor.platform === 'telegram' && this.deps.source.telegramChatId)
        ref = { kind: 'conversation', platform: 'telegram', chatId: this.deps.source.telegramChatId, topicId: descriptor.topicId };
      else if (descriptor.platform === 'slack') ref = { kind: 'conversation', platform: 'slack', channelId: descriptor.channelId,
        ...(descriptor.threadTs ? { threadTs: descriptor.threadTs } : {}) };
      else if (descriptor.platform === 'app') ref = { kind: 'conversation', platform: 'app', conversationKey: descriptor.conversationKey };
      if (ref && validDelegationConversationRef(ref)) refs.set(JSON.stringify(ref), ref);
    }
    return refs.size === 1 ? [...refs.values()][0] : null;
  }
  /** Invoke ONLY after spawnSession succeeded, binding was persisted and normal
   * ownership claim finished. Inputs contain no caller-selected parent/ref/title.
   * The caller's existing bearer alone cannot create graph provenance. */
  async afterSuccessfulSpawn(parentBindToken: unknown, spawnedSessionId: string): Promise<SpawnDelegationHookResult> {
    try {
      if (typeof parentBindToken !== 'string') return { status: 'refused', reason: 'parent-bootstrap-proof-required' };
      const parentProof = this.deps.source.bindAuth.verify(parentBindToken);
      const parent = parentProof && this.deps.source.state.findSessionByTmux(parentProof.sessionName);
      const worker = this.deps.source.state.getSession(spawnedSessionId);
      if (!parentProof || !parent || parent.status !== 'running' || !worker || worker.status !== 'running'
        || worker.id === parent.id) return { status: 'refused', reason: 'persisted-live-spawn-required' };
      const workerToken = await this.environment(worker.tmuxSession, 'INSTAR_BIND_TOKEN');
      const runtimeSessionId = await this.environment(worker.tmuxSession, 'INSTAR_SESSION_ID');
      const workerProof = workerToken && this.deps.source.bindAuth.verify(workerToken);
      if (runtimeSessionId !== worker.id || !workerProof || workerProof.sessionName !== worker.tmuxSession)
        return { status: 'refused', reason: 'launched-worker-bootstrap-proof-required' };
      const parentRef = this.refFor(parentProof), workerRef = this.refFor(workerProof);
      if (!parentRef || !workerRef) return { status: 'refused', reason: 'unambiguous-live-conversation-binding-required' };
      if(this.deps.establishOwnership){
        const actualParentToken=await this.environment(parent.tmuxSession,'INSTAR_BIND_TOKEN');
        const actualParentId=await this.environment(parent.tmuxSession,'INSTAR_SESSION_ID');
        if(actualParentToken!==parentBindToken||actualParentId!==parent.id)return{status:'refused',reason:'parent-bootstrap-incarnation-proof-required'};
        this.deps.establishOwnership([parentRef,workerRef]);
      }
      const captured = this.capture.captureSuccessfulSpawn({ sourceId: `spawn-${worker.id}`, parentSessionId: parent.id,
        workerSessionId: worker.id, parentRef, workerRef, parentBindToken, workerBindToken: workerToken as string });
      if (captured.status !== 'captured-local') return captured;
      const prepared = this.ingress.prepare(captured.source);
      if (prepared.status !== 'proposed') return prepared;
      if (this.deps.onPrepared) {
        try { await this.deps.onPrepared(prepared); }
        catch { return { status: 'prepared-local', eventId: prepared.core.eventId, coordinatorNotified: false }; }
      }
      return { status: 'prepared-local', eventId: prepared.core.eventId, coordinatorNotified: !!this.deps.onPrepared };
    } catch { return { status: 'refused', reason: 'spawn-provenance-unavailable' }; }
  }
}
