import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js'
import { once } from 'node:events'
import { lstat, mkdtemp, symlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openCodexWorkingRelay } from '../../src/core/CodexWorkingRelay.js'

describe.skipIf(process.getuid === undefined)('Codex working relay', () => {
  it('preserves wire bytes for one verified frontend and closes the owned socket', async () => {
    const root = await mkdtemp('/tmp/icx-relay-')
    const target = join(root, 'upstream.sock')
    const alias = join(root, 'backend.sock')
    const seen: Socket[] = []
    const backend = createServer(socket => {
      seen.push(socket)
      socket.pipe(socket)
    })
    let relay: Awaited<ReturnType<typeof openCodexWorkingRelay>> | undefined
    let client: Socket | undefined
    let second: Socket | undefined
    try {
      backend.listen(target)
      await once(backend, 'listening')
      await symlink(target, alias)
      let backendChecks = 0
      let frontendChecks = 0
      relay = await openCodexWorkingRelay({
        privateDir: root,
        backendAlias: alias,
        verifyBackend: async socket => {
          backendChecks++
          expect(socket.connecting).toBe(false)
          return true
        },
        verifyFrontend: async () => {
          frontendChecks++
          return true
        },
      })
      expect((await lstat(relay.socketPath)).mode & 0o777).toBe(0o600)
      client = createConnection(relay.socketPath)
      await once(client, 'connect')
      const payload = Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
      const received = once(client, 'data')
      client.write(payload)
      expect((await received)[0]).toEqual(payload)
      expect(frontendChecks).toBe(1)
      expect(backendChecks).toBe(1)
      second = createConnection(relay.socketPath)
      await once(second, 'close')
      expect(seen).toHaveLength(1)
      expect(relay.read()).toBeUndefined()
      client.destroy()
      await relay.ended
      await relay.close()
      await expect(lstat(relay.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      second?.destroy()
      client?.destroy()
      await relay?.close()
      for (const socket of seen) socket.destroy()
      if (backend.listening) await new Promise<void>(resolve => backend.close(() => resolve()))
      await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'codex-working-relay-test-cleanup' })
    }
  })

  it.each(['frontend', 'backend'])('does not attach an unverified %s', async rejected => {
    const root = await mkdtemp('/tmp/icx-relay-')
    const backendAlias = join(root, 'backend.sock')
    let forwarded = false
    let connected = false
    const backend = createServer(socket => {
      connected = true
      socket.on('data', () => { forwarded = true })
    })
    let relay: Awaited<ReturnType<typeof openCodexWorkingRelay>> | undefined
    let client: Socket | undefined
    try {
      backend.listen(backendAlias)
      await once(backend, 'listening')
      relay = await openCodexWorkingRelay({
        privateDir: root,
        backendAlias,
        verifyFrontend: async () => rejected !== 'frontend',
        verifyBackend: async () => rejected !== 'backend',
      })
      client = createConnection(relay.socketPath)
      await once(client, 'close')
      expect(connected).toBe(rejected === 'backend')
      expect(forwarded).toBe(false)
      expect(relay.read()).toBeUndefined()
    } finally {
      client?.destroy()
      await relay?.close()
      if (backend.listening) await new Promise<void>(resolve => backend.close(() => resolve()))
      await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'codex-working-relay-test-cleanup' })
    }
  })
})
