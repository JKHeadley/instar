import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { telegramInjectionFailureFixture } from '../helpers/telegramInjectionFailureFixture.js';

let f: ReturnType<typeof telegramInjectionFailureFixture>;
beforeEach(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.3.1980', null); f = telegramInjectionFailureFixture(); });
afterEach(async () => { await f.close(); vi.restoreAllMocks(); ProcessIntegrity.reset(); });
const inbound = { topicId: 41, text: 'private original message', fromUserId: 777, fromFirstName: 'Fixture', messageId: 157 };

describe('Telegram refused-injection HTTP path', () => {
  it('returns an actual handler refusal to the lifeline and retains authenticated failure readback', async () => {
    const res = await request(f.app).post('/internal/telegram-forward').set('Authorization', 'Bearer n80-synthetic-auth').send(inbound);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true, refused: true });
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain('This attempt stopped before sending');
    expect(f.notices[0]).not.toContain('Delivered');
    const attention = await request(f.app).get('/attention').set('Authorization', 'Bearer n80-synthetic-auth');
    const commitments = await request(f.app).get('/commitments?scope=mesh').set('Authorization', 'Bearer n80-synthetic-auth');
    expect(attention.status).toBe(200); expect(JSON.stringify(attention.body)).toContain('telegram-injection-refusal');
    expect(commitments.status).toBe(200); expect(commitments.body.commitments).toHaveLength(1);
    expect(JSON.stringify(commitments.body)).not.toContain(inbound.text);
    expect(JSON.stringify(attention.body)).not.toContain(inbound.text);
  });

  it('does not turn repeated forwarding of a refused source into Delivered', async () => {
    for (let n = 0; n < 2; n++) {
      const r = await request(f.app).post('/internal/telegram-forward').set('Authorization', 'Bearer n80-synthetic-auth').send(inbound);
      expect(r.body.refused).toBe(true);
    }
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.tracker.getActive()).toHaveLength(1);
    expect(f.notices.every(n => !n.includes('✓ Delivered'))).toBe(true);
  });

  it('withholds the HTTP acknowledgement until the callback supplies its actual refusal', async () => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let finish!: (value: { refused: true }) => void;
    const verdict = new Promise<{ refused: true }>(resolve => { finish = resolve; });
    f.telegram.onTopicMessage = async () => { enter(); return verdict; };
    let answered = false;
    const pending = request(f.app).post('/internal/telegram-forward').set('Authorization', 'Bearer n80-synthetic-auth')
      .send(inbound).then(r => { answered = true; return r; });
    await entered;
    expect(answered).toBe(false);
    finish({ refused: true });
    expect((await pending).body.refused).toBe(true);
  });

  it('preserves successful callback acknowledgements and rejects unauthorized readback', async () => {
    f.telegram.onTopicMessage = async () => {};
    const r = await request(f.app).post('/internal/telegram-forward').set('Authorization', 'Bearer n80-synthetic-auth').send(inbound);
    expect(r.body.refused).toBeUndefined();
    expect((await request(f.app).get('/commitments')).status).toBe(401);
    expect(f.tracker.getActive()).toHaveLength(0);
  });
});
