/**
 * native-conversation-any-machine-access §3e — the console composer's draft model, every
 * state: a draft clears only on an acknowledgement carrying its own id (however late);
 * an id-less or other-id acknowledgement clears nothing; "Send again" appears only where
 * the serving machine recognises a repeat; an unresolved draft sends the session one fixed
 * line, once, waiting for `input_caps` when the link is down; keys only report; and no
 * sentence sends the person to check anything.
 */
import { describe, it, expect } from 'vitest';
import { createInputTracker, sessionLine, newInputId, INPUT_ID_RE, WORDS, UNRESOLVED_AFTER_MS } from '../../dashboard/console/input-model.js';

function rig(opts: { sendOk?: () => boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const timers: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
  let clock = Date.parse('2026-11-11T21:05:00Z');
  let n = 0;
  let changes = 0;
  const t = createInputTracker({
    send: (extra: Record<string, unknown>) => { if (opts.sendOk && !opts.sendOk()) return false; sent.push(extra); return true; },
    now: () => clock,
    newId: () => `id_${String(++n).padStart(16, '0')}`,
    setTimer: (ms: number, fn: () => void) => { const h = { at: clock + ms, fn, id: timers.length, live: true }; timers.push(h); return h; },
    clearTimer: (h: { live: boolean }) => { h.live = false; },
    onChange: () => { changes++; },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const h of [...timers]) if (h.live && h.at <= clock) { h.live = false; h.fn(); }
  };
  return { t, sent, advance, changes: () => changes };
}
const caps2 = { type: 'input_caps', session: 's', inputAck: 2, remoteInput: true };
const caps1 = { type: 'input_caps', session: 's', inputAck: 1, remoteInput: null };

describe('ids and the session line', () => {
  it('makes ids the server accepts', () => {
    for (let i = 0; i < 20; i++) expect(newInputId()).toMatch(INPUT_ID_RE);
  });
  it('the session line is fixed, names the id and the time, and never declares the message lost', () => {
    const at = new Date(2026, 10, 11, 9, 7).getTime();
    const line = sessionLine(at, 'abcdefghijklmnop');
    expect(line).toBe('[dashboard] A message typed in the dashboard at 09:07 (input `abcdefghijklmnop`) could not be confirmed as delivered to this session. This line is from the dashboard, not from the user. In your next reply to the user, say whether a dashboard message reached you around that time and what it said. If you do not recall one, say only that you cannot confirm it. Do not say it was lost and do not ask for it again.');
  });
  it('no sentence asks the person to look at the session or check anything', () => {
    for (const w of Object.values(WORDS)) expect(w).not.toMatch(/\bcheck\b|\blook at\b/i);
  });
});

describe('before the machine says what it can do', () => {
  it('the composer is disabled and says it is connecting; nothing is sent', () => {
    const { t, sent } = rig();
    expect(t.view().composer).toEqual({ disabled: true, readOnly: false, words: WORDS.connecting });
    expect(t.sendText('hi')).toEqual({ ok: false, words: WORDS.connecting });
    expect(sent).toEqual([]);
  });
  it('remote input switched off: read-only with the refusal sentence before anything is typed', () => {
    const { t, sent } = rig();
    t.onFrame({ ...caps2, remoteInput: false });
    expect(t.view().composer).toEqual({ disabled: true, readOnly: true, words: WORDS.refused });
    expect(t.sendText('hi')).toEqual({ ok: false, words: WORDS.refused });
    expect(sent).toEqual([]);
  });
});

describe('inputAck 2 (a machine that recognises a repeat)', () => {
  it('sends with an id, keeps the text as sending, and clears it only on its own acknowledgement', () => {
    const { t, sent } = rig();
    t.onFrame(caps2);
    const r = t.sendText('yes');
    expect(r.ok).toBe(true);
    expect(sent[0]).toEqual({ text: 'yes', clientInputId: r.id });
    expect(t.view().sending).toEqual({ id: r.id, text: 'yes' });
    t.onFrame({ type: 'input_ack', session: 's', success: true }); // no id
    t.onFrame({ type: 'input_ack', session: 's', success: true, clientInputId: 'id_9999999999999999' }); // another id
    expect(t.view().sending).toEqual({ id: r.id, text: 'yes' });
    t.onFrame({ type: 'input_ack', session: 's', success: true, clientInputId: r.id });
    const v = t.view();
    expect(v.sending).toBeNull();
    expect(v.drafts).toEqual([]);
  });

  it('after 8 s with no answer only the label changes; the session is asked once; "Send again" reuses the id', () => {
    const { t, sent, advance } = rig();
    t.onFrame(caps2);
    const { id } = t.sendText('deploy it');
    advance(UNRESOLVED_AFTER_MS - 1);
    expect(t.view().drafts).toEqual([]);
    advance(1);
    const v = t.view();
    expect(v.sending).toBeNull();
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0].controls).toEqual(['send-again', 'copy', 'discard']);
    // The one line went to the session with a fresh id of its own.
    expect(sent).toHaveLength(2);
    expect(String(sent[1].text)).toContain(`(input \`${id}\`)`);
    expect(sent[1].clientInputId).not.toBe(id);
    t.onFrame({ type: 'input_ack', session: 's', success: true, clientInputId: sent[1].clientInputId });
    expect(t.view().drafts[0].words).toBe(WORDS.askedAcked);
    // The line's acknowledgement never clears the draft.
    expect(t.view().drafts).toHaveLength(1);
    t.retry(id);
    expect(sent[2]).toEqual({ text: 'deploy it', clientInputId: id, retry: true });
    // The line is never sent twice.
    advance(UNRESOLVED_AFTER_MS * 3);
    expect(sent.filter((m) => String(m.text).startsWith('[dashboard]'))).toHaveLength(1);
  });

  it('an acknowledgement with the draft id that arrives after it was shown as not confirmed clears it', () => {
    const { t, advance } = rig();
    t.onFrame(caps2);
    const { id } = t.sendText('late');
    advance(UNRESOLVED_AFTER_MS);
    expect(t.view().drafts).toHaveLength(1);
    t.onFrame({ type: 'input_ack', session: 's', success: true, clientInputId: id });
    expect(t.view().drafts).toEqual([]);
  });

  it('the line waits for input_caps when the link is down, and is then sent once', () => {
    const { t, sent, advance } = rig();
    t.onFrame(caps2);
    t.sendText('x');
    t.linkDown();
    advance(UNRESOLVED_AFTER_MS);
    expect(sent).toHaveLength(1);
    expect(t.view().drafts[0].words).toBe(WORDS.askedNot);
    expect(t.view().drafts[0].controls).toEqual(['copy', 'discard']); // no send control while the link is down
    t.onFrame(caps2);
    expect(sent).toHaveLength(2);
    expect(String(sent[1].text)).toMatch(/^\[dashboard\]/);
    t.onFrame(caps2);
    expect(sent).toHaveLength(2);
  });

  it('the line unanswered, or refused, reads "could not confirm that either"', () => {
    const { t, sent, advance } = rig();
    t.onFrame(caps2);
    t.sendText('x');
    advance(UNRESOLVED_AFTER_MS);
    advance(UNRESOLVED_AFTER_MS);
    expect(t.view().drafts[0].words).toBe(WORDS.askedNot);
    expect(sent).toHaveLength(2);
  });

  it('a write that failed may have typed part of the text: it stays unresolved, the session is asked, no send control', () => {
    const { t, sent } = rig();
    t.onFrame(caps2);
    const { id } = t.sendText('hello');
    t.onFrame({ type: 'input_ack', session: 's', success: false, clientInputId: id });
    const v = t.view();
    expect(v.sending).toBeNull();
    expect(v.returned).toBeNull();
    expect(v.drafts).toEqual([{ id, text: 'hello', words: WORDS.failed, controls: ['copy', 'discard'] }]);
    expect(String(sent[1].text)).toMatch(/^\[dashboard\]/);
  });

  it('refused before any write, or never relayed, first sends give the text back with their sentence', () => {
    for (const [frame, words] of [
      [{ type: 'error', code: 'input-not-allowed' }, WORDS.refused],
      [{ type: 'error', code: 'peer-stream-lost' }, WORDS.lost],
      [{ type: 'error', code: 'session-not-found' }, WORDS.failed],
    ] as const) {
      const { t } = rig();
      t.onFrame(caps2);
      const { id } = t.sendText('hello');
      t.onFrame({ ...frame, session: 's', clientInputId: id });
      const v = t.view();
      expect(v.sending).toBeNull();
      expect(v.returned).toEqual({ text: 'hello', words });
      expect(v.notice).toBe(words);
      expect(v.drafts).toEqual([]);
    }
  });

  it('a retry the machine does not know is refused and shown as such; no send control after', () => {
    const { t, advance } = rig();
    t.onFrame(caps2);
    const { id } = t.sendText('once');
    advance(UNRESOLVED_AFTER_MS);
    t.retry(id);
    t.onFrame({ type: 'error', code: 'input-retry-unknown', session: 's', clientInputId: id });
    const d = t.view().drafts[0];
    expect(d.words.startsWith(WORDS.retryUnknown)).toBe(true);
    expect(d.controls).toEqual(['copy', 'discard']);
  });

  it('a retry answered with the original acknowledgement clears the draft', () => {
    const { t, advance } = rig();
    t.onFrame(caps2);
    const { id } = t.sendText('once');
    advance(UNRESOLVED_AFTER_MS);
    t.retry(id);
    t.onFrame({ type: 'input_ack', session: 's', success: true, clientInputId: id });
    expect(t.view().drafts).toEqual([]);
  });

  it('Discard removes the draft', () => {
    const { t, advance } = rig();
    t.onFrame(caps2);
    const { id } = t.sendText('x');
    advance(UNRESOLVED_AFTER_MS);
    t.discard(id);
    expect(t.view().drafts).toEqual([]);
  });

  it('a socket that cannot write sends nothing and keeps the text', () => {
    const { t } = rig({ sendOk: () => false });
    t.onFrame(caps2);
    expect(t.sendText('x')).toEqual({ ok: false, words: WORDS.lost });
    expect(t.view().sending).toBeNull();
  });
});

describe('inputAck 1 (an older serving machine)', () => {
  it('frames go without an id, the draft is unresolved at once with no send control, and the session gets the one line', () => {
    const { t, sent } = rig();
    t.onFrame(caps1);
    const r = t.sendText('yes');
    expect(r.ok).toBe(true);
    expect(sent[0]).toEqual({ text: 'yes' });
    expect(String(sent[1].text)).toMatch(/^\[dashboard\]/);
    expect(sent[1].clientInputId).toBeUndefined();
    const v = t.view();
    expect(v.sending).toBeNull();
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0].controls).toEqual(['copy', 'discard']);
  });
  it('an id-less acknowledgement never clears a draft (it may be another client\'s input)', () => {
    const { t } = rig();
    t.onFrame(caps1);
    t.sendText('yes');
    t.onFrame({ type: 'input_ack', session: 's', success: true });
    t.onFrame({ type: 'input_ack', session: 's', success: true });
    expect(t.view().drafts).toHaveLength(1);
  });
  it('an id-less refusal shows the refusal sentence and keeps the draft', () => {
    const { t } = rig();
    t.onFrame(caps1);
    t.sendText('yes');
    t.onFrame({ type: 'error', code: 'input-not-allowed', session: 's' });
    const v = t.view();
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0].words).toBe(WORDS.refused);
  });
});

describe('keys only report', () => {
  it('a key gets an id and a failure is shown, never kept or retried', () => {
    const { t, sent, advance } = rig();
    t.onFrame(caps2);
    expect(t.sendKey('C-c')).toEqual({ ok: true });
    expect(sent[0]).toEqual({ key: 'C-c', clientInputId: expect.stringMatching(INPUT_ID_RE) });
    t.onFrame({ type: 'input_ack', session: 's', success: false, clientInputId: sent[0].clientInputId });
    expect(t.takeNotice()).toBe('Not sent: that machine could not type into the session.');
    advance(UNRESOLVED_AFTER_MS * 2);
    expect(sent).toHaveLength(1);
    expect(t.view().drafts).toEqual([]);
  });
});
