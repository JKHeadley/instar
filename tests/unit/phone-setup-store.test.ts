/** Identity A4 steps 2 to 6: the setup store's number, its bindings and its windows (src/server/phoneSetupRoutes.ts). */
import { describe, it, expect } from 'vitest';
import { PhoneSetupStore, buildPairLinkV2, PHONE_SETUP_SIGN_WINDOW_MS, PHONE_SETUP_TTL_MS, PHONE_SETUP_MAX_WRONG_NUMBERS } from '../../src/server/phoneSetupRoutes.js';

function store(start = 1_000_000) {
  const clock = { t: start };
  const s = new PhoneSetupStore(() => clock.t);
  const mk = (code = 'CODE-1') => s.create({ code, address: 'home', host: 'a-b.local:5000', kind: 'same-network', spkiHash: 'H', approval: 'computer' });
  return { s, clock, mk };
}
const phone = { id: 'dev-1', deviceName: 'iPhone', fingerprint: 'AB-CD' };

describe('phone setup store', () => {
  it('the agent issues a random six-digit number when the phone redeems, once', () => {
    const { s, mk } = store();
    const a = mk();
    expect(s.byCode('CODE-1')?.id).toBe(a.id);
    const n = s.attachPhone(a.id, phone, 'kh');
    expect(n).toMatch(/^\d{6}$/);
    expect(s.attachPhone(a.id, { ...phone, id: 'dev-2' }, 'kh2')).toBeNull();
    const numbers = new Set<string>();
    for (let i = 0; i < 40; i++) { const b = mk(`C${i}`); numbers.add(s.attachPhone(b.id, { ...phone, id: `d${i}` }, 'k')!); }
    expect(numbers.size).toBeGreaterThan(30);
  });

  it('the right number moves to signing; a wrong one does not; three wrong end the setup', () => {
    const { s, mk } = store();
    const a = mk();
    const n = s.attachPhone(a.id, phone, 'kh')!;
    const wrong = String((Number(n) + 1) % 1_000_000).padStart(6, '0');
    expect(s.typeNumber(a.id, 'abc')).toBe('bad-format');
    expect(s.typeNumber(a.id, wrong)).toBe('wrong');
    expect(s.activation('dev-1').result).toBe('waiting');
    expect(s.typeNumber(a.id, `${n.slice(0, 3)} ${n.slice(3)}`)).toBe('ok');
    expect(s.activation('dev-1').result).toBe('ok');
    const b = mk('CODE-2');
    const m = s.attachPhone(b.id, { ...phone, id: 'dev-9' }, 'k')!;
    const bad = String((Number(m) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 1; i < PHONE_SETUP_MAX_WRONG_NUMBERS; i++) expect(s.typeNumber(b.id, bad)).toBe('wrong');
    expect(s.typeNumber(b.id, bad)).toBe('ended');
    expect(s.typeNumber(b.id, m)).toBe('ended');
    expect(s.activation('dev-9')).toEqual({ result: 'ended', reason: 'wrong-numbers' });
  });

  it('after the right number the phone has 15 minutes to sign, and not a moment more', () => {
    const { s, clock, mk } = store();
    const a = mk();
    const n = s.attachPhone(a.id, phone, 'kh')!;
    s.typeNumber(a.id, n);
    clock.t += PHONE_SETUP_SIGN_WINDOW_MS;
    expect(s.activation('dev-1').result).toBe('ok');
    clock.t += 1;
    expect(s.activation('dev-1')).toEqual({ result: 'ended', reason: 'sign-window-passed' });
  });

  it('a number typed late in the setup still gets the full 15-minute signing window when the phone\'s pending expiry allows it (none known here)', () => {
    const { s, clock, mk } = store();
    const a = mk();
    const n = s.attachPhone(a.id, phone, 'kh')!;
    clock.t += PHONE_SETUP_TTL_MS - 60_000;
    expect(s.typeNumber(a.id, n)).toBe('ok');
    clock.t += PHONE_SETUP_SIGN_WINDOW_MS - 1;
    expect(s.activation('dev-1').result).toBe('ok');
  });

  it('a setup lapses after 30 minutes, and one setup at a time', () => {
    const { s, clock, mk } = store();
    const a = mk();
    clock.t += PHONE_SETUP_TTL_MS + 1;
    expect(s.get(a.id)?.state).toBe('ended');
    const b = mk('C-b');
    const c = mk('C-c');
    expect(s.get(b.id)?.endedReason).toBe('replaced');
    expect(s.get(c.id)?.state).toBe('waiting-phone');
  });

  it('a finished setup closes its number', () => {
    const { s, mk } = store();
    const a = mk();
    const n = s.attachPhone(a.id, phone, 'kh')!;
    s.typeNumber(a.id, n);
    s.finish(a.id);
    expect(s.get(a.id)?.number).toBeUndefined();
    expect(s.isAtComputerPending('dev-1')).toBe(false);
  });

  it('the pairing link version 2 carries the code, the name and port, the key hash and the address hints', () => {
    const link = buildPairLinkV2({ host: 'wintest-pc.local:5321', spkiHash: 'abc_DEF-123', code: 'C0DE', hints: ['192.168.1.20:5321'], agentName: 'Wintest' });
    expect(link.startsWith('https://instar.sh/pair#v=2&')).toBe(true);
    const q = new URLSearchParams(link.split('#')[1]);
    expect(q.get('h')).toBe('wintest-pc.local:5321');
    expect(q.get('k')).toBe('abc_DEF-123');
    expect(q.get('c')).toBe('C0DE');
    expect(q.get('a')).toBe('192.168.1.20:5321');
    expect(q.get('n')).toBe('Wintest');
  });
});

describe('PhoneSetupStore.secondPhone (security review of home pairing, 2026-11-21)', () => {
  const dev = { id: 'dev-1', deviceName: 'Phone', fingerprint: 'AB:CD' };
  const mk = (approval: 'computer' | 'telegram' = 'computer') => {
    const st = new PhoneSetupStore(() => 1_000);
    const seen: string[] = [];
    st.onSecondPhone = (s) => { seen.push(s.id); };
    const s = st.create({ code: 'code-1', address: 'home', host: 'h.local:1', kind: 'same-network', spkiHash: 'k', approval });
    return { st, s, seen };
  };
  it('ends a setup waiting for its number, and one whose number was typed, and tells the routes', () => {
    const a = mk();
    const n = a.st.attachPhone(a.s.id, dev, 'kh')!;
    expect(a.st.secondPhone(a.s.id)).toBe(true);
    expect(a.st.get(a.s.id)!.state).toBe('ended');
    expect(a.st.get(a.s.id)!.endedReason).toBe('second-phone');
    expect(a.st.get(a.s.id)!.number).toBeUndefined();
    expect(a.seen).toEqual([a.s.id]);
    expect(a.st.activation('dev-1')).toEqual({ result: 'ended', reason: 'second-phone' });
    const b = mk();
    const nb = b.st.attachPhone(b.s.id, dev, 'kh')!;
    expect(b.st.typeNumber(b.s.id, nb)).toBe('ok');
    expect(b.st.secondPhone(b.s.id)).toBe(true);
    expect(b.st.activation('dev-1').result).toBe('ended');
    void n;
  });
  it('leaves alone a setup with no phone yet, a finished one, an ended one, and a Telegram one', () => {
    const a = mk();
    expect(a.st.secondPhone(a.s.id)).toBe(false);
    a.st.attachPhone(a.s.id, dev, 'kh'); a.st.finish(a.s.id);
    expect(a.st.secondPhone(a.s.id)).toBe(false);
    expect(a.st.get(a.s.id)!.state).toBe('done');
    const t = mk('telegram');
    t.st.sentToChat(t.s.id, 'dev-1');
    expect(t.st.secondPhone(t.s.id)).toBe(false);
    expect(t.seen).toEqual([]);
    expect(a.st.secondPhone('nope')).toBe(false);
  });
});
