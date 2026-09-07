import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { RuntimeOriginObserver, type RuntimeOriginObservation } from './RuntimeOriginObserver.js';
import { CODEX_CANARY_FALLBACK, CODEX_CANARY_MODELS, openCodexCanaryProvider } from './OriginCodexModelCanaryProtocol.js';

export interface CodexNativeModelCanaryResult {
  harness: 'codex-cli';
  scope: 'native-cli-format-with-loopback-provider';
  providerExecutionVerified: false;
  state: 'passed' | 'failed' | 'unavailable';
  reason: string;
  sampledAt: number;
  cliVersion: string | null;
  cliDigest: string | null;
  parserDigest: string | null;
  twoTurnChecks: Array<{ expectedModel: string; nativeId: string; turnId: string; observedMatch: boolean }>;
  isolationControls: Array<{ name: string; passed: boolean }>;
  cleanupVerified: boolean;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const quote = (value: string) => JSON.stringify(value);
class CanaryFailure extends Error { constructor(readonly category: string) { super(category); } }

/** Resolve the installed official npm shim without executing it or loading its
 * user config. Never fall back to a shell, another provider or downloaded CLI. */
export async function resolveCodexNativeCanaryBinary(cliPath: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  let entrypoint = cliPath;
  if (cliPath === 'codex') {
    // Mirror the shared resolver's bare default without a shell or `which`.
    // The first executable owns the name; an unrecognized shim does not grant
    // permission to silently select another installation later in PATH.
    entrypoint = '';
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).slice(0, 64)) {
      if (!path.isAbsolute(directory) || directory.length > 4096) continue;
      const candidate = path.join(directory, 'codex');
      try { await access(candidate, constants.X_OK); if (!(await stat(candidate)).isFile()) continue; entrypoint = candidate; break; }
      catch { /* Missing/inaccessible PATH entry: continue the bounded lookup. */ }
    }
  }
  if (!path.isAbsolute(entrypoint)) return null;
  const native = async (file: string) => {
    const handle = await open(file, 'r');
    try { const bytes = Buffer.alloc(4); await handle.read(bytes, 0, 4, 0);
      return ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(bytes.toString('hex')); }
    finally { await handle.close(); }
  };
  try {
    const resolved = await realpath(entrypoint);
    if (await native(resolved)) return resolved;
    const packageFile = path.join(path.dirname(path.dirname(resolved)), 'package.json');
    if ((await stat(packageFile)).size > 64 * 1024 || JSON.parse(await readFile(packageFile, 'utf8')).name !== '@openai/codex') return null;
    if (!['arm64', 'x64'].includes(process.arch)) return null;
    const platformPackage = createRequire(packageFile).resolve(`@openai/codex-darwin-${process.arch}/package.json`);
    const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    const binary = await realpath(path.join(path.dirname(platformPackage), 'vendor', triple, 'bin', 'codex'));
    return await native(binary) ? binary : null;
  } catch { return null; }
}

export function matchesCodexCanaryObservation(observation: RuntimeOriginObservation | undefined,
  expected: { nativeId: string; turnId: string; model: string }): boolean {
  return observation?.harnessId === 'codex-cli' && observation.nativeSessionId === expected.nativeId &&
    observation.turnId === expected.turnId && observation.model.status === 'observed' &&
    observation.model.value === expected.model && typeof observation.model.sourceEventRef === 'string' &&
    observation.model.sourceEventRef.length > 0;
}

/** Standalone one-shot canary, not an LLM request provider or session launcher.
 * It cannot use real authentication: the only provider is a fixed local SSE
 * fixture, fenced by Seatbelt. Native app-server replies are the independent
 * session/turn oracle; only the CLI writes the transcript parsed by the observer.
 * Scheduling/single-flight and health freshness belong to the owning supervisor.
 */
export async function runCodexNativeModelCanary(options: {
  cliPath: string; scratchParent: string; signal: AbortSignal; timeoutMs?: number;
}): Promise<CodexNativeModelCanaryResult> {
  const result: CodexNativeModelCanaryResult = { harness: 'codex-cli', scope: 'native-cli-format-with-loopback-provider', providerExecutionVerified: false,
    state: 'unavailable', reason: 'native-model-canary-not-started', sampledAt: Date.now(),
    cliVersion: null, cliDigest: null, parserDigest: null, twoTurnChecks: [], isolationControls: [], cleanupVerified: true };
  if (process.platform !== 'darwin') return { ...result, reason: 'native-model-canary-kernel-isolation-unavailable' };
  if (!path.isAbsolute(options.cliPath) || !path.isAbsolute(options.scratchParent)) return { ...result, reason: 'native-model-canary-invalid-path' };
  const budget = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 30_000) return { ...result, reason: 'native-model-canary-invalid-budget' };
  if (options.signal.aborted) return { ...result, reason: 'native-model-canary-cancelled' };
  const abort = new AbortController(), deadline = Date.now() + budget;
  const cancel = () => abort.abort(); options.signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, budget);
  const children: Array<{ child: ChildProcessWithoutNullStreams; exited: boolean; exit: Promise<void> }> = [];
  let root: string | undefined, provider: Awaited<ReturnType<typeof openCodexCanaryProvider>> | undefined;
  const observer = new RuntimeOriginObserver({ maxSessions: 1 });
  const check = () => { if (abort.signal.aborted || Date.now() >= deadline) throw new CanaryFailure('native-model-canary-cancelled-or-timeout'); };
  const launch = (args: string[], env: NodeJS.ProcessEnv) => {
    check();
    const child = spawn('/usr/bin/sandbox-exec', args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const entry = { child, exited: false, exit: Promise.resolve() };
    entry.exit = new Promise<void>(resolve => {
      child.once('exit', () => { entry.exited = true; resolve(); });
      child.once('error', () => { entry.exited = true; resolve(); });
    });
    children.push(entry);
    return entry;
  };
  const kill = () => {
    for (const entry of children) if (!entry.exited && entry.child.pid) {
      // Detached, still-owned ChildProcess group; never target a session or
      // discover a PID by name. The group is created only by this invocation.
      try { process.kill(-entry.child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') result.cleanupVerified = false; }
    }
  };
  abort.signal.addEventListener('abort', kill, { once: true });
  try {
    await access('/usr/bin/sandbox-exec');
    const cli = await realpath(options.cliPath), info = await stat(cli);
    if (!info.isFile() || info.size > 256 * 1024 * 1024 || info.size < 4) throw new CanaryFailure('native-model-canary-cli-unavailable');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(cli)) { check(); hash.update(chunk); }
    result.cliDigest = hash.digest('hex');
    let parser: Buffer;
    try { parser = await readFile(new URL('./RuntimeOriginObserver.js', import.meta.url)); }
    catch { parser = await readFile(new URL('./RuntimeOriginObserver.ts', import.meta.url)); }
    result.parserDigest = digest(parser);
    const parent = await realpath(options.scratchParent);
    root = await realpath(await mkdtemp(path.join(parent, 'instar-codex-model-canary-')));
    const configHome = path.join(root, 'codex-home'), project = path.join(root, 'project');
    for (const directory of [configHome, project, path.join(root, 'tmp')]) await mkdir(directory, { mode: 0o700 });
    provider = await openCodexCanaryProvider(abort.signal); check();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { CODEX_HOME: configHome, TMPDIR: path.join(root, 'tmp'), PWD: project });
    const profile = path.join(root, 'canary.sb');
    await writeFile(profile, `(version 1)\n(deny default)\n(allow file-read*)\n` +
      `(deny file-read-data (require-all (subpath ${quote(os.homedir())}) (require-not (subpath ${quote(root)}))))\n` +
      `(deny file-read-data (subpath "/Users/Shared") (subpath "/Library/Keychains"))\n` +
      `(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))\n` +
      // No tools are requested, so descendants are forbidden structurally.
      // This also makes an exited leader sufficient for resource closure.
      `(allow process-exec (literal ${quote(cli)}) (literal ${quote(await realpath(process.execPath))}))\n` +
      `(allow signal (target same-sandbox))\n(allow process-info*)\n(allow sysctl-read)\n(allow mach-lookup)\n` +
      `(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.SecurityServer"))\n` +
      `(allow network-outbound (remote ip "localhost:${provider.port}"))\n` +
      `(allow network* (local unix-socket (subpath ${quote(root)})) (remote unix-socket (subpath ${quote(root)})))\n`, { mode: 0o600 });
    // Actual kernel sabotage controls, before the CLI receives any prompt.
    const controls = `const fs=require('fs'),net=require('net');(async()=>{const out=[];` +
      `const fork=require('child_process').spawnSync(process.execPath,['-e','process.exit(0)'],{timeout:1000});out.push(fork.error?.code==='EPERM');` +
      `for(const [name,fn] of [['credential',()=>fs.readFileSync(${quote(path.join(os.homedir(), '.codex/auth.json'))})],['write',()=>fs.writeFileSync(${quote(path.join(os.tmpdir(), `canary-denied-${randomUUID()}`))},'denied')]]){try{fn();out.push(false)}catch(e){out.push(e.code==='EPERM')}}` +
      `for(const [host,port,allow] of [['1.1.1.1',443,false],['127.0.0.1',4042,false],['127.0.0.1',${provider.port},true]])await new Promise(r=>{const s=net.createConnection({host,port});let done=false;const finish=v=>{if(done)return;done=true;out.push(v);s.destroy();r()};s.once('connect',()=>finish(allow));s.once('error',e=>finish(!allow&&e.code==='EPERM'));setTimeout(()=>finish(false),1500).unref()});` +
      `console.log(JSON.stringify({passed:out.length===6&&out.every(Boolean),results:out}))})().catch(()=>process.exit(1));`;
    const control = launch(['-f', profile, process.execPath, '-e', controls], env);
    let controlOutput = ''; control.child.stdout.on('data', chunk => { controlOutput += String(chunk); if (controlOutput.length > 4096) abort.abort(); });
    control.child.stderr.resume(); await control.exit; check();
    let controlsPassed = false;
    try {
      const proof = JSON.parse(controlOutput);
      const names = ['no-fork-same-allowed-node', 'operator-auth-file-read-denied', 'outside-root-write-denied',
        'external-network-denied', 'production-local-api-denied', 'owned-loopback-permitted'];
      if (Array.isArray(proof.results) && proof.results.length === names.length && proof.results.every((value: unknown) => typeof value === 'boolean')) {
        result.isolationControls = names.map((name, index) => ({ name, passed: proof.results[index] }));
        controlsPassed = proof.passed === true && result.isolationControls.every(item => item.passed);
      }
    } catch { /* A malformed control result never authorizes the native launch. */ }
    if (control.child.exitCode !== 0 || !controlsPassed) throw new CanaryFailure('native-model-canary-isolation-control-failed');
    await writeFile(path.join(configHome, 'config.toml'),
      `model = ${quote(CODEX_CANARY_MODELS[0])}\nmodel_provider = "instar_canary"\ncli_auth_credentials_store = "file"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n` +
      `[features]\nshell_snapshot = false\n[analytics]\nenabled = false\n` +
      `[model_providers.instar_canary]\nname = "Isolated native-format canary"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 5000\n`, { mode: 0o600 });
    const live = launch(['-f', profile, cli, 'app-server', '--stdio'], env);
    let sequence = 0, buffer = '', bytes = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const completed = new Set<string>();
    const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
      check(); const id = ++sequence; pending.set(id, { resolve, reject });
      live.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) reject(new CanaryFailure('native-model-canary-rpc-unavailable')); });
    });
    live.child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 1024 * 1024) { abort.abort(); return; } buffer += String(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.id !== undefined && pending.has(event.id)) {
            const slot = pending.get(event.id)!; pending.delete(event.id);
            if (event.error) slot.reject(new CanaryFailure('native-model-canary-native-protocol-refused')); else slot.resolve(event.result);
          } else if (event.method === 'turn/completed' && typeof event.params?.turn?.id === 'string') completed.add(event.params.turn.id);
          // The scripted provider never requests tools; any native request
          // requiring an answer is a failed protocol, not an approval grant.
          else if (event.id !== undefined) abort.abort();
        } catch { abort.abort(); }
      }
    });
    live.child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) abort.abort(); });
    const rejectPending = () => { for (const item of pending.values()) item.reject(new CanaryFailure('native-model-canary-native-exited')); pending.clear(); };
    void live.exit.then(rejectPending); abort.signal.addEventListener('abort', rejectPending, { once: true });
    const initialized = await request('initialize', { clientInfo: { name: 'instar_model_canary', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    const version = String(initialized?.userAgent ?? '').match(/(?:codex[^/ ]*\/)?(\d+\.\d+\.\d+)/);
    result.cliVersion = version?.[1] ?? null;
    live.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const started = await request('thread/start', { cwd: project, model: CODEX_CANARY_MODELS[0], modelProvider: 'instar_canary', approvalPolicy: 'never', sandbox: 'read-only' });
    const nativeId = started?.thread?.id;
    if (typeof nativeId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(nativeId)) throw new CanaryFailure('native-model-canary-native-id-unavailable');
    observer.track({ agentId: 'isolated-canary', machineId: 'isolated-canary', sessionId: 'canary', sessionIncarnation: randomUUID(),
      issuedAt: new Date().toISOString(), harnessId: 'codex-cli', projectDir: project, configHome, nativeSessionId: nativeId, configuredModel: CODEX_CANARY_FALLBACK });
    for (const expectedModel of CODEX_CANARY_MODELS) {
      check();
      const turn = await request('turn/start', { threadId: nativeId, model: expectedModel, input: [{ type: 'text', text: 'Return CANARY_OK without using any tool.' }] });
      const turnId = turn?.turn?.id;
      if (typeof turnId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(turnId)) throw new CanaryFailure('native-model-canary-turn-id-unavailable');
      if (result.twoTurnChecks.some(previous => previous.turnId === turnId)) throw new CanaryFailure('native-model-canary-turn-id-reused');
      while (!completed.has(turnId)) { check(); if (live.exited) throw new CanaryFailure('native-model-canary-native-exited'); await delay(25); }
      let observedMatch = false;
      while (Date.now() < deadline - 100) {
        check(); await observer.refresh('canary'); const observation = observer.get('canary');
        observedMatch = matchesCodexCanaryObservation(observation, { nativeId, turnId, model: expectedModel });
        if (observedMatch) break; await delay(25);
      }
      result.twoTurnChecks.push({ expectedModel, nativeId, turnId, observedMatch });
      if (!observedMatch) throw new CanaryFailure('native-model-canary-observation-mismatch');
    }
    if (provider.failed() || provider.models.length !== 2 || provider.models.some((model, index) => model !== CODEX_CANARY_MODELS[index])) {
      throw new CanaryFailure('native-model-canary-provider-expectation-mismatch');
    }
    // CLI persisted its own transcript; an auth file appearing is never accepted.
    try { await access(path.join(configHome, 'auth.json')); throw new CanaryFailure('native-model-canary-unexpected-auth'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    result.state = 'passed'; result.reason = 'native-model-canary-two-native-turns-matched';
  } catch (error) {
    result.state = result.cliDigest ? 'failed' : 'unavailable';
    result.reason = error instanceof CanaryFailure ? error.category : 'native-model-canary-unavailable';
  } finally {
    clearTimeout(timeout); options.signal.removeEventListener('abort', cancel); observer.stop(); kill();
    await Promise.race([Promise.all(children.map(entry => entry.exit)), delay(2000)]);
    if (children.some(entry => !entry.exited)) result.cleanupVerified = false;
    try { await provider?.close(); } catch { result.cleanupVerified = false; }
    if (root && result.cleanupVerified) {
      try { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'origin-native-model-canary-owned-scratch-cleanup' }); }
      catch { result.cleanupVerified = false; }
    }
    if (!result.cleanupVerified) { result.state = 'failed'; result.reason = 'native-model-canary-cleanup-unverified'; }
    result.sampledAt = Date.now();
  }
  return result;
}
