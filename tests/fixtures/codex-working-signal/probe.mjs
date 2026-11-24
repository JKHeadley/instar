/** Review-only fixture. Never uses the operator's Codex home or a live model. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, stat, realpath, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startCodexWorkingLaunch } from '../../../dist/core/CodexWorkingLaunch.js';
import { CodexWorkingProtocol } from '../../../dist/core/CodexWorkingProtocol.js';
import { SafeFsExecutor } from '../../../dist/core/SafeFsExecutor.js';
import { openCodexCanaryProvider, CODEX_CANARY_MODELS } from '../../../dist/messaging/telegram-origin/OriginCodexModelCanaryProtocol.js';

if (process.platform !== 'darwin') throw Error('This fixture requires macOS');
const run = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'icx-')));
let relay;
let resolvePane;
const panePid = new Promise(resolve => { resolvePane = resolve; });
const mux = join(root, 'tmux.sock');
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, TERM: 'xterm-256color' };
let provider;
let positive = false;
let completed = false;
let tuiReady = false;
const embedded = process.argv.includes('--embedded');
const resume = process.argv.includes('--resume');
let resumedThread;
let confirmedThread;
const stopReceipt = join(root, 'stop-count');
const inject = process.argv.includes('--inject');
const fixturePrompt = 'Return CANARY_OK without tools.';
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
  const requestBaseline = provider.models.length;
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
  await writeFile(join(root, '.codex', 'hooks.json'), JSON.stringify({
    hooks: {Stop: [{matcher:'', hooks:[{type:'command', command:hook}]}]},
  }));
  if (!embedded) {
    relay = await startCodexWorkingLaunch({
      codexBinary: (await run('which', ['codex'])).stdout.trim(),
      peerVerifierBinary: verifier,
      cwd: root, env, frontendPid: panePid,
      backendConfigArgs: ['--dangerously-bypass-hook-trust'],
      signal: new AbortController().signal,
    });
    const threadMethod = CodexWorkingProtocol.prototype.inspect;
    CodexWorkingProtocol.prototype.inspect = function(direction, payload) {
      const before = relay.read();
      const elapsedStart = performance.now();
      threadMethod.call(this, direction, payload);
      const after = Boolean(relay.read());
      positive ||= after;
      if (direction !== 'backend') return;
      const rpc = JSON.parse(payload.toString());
      tuiReady ||= typeof rpc.result?.thread?.id === 'string';
      if (typeof rpc.result?.thread?.id === 'string') confirmedThread = rpc.result.thread.id;
      completed ||= Boolean(before && before.freshForMs > performance.now() - elapsedStart && !after
        && rpc.method === 'turn/completed' && rpc.params?.turn?.status === 'completed');
    };
  }
  const binary = (await run('which', ['codex'])).stdout.trim();
  const command = ['-S', mux, 'new-session', '-d', '-s', 'probe', '-c', root,
    binary, '--dangerously-bypass-hook-trust', ...(resume ? ['resume', resumedThread] : []), '--model', CODEX_CANARY_MODELS[0], ...(embedded ? [] : ['--remote', relay.remote]),
    ...(inject ? [] : ['Return CANARY_OK without tools.'])];
  await run('tmux', command, { env, timeout: 3000 });
  const pane = await run('tmux', ['-S', mux, 'display-message', '-p', '-t', '=probe:', '#{pane_pid}'], { env, timeout: 3000 });
  resolvePane(Number(pane.stdout.trim()));
  if (process.argv.includes('--manual-trust-fixture')) {
    let sawPrompt = false;
    for (let attempt = 0; attempt < 40 && !sawPrompt; attempt++) {
      const pane = await run('tmux', ['-S', mux, 'capture-pane', '-p', '-t', '=probe:'], {env,timeout:3000});
      sawPrompt = pane.stdout.includes('Hooks need review') && pane.stdout.includes('Trust all and continue');
      if (!sawPrompt) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!sawPrompt) throw Error('Expected fixture-only manual hook approval prompt');
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
  console.log(JSON.stringify({embedded, resume, resumeMatched, stops, fixtureRequests, refused:provider.failed(), positive, completed}));
  if (stops.join(',') !== 'blocked,allowed' || fixtureRequests < 2 || provider.failed() || !resumeMatched || (!embedded && (!positive || !completed))) {
    const pane = await run('tmux', ['-S', mux, 'capture-pane', '-p', '-t', '=probe:'], {env,timeout:3000}).catch(() => null);
    console.log('Disposable pane:', pane?.stdout?.trim().slice(-1700));
    process.exitCode = 1;
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
