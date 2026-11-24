import { describe, expect, it } from 'vitest'
import { CodexWorkingProtocol } from '../../src/core/CodexWorkingProtocol.js'
import { CodexWorkingTurn } from '../../src/core/CodexWorkingTurn.js'

function fixture() {
  const turn = new CodexWorkingTurn(() => 0)
  const protocol = new CodexWorkingProtocol(turn)
  const send = (direction: 'frontend' | 'backend', value: object) =>
    protocol.inspect(direction, Buffer.from(JSON.stringify(value)))
  const request = (id: number, method: string, threadId = 'main') =>
    send('frontend', { id, method, params: { threadId } })
  const response = (id: number, result: object) => send('backend', { id, result })
  const notice = (method: string, threadId = 'main', id = 'current') =>
    send('backend', { method, params: { threadId, turn: { id } } })
  const open = (id = 0) => {
    request(id, 'thread/resume')
    response(id, { thread: { id: 'main' } })
  }
  const start = (id: number) => {
    request(id, 'turn/start')
    notice('turn/started')
    response(id, { turn: { id: 'current', status: 'inProgress' } })
  }
  return { turn, protocol, request, response, notice, open, start }
}

describe('CodexWorkingProtocol', () => {
  it('uses a successful frontend thread selection and a matched in-progress turn', () => {
    const f = fixture()
    f.start(1)
    expect(f.turn.read()).toBeUndefined()
    f.open()
    f.start(2)
    expect(f.turn.read()?.freshForMs).toBe(10_000)
    f.notice('turn/completed', 'helper')
    expect(f.turn.read()).toBeDefined()
    f.notice('turn/completed')
    expect(f.turn.read()).toBeUndefined()
  })

  it('rejects a turn response already marked completed', () => {
    const f = fixture()
    f.open()
    f.request(1, 'turn/start')
    f.notice('turn/started')
    f.response(1, { turn: { id: 'current', status: 'completed' } })
    expect(f.turn.read()).toBeUndefined()
  })

  it('clears on oversized backend data and recovers on a new matched turn', () => {
    const f = fixture()
    f.open()
    f.start(1)
    f.protocol.inspect('backend', Buffer.alloc(65_537))
    expect(f.turn.read()).toBeUndefined()
    f.start(2)
    expect(f.turn.read()).toBeDefined()
  })

  it('requires a fresh selection if a frontend message could have replaced the thread', () => {
    const f = fixture()
    f.open()
    f.start(1)
    f.protocol.skipMessage('frontend')
    f.start(2)
    expect(f.turn.read()).toBeUndefined()
    f.open(3)
    f.start(4)
    expect(f.turn.read()).toBeDefined()
    f.request(5, 'turn/interrupt')
    expect(f.turn.read()).toBeUndefined()
  })
})
