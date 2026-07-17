/**
 * Terminal delivery controller for token-burn alerts.
 *
 * A configured Telegram topic can disappear permanently. Retrying that topic
 * on every detector interval is not recovery: it is an unbounded silent loop.
 * This controller quarantines only terminal topic failures, persists that
 * decision across restarts, and reroutes alerts through the durable Attention
 * queue. Transient failures remain retryable and are never blindly duplicated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface BurnAttentionInput {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export interface BurnAlertDeliveryDeps {
  sendToTopic: (topicId: number, text: string) => Promise<unknown>;
  raiseAttention: (item: BurnAttentionInput) => Promise<unknown>;
  hasAttentionItem?: (id: string) => boolean;
  stateFile?: string;
  now?: () => number;
  log?: (line: string) => void;
}

interface TerminalTopicState {
  version: 1;
  topicId: number;
  terminalAt: string;
  reason: string;
  noticeId: string;
  /** Retained until the durable Attention store confirms custody. */
  pendingNotice?: BurnAttentionInput;
}

export function isTerminalBurnAlertTopicError(error: unknown): boolean {
  const errorText = error instanceof Error ? error.message : String(error);
  return /message thread not found|thread not found|topic[ _-]?deleted|topic[ _-]?closed|chat not found/i.test(errorText);
}

export class BurnAlertDelivery {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private terminal: TerminalTopicState | null;

  constructor(private readonly deps: BurnAlertDeliveryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((line) => console.warn(line));
    this.terminal = this.loadState();
  }

  async deliver(topicId: number, text: string): Promise<void> {
    if (this.terminal?.pendingNotice && this.terminal.topicId === topicId) {
      await this.recoverPending();
    } else if (this.terminal?.pendingNotice && this.terminal.topicId !== topicId) {
      // Configuration repair must not be held hostage by the old Attention
      // outage. Try the retained original on the newly configured destination,
      // but continue on to the current alert even if that recovery is ambiguous.
      await this.recoverPendingToTopic(topicId);
    }
    // The Attention store is a second durable witness. It preserves quarantine
    // even if the small controller state file could not be written previously.
    if (!this.terminal && this.deps.hasAttentionItem?.(`burn-alert-topic-terminal-${topicId}`)) {
      this.terminal = {
        version: 1,
        topicId,
        terminalAt: new Date(this.now()).toISOString(),
        reason: 'Recovered from durable Attention terminal notice.',
        noticeId: `burn-alert-topic-terminal-${topicId}`,
      };
      this.saveState(this.terminal);
    }
    if (this.terminal?.topicId === topicId) {
      await this.routeAlertToAttention(topicId, text);
      return;
    }

    try {
      await this.deps.sendToTopic(topicId, text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!isTerminalBurnAlertTopicError(error)) {
        this.log(`[burn-detection] alert send to topic ${topicId} failed transiently: ${reason}`);
        return;
      }

      const retainedOriginal = this.terminal?.pendingNotice
        ? this.terminal.pendingNotice.description ?? this.terminal.pendingNotice.summary
        : null;
      const pendingDescription = retainedOriginal && retainedOriginal !== text
        ? `${retainedOriginal}\n\n--- Later alert after destination change ---\n\n${text}`
        : text;
      const pendingNotice: BurnAttentionInput = {
        id: `burn-alert-topic-terminal-${topicId}`,
        title: 'Token-burn alert destination retired',
        summary: `The configured token-burn alert topic (${topicId}) no longer exists. I stopped retrying it and rerouted this alert here.`,
        description: pendingDescription,
        category: 'Token burn monitoring',
        priority: 'HIGH',
        sourceContext: `burn-detection:terminal-topic:${topicId}`,
      };
      this.terminal = {
        version: 1,
        topicId,
        terminalAt: new Date(this.now()).toISOString(),
        reason,
        noticeId: pendingNotice.id,
        pendingNotice,
      };
      const statePersisted = this.saveState(this.terminal);
      this.log(`[burn-detection] topic ${topicId} is permanently unavailable; quarantined and rerouting to Attention`);
      try {
        await this.recoverPending();
      } catch (attentionError) {
        if (!statePersisted) {
          throw new Error(`Burn alert reached a terminal destination but neither durable store accepted it: ${attentionError instanceof Error ? attentionError.message : String(attentionError)}`);
        }
        throw attentionError;
      }
    }
  }

  /** Replay a notice whose state was persisted before Attention accepted it. */
  async recoverPending(): Promise<void> {
    const pending = this.terminal?.pendingNotice;
    if (!pending) return;
    try {
      await this.deps.raiseAttention(pending);
    } catch (error) {
      this.log(`[burn-detection] terminal notice remains pending durable handoff: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    if (!this.terminal || this.terminal.pendingNotice?.id !== pending.id) return;
    delete this.terminal.pendingNotice;
    // A failed clear is safe: the stable Attention id makes boot replay a
    // no-op, after which another clear attempt is made.
    this.saveState(this.terminal);
  }

  private async recoverPendingToTopic(topicId: number): Promise<void> {
    const pending = this.terminal?.pendingNotice;
    if (!pending) return;
    const original = pending.description ?? pending.summary;
    try {
      await this.deps.sendToTopic(topicId, original);
    } catch (error) {
      this.log(`[burn-detection] retained alert could not yet move to newly configured topic ${topicId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!this.terminal || this.terminal.pendingNotice?.id !== pending.id) return;
    delete this.terminal.pendingNotice;
    this.saveState(this.terminal);
  }

  private async routeAlertToAttention(topicId: number, text: string): Promise<void> {
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 20);
    await this.deps.raiseAttention({
      id: `burn-alert-rerouted-${topicId}-${digest}`,
      title: 'Token-burn alert',
      summary: text,
      category: 'Token burn monitoring',
      priority: 'HIGH',
      sourceContext: `burn-detection:rerouted-from:${topicId}`,
    });
  }

  private loadState(): TerminalTopicState | null {
    if (!this.deps.stateFile) return null;
    if (!fs.existsSync(this.deps.stateFile)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf8')) as Partial<TerminalTopicState>;
      if (parsed.version !== 1 || typeof parsed.topicId !== 'number' || typeof parsed.noticeId !== 'string') {
        throw new Error('invalid terminal-state shape');
      }
      return parsed as TerminalTopicState;
    } catch (error) {
      // Fail closed: corrupt quarantine state must never mean "retry the dead
      // topic." AgentServer's enclosing startup guard keeps this subsystem down.
      throw new Error(`Cannot load burn-alert terminal state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private saveState(state: TerminalTopicState): boolean {
    if (!this.deps.stateFile) {
      this.log('[burn-detection] no state file configured; relying on durable Attention custody');
      return false;
    }
    const dir = path.dirname(this.deps.stateFile);
    const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.deps.stateFile);
      return true;
    } catch (error) {
      // @silent-fallback-ok — this failure is explicitly surfaced through the
      // injected logger and the caller receives false so it can require the
      // independent durable Attention handoff before accepting custody.
      try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'BurnAlertDelivery.saveState cleanup' }); } catch { /* @silent-fallback-ok — cleanup is best effort; the persistence failure is logged below */ }
      this.log(`[burn-detection] failed to persist terminal topic state: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
