/**
 * Tier-1 tests for the NicknameCommand recognizer (Multi-Machine Session Pool §L4).
 * Covers the headline "move this to <nickname>" flows, intent classification
 * (transfer vs pin), longest-nickname resolution, and — critically — the negatives:
 * a bare machine mention must NEVER be read as a relocation command.
 */
import { describe, it, expect } from 'vitest';
import { recognizeNicknameCommand } from '../../src/core/NicknameCommand.js';

const NICKS = ['mini', 'mac mini', 'workstation', 'laptop', 'gpu box'];

describe('recognizeNicknameCommand (§L4)', () => {
  it('recognizes "move this to the mini" as a transfer', () => {
    expect(recognizeNicknameCommand('move this to the mini', NICKS)).toMatchObject({ intent: 'transfer', nickname: 'mini' });
  });

  it('recognizes several relocation verbs', () => {
    for (const t of ['transfer the conversation to workstation', 'switch this over to the laptop', 'migrate the session onto workstation', 'send this to the laptop']) {
      expect(recognizeNicknameCommand(t, NICKS)?.intent).toBe('transfer');
    }
  });

  it('recognizes "run this on <nick>" / "keep running on <nick>" as a transfer', () => {
    expect(recognizeNicknameCommand('run this on the workstation', NICKS)).toMatchObject({ intent: 'transfer', nickname: 'workstation' });
    expect(recognizeNicknameCommand('keep running on the laptop', NICKS)).toMatchObject({ nickname: 'laptop' });
  });

  it('classifies "pin this to <nick>" as a pin (hard) intent', () => {
    expect(recognizeNicknameCommand('pin this to the gpu box', NICKS)).toMatchObject({ intent: 'pin', nickname: 'gpu box' });
  });

  it('resolves the LONGEST nickname when several could match', () => {
    expect(recognizeNicknameCommand('move this to the mac mini', NICKS)).toMatchObject({ nickname: 'mac mini' });
  });

  it('is case-insensitive', () => {
    expect(recognizeNicknameCommand('MOVE THIS TO THE WORKSTATION', NICKS)?.nickname).toBe('workstation');
  });

  it('returns null for a bare machine mention (no relocation verb)', () => {
    expect(recognizeNicknameCommand('the mini is really fast today', NICKS)).toBeNull();
    expect(recognizeNicknameCommand('the workstation handled that job', NICKS)).toBeNull();
  });

  it('returns null when the verb has no target preposition', () => {
    expect(recognizeNicknameCommand('move along, nothing to see', NICKS)).toBeNull();
    expect(recognizeNicknameCommand('send me an update', NICKS)).toBeNull();
  });

  it('returns null when the target is not a known nickname', () => {
    expect(recognizeNicknameCommand('move this to mars', NICKS)).toBeNull();
    expect(recognizeNicknameCommand('transfer this to the cloud', NICKS)).toBeNull();
  });

  it('returns null on empty input or empty nickname set', () => {
    expect(recognizeNicknameCommand('', NICKS)).toBeNull();
    expect(recognizeNicknameCommand('move this to the mini', [])).toBeNull();
  });

  it('is pure — same inputs → same output', () => {
    const a = recognizeNicknameCommand('move this to the mac mini', NICKS);
    const b = recognizeNicknameCommand('move this to the mac mini', NICKS);
    expect(a).toEqual(b);
  });
});
