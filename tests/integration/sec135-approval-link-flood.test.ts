/**
 * Integration — SEC-135 (docs/specs/sec135-approval-link-guess-bound.md, Tests: integration), over the
 * full HTTP pipeline through a real AgentServer with sign-in's shipped limits: a stranger flood on the
 * confirm routes is bounded by the public aggregate (20 per window, shared with sign-in) and raises the
 * brute-force alert, after which a marked browser and the machine itself both still open a page and
 * complete an answer, and the counters report it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import {
  bootSec135, localUnlock, markerCookie, namesBody, strangerGet, strangerPost, strangerToken, strangerUnlock,
  SEC135_AUTH, SEC135_PIN, SEC135_PORT, type Sec135Boot,
} from '../helpers/sec135Server.js';

let b: Sec135Boot;
afterEach(() => { vi.restoreAllMocks(); b?.project.cleanup(); });

describe('SEC-135 stranger flood on confirm pages', () => {
  it('bounds the flood by sign-in\'s aggregate; a marked browser and the machine itself still complete an answer', async () => {
    const spy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    b = bootSec135();
    const cookie = await markerCookie(b.app);
    const tokens: string[] = [];
    for (let i = 0; i < 25; i++) tokens.push(await strangerToken(b.app, `192.0.2.${i + 1}`));
    const statuses: number[] = [];
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < tokens.length; i++) {
        statuses.push((await strangerPost(b.app, `10.${round}.${i}.1`).send(namesBody(tokens[i], '000000'))).status);
      }
    }
    expect(statuses.filter((s) => s === 403)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
    expect(spy.mock.calls.some((c) => (c[0] as { feature: string }).feature === 'DashboardPin.bruteForce')).toBe(true);
    // Sign-in is refused for a stranger now too: one budget.
    expect((await strangerUnlock(b.app, '10.9.9.1').send({ pin: SEC135_PIN })).status).toBe(429);

    // The owner's browser opens its own page (strangers' mint cap is irrelevant) and says no.
    const ownPage = await request(b.app).get('/recommended-services/jev/confirm').set('Host', 'sec135.trycloudflare.test')
      .set('cf-connecting-ip', '10.20.0.1').set('x-forwarded-proto', 'https').set('Cookie', cookie).set('X-Instar-Request', '1');
    expect(ownPage.status).toBe(200);
    const markedNo = await request(b.app).post('/recommended-services/jev/confirm').set('Host', 'sec135.trycloudflare.test')
      .set('cf-connecting-ip', '10.20.0.1').set('x-forwarded-proto', 'https').set('Cookie', cookie).set('X-Instar-Request', '1')
      .send({ token: ownPage.body.token, pin: SEC135_PIN, answer: 'no', reason: 'none', shutdown: false });
    expect(markedNo.status).toBe(200);
    expect(markedNo.body.choice).toBe('no');

    // The machine itself, too.
    const localPage = await request(b.app).get('/recommended-services/tailscale/confirm').set('Host', `127.0.0.1:${SEC135_PORT}`).set('X-Instar-Request', '1');
    expect(localPage.status).toBe(200);
    const localNo = await request(b.app).post('/recommended-services/tailscale/confirm').set('Host', `127.0.0.1:${SEC135_PORT}`).set('X-Instar-Request', '1')
      .send({ token: localPage.body.token, pin: SEC135_PIN, answer: 'no', reason: 'none', shutdown: false });
    expect(localNo.status).toBe(200);
    expect((await localUnlock(b.app).send({ pin: SEC135_PIN })).status).toBe(200);

    const list = await request(b.app).get('/recommended-services').set('Authorization', `Bearer ${SEC135_AUTH}`);
    expect(list.body.confirmStats).toMatchObject({
      publicPathRefused: 30,
      answersByPath: { marker: 1, local: 1, public: 0 },
      exemptPathOpens: 2,
      exemptPathAnswersWhileAggregateFull: { marker: 1, local: 1 },
    });
    // A stranger's page open still works (only answers are bounded).
    expect((await strangerGet(b.app, '192.0.2.250')).status).toBe(200);
  });
});
