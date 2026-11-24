import { spawn } from 'node:child_process'
import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'

const CHECK_DEADLINE_MS = 2_000

/** The binary path must come from the installed package, never from a client or chat. */
export function verifyCodexUnixPeer(binary: string, socket: Socket, expectedPid: number): Promise<boolean> {
  if (process.platform !== 'darwin' || !isAbsolute(binary) || socket.destroyed
    || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) return Promise.resolve(false)

  return new Promise(resolve => {
    let child
    try {
      // The helper receives only the connected descriptor and the expected PID.
      child = spawn(binary, [String(expectedPid)], {
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', socket],
      })
    } catch {
      // @silent-fallback-ok: without a peer check the optional indicator stays hidden.
      resolve(false)
      return
    }

    let expired = false
    const timer = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
    }, CHECK_DEADLINE_MS)
    timer.unref()
    child.on('error', () => {
      // A failed native verifier is never evidence of peer ownership.
      expired = true
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve(!expired && code === 0 && signal === null)
    })
  })
}
