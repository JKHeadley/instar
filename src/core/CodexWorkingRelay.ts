import { lstat, realpath, chmod } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { CodexWorkingTurn } from './CodexWorkingTurn.js'
import { CodexWorkingProtocol } from './CodexWorkingProtocol.js'
import { CodexWorkingFrameTap } from './CodexWorkingFrameTap.js'

interface RelayOptions {
  privateDir: string
  backendAlias: string
  /** Checks the connected peer against the app-server child for this launch. */
  verifyBackend: (socket: Socket) => Promise<boolean>
  /** Checks that the connected process belongs to the expected frontend launch. */
  verifyFrontend: (socket: Socket) => Promise<boolean>
}

async function privateDirectory(directory: string, uid: number): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('Codex observation directory is not private')
  }
}

export async function openCodexWorkingRelay(options: RelayOptions) {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Codex observation requires Unix socket ownership')
  await privateDirectory(options.privateDir, uid)
  const socketPath = join(options.privateDir, 'frontend.sock')
  if (dirname(options.backendAlias) !== options.privateDir) {
    throw new Error('Codex observation requires the launch-owned backend alias')
  }

  const turn = new CodexWorkingTurn()
  const protocol = new CodexWorkingProtocol(turn)
  let accepted = false
  let frontend: Socket | undefined
  let backend: Socket | undefined
  let inbound: CodexWorkingFrameTap | undefined
  let outbound: CodexWorkingFrameTap | undefined
  let closed = false
  let finish!: () => void
  const ended = new Promise<void>(resolve => { finish = resolve })

  function disconnect(): void {
    protocol.stopObservation()
    frontend?.destroy()
    backend?.destroy()
    inbound?.destroy()
    outbound?.destroy()
    finish()
  }

  async function attach(socket: Socket): Promise<void> {
    if (!await options.verifyFrontend(socket)) throw new Error('Unexpected Codex frontend peer')
    const target = await realpath(options.backendAlias)
    await privateDirectory(dirname(target), uid!)
    const info = await lstat(target)
    if (!info.isSocket() || info.uid !== uid) {
      throw new Error('Unexpected Codex backend socket')
    }
    if (closed || socket.destroyed) return
    const connection = createConnection(target)
    backend = connection
    connection.on('error', disconnect)
    connection.on('close', disconnect)
    connection.once('connect', () => {
      void forward(socket, connection).catch(disconnect)
    })
  }

  async function forward(socket: Socket, connection: Socket): Promise<void> {
    if (!await options.verifyBackend(connection)) throw new Error('Unexpected Codex backend peer')
    if (closed || socket.destroyed || connection.destroyed) return
    inbound = new CodexWorkingFrameTap('frontend', protocol)
    outbound = new CodexWorkingFrameTap('backend', protocol)
    inbound.on('error', disconnect)
    outbound.on('error', disconnect)
    socket.pipe(inbound).pipe(connection)
    connection.pipe(outbound).pipe(socket)
  }

  const server = createServer({ pauseOnConnect: true, highWaterMark: 4096 }, socket => {
    if (accepted || closed) {
      socket.destroy()
      return
    }
    accepted = true
    frontend = socket
    socket.on('close', disconnect)
    socket.on('error', disconnect)
    void attach(socket).catch(disconnect)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      server.on('error', disconnect)
      resolve()
    })
  })

  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    disconnect()
    closing = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    return closing
  }

  try {
    await chmod(socketPath, 0o600)
  } catch (error) {
    await close()
    throw error
  }

  return { socketPath, read: () => turn.read(), close, ended }
}
