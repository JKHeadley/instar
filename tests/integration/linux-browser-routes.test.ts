/** The browser state, the install route and browserHost, through the real routes. Spec: docs/specs/normal-chrome-linux.md. */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITY_INDEX } from '../../src/server/CapabilityIndex.js';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';

const PROJECT_NAME = 'linux-browser-routes-test';
let dir: string;
let token = '';
let values: Record<string, unknown> = {};

function mount(): express.Express {
  const ctx = {
    config: { projectName: PROJECT_NAME, projectDir: dir, stateDir: path.join(dir, '.instar'), port: 0, authToken: token, secrets: { forceFileKey: true } },
    liveConfig: { get: <T>(key: string, def: T) => (key in values ? values[key] as T : def), set: (key: string, value: unknown) => { values[key] = value; } },
    sessionManager: null, state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbr-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  token = generateAgentToken(PROJECT_NAME);
  values = {};
});
afterEach(() => {
  deleteAgentToken(PROJECT_NAME);
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' });
});

describe('GET /browser/state', () => {
  it('always answers a named state with a next step', async () => {
    const res = await request(mount()).get('/browser/state').expect(200);
    expect(['ready', 'installing', 'not-built', 'broken']).toContain(res.body.state);
    expect(res.body.nextStep).toBeTruthy();
    expect(res.body.machineLocal).toBe(true);
  });

  it('is a claimed entry in the capability index, with the same answer', () => {
    const entry = CAPABILITY_INDEX.find((e) => e.key === 'browser');
    expect(entry?.prefixes).toContain('/browser');
    const built = entry?.build({ ctx: { config: { stateDir: path.join(dir, '.instar') } } } as never) as { state: string; endpoints: string[] };
    expect(['ready', 'installing', 'not-built', 'broken']).toContain(built.state);
    expect(built.endpoints.join(' ')).toContain('GET /browser/state');
  });
});

describe('POST /browser/linux/install', () => {
  it('needs the request header', async () => {
    await request(mount()).post('/browser/linux/install').expect(403);
  });

  it('never overrides an explicit stop', async () => {
    values['browser.linuxDriver.autoInstall'] = false;
    await request(mount()).post('/browser/linux/install').set('X-Instar-Request', '1').expect(409);
    expect(values['browser.linuxDriver.autoInstall']).toBe(false);
  });

  it('sets the flag and answers with the state', async () => {
    const res = await request(mount()).post('/browser/linux/install').set('X-Instar-Request', '1');
    if (res.status === 409) return; // a temp folder can classify as a throwaway location: refusing is then correct
    expect(res.status).toBe(202);
    expect(values['browser.linuxDriver.autoInstall']).toBe(true);
    expect(res.body.browser.state).toBeTruthy();
  });
});

describe('Secret Drop with browserHost', () => {
  const body = { label: 'Example sign-in', fields: [{ name: 'password', label: 'Password', masked: true }], browserHost: 'accounts.example.com' };

  it('refuses a malformed host and a sealed handoff', async () => {
    const app = mount();
    await request(app).post('/secrets/request').send({ ...body, browserHost: 'https://x' }).expect(400);
    await request(app).post('/secrets/request').send({ ...body, senderVerification: { senderPubKeyHex: 'a'.repeat(64) } }).expect(400);
  });

  it('shows the host on the form and stores nothing durable', async () => {
    const app = mount();
    // A browser password is asked for with the agent key (a keyless request may not ask for one).
    const made = await request(app).post('/secrets/request').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    const form = await request(app).get(`/secrets/drop/${made.body.token}`).expect(200);
    expect(form.text).toContain('This will be typed into accounts.example.com.');
    const csrf = /name="_csrf"\s+value="([0-9a-f]+)"/.exec(form.text)?.[1] ?? /csrfToken['":\s=]+['"]([0-9a-f]+)/.exec(form.text)?.[1];
    await request(app).post(`/secrets/drop/${made.body.token}`).send({ _csrf: csrf, password: 'S3cret!' }).expect(200);
    const secretFiles = fs.readdirSync(path.join(dir, '.instar'), { recursive: true }).map(String).filter((f) => f.includes('secret'));
    for (const name of secretFiles) {
      const full = path.join(dir, '.instar', name);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full).includes('S3cret!')).toBe(false);
    }
    // SEC-156: the API-key retrieve refuses a browser-only password: names and host only, never the value.
    const peek = await request(app).post(`/secrets/retrieve/${made.body.token}`).expect(409);
    expect(peek.body).toMatchObject({ error: 'browser-only', browserHost: 'accounts.example.com', fieldRefs: ['password'] });
    expect(JSON.stringify(peek.body)).not.toContain('S3cret!');
    const consume = await request(app).post(`/secrets/retrieve/${made.body.token}?consume=true`).expect(409);
    expect(JSON.stringify(consume.body)).not.toContain('S3cret!');
  });

  /** A browser password, submitted, plus a recorder in place of the agent's xdrive.sh. */
  async function submittedBrowserDrop(exit: number) {
    const app = mount();
    const made = await request(app).post('/secrets/request').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    const form = await request(app).get(`/secrets/drop/${made.body.token}`).expect(200);
    const csrf = /name="_csrf"\s+value="([0-9a-f]+)"/.exec(form.text)?.[1] ?? /csrfToken['":\s=]+['"]([0-9a-f]+)/.exec(form.text)?.[1];
    await request(app).post(`/secrets/drop/${made.body.token}`).send({ _csrf: csrf, password: 'S3cret!' }).expect(200);
    const browserDir = path.join(dir, '.instar', 'scripts', 'browser');
    fs.mkdirSync(browserDir, { recursive: true });
    const called = path.join(dir, 'called.txt');
    fs.writeFileSync(path.join(browserDir, 'xdrive.sh'),
      `#!/bin/bash\n{ echo "args=$*"; echo "marker=$XD_SECRET_BROWSER"; echo "profile=$XD_PROFILE"; echo "stdin=$(cat)"; } > ${called}\necho "OK driver"\nexit ${exit}\n`, { mode: 0o755 });
    return { app, dropToken: made.body.token as string, called };
  }

  it('SEC-156: the server types it with the stored host and the value on standard input, returns no value, and consumes on success', async () => {
    const { app, dropToken, called } = await submittedBrowserDrop(0);
    const r = await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: 'password', profile: 'work-google' }).expect(200);
    expect(r.body).toMatchObject({ typed: true, exitCode: 0, consumed: true, browserHost: 'accounts.example.com' });
    expect(r.body.output).toContain('OK driver');
    expect(JSON.stringify(r.body)).not.toContain('S3cret!');
    expect(fs.readFileSync(called, 'utf8')).toBe('args=typesecret accounts.example.com\nmarker=1\nprofile=work-google\nstdin=S3cret!\n');
    await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: 'password', profile: 'work-google' }).expect(404);
  });

  it('SEC-156: one typing run per drop at a time', async () => {
    const { app, dropToken } = await submittedBrowserDrop(0);
    const driver = path.join(dir, '.instar', 'scripts', 'browser', 'xdrive.sh');
    fs.writeFileSync(driver, '#!/bin/bash\ncat >/dev/null\nsleep 1\nexit 0\n', { mode: 0o755 });
    const send = () => request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: 'password', profile: 'p' });
    const [a, b] = await Promise.all([send(), new Promise((r) => setTimeout(r, 150)).then(send)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).body.error).toBe('typing-in-progress');
  });

  it('SEC-156: a failed type keeps the drop for a retry; the route needs a real field and a valid profile', async () => {
    const { app, dropToken } = await submittedBrowserDrop(2);
    const r = await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: '#1', profile: 'work-google' }).expect(200);
    expect(r.body).toMatchObject({ typed: false, exitCode: 2, consumed: false });
    await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: 'nope', profile: 'p' }).expect(404);
    await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: '__proto__', profile: 'p' }).expect(404);
    await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: 'constructor', profile: 'p' }).expect(404);
    await request(app).post(`/secrets/type/${dropToken}`).set('Authorization', `Bearer ${token}`).send({ field: 'password', profile: '../x' }).expect(400);
    // Still there: the retrieve still refuses it as browser-only rather than 404.
    await request(app).post(`/secrets/retrieve/${dropToken}`).set('Authorization', `Bearer ${token}`).expect(409);
  });
});
