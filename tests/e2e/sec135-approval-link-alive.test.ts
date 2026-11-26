/**
 * E2E — SEC-135 (docs/specs/sec135-approval-link-guess-bound.md, Tests: E2E). The real AgentServer, on
 * the production constructor path, with sign-in's shipped limits: the shared hook is wired (not null,
 * not a no-op), the feature is alive on a development agent (confirmStats in the signed-in list), and
 * with the public aggregate full a marked-browser confirm completes while an unmarked one gets the
 * fixed pin-paused answer. A fleet agent with no setting keeps piece 1c's behaviour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PUBLIC_PAUSED_MESSAGE } from '../../src/server/recommendedServiceRoutes.js';
import {
  bootSec135, drainAggregate, markerCookie, namesBody, strangerPost, strangerToken,
  SEC135_AUTH, SEC135_PIN, type Sec135Boot,
} from '../helpers/sec135Server.js';

const booted: Sec135Boot[] = [];
afterEach(async () => { for (const b of booted.splice(0)) { await b.server.stop().catch(() => undefined); b.project.cleanup(); } });
const boot = (opts: Parameters<typeof bootSec135>[0] = {}) => { const b = bootSec135(opts); booted.push(b); return b; };

describe('SEC-135 approval links: alive on the production path', () => {
  it('wires the shared hook and reports confirmStats on a development agent', async () => {
    const b = boot();
    const hook = (b.server as unknown as { publicPinHook: { context: unknown; verify: unknown } | null }).publicPinHook;
    expect(hook).not.toBeNull();
    expect(typeof hook!.verify).toBe('function');
    const list = await request(b.app).get('/recommended-services').set('Authorization', `Bearer ${SEC135_AUTH}`);
    expect(list.status).toBe(200);
    expect(list.body.confirmStats).toMatchObject({ publicPathRefused: 0, answersByPath: { marker: 0, local: 0, public: 0 } });
  });

  it('with the aggregate full, a marked-browser confirm completes and an unmarked one gets pin-paused', async () => {
    const b = boot();
    const cookie = await markerCookie(b.app);
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 20);
    const stranger = await strangerPost(b.app, '198.51.100.77').send(namesBody(token, SEC135_PIN));
    expect(stranger.status).toBe(429);
    expect(stranger.body).toEqual({ error: 'pin-paused', message: PUBLIC_PAUSED_MESSAGE, retryAfterSeconds: expect.any(Number) });
    const marked = await strangerPost(b.app, '198.51.100.78').set('Cookie', cookie).send(namesBody(token, SEC135_PIN));
    expect(marked.status).toBe(200);
    expect(Array.isArray(marked.body.copies)).toBe(true);
  });

  it('a fleet agent with no setting keeps piece 1c: the per-token budget only', async () => {
    const b = boot({ developmentAgent: false });
    const token = await strangerToken(b.app);
    await drainAggregate(b.app, 20);
    expect((await strangerPost(b.app, '198.51.100.79').send(namesBody(token, SEC135_PIN))).status).toBe(200);
  });
});
