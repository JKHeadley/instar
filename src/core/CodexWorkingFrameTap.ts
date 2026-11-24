import { Transform, type TransformCallback } from 'node:stream'
import { CodexWorkingProtocol, MAX_OBSERVED_BYTES } from './CodexWorkingProtocol.js'

type Direction = 'frontend' | 'backend'

/** Passes the original wire bytes through unchanged while inspecting bounded text messages. */
export class CodexWorkingFrameTap extends Transform {
  private static readonly headerEnd = Buffer.from('\r\n\r\n')
  private handshakeBytes = 0
  private handshakeMatch = 0
  private headerLength = 0
  private readonly header = Buffer.alloc(14)
  private readonly message = Buffer.alloc(MAX_OBSERVED_BYTES)
  private messageLength = 0
  private remaining = 0
  private maskOffset?: number
  private frameOffset = 0
  private control = false
  private fin = false
  private fragmented = false
  private skipping = false
  private disabled = false

  constructor(
    private readonly direction: Direction,
    private readonly protocol: CodexWorkingProtocol,
  ) {
    super({ highWaterMark: 4096 })
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.inspect(chunk)
    callback(null, chunk)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.disable()
    callback(error)
  }

  private inspect(chunk: Buffer): void {
    let offset = 0
    while (!this.disabled && this.handshakeMatch < 4 && offset < chunk.length) {
      const byte = chunk[offset++]
      const end = CodexWorkingFrameTap.headerEnd
      this.handshakeMatch = byte === end[this.handshakeMatch]
        ? this.handshakeMatch + 1
        : Number(byte === end[0])
      if (++this.handshakeBytes > 16 * 1024) this.disable()
    }

    while (!this.disabled && offset < chunk.length) {
      if (this.remaining === 0) {
        this.header[this.headerLength++] = chunk[offset++]
        if (this.headerLength >= 2) this.beginFrame()
        if (this.headerLength !== 0 || this.remaining === 0) continue
      }

      const count = Math.min(this.remaining, chunk.length - offset)
      if (!this.control && !this.skipping) {
        if (this.maskOffset === undefined) {
          chunk.copy(this.message, this.messageLength, offset, offset + count)
        } else {
          for (let i = 0; i < count; i++) {
            this.message[this.messageLength + i] =
              chunk[offset + i] ^ this.header[this.maskOffset + ((this.frameOffset + i) % 4)]
          }
        }
        this.messageLength += count
      }
      this.frameOffset += count
      offset += count
      this.remaining -= count
      if (this.remaining === 0) this.endFrame()
    }
  }

  private beginFrame(): void {
    const opcode = this.header[0] & 15
    const length = this.header[1] & 127
    const masked = Boolean(this.header[1] & 128)
    const lengthOffset = length === 127 ? 10 : length === 126 ? 4 : 2
    if (this.headerLength < lengthOffset + (masked ? 4 : 0)) return

    this.fin = Boolean(this.header[0] & 128)
    this.control = opcode >= 8
    if (this.header[0] & 0x70 || masked !== (this.direction === 'frontend')
      || (this.control && (!this.fin || length > 125 || opcode > 10))) {
      this.disable()
      return
    }

    const size = length === 127 ? this.header.readBigUInt64BE(2)
      : BigInt(length === 126 ? this.header.readUInt16BE(2) : length)
    if (size > BigInt(Number.MAX_SAFE_INTEGER) || opcode === 8) {
      this.disable()
      return
    }

    this.headerLength = 0
    this.maskOffset = masked ? lengthOffset : undefined
    this.remaining = Number(size)
    this.frameOffset = 0

    if (!this.control) {
      if (this.fragmented ? opcode !== 0 : opcode !== 1 && opcode !== 2) {
        this.disable()
        return
      }
      if (!this.fragmented) {
        this.messageLength = 0
        this.skipping = opcode === 2
        if (this.skipping) this.protocol.skipMessage(this.direction)
      }
      if (!this.skipping && this.messageLength + this.remaining > MAX_OBSERVED_BYTES) {
        this.skipping = true
        this.clearMessage()
        this.protocol.skipMessage(this.direction)
      }
    }

    if (this.remaining === 0) this.endFrame()
  }

  private endFrame(): void {
    if (this.control) return
    this.fragmented = !this.fin
    if (this.fin && !this.skipping) {
      this.protocol.inspect(this.direction, this.message.subarray(0, this.messageLength))
      this.clearMessage()
    }
  }

  private clearMessage(): void {
    this.message.fill(0, 0, this.messageLength)
    this.messageLength = 0
  }

  private disable(): void {
    this.clearMessage()
    this.disabled = true
    this.protocol.stopObservation()
  }
}
