/**
 * SlackRefusedHold — a Slack message whose conversation could not be started is kept and retried,
 * and the person is told (fb-73ad5b9e-f14, B2Lead condition 5).
 *
 * Before this, the live Slack path dropped a 'refused' dispatch: on 2026-11-04 one person's three
 * messages went unanswered for about two hours while the reply helper did not match the installed
 * version, and nobody was told.
 *
 * It retries per conversation on a fixed schedule of about two hours, oldest message first, and
 * never starts anything itself: every retry is the ordinary dispatch, with all of its own checks.
 * After the last try the person is asked to send it again and the messages are dropped.
 *
 * Holds message text on disk (mode 600) only while it waits. Machine-local by design: the machine
 * that took the message from Slack holds it. A retry goes back through the pool routing, so a
 * conversation that moved is answered by the machine that owns it now.
 *
 * @self-action-controller: slack-refused-hold-retry
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Message } from './types.js';
import { isQuietReceipt, type QuietReceipt } from '../messaging/NotificationSelectivityGate.js';

/** Waits between tries, about two hours in all. */
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
export const TICK_MS = 15_000;
/** Failed tries before the operator is told. A refusal that clears in a minute needs nobody. */
export const OPERATOR_AFTER_ATTEMPTS = 3;
export const NOTICE_MAX_ATTEMPTS = 5;
export const MAX_PER_CONVERSATION = 20;
export const MAX_CONVERSATIONS = 100;

export const PERSON_HELD_TEXT =
  "I got your message, but I couldn't start up to answer it just now. I've kept it and will keep trying for about two hours.";
export const PERSON_GAVE_UP_TEXT =
  "I still couldn't start up to answer your message, so it hasn't been handled. Please send it again in a little while.";
export const PERSON_OVERFLOW_TEXT =
  "I can't start up to answer right now and I'm already holding as many messages as I can. Please send this one again in a little while.";
export const PERSON_STOPPED_TEXT =
  "An emergency stop cancelled the message I was holding for you, so it hasn't been handled. Send it again when you're ready.";
export const OPERATOR_TEXT =
  "Your agent can't start a Slack conversation to answer someone. Their message is kept, they've been told, and it's retrying for about two hours. " +
  'Nothing is needed unless this repeats: if it does, ask me in a conversation that works and I will look into why.';

/** Fixed texts this posts into conversations. None of them is the agent answering. */
export const REFUSED_HOLD_NOTICE_TEXTS: readonly string[] = [PERSON_HELD_TEXT, PERSON_GAVE_UP_TEXT, PERSON_OVERFLOW_TEXT, PERSON_STOPPED_TEXT, OPERATOR_TEXT];

/** The brake, pure (shared with the self-action convergence ratchet). */
export function decideRefusedRetry(input: { attempts: number }): 'attempt' | 'gave-up' {
  return input.attempts >= RETRY_DELAYS_MS.length ? 'gave-up' : 'attempt';
}

/** 'explained': refused, and the person was already told why. Not worth another try. */
export type RedispatchOutcome = 'delivered' | 'queued' | 'refused' | 'explained';

interface HeldConversation {
  routingKey: string;
  heldAt: number;
  attempts: number;
  nextTryAt: number;
  /** Threads (or '' for the conversation itself) already told. */
  toldThreads: string[];
  reason: string;
  messages: Message[];
}

interface PersistedState {
  conversations: HeldConversation[];
  operatorTold: boolean;
  operatorQuietId?: string;
  noticeAttempts: number;
}

const initialState = (): PersistedState => ({ conversations: [], operatorTold: false, noticeAttempts: 0 });

export interface SlackRefusedHoldDeps {
  stateFile: string;
  /** The ordinary Slack dispatch. Must not hold again: this class owns the retry. */
  redispatch: (message: Message) => Promise<RedispatchOutcome>;
  /** True only on confirmed delivery to the conversation. */
  notifyConversation: (routingKey: string, text: string, latest: Message | undefined) => Promise<boolean>;
  /** True only when a person can read it. */
  notifyOperator: (text: string) => Promise<boolean | QuietReceipt>;
  report: (input: { reason: string; impact: string }) => void;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /** Tests drive ticks by hand. */
  manualTimers?: boolean;
}

function latestByThread(messages: readonly Message[]): Map<string, Message> {
  const latest = new Map<string, Message>();
  for (const m of messages) latest.set(typeof m.metadata?.threadTs === 'string' ? m.metadata.threadTs : '', m);
  return latest;
}

let active: SlackRefusedHold | null = null;
/** The running instance, for the app's emergency stop. */
export function activeSlackRefusedHold(): SlackRefusedHold | null { return active; }
export function setActiveSlackRefusedHold(instance: SlackRefusedHold | null): void { active = instance; }

export class SlackRefusedHold {
  private state: PersistedState = initialState();
  private timer: NodeJS.Timeout | null = null;
  private working = false;
  private started = false;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };

  constructor(private readonly deps: SlackRefusedHoldDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
  }

  /** Load what a restart interrupted. Nothing retries until start(). */
  boot(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf-8')) as Partial<PersistedState>;
      const conversations = Array.isArray(raw.conversations) ? raw.conversations.map((c) => ({ ...c, toldThreads: c.toldThreads ?? [] })) : [];
      this.state = { ...initialState(), ...raw, conversations };
    } catch { this.state = initialState(); } // @silent-fallback-ok: no file or a bad one means nothing was waiting
  }

  /** The server is fully up: routing, admission and the operator routes all exist. */
  start(): void {
    this.started = true;
    this.ensureTimer();
  }

  /** An emergency stop means nothing held may start anything later. Those people are told. */
  dropAll(reason: string): void {
    const dropped = this.state.conversations;
    if (dropped.length === 0) return;
    this.logger.warn(`[SlackRefusedHold] dropping ${dropped.length} held conversation(s): ${reason}`);
    this.state = initialState();
    this.save();
    this.ensureTimer();
    void (async () => {
      for (const convo of dropped) {
        for (const [, latest] of latestByThread(convo.messages)) await this.safeTell(convo.routingKey, PERSON_STOPPED_TEXT, latest);
      }
    })();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What is waiting, for status and tests. */
  held(): Array<{ routingKey: string; messages: number; attempts: number }> {
    return this.state.conversations.map((c) => ({ routingKey: c.routingKey, messages: c.messages.length, attempts: c.attempts }));
  }

  /** A dispatch was refused. Never throws. */
  async hold(routingKey: string, message: Message, reason: string): Promise<void> {
    let convo = this.state.conversations.find((c) => c.routingKey === routingKey);
    if (convo?.messages.some((m) => m.id === message.id)) return; // a redelivery of one already kept
    const full = convo
      ? convo.messages.length >= MAX_PER_CONVERSATION
      : this.state.conversations.length >= MAX_CONVERSATIONS;
    if (full) {
      this.deps.report({
        reason: `A refused Slack message could not be kept: the hold is full (${reason}).`,
        impact: 'The person was asked to send it again.',
      });
      await this.safeTell(routingKey, PERSON_OVERFLOW_TEXT, message);
      return;
    }
    if (!convo) {
      convo = { routingKey, heldAt: this.now(), attempts: 0, nextTryAt: this.now() + RETRY_DELAYS_MS[0], toldThreads: [], reason, messages: [] };
      this.state.conversations.push(convo);
    }
    convo.reason = reason;
    convo.messages.push(message);
    this.save();
    this.logger.warn(`[SlackRefusedHold] holding a message for ${routingKey}: ${reason}`);
    await this.tellHeld(convo);
    this.ensureTimer();
  }

  /** A message just got through on this conversation: what it holds can go now, in order. */
  async conversationWorks(routingKey: string): Promise<void> {
    const convo = this.state.conversations.find((c) => c.routingKey === routingKey);
    if (!convo) return;
    convo.nextTryAt = 0;
    await this.tick();
  }

  /** One timer pass. */
  async tick(): Promise<void> {
    if (this.working || !this.started) return;
    this.working = true;
    try {
      for (const convo of [...this.state.conversations]) {
        if (!this.isHeld(convo)) continue;
        await this.tellHeld(convo);
        if (!this.isHeld(convo)) continue; // a stop arrived during the await
        if (this.now() >= convo.nextTryAt) await this.retry(convo);
      }
      await this.tellOperatorIfDue();
      if (this.state.conversations.length === 0 && (this.state.operatorTold || this.state.operatorQuietId || this.state.noticeAttempts > 0)) {
        this.state = initialState(); // episode over: a later one tells the operator again
        this.save();
      }
    } finally {
      this.working = false;
    }
    this.ensureTimer();
  }

  private async retry(convo: HeldConversation): Promise<void> {
    // Oldest first, stopping at the first refusal, so a person's messages arrive in order.
    while (convo.messages.length > 0) {
      if (!this.isHeld(convo)) return;
      let outcome: RedispatchOutcome = 'refused';
      try { outcome = await this.deps.redispatch(convo.messages[0]); }
      catch (err) { this.logger.warn(`[SlackRefusedHold] retry for ${convo.routingKey} failed: ${err instanceof Error ? err.message : String(err)}`); }
      if (!this.isHeld(convo)) return; // a stop arrived during the await
      if (outcome === 'refused') break;
      convo.messages.shift();
      this.save();
    }
    if (convo.messages.length === 0) {
      this.drop(convo);
      this.logger.log(`[SlackRefusedHold] ${convo.routingKey} got through after ${convo.attempts + 1} tries`);
      return;
    }
    convo.attempts += 1;
    if (decideRefusedRetry({ attempts: convo.attempts }) === 'gave-up') {
      this.deps.report({
        reason: `A Slack conversation could not be started after ${convo.attempts} tries (${convo.reason}).`,
        impact: `${convo.messages.length} message(s) were not answered. The person was asked to send them again.`,
      });
      let told = true;
      for (const [, latest] of latestByThread(convo.messages)) {
        if (!(await this.safeTell(convo.routingKey, PERSON_GAVE_UP_TEXT, latest))) told = false;
      }
      if (!told) {
        this.deps.report({
          reason: 'A person could not be told that their Slack message was not handled.',
          impact: 'They may still be waiting.',
        });
      }
      this.drop(convo);
      return;
    }
    convo.nextTryAt = this.now() + RETRY_DELAYS_MS[convo.attempts];
    this.save();
  }

  private isHeld(convo: HeldConversation): boolean {
    return this.state.conversations.includes(convo);
  }

  private drop(convo: HeldConversation): void {
    this.state.conversations = this.state.conversations.filter((c) => c !== convo);
    this.save();
  }

  /** One notice per thread: two people in two threads of a channel each hear it. */
  private async tellHeld(convo: HeldConversation): Promise<void> {
    for (const [thread, latest] of latestByThread(convo.messages)) {
      if (convo.toldThreads.includes(thread)) continue;
      if (await this.safeTell(convo.routingKey, PERSON_HELD_TEXT, latest)) {
        convo.toldThreads.push(thread);
        this.save();
      }
    }
  }

  private async safeTell(routingKey: string, text: string, latest: Message | undefined): Promise<boolean> {
    try { return (await this.deps.notifyConversation(routingKey, text, latest)) === true; }
    catch (err) { /* @silent-fallback-ok: an untold person is retried each tick, and a final failure is reported */ this.logger.warn(`[SlackRefusedHold] notice failed: ${err instanceof Error ? err.message : String(err)}`); return false; }
  }

  private async tellOperatorIfDue(): Promise<void> {
    if (this.state.operatorTold || this.state.operatorQuietId || this.state.noticeAttempts >= NOTICE_MAX_ATTEMPTS) return;
    if (!this.state.conversations.some((c) => c.attempts >= OPERATOR_AFTER_ATTEMPTS)) return;
    this.state.noticeAttempts += 1;
    let delivered: boolean | QuietReceipt = false;
    try { delivered = await this.deps.notifyOperator(OPERATOR_TEXT); }
    catch (err) { /* @silent-fallback-ok: `delivered` stays false, which drives the retry and its capped report */ this.logger.warn(`[SlackRefusedHold] operator notice failed: ${err instanceof Error ? err.message : String(err)}`); }
    if (isQuietReceipt(delivered)) this.state.operatorQuietId = delivered.quietId;
    else this.state.operatorTold = delivered === true;
    if (!this.state.operatorTold && !this.state.operatorQuietId && this.state.noticeAttempts >= NOTICE_MAX_ATTEMPTS) {
      this.deps.report({
        reason: 'The operator could not be told that Slack conversations are not starting.',
        impact: 'This report is the only record.',
      });
    }
    this.save();
  }

  private ensureTimer(): void {
    if (this.deps.manualTimers || !this.started) return;
    const needed = this.state.conversations.length > 0;
    if (needed && !this.timer) {
      this.timer = setInterval(() => { void this.tick().catch((err) => this.logger.warn(`[SlackRefusedHold] ${err instanceof Error ? err.message : String(err)}`)); }, TICK_MS);
      this.timer.unref?.();
    } else if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.stateFile);
    } catch (err) {
      this.logger.warn(`[SlackRefusedHold] could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
