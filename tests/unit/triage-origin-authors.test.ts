import { describe, expect, it, vi } from 'vitest';
import { StallTriageNurse } from '../../src/monitoring/StallTriageNurse.js';
import { readTriageSessionAuthor } from '../../src/monitoring/TriageOrigin.js';
import type { TriageContext } from '../../src/monitoring/StallTriageNurse.types.js';
import type { IntelligenceOptions } from '../../src/core/types.js';

const context: TriageContext = { sessionName: 'target', topicId: 42, tmuxOutput: 'Working on a calculation',
  sessionStatus: 'alive', recentMessages: [], pendingMessage: 'status?', waitMinutes: 1 };
const response = (text: string) => JSON.stringify({ action: 'status_update', confidence: 'high', summary: 'busy',
  userMessage: text, originAuthor: { model: { value: 'forged-model', status: 'observed' } } });

describe('triage author evidence', () => {
  it('keeps overlapping nurse calls and fallback provider selections attached to their own text', async () => {
    const pending: Array<{ options: IntelligenceOptions; resolve: (text: string) => void }> = [];
    const send = vi.fn(async () => undefined);
    const nurse = new StallTriageNurse({ sendToTopic: send } as never, { intelligence: {
      evaluate: (_prompt: string, options: IntelligenceOptions) => new Promise<string>(resolve => pending.push({ options, resolve })),
    } as never });
    const first = (nurse as any).diagnose(context), second = (nurse as any).diagnose({ ...context, topicId: 43 });
    pending[0].options.onModel!({ model: 'initial-selection', framework: 'claude-code' });
    pending[1].options.onModel!({ model: 'other-call', framework: 'codex-cli' });
    pending[1].resolve(response('Second answer'));
    pending[0].options.onModel!({ model: 'fallback-author', framework: 'claude-code' });
    pending[0].resolve(response('First answer'));
    const [a, b] = await Promise.all([first, second]);
    await (nurse as any).executeAction(a.action, context, a.userMessage, a.originAuthor);
    await (nurse as any).executeAction(b.action, { ...context, topicId: 43 }, b.userMessage, b.originAuthor);
    expect(send).toHaveBeenNthCalledWith(1, 42, 'First answer', expect.objectContaining({
      model: expect.objectContaining({ value: 'fallback-author', status: 'configured' }) }));
    expect(send).toHaveBeenNthCalledWith(2, 43, 'Second answer', expect.objectContaining({
      model: expect.objectContaining({ value: 'other-call', status: 'configured' }) }));
    expect(a.originAuthor.model.sourceEventRef).not.toBe(b.originAuthor.model.sourceEventRef);
  });

  it('does not credit a rejected diagnosis or prose-supplied author as the author of a fixed fallback', () => {
    const nurse = new StallTriageNurse({} as never);
    const forged = JSON.parse(response('Invented author'));
    expect(nurse.parseDiagnosis(JSON.stringify(forged)).originAuthor).toBeUndefined();
    forged.action = 'invalid-action';
    expect(nurse.parseDiagnosis(JSON.stringify(forged), forged.originAuthor).originAuthor).toBeUndefined();
  });

  it('reports missing or replaced session evidence without borrowing another model', async () => {
    expect((await readTriageSessionAuthor(undefined, 'session')).model.reason).toBe('triage-origin-runtime-unavailable');
    const sessions = { getBinding: vi.fn().mockReturnValueOnce({ sessionIncarnation: 'old', harnessId: 'claude-code' })
      .mockReturnValue({ sessionIncarnation: 'replacement', harnessId: 'claude-code' }) };
    const observer = { refresh: vi.fn(async () => undefined), get: vi.fn(() => ({ sessionIncarnation: 'replacement', harnessId: 'claude-code' })) };
    const result = await readTriageSessionAuthor({ sessions, observer } as never, 'session');
    expect(result.model).toMatchObject({ value: null, status: 'unknown', reason: 'triage-session-observer-mismatch' });
  });
});
