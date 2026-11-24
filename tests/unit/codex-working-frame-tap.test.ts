import { describe, expect, it } from 'vitest'
import { CodexWorkingFrameTap } from '../../src/core/CodexWorkingFrameTap.js'
import { CodexWorkingProtocol } from '../../src/core/CodexWorkingProtocol.js'
import { CodexWorkingTurn } from '../../src/core/CodexWorkingTurn.js'

function frame(opcode: number, fin: boolean, payload: Buffer, masked = false): Buffer {
  const extended = payload.length > 125
  const wide = payload.length > 65_535
  const header = Buffer.alloc(wide ? 10 : extended ? 4 : 2)
  header[0] = opcode | (fin ? 128 : 0)
  header[1] = (wide ? 127 : extended ? 126 : payload.length) | (masked ? 128 : 0)
  if (wide) header.writeBigUInt64BE(BigInt(payload.length), 2)
  else if (extended) header.writeUInt16BE(payload.length, 2)
  if (!masked) return Buffer.concat([header, payload])
  const key = Buffer.from([17, 33, 49, 65])
  return Buffer.concat([header, key, Buffer.from(payload.map((byte, i) => byte ^ key[i % 4]))])
}

const handshake = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n')

function fixture() {
  const turn = new CodexWorkingTurn(() => 0)
  const protocol = new CodexWorkingProtocol(turn)
  return { protocol, turn }
}

describe('CodexWorkingFrameTap', () => {
  it('forwards fragmented masked bytes verbatim and inspects one decoded request', () => {
    const { protocol } = fixture()
    const messages: string[] = []
    protocol.inspect = (direction, payload) => messages.push(direction + ':' + payload.toString())
    const tap = new CodexWorkingFrameTap('frontend', protocol)
    const forwarded: Buffer[] = []
    tap.on('data', (chunk: Buffer) => forwarded.push(chunk))

    const wire = Buffer.concat([
      handshake,
      frame(1, false, Buffer.from('{"id":'), true),
      frame(9, true, Buffer.alloc(0), true),
      frame(0, true, Buffer.from('1}'), true),
    ])
    for (const byte of wire) tap.write(Buffer.from([byte]))

    expect(Buffer.concat(forwarded)).toEqual(wire)
    expect(messages).toEqual(['frontend:{"id":1}'])
    tap.destroy()
  })

  it('forwards an oversized fragmented message unchanged, skips it and observes the next frame', () => {
    const { protocol } = fixture()
    const messages: string[] = []
    protocol.skipMessage = direction => messages.push('skip:' + direction)
    protocol.inspect = (direction, payload) => messages.push(direction + ':' + payload.toString())
    const tap = new CodexWorkingFrameTap('backend', protocol)
    const forwarded: Buffer[] = []
    tap.on('data', (chunk: Buffer) => forwarded.push(chunk))

    const wire = Buffer.concat([
      handshake,
      frame(1, false, Buffer.alloc(8, 97)),
      frame(0, true, Buffer.alloc(200_000, 98)),
      frame(1, true, Buffer.from('{}')),
    ])
    for (let i = 0; i < wire.length; i += 53) tap.write(wire.subarray(i, i + 53))

    expect(Buffer.concat(forwarded)).toEqual(wire)
    expect(messages).toEqual(['skip:backend', 'backend:{}'])
    tap.destroy()
  })

  it('withdraws a pending response when a possible completion is forwarded uninspected', () => {
    const { protocol, turn } = fixture()
    const json = (value: object) => Buffer.from(JSON.stringify(value))
    protocol.inspect('frontend', json({ id: 0, method: 'thread/start' }))
    protocol.inspect('backend', json({ id: 0, result: { thread: { id: 'main' } } }))
    protocol.inspect('frontend', json({ id: 1, method: 'turn/start', params: { threadId: 'main' } }))

    const tap = new CodexWorkingFrameTap('backend', protocol)
    const forwarded: Buffer[] = []
    tap.on('data', (chunk: Buffer) => forwarded.push(chunk))
    const wire = Buffer.concat([
      handshake,
      frame(1, true, json({ id: 1, result: { turn: { id: 'turn', status: 'inProgress' } } })),
      frame(1, true, json({
        method: 'turn/completed',
        params: { threadId: 'main', turn: { id: 'turn', padding: 'x'.repeat(66_000) } },
      })),
      frame(1, true, json({ method: 'turn/started', params: { threadId: 'main', turn: { id: 'turn' } } })),
    ])
    tap.write(wire)

    expect(turn.read()).toBeUndefined()
    expect(Buffer.concat(forwarded)).toEqual(wire)
    tap.destroy()
  })
})
