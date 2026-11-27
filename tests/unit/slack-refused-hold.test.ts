// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATIONS, MAX_PER_CONVERSATION, OPERATOR_TEXT, PERSON_GAVE_UP_TEXT, PERSON_HELD_TEXT, PERSON_OVERFLOW_TEXT, PERSON_STOPPED_TEXT,
  RETRY_DELAYS_MS, SlackRefusedHold, decideRefusedRetry, type RedispatchOutcome,
} from '../../src/core/SlackRefusedHold.js';
import { PRIOR_SHIPPED_SLACK_RELAY_SHA256, repairSlackReplyRelayIfStale, slackReplyRelayReadiness } from '../../src/core/SlackReplyRelayInstaller.js';
import type { Message } from '../../src/core/types.js';
import { createHash } from 'node:crypto';

const msg = (id: string, threadTs?: string): Message => ({
  id, userId: 'U1', content: `text ${id}`, channel: { type: 'slack', identifier: 'D1' }, receivedAt: '2026-11-06T00:00:00Z',
  metadata: threadTs ? { threadTs } : {},
});

describe('SlackRefusedHold', () => {
  let dir: string;
  let now: number;
  let told: Array<[string, string, Message | undefined]>;
  let operator: string[];
  let reports: string[];
  let sent: string[];
  let outcome: (m: Message) => RedispatchOutcome;
  let personDelivers: boolean;
  let operatorDelivers: boolean;

  const make = (start = true) => { const h = new SlackRefusedHold({
    stateFile: path.join(dir, 'hold.json'),
    redispatch: async (m) => { sent.push(m.id); return outcome(m); },
    notifyConversation: async (k, t, l) => { told.push([k, t, l]); return personDelivers; },
    notifyOperator: async (t) => { operator.push(t); return operatorDelivers; },
    report: ({ reason }) => { reports.push(reason); },
    now: () => now,
    manualTimers: true,
  }); if (start) h.start(); return h; };
  const pastNextTry = async (h: SlackRefusedHold, attempt: number) => { now += RETRY_DELAYS_MS[attempt]; await h.tick(); };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-hold-'));
    now = 1_000_000; told = []; operator = []; reports = []; sent = [];
    outcome = () => 'refused'; personDelivers = true; operatorDelivers = true;
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('tells the person at once, keeps the message, and does not retry before it is due', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    expect(told.map(([, t]) => t)).toEqual([PERSON_HELD_TEXT]);
    now += RETRY_DELAYS_MS[0] - 1;
    await h.tick();
    expect(sent).toEqual([]);
    expect(h.held()).toEqual([{ routingKey: 'D1', messages: 1, attempts: 0 }]);
  });

  it('a retry that gets through sends the messages in order and drops them, with no notice beyond the first', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    await h.hold('D1', msg('b'), 'relay');
    outcome = () => 'delivered';
    await pastNextTry(h, 0);
    expect(sent).toEqual(['a', 'b']);
    expect(h.held()).toEqual([]);
    expect(told).toHaveLength(1);
    expect(operator).toEqual([]);
  });

  it('counts queued as handled: durable custody owns it now', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    outcome = () => 'queued';
    await pastNextTry(h, 0);
    expect(h.held()).toEqual([]);
  });

  it('stops at the first refusal so a later message never overtakes an earlier one', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    await h.hold('D1', msg('b'), 'relay');
    await pastNextTry(h, 0);
    expect(sent).toEqual(['a']);
    expect(h.held()[0]).toMatchObject({ messages: 2, attempts: 1 });
  });

  it('a throwing dispatch is a refusal, not a lost message', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    outcome = () => { throw new Error('boom'); };
    await pastNextTry(h, 0);
    expect(h.held()[0]).toMatchObject({ messages: 1, attempts: 1 });
  });

  it('ignores a redelivery of a message it already holds', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    await h.hold('D1', msg('a'), 'relay');
    expect(h.held()[0].messages).toBe(1);
    expect(told).toHaveLength(1);
  });

  it('tells the operator only once it has lasted, once per episode, and again in a later episode', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    for (let i = 0; i < 2; i++) await pastNextTry(h, i);
    expect(operator).toEqual([]);
    await pastNextTry(h, 2);
    await pastNextTry(h, 3);
    expect(operator).toEqual([OPERATOR_TEXT]);
    outcome = () => 'delivered';
    await pastNextTry(h, 4);
    outcome = () => 'refused';
    await h.hold('D1', msg('b'), 'relay');
    for (let i = 0; i < 3; i++) await pastNextTry(h, i);
    expect(operator).toEqual([OPERATOR_TEXT, OPERATOR_TEXT]);
  });

  it('a refusal that clears quickly never reaches the operator', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    await pastNextTry(h, 0);
    outcome = () => 'delivered';
    await pastNextTry(h, 1);
    expect(operator).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('after the last try asks the person to resend, reports it, and stops: no retries ever after', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) await pastNextTry(h, i);
    expect(told.at(-1)?.[1]).toBe(PERSON_GAVE_UP_TEXT);
    expect(reports.some((r) => r.includes('could not be started'))).toBe(true);
    expect(h.held()).toEqual([]);
    const tries = sent.length;
    expect(tries).toBe(RETRY_DELAYS_MS.length);
    now += 24 * 60 * 60_000;
    await h.tick();
    expect(sent.length).toBe(tries);
    expect(fs.readFileSync(path.join(dir, 'hold.json'), 'utf-8')).not.toContain('text a');
  });

  it('reports when the person could not be told at the end', async () => {
    const h = make();
    personDelivers = false;
    await h.hold('D1', msg('a'), 'relay');
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) await pastNextTry(h, i);
    expect(reports.some((r) => r.includes('could not be told'))).toBe(true);
  });

  it('keeps trying to tell a person whose first notice failed, and stops once it lands', async () => {
    const h = make();
    personDelivers = false;
    await h.hold('D1', msg('a'), 'relay');
    personDelivers = true;
    await h.tick();
    await h.tick();
    expect(told.filter(([, t]) => t === PERSON_HELD_TEXT)).toHaveLength(2);
  });

  it('caps the operator notice attempts and reports when nobody could be told', async () => {
    const h = make();
    operatorDelivers = false;
    await h.hold('D1', msg('a'), 'relay');
    for (let i = 0; i < RETRY_DELAYS_MS.length - 1; i++) await pastNextTry(h, i);
    for (let i = 0; i < 10; i++) await h.tick();
    expect(operator.length).toBe(5);
    expect(reports.some((r) => r.includes('operator could not be told'))).toBe(true);
  });

  it('two conversations are independent: one clearing does not touch the other', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    await h.hold('D2', msg('b'), 'relay');
    outcome = (m) => (m.id === 'a' ? 'delivered' : 'refused');
    await pastNextTry(h, 0);
    expect(h.held()).toEqual([{ routingKey: 'D2', messages: 1, attempts: 1 }]);
    expect(told.map(([k]) => k)).toEqual(['D1', 'D2']);
  });

  it('a message that got through on the conversation flushes what it holds straight away', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    outcome = () => 'delivered';
    await h.conversationWorks('D1');
    expect(sent).toEqual(['a']);
    await h.conversationWorks('D-other');
    expect(sent).toEqual(['a']);
  });

  it('survives a restart with its attempts, messages and the person already told', async () => {
    const first = make();
    await first.hold('D1', msg('a'), 'relay');
    await pastNextTry(first, 0);
    const second = make();
    second.boot();
    expect(second.held()).toEqual([{ routingKey: 'D1', messages: 1, attempts: 1 }]);
    expect(told).toHaveLength(1);
    outcome = () => 'delivered';
    await pastNextTry(second, 1);
    expect(sent.at(-1)).toBe('a');
    expect(second.held()).toEqual([]);
  });

  it('a corrupt state file means nothing was waiting', () => {
    fs.writeFileSync(path.join(dir, 'hold.json'), '{nope');
    const h = make();
    h.boot();
    expect(h.held()).toEqual([]);
  });

  it('writes held text readable only by its owner', async () => {
    await make().hold('D1', msg('a'), 'relay');
    expect(fs.statSync(path.join(dir, 'hold.json')).mode & 0o777).toBe(0o600);
  });

  it('when full, says so instead of silently losing the message', async () => {
    const h = make();
    for (let i = 0; i < MAX_PER_CONVERSATION; i++) await h.hold('D1', msg(`m${i}`), 'relay');
    await h.hold('D1', msg('extra'), 'relay');
    expect(h.held()[0].messages).toBe(MAX_PER_CONVERSATION);
    expect(told.at(-1)?.[1]).toBe(PERSON_OVERFLOW_TEXT);
    expect(told.at(-1)?.[2]?.id).toBe('extra');
    for (let i = 1; i < MAX_CONVERSATIONS; i++) await h.hold(`C${i}`, msg(`c${i}`), 'relay');
    await h.hold('C-over', msg('over'), 'relay');
    expect(h.held()).toHaveLength(MAX_CONVERSATIONS);
    expect(told.at(-1)?.[0]).toBe('C-over');
    expect(told.at(-1)?.[1]).toBe(PERSON_OVERFLOW_TEXT);
  });

  it('notices carry the latest message, so the wiring can answer in its thread', async () => {
    await make().hold('D1', msg('a', '123.4'), 'relay');
    expect(told[0][2]?.metadata?.threadTs).toBe('123.4');
  });

  it('nothing retries before the server is fully up, but a message can still be kept and the person told', async () => {
    const h = make(false);
    await h.hold('D1', msg('a'), 'relay');
    now += RETRY_DELAYS_MS[0];
    await h.tick();
    await h.conversationWorks('D1');
    expect(sent).toEqual([]);
    expect(told).toHaveLength(1);
    h.start();
    await h.tick();
    expect(sent).toEqual(['a']);
  });

  it('a refusal already explained to the person ends the hold: no more tries, no give-up notice', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    outcome = () => 'explained';
    await pastNextTry(h, 0);
    expect(h.held()).toEqual([]);
    expect(told).toHaveLength(1);
  });

  it('an emergency stop empties the hold, on disk too, and nothing starts later', async () => {
    const h = make();
    await h.hold('D1', msg('a'), 'relay');
    h.dropAll('emergency stop');
    now += 24 * 60 * 60_000;
    await h.tick();
    expect(sent).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'hold.json'), 'utf-8')).not.toContain('text a');
    await new Promise((res) => setImmediate(res));
    expect(told.at(-1)?.[1]).toBe(PERSON_STOPPED_TEXT);
  });

  it('a stop arriving during a retry ends it: the next held message never goes', async () => {
    let h: SlackRefusedHold;
    outcome = () => { h.dropAll('emergency stop'); return 'delivered'; };
    h = make();
    await h.hold('D1', msg('a'), 'relay');
    await h.hold('D1', msg('b'), 'relay');
    await pastNextTry(h, 0);
    expect(sent).toEqual(['a']);
    expect(h.held()).toEqual([]);
  });

  it('two threads in one channel conversation each hear the notice, once, and each hears the give-up', async () => {
    const h = make();
    await h.hold('C1', msg('a', '1.1'), 'relay');
    await h.hold('C1', msg('b', '2.2'), 'relay');
    await h.hold('C1', msg('c', '1.1'), 'relay');
    expect(told.map(([, , l]) => l?.metadata?.threadTs)).toEqual(['1.1', '2.2']);
    told = [];
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) await pastNextTry(h, i);
    expect(told.filter(([, t]) => t === PERSON_GAVE_UP_TEXT).map(([, , l]) => l?.metadata?.threadTs).sort()).toEqual(['1.1', '2.2']);
  });

  it('the brake: attempts inside the schedule, then gave-up', () => {
    expect(decideRefusedRetry({ attempts: RETRY_DELAYS_MS.length - 1 })).toBe('attempt');
    expect(decideRefusedRetry({ attempts: RETRY_DELAYS_MS.length })).toBe('gave-up');
  });
});

describe('repairSlackReplyRelayIfStale (the 2026-11-04 refusal)', () => {
  let dir: string;
  const template = '#!/bin/bash\necho current\n';
  const config = { messaging: [{ type: 'slack', enabled: true }] };
  const relay = () => path.join(dir, 'state', 'scripts', 'slack-reply.sh');
  const run = () => repairSlackReplyRelayIfStale({ projectDir: dir, stateDir: path.join(dir, 'state'), config, template, warn: () => {} });
  const put = (body: string) => { fs.mkdirSync(path.dirname(relay()), { recursive: true }); fs.writeFileSync(relay(), body, { mode: 0o755 }); };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repair-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('a current relay is ready and untouched', () => {
    put(template);
    const before = fs.statSync(relay()).mtimeMs;
    expect(run()).toEqual({ ready: true });
    expect(fs.statSync(relay()).mtimeMs).toBe(before);
  });

  it('a missing relay is installed and then ready', () => {
    expect(slackReplyRelayReadiness(path.join(dir, 'state'), template).ready).toBe(false);
    expect(run()).toEqual({ ready: true });
  });

  it('a known shipped older relay is rewritten, with a backup, and then ready', () => {
    const old = '#!/bin/bash\necho old\n';
    const sha = createHash('sha256').update(old).digest('hex');
    PRIOR_SHIPPED_SLACK_RELAY_SHA256.add(sha);
    try {
      put(old);
      expect(run()).toEqual({ ready: true });
      expect(fs.readFileSync(relay(), 'utf8')).toBe(template);
      expect(fs.existsSync(`${relay()}.bak.${sha.slice(0, 12)}`)).toBe(true);
    } finally { PRIOR_SHIPPED_SLACK_RELAY_SHA256.delete(sha); }
  });

  it('a hand-edited relay is never overwritten and stays not ready', () => {
    put('#!/bin/bash\necho mine\n');
    const result = run();
    expect(result.ready).toBe(false);
    expect(fs.readFileSync(relay(), 'utf8')).toContain('mine');
  });
});

describe('server wiring', () => {
  const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');

  it('the live Slack path and the forwarded path hold a refusal instead of dropping it', () => {
    expect(server).toContain('await slackRouteAndDispatch(message, slackDispatchOrHold);');
    expect(server).toContain('return dispatch(message, _slackAdmissionVerdict);');
    expect(server).toContain('void (_slackDispatchOrHold ?? _slackInboundDispatch)(sMessage)');
  });

  it('a retry goes back through pool routing with a fresh id, and the plain dispatch so it can never hold itself again', () => {
    expect(server).toContain('await slackRouteAndDispatch(copy, slackInboundDispatch);');
    expect(server).toMatch(/id: `\$\{m\.id\}~retry-/);
  });

  it('retries start only after routing and admission exist, and an both all-session emergency stops reach the hold', () => {
    expect(server.indexOf('_slackRefusedHold?.start();')).toBeGreaterThan(server.indexOf('_spawnAdmission = new spawnAdmMod.SpawnAdmission('));
    expect(server.indexOf('_slackRefusedHold?.start();')).toBeGreaterThan(server.indexOf('_operatorNotice = noticeToOperator;'));
    expect(server.match(/_slackRefusedHold\?\.dropAll\('emergency stop'\)/g)).toHaveLength(1);
    const agentServer = fs.readFileSync(path.join(__dirname, '../../src/server/AgentServer.ts'), 'utf8');
    expect(agentServer).toContain("activeSlackRefusedHold()?.dropAll('emergency stop')");
    expect(server).toContain('setActiveSlackRefusedHold(slackRefusedHold);');
  });

  it('a later refusal puts the resume entry back, so the retry resumes', () => {
    expect(server.match(/restoreResume\(\);/g)).toHaveLength(3);
  });

  it('a refused spawn does not use up the conversation resume entry', () => {
    expect(server.indexOf('const relayReadiness = repairedSlackRelayReadiness(config);')).toBeLessThan(server.indexOf('slackAdapter!.removeChannelResume(routingKey);'));
  });

  it('both spawn sites repair a stale relay first; neither refuses on the bare check', () => {
    expect(server.match(/const relayReadiness = repairedSlackRelayReadiness\(config\);/g)).toHaveLength(2);
    expect(server).not.toContain('const relayReadiness = localSlackRelayReadiness(config.stateDir);');
  });

  it('a refusal already explained to the person is not retried or told twice', () => {
    const at = server.indexOf("if (verdict === 'unavailable') {");
    const block = server.slice(at, server.indexOf("return 'refused';", at));
    expect(block).not.toContain('_slackRetryableRefusals');
  });

  it('the operator notice is wired to the real routes', () => {
    expect(server).toContain('_operatorNotice = noticeToOperator;');
    expect(server).toContain('notifyOperator: noticeToOperator,');
  });
});
