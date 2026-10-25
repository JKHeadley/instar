import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { mountTelegramOriginRoutes } from '../../src/server/telegramOriginRoutes.js';
import { originToolGuardHook, originToolGuardDigest } from '../../src/messaging/telegram-origin/OriginToolGuard.js';
import { inspectOriginInstallation } from '../../src/messaging/telegram-origin/OriginInstallation.js';
import { parseOriginHookMarker, captureOriginHookSettings } from '../../src/messaging/telegram-origin/OriginNativeHookProof.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let worker: URL;
const runtimes: TelegramOriginRuntime[] = [], servers: Server[] = [], roots: string[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-native-hook:cleanup' });
});

describe('native origin guard execution enrollment', () => {
  it.each(['claude-code', 'codex-cli'] as const)('%s joins the real installed guard challenge to native listener output, never to an API callback or tool text', async harnessId => {
    const projectDir = temporaryState(); roots.push(projectDir);
    const stateDir = path.join(projectDir, '.instar'), configHome = path.join(projectDir, 'claude-home');
    const nativeSessionId = '11111111-1111-4111-8111-111111111111';
    const nativeFile = harnessId === 'claude-code' ? path.join(configHome, 'projects', projectDir.replace(/[\\/.]/g, '-'), `${nativeSessionId}.jsonl`)
      : path.join(configHome, 'sessions', `rollout-${nativeSessionId}.jsonl`);
    for (const dir of ['hooks/instar', 'scripts', 'state']) await mkdir(path.join(stateDir, dir), { recursive: true });
    await mkdir(path.dirname(nativeFile), { recursive: true });
    await mkdir(path.join(projectDir, '.claude/scripts'), { recursive: true });
    await mkdir(path.join(projectDir, '.codex'), { recursive: true });
    const script = path.join(stateDir, 'hooks/instar/telegram-origin-guard.js');
    const relay = await readFile(new URL('../../src/templates/scripts/telegram-reply.sh', import.meta.url), 'utf8');
    await Promise.all([
      writeFile(script, originToolGuardHook()),
      writeFile(path.join(stateDir, 'scripts/telegram-reply.sh'), relay),
      writeFile(path.join(projectDir, '.claude/scripts/telegram-reply.sh'), relay),
      writeFile(path.join(projectDir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command: `node ${script}` }] }] } })),
      writeFile(path.join(projectDir, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command: `node ${script}` }] }] } })),
      writeFile(path.join(stateDir, 'state/playwright-profiles.json'), '{"profiles":[]}'),
      writeFile(nativeFile, JSON.stringify(harnessId === 'claude-code'
        ? { type: 'user', sessionId: nativeSessionId, uuid: 'turn', message: { content: 'fixture' } }
        : { type: 'session_meta', payload: { id: nativeSessionId } }) + '\n'),
    ]);
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    let lifecycle: OriginSessionLifecycle | undefined;
    const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Studio' },
      signingKey: { privateKey, keyId: 'key', keyEpoch: 1 }, bot: { token: '', accountId: 'bot', chatId: '-100123' },
      display: () => ({}), authorize: () => true, isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
      alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined, diagnoseUnknown: async () => undefined });
    runtimes.push(runtime);
    const launch = { sessionId: 'session', harnessId, projectDir, configHome, nativeSessionId,
      launchHookSettingsDigest: await captureOriginHookSettings(projectDir, harnessId) };
    const token = await lifecycle!.issue(launch);
    await runtime.observer.refresh('session');
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture') { res.sendStatus(401); return; } next(); });
    const router = express.Router(); mountTelegramOriginRoutes(router, { runtime: () => runtime, verifyOperator: () => false }); app.use(router);
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ port, authToken: 'fixture', projectName: 'echo', enabledFrameworks: [harnessId] }));
    const state = async () => (await inspectOriginInstallation({ runtime, projectDir, stateDir, automationOnly: false,
      storageHealthy: true, sessions: [{ sessionId: 'session', harnessId }] })).observations
      .find(item => item.subject === `${harnessId}:native-enforcement`)!.state;
    const endpoint = '/telegram/origins/native-hook/challenge';
    const body = { nativeSessionId, guardDigest: originToolGuardDigest() };
    expect((await request(app).post(endpoint).send(body)).status).toBe(401);
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').send(body)).status).toBe(403);
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').set('X-Instar-Origin-Session', token).send({ ...body, nativeSessionId: 'foreign' })).status).toBe(409);
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').set('X-Instar-Origin-Session', token).send({ ...body, guardDigest: '0'.repeat(64) })).status).toBe(400);
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').set('X-Instar-Origin-Session', token).send(body)).status).toBe(200);
    expect(await state()).toBe('unknown');
    const output = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script], { env: { ...process.env, INSTAR_PROJECT_DIR: projectDir, INSTAR_PORT: String(port), INSTAR_ORIGIN_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stdout += chunk; }); child.on('error', reject);
      child.on('close', code => resolve({ code, stderr, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: nativeSessionId, tool_name: 'Bash', tool_use_id: 'native-tool', tool_input: { command: 'true' } }));
    });
    expect(output.code).toBe(0); expect(parseOriginHookMarker(output.stderr)?.guardDigest).toBe(originToolGuardDigest());
    const structured = JSON.parse(output.stdout);
    expect(Object.keys(structured)).toEqual(['hookSpecificOutput']);
    expect(structured.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: output.stderr.trim() });
    expect(await state()).toBe('unknown');
    await appendFile(nativeFile, JSON.stringify({ type: 'user', sessionId: nativeSessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: output.stderr }] } }) + '\n');
    await runtime.observer.refresh('session'); expect(await state()).toBe('unknown');
    const codexPayload = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: structured.hookSpecificOutput.additionalContext }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['hooks.additional_context'] } };
    if (harnessId === 'codex-cli') {
      for (const payload of [{ ...codexPayload, role: 'user' }, { ...codexPayload, internal_chat_message_metadata_passthrough: undefined },
        { ...codexPayload, internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } }]) {
        await appendFile(nativeFile, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload }) + '\n');
        await runtime.observer.refresh('session'); expect(await state()).toBe('unknown');
      }
    }
    await appendFile(nativeFile, JSON.stringify(harnessId === 'claude-code' ? { type: 'attachment', sessionId: nativeSessionId, timestamp: new Date().toISOString(),
      attachment: { type: 'hook_success', hookEvent: 'PreToolUse', command: `node ${script}`, toolUseID: 'native-tool', exitCode: 0, stderr: output.stderr, stdout: '' } }
      : { type: 'response_item', timestamp: new Date().toISOString(), payload: codexPayload }) + '\n');
    await runtime.observer.refresh('session'); expect(await state()).toBe('ready');
    expect((await request(app).post(endpoint).set('Authorization', 'Bearer fixture').set('X-Instar-Origin-Session', token).send(body)).status).toBe(204);
    const settingsFile = path.join(projectDir, harnessId === 'claude-code' ? '.claude/settings.json' : '.codex/hooks.json');
    const settings = await readFile(settingsFile, 'utf8');
    // Fresh guard execution does not prove an already-running CLI reloaded
    // changed registration bytes. Credential re-enrollment cannot certify it.
    await writeFile(settingsFile, settings + '\n'); expect(await state()).toBe('unknown');
    await writeFile(settingsFile, settings); expect(await state()).toBe('ready');
    await writeFile(script, originToolGuardHook() + '// changed\n'); expect(await state()).toBe('held');
    await writeFile(script, originToolGuardHook()); expect(await state()).toBe('ready');
    await lifecycle!.issue({ ...launch, launchHookSettingsDigest: undefined }); expect(await state()).toBe('unknown');
  });
});
