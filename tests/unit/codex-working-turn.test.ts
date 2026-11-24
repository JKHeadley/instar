import { describe, expect, it } from 'vitest'
import { CodexWorkingTurn } from '../../src/core/CodexWorkingTurn.js'

describe('CodexWorkingTurn', () => {
  it.each(['notification-first', 'response-first'])('correlates a turn in %s order', order => {
    let now = 0
    const turn = new CodexWorkingTurn(() => now)
    turn.selectThread('main')
    turn.requestStart('main', 1)
    const notice = () => turn.observeStart('main', 'turn')
    const response = () => turn.confirmStart(1, 'main', 'turn')
    if (order === 'notification-first') notice()
    else response()
    expect(turn.read()).toBeUndefined()
    if (order === 'notification-first') response()
    else notice()
    expect(turn.read()).toEqual({ v: 1, freshForMs: 10_000 })
    now = 9_999
    expect(turn.read()?.freshForMs).toBe(1)
    now = 10_000
    expect(turn.read()).toBeUndefined()
  })

  it('ages evidence from native start even when the response is delayed', () => {
    let now = 10
    const turn = new CodexWorkingTurn(() => now)
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.observeStart('main', 'turn')
    now = 4_010
    turn.confirmStart(1, 'main', 'turn')
    expect(turn.read()).toEqual({ v: 1, freshForMs: 6_000 })
  })

  it('cannot show a turn confirmed exactly at its native-start cutoff', () => {
    let now = 1
    const turn = new CodexWorkingTurn(() => now)
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.observeStart('main', 'turn')
    now += 10_000
    turn.confirmStart(1, 'main', 'turn')
    expect(turn.read()).toBeUndefined()
  })

  it('clears a failed request and recovers on a new correlated start', () => {
    const turn = new CodexWorkingTurn(() => 0)
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.observeStart('main', 'failed')
    turn.confirmStart(1)
    turn.confirmStart(1, 'main', 'failed')
    expect(turn.read()).toBeUndefined()
    turn.requestStart('main', 2)
    turn.confirmStart(2, 'main', 'next')
    turn.observeStart('main', 'next')
    expect(turn.read()?.freshForMs).toBe(10_000)
    turn.observeEnd('main')
    expect(turn.read()).toBeUndefined()
  })

  it('withdraws pending evidence when selected-thread requests overlap', () => {
    const turn = new CodexWorkingTurn()
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.requestStart('main', 2)
    turn.confirmStart(1, 'main', 'first')
    turn.observeStart('main', 'first')
    turn.confirmStart(2, 'main', 'second')
    turn.observeStart('main', 'second')
    expect(turn.read()).toBeUndefined()
  })

  it('ignores a discarded RPC response while a later request waits', () => {
    const turn = new CodexWorkingTurn(() => 0)
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.requestStart('main', 2)
    turn.requestStart('main', 3)
    turn.confirmStart(2, 'main', 'discarded')
    expect(turn.read()).toBeUndefined()
    turn.confirmStart(3, 'main', 'current')
    turn.observeStart('main', 'current')
    expect(turn.read()?.freshForMs).toBe(10_000)
  })

  it('never shows a turn that ends before confirmation', () => {
    const turn = new CodexWorkingTurn()
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.observeStart('main', 'turn')
    turn.observeEnd('main')
    turn.confirmStart(1, 'main', 'turn')
    expect(turn.read()).toBeUndefined()
  })

  it('recognizes only the selected thread and exact matching turn', () => {
    const turn = new CodexWorkingTurn()
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.observeStart('helper', 'turn')
    turn.confirmStart(1, 'main', 'turn')
    expect(turn.read()).toBeUndefined()
    turn.observeStart('main', 'another-turn')
    expect(turn.read()).toBeUndefined()
  })

  it.each(['unclassifiable frame', 'thread replacement', 'transport close'])('withdraws evidence on %s', reason => {
    const turn = new CodexWorkingTurn(() => 0)
    turn.selectThread('main')
    turn.requestStart('main', 1)
    turn.confirmStart(1, 'main', 'turn')
    turn.observeStart('main', 'turn')
    turn.observeEnd('helper')
    expect(turn.read()?.freshForMs).toBe(10_000)
    if (reason === 'unclassifiable frame') turn.clearEvidence()
    if (reason === 'thread replacement') turn.selectThread('replacement')
    if (reason === 'transport close') turn.close()
    expect(turn.read()).toBeUndefined()
    turn.observeStart('main', 'turn')
    expect(turn.read()).toBeUndefined()
  })
})
