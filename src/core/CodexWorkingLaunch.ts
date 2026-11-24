import { SafeFsExecutor } from './SafeFsExecutor.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyCodexUnixPeer } from './CodexWorkingPeerVerifier.js'
import { openCodexWorkingRelay } from './CodexWorkingRelay.js'

interface ManagedLaunchOptions {
  codexBinary: string
  peerVerifierBinary: string
  cwd: string
  /** Exact environment prepared for this session, including the selected Codex home. */
  env: NodeJS.ProcessEnv
  frontendPid: Promise<number>
  /** Existing launch configuration flags that are also valid for app-server. */
  backendConfigArgs: readonly string[]
  signal: AbortSignal
}

const STARTUP_MS = 4_000

/** Owns one app-server child and relay. The caller owns the terminal session. */
export async function startCodexWorkingLaunch(options: ManagedLaunchOptions) {
  if (process.platform !== 'darwin' || !isAbsolute(options.codexBinary)
    || !isAbsolute(options.peerVerifierBinary)) {
    throw new Error('Managed Codex launch requires installed macOS executables')
  }
  options.signal.throwIfAborted()
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'icx-'))
  const alias = join(directory, 'backend.sock')
  const lifetime = AbortSignal.any([options.signal, AbortSignal.timeout(STARTUP_MS)])
  const frontendPid = options.frontendPid.catch(() => undefined)
  let child: ReturnType<typeof spawn> | undefined
  let relay: Awaited<ReturnType<typeof openCodexWorkingRelay>> | undefined
  let closed = false
  let closing: Promise<void> | undefined
  let exit: Promise<unknown> | undefined

  function close(): Promise<void> {
    closed = true
    closing ??= cleanup()
    return closing
  }

  async function cleanup(): Promise<void> {
    options.signal.removeEventListener('abort', abort)
    try {
      await relay?.close()
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([exit, delay(500, undefined, { ref: false })])
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await exit
      // This directory was created for this launch. Its socket alias is removed
      // without following the symlink into Codex's own temporary directory.
      await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, maxRetries: 3, operation: 'codex-working-launch-cleanup' })
    }
  }

  function abort(): void {
    void close().catch(() => {
      // @silent-fallback-ok: the owning caller can observe cleanup via close().
    })
  }

  try {
    lifetime.throwIfAborted()
    child = spawn(options.codexBinary, [
      ...options.backendConfigArgs, 'app-server', '--listen', 'unix://' + alias,
    ], { cwd: options.cwd, env: options.env, stdio: 'ignore' })
    // Keep error and close listeners even when startup runs out of time.
    exit = new Promise(resolve => child!.once('close', resolve))
    const spawned = once(child, 'spawn', { signal: lifetime })
    child.on('error', abort)
    await spawned
    const backendPid = child.pid
    if (!backendPid) throw new Error('Managed Codex app-server has no PID')
    while (!(await stat(alias).catch(() => undefined))?.isSocket()) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Managed Codex app-server exited before opening its socket')
      }
      await delay(25, undefined, { signal: lifetime })
    }
    lifetime.throwIfAborted()
    relay = await openCodexWorkingRelay({
      privateDir: directory,
      backendAlias: alias,
      verifyFrontend: async (socket) => {
        const deadline = new AbortController()
        try {
          const pid = await Promise.race([
            frontendPid,
            delay(STARTUP_MS, undefined, { signal: deadline.signal, ref: false }),
          ])
          return pid !== undefined && !closed && verifyCodexUnixPeer(options.peerVerifierBinary, socket, pid)
        } finally {
          deadline.abort()
        }
      },
      verifyBackend: async (socket) => !closed
        && verifyCodexUnixPeer(options.peerVerifierBinary, socket, backendPid),
    })
    if (closed) {
      await relay.close()
      throw new Error('Managed Codex startup was interrupted')
    }
    lifetime.throwIfAborted()
    void relay.ended.then(abort)
    child.once('close', abort)
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Managed Codex app-server ended during startup')
    }
    return { remote: 'unix://' + relay.socketPath, read: relay.read, close }
  } catch (error) {
    await close()
    throw error
  }
}
