import { describe, it, expect } from 'vitest';
import { looksActivelyWorking } from '../../src/monitoring/sentinelWiring.js';

/**
 * The silence-sentinel codex-coverage fix: a `codex exec --json` session (jobs,
 * autonomous spawns) emits a JSON event stream, not the interactive TUI status
 * line. Before the fix none of the codex patterns matched that stream, so a
 * working exec-json session read as NOT active → marked paused → skipped by the
 * ActiveWorkSilenceSentinel → a wedged exec-json job (the 8.5h-hung
 * commitment-detection job) was invisible. These tests pin the new behaviour
 * AND the critical no-false-positive guard (idle model-name line stays inactive).
 */
describe('looksActivelyWorking — codex exec --json coverage', () => {
  it('recognizes a codex exec --json event-stream frame as active', () => {
    expect(looksActivelyWorking('{"type":"turn.started"}', 'codex-cli')).toBe(true);
    expect(looksActivelyWorking('{"type":"thread.started","thread_id":"abc"}', 'codex-cli')).toBe(true);
    expect(
      looksActivelyWorking('{"type":"item.completed","item":{"id":"item_0"}}', 'codex-cli'),
    ).toBe(true);
    // realistic multi-line pane tail
    const pane = [
      '{"type":"thread.started","thread_id":"019e77ca"}',
      '{"type":"turn.started"}',
    ].join('\n');
    expect(looksActivelyWorking(pane, 'codex-cli')).toBe(true);
  });

  it('still recognizes the interactive TUI working signatures (no regression)', () => {
    expect(looksActivelyWorking('• Working (12s • esc to interrupt)', 'codex-cli')).toBe(true);
    expect(looksActivelyWorking('• Ran apply_patch', 'codex-cli')).toBe(true);
  });

  it('does NOT treat the idle codex model-name status line as active (critical guard)', () => {
    // The 2026-05-23 incident: matching "codex" made every idle session look busy.
    expect(looksActivelyWorking('gpt-5.3-codex medium · ~/project', 'codex-cli')).toBe(false);
    expect(looksActivelyWorking('Find and fix a bug in @filename', 'codex-cli')).toBe(false);
  });

  it('does not false-positive on empty or unrelated output', () => {
    expect(looksActivelyWorking('', 'codex-cli')).toBe(false);
    expect(looksActivelyWorking('$ ', 'codex-cli')).toBe(false);
  });

  it('leaves claude-code detection unaffected', () => {
    expect(looksActivelyWorking('Read(file.ts)', 'claude-code')).toBe(true);
    // a codex JSON frame should NOT register under claude-code signals
    expect(looksActivelyWorking('{"type":"turn.started"}', 'claude-code')).toBe(false);
  });
});
