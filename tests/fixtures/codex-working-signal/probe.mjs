/** Review-only fixture. Never uses the operator's Codex home or a live model. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, stat, realpath, writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { tmpdir } from 'node:os';
import { startCodexWorkingLaunch } from '../../../dist/core/CodexWorkingLaunch.js';
import { CodexWorkingProtocol } from '../../../dist/core/CodexWorkingProtocol.js';
import { SafeFsExecutor } from '../../../dist/core/SafeFsExecutor.js';
import { openCodexCanaryProvider, CODEX_CANARY_MODELS } from '../../../dist/messaging/telegram-origin/OriginCodexModelCanaryProtocol.js';

if (process.platform !== 'darwin') throw Error('This fixture requires macOS');
const embedded = process.argv.includes('--embedded');
const resume = process.argv.includes('--resume');
const inject = process.argv.includes('--inject');
const changeAfterPreflight = process.argv.includes('--change-after-preflight');
const changedHookRestart = changeAfterPreflight || process.argv.includes('--changed-hook-restart');
const trustedRestart = changedHookRestart || process.argv.includes('--trusted-restart');
if (trustedRestart && (!resume || embedded || inject)) throw Error('Trusted restart requires managed resume');

const run = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'icx-')));
let relay;
const mux = join(root, 'tmux.sock');
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, TERM: 'xterm-256color' };
let provider;
let positive = false;
let completed = false;
let tuiReady = false;
let resumedThread;
let confirmedThread;
let referencedThread;
const observedRequests = new Map();
const observedHookReads = [];
const threadsReturned = [];
const positiveThreads = [];
const stopReceipt = join(root, 'stop-count');
const fixturePrompt = 'Return CANARY_OK without tools.';
function fixtureHookTrust(reply, hookConfig) {
  const entries = reply.result?.data;
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0].errors?.length !== 0) return undefined;
  const hooks = entries[0].hooks?.filter(hook => hook.sourcePath === hookConfig);
  if (hooks?.length !== 1 || typeof hooks[0].currentHash !== 'string' || hooks[0].enabled !== true) return undefined;
  return hooks[0].trustStatus;
}

async function readBackendHookTrust(hookConfig, params, expected) {
  if (!relay) throw Error('The fixture has no managed app-server');
  const backendSocket = join(dirname(new URL(relay.remote).pathname), 'backend.sock');
  const client = new WebSocket('ws+unix://' + backendSocket + ':/', {
    maxPayload: 128 * 1024,
    handshakeTimeout: 2000,
    perMessageDeflate: false,
  });
  const trust = await new Promise((resolve, reject) => {
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.terminate();
      if (error) reject(error);
      else resolve(value);
    }
    const timer = setTimeout(() => finish(Error('Loaded thread hook query timed out')), 3000);
    const send = message => client.send(JSON.stringify(message), error => {
      if (error) finish(error);
    });
    client.on('error', error => finish(error));
    client.on('close', () => finish(Error('Loaded thread hook query closed early')));
    client.once('open', () => {
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'instar-loaded-hook-fixture', version: '1.0.0' } } });
    });
    client.on('message', payload => {
      try {
        const reply = JSON.parse(payload.toString());
        if (reply.id === 1 && !reply.error) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'hooks/list', params });
        } else if (reply.id === 2) {
          if (!reply.error) finish(null, fixtureHookTrust(reply, hookConfig));
          else if (params.threadId && reply.error.code === -32600 && reply.error.message === 'thread not found: ' + params.threadId) {
            finish(null, 'not-loaded');
          } else {
            finish(Error('Native loaded thread hook query refused with code ' + reply.error.code));
          }
        }
      } catch (error) {
        finish(error);
      }
    });
  });
  if (trust !== expected) throw Error('Expected loaded thread hook trust ' + expected + ', got ' + trust);
  console.log('Native hooks/list reported ' + (params.threadId ? 'loaded thread' : 'managed project') + ' hook ' + trust);
}

async function readNativeHookTrust(hookConfig, expected) {
  const task = run('codex', ['app-server', '--stdio'], { cwd: root, env, timeout: 4000, maxBuffer: 128 * 1024 });
  const { stdout, stdin } = task.child;
  const lines = createInterface({ input: stdout });
  const send = message => stdin.write(JSON.stringify(message) + '\n');
  let trust;
  let writeError;
  stdin.on('error', error => { writeError = error; });
  lines.on('line', line => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      stdin.end();
      return;
    }
    if (reply.id === 1 && !reply.error) {
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'hooks/list', params: { cwds: [root] } });
    } else if (reply.id === 2) {
      trust = fixtureHookTrust(reply, hookConfig);
      stdin.end();
    }
  });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'instar-hook-trust-fixture', version: '1.0.0' } } });
  try {
    await task;
  } finally {
    lines.close();
  }
  if (writeError) throw writeError;
  if (trust !== expected) throw Error('Expected native hook trust ' + expected + ', got ' + trust);
  console.log('Native hooks/list reported fixture hook ' + trust);
}

try {
  provider = await openCodexCanaryProvider(new AbortController().signal);
  const verifier = join(root, 'peer-pid');
  await run('xcrun', ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror',
    'src/native/codex-working/macos/instar-codex-peer-pid.c', '-o', verifier], { timeout: 10000 });
  await writeFile(join(root, 'config.toml'), [
    'model = ' + JSON.stringify(CODEX_CANARY_MODELS[0]),
    'model_provider = "fixture"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'show_hints = false',
    '[features]',
    'plugins = false',
    'plugin_sharing = false',
    'remote_plugin = false',
    '[projects.' + JSON.stringify(root) + ']',
    'trust_level = "trusted"',
    '[model_providers.fixture]',
    'name = "isolated fixture"',
    'base_url = "http://127.0.0.1:' + provider.port + '/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
  ].join('\n'));
  await mkdir(join(root, '.codex'));
  await run('git', ['init', '-q', root], {env, timeout:3000});
  if (resume) {
    const seedRun = run('codex', ['exec', '--json', 'Return CANARY_OK without tools.'], {
      cwd: root, env, timeout: 10000, maxBuffer:1024*1024,
    });
    seedRun.child.stdin.end();
    const seed = await seedRun;
    const metadata = seed.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    resumedThread = metadata.find(event => event.type === 'thread.started')?.thread_id;
    if (!resumedThread) throw Error('No native seed thread');
  }
  const hook = join(root, 'stop-probe.sh');
  await writeFile(hook, ['#!/bin/sh',
    'cat >/dev/null',
    'if [ ! -f "' + stopReceipt + '" ]; then',
    'printf "blocked\n" > "' + stopReceipt + '"',
    "printf '%s\\n' '{\"decision\":\"block\",\"reason\":\"INSTAR_STOP_PARITY_CONTINUE\"}'",
    'else',
    'printf "allowed\n" >> "' + stopReceipt + '"',
    'fi',
  ].join('\n'), {mode: 0o700});
  const hookConfig = join(root, '.codex', 'hooks.json');
  const stopHook = command => JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command }] }] },
  });
  await writeFile(hookConfig, stopHook(hook));
  if (!embedded) {
    const threadMethod = CodexWorkingProtocol.prototype.inspect;
    CodexWorkingProtocol.prototype.inspect = function(direction, payload) {
      const before = relay.read();
      const elapsedStart = performance.now();
      threadMethod.call(this, direction, payload);
      const after = Boolean(relay.read());
      positive ||= after;
      const rpc = JSON.parse(payload.toString());
      if (direction === 'frontend') {
        if (['thread/read', 'thread/start', 'thread/resume', 'hooks/list', 'turn/start'].includes(rpc.method)
          && (typeof rpc.id === 'number' || typeof rpc.id === 'string')) {
          observedRequests.set(rpc.id, {
            method: rpc.method,
            scope: rpc.params?.threadId ? 'thread' : 'project',
            threadId: rpc.params?.threadId,
            ephemeral: rpc.params?.ephemeral === true,
          });
        }
        return;
      }

      const request = observedRequests.get(rpc.id);
      observedRequests.delete(rpc.id);
      const thread = rpc.result?.thread?.id;
      if (typeof thread === 'string') threadsReturned.push({
        method: request?.method ?? 'unmatched',
        matchesSeed: resume && thread === resumedThread,
        ephemeral: request?.ephemeral === true,
      });
      if (typeof thread === 'string' && request?.method === 'thread/read') referencedThread = thread;
      if (typeof thread === 'string' && request?.method === (resume ? 'thread/resume' : 'thread/start') && !confirmedThread) {
        confirmedThread = thread;
        tuiReady = true;
      }
      if (!before && after) {
        const signaledThread = rpc.params?.threadId ?? request?.threadId;
        positiveThreads.push(signaledThread === confirmedThread ? 'selected' : 'other');
      }
      if (request?.method === 'hooks/list') {
        observedHookReads.push({
          scope: request.scope,
          trust: fixtureHookTrust(rpc, hookConfig) ?? 'unavailable',
        });
      }
      completed ||= Boolean(before && before.freshForMs > performance.now() - elapsedStart && !after
        && rpc.method === 'turn/completed' && rpc.params?.turn?.status === 'completed');
    };
  }

  async function exercise(manualTrust, expectReview = false, expectedLoadedTrust, afterPreflight) {
    const requestBaseline = provider.models.length;
    let resolvePane;
    const panePid = new Promise(resolve => { resolvePane = resolve; });
    positive = false;
    completed = false;
    tuiReady = false;
    confirmedThread = undefined;
    referencedThread = undefined;
    observedRequests.clear();
    observedHookReads.length = 0;
    threadsReturned.length = 0;
    positiveThreads.length = 0;
    if (!embedded) {
      relay = await startCodexWorkingLaunch({
        codexBinary: (await run('which', ['codex'])).stdout.trim(),
        peerVerifierBinary: verifier,
        cwd: root, env, frontendPid: panePid,
        backendConfigArgs: ['--dangerously-bypass-hook-trust'],
        signal: new AbortController().signal,
      });

    }
    if (afterPreflight) {
      await readBackendHookTrust(hookConfig, { cwds: [root] }, 'trusted');
      await afterPreflight();
      console.log('Changed the fixture hook after the same app-server reported trusted');
    }
    const binary = (await run('which', ['codex'])).stdout.trim();
    const command = ['-S', mux, 'new-session', '-d', '-s', 'probe', '-c', root,
      binary, '--dangerously-bypass-hook-trust', ...(resume ? ['resume', resumedThread] : []), '--model', CODEX_CANARY_MODELS[0], ...(embedded ? [] : ['--remote', relay.remote]),
      ...(inject ? [] : ['Return CANARY_OK without tools.'])];
    await run('tmux', command, { env, timeout: 3000 });
    const pane = await run('tmux', ['-S', mux, 'display-message', '-p', '-t', '=probe:', '#{pane_pid}'], { env, timeout: 3000 });
    resolvePane(Number(pane.stdout.trim()));
    if (manualTrust || expectReview) {
      let sawPrompt = false;
      for (let attempt = 0; attempt < 40 && !sawPrompt; attempt++) {
        const pane = await run('tmux', ['-S', mux, 'capture-pane', '-p', '-t', '=probe:'], {env,timeout:3000});
        sawPrompt = pane.stdout.includes('Hooks need review') && pane.stdout.includes('Trust all and continue');
        if (!sawPrompt) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!sawPrompt) throw Error('Expected fixture-only manual hook approval prompt');
      const queriedThread = confirmedThread ?? referencedThread;
      if (queriedThread !== resumedThread || confirmedThread) throw Error('Expected exact requested thread before load');
      const reviewTrust = expectReview ? 'modified' : 'untrusted';
      if (!observedHookReads.some(read => read.scope === 'project' && read.trust === reviewTrust)) {
        throw Error('Expected the TUI itself to read ' + reviewTrust + ' project hooks before review');
      }
      console.log(JSON.stringify({ reviewPrompt: true, threadsReturned, threadLoadedByTui: confirmedThread === resumedThread, observedHookReads }));
      await readBackendHookTrust(hookConfig, { threadId: queriedThread }, 'not-loaded');
      if (expectReview) {
        const hookReceipt = await stat(stopReceipt).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (provider.models.length !== requestBaseline || hookReceipt) {
          throw Error('A changed hook ran or the fixture prompt reached the model before review');
        }
        console.log('Changed fixture hook required review before any Stop or model call');
        return true;
      }
      await run('tmux', ['-S', mux, 'send-keys', '-t', '=probe:', 'Down', 'Enter'], {env,timeout:3000});
      console.log('Explicitly selected Trust all and continue for this disposable fixture');
    }
    if (inject) {
      for (let attempt = 0; attempt < 70 && !tuiReady; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!tuiReady) throw Error('TUI thread did not initialize');
      await new Promise(resolve => setTimeout(resolve, 250));
      await run('tmux', ['-S', mux, 'send-keys', '-t', '=probe:', '-l', fixturePrompt], { env, timeout: 3000 });
      await run('tmux', ['-S', mux, 'send-keys', '-t', '=probe:', 'Enter'], { env, timeout: 3000 });
      await new Promise(resolve => setTimeout(resolve, 300));
      await run('tmux', ['-S', mux, 'send-keys', '-t', '=probe:', 'Enter'], { env, timeout: 3000 });
      console.log('A prompt was submitted via literal tmux pane input and the Codex two-Enter sequence.');
    }
    let stops = [];
    for (let attempt = 0; attempt < 160; attempt++) {
      stops = (await readFile(stopReceipt, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
      if (stops.length >= 2 && (embedded || completed)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const fixtureRequests = provider.models.length - requestBaseline;
    const resumeMatched = !resume || embedded || resumedThread === confirmedThread;
    console.log(JSON.stringify({embedded, resume, resumeMatched, stops, fixtureRequests, refused:provider.failed(), positive, completed, threadsReturned, positiveThreads}));
    if (stops.join(',') !== 'blocked,allowed' || fixtureRequests < 2 || provider.failed() || !resumeMatched || (!embedded && (!positive || !completed || !positiveThreads.includes('selected') || positiveThreads.includes('other')))) {
      const pane = await run('tmux', ['-S', mux, 'capture-pane', '-p', '-t', '=probe:'], {env,timeout:3000}).catch(() => null);
      console.log('Disposable pane:', pane?.stdout?.trim().slice(-1700));
      return false;
    }
    if (expectedLoadedTrust) {
      if (!observedHookReads.some(read => read.scope === 'project' && read.trust === 'trusted')) {
        throw Error('Expected the TUI itself to read trusted project hooks before load');
      }
      console.log(JSON.stringify({ reviewPrompt: false, threadLoadedByTui: confirmedThread === resumedThread, observedHookReads }));
      await readBackendHookTrust(hookConfig, { threadId: confirmedThread }, expectedLoadedTrust);
    }
    return true;
  }

  if (trustedRestart) await readNativeHookTrust(hookConfig, 'untrusted');
  const first = await exercise(trustedRestart || process.argv.includes('--manual-trust-fixture'));
  if (!first) {
    process.exitCode = 1;
  } else if (trustedRestart) {
    const configPath = join(root, 'config.toml');
    const armedConfig = await readFile(configPath, 'utf8');
    if (!armedConfig.includes('trusted_hash')) throw Error('Expected fixture hook approval to be stored');
    await run('tmux', ['-S', mux, 'kill-server'], { env, timeout: 3000 });
    await relay.close();
    relay = undefined;
    // The existing loopback provider intentionally accepts four calls total.
    // Rotate only its fixture URL so that the second exercise has its own cap.
    const firstPort = provider.port;
    await provider.close();
    provider = await openCodexCanaryProvider(new AbortController().signal);
    const priorUrl = 'http://127.0.0.1:' + firstPort + '/v1';
    if (!armedConfig.includes(priorUrl)) throw Error('Expected the original fixture URL');
    await writeFile(configPath, armedConfig.replace(priorUrl, 'http://127.0.0.1:' + provider.port + '/v1'));
    await SafeFsExecutor.safeUnlink(stopReceipt, { operation: 'codex-working-signal-fixture-reset' });
    const changeHook = () => writeFile(hookConfig, stopHook(hook + ' changed-fixture-argument'));
    if (changedHookRestart && !changeAfterPreflight) {
      await changeHook();
      console.log('Reopening the same thread after changing the approved fixture hook command');
    } else {
      console.log('Reopening the same thread with unchanged fixture hook approval');
    }
    await readNativeHookTrust(hookConfig, changedHookRestart && !changeAfterPreflight ? 'modified' : 'trusted');
    if (!await exercise(false, changedHookRestart, changedHookRestart ? undefined : 'trusted',
      changeAfterPreflight ? changeHook : undefined)) process.exitCode = 1;
  }

} finally {
  try {
    await relay?.close();
    if (relay && await stat(new URL(relay.remote).pathname).catch(() => null)) {
      throw Error('Managed socket survived close');
    }
  } finally {
    try {
      await run('tmux', ['-S', mux, 'kill-server'], { env, timeout: 3000 }).catch(() => null);
    } finally {
      try {
        await provider?.close();
      } finally {
        await SafeFsExecutor.safeRm(root, {
          recursive: true, force: true, maxRetries: 4, operation: 'codex-working-signal-fixture-cleanup',
        });
      }
    }
  }
}
