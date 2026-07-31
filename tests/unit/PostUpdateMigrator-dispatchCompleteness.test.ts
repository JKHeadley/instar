/**
 * The context hierarchy appends Tier 0 and Tier 1 guidance after the routing
 * table. Both fresh-session and compaction hooks must therefore emit the whole
 * generated DISPATCH.md file; a line cap silently drops structurally required
 * sections as the table grows.
 */
import { describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

function migrator(): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir: '/tmp/instar-dispatch-completeness',
    stateDir: '/tmp/instar-dispatch-completeness/.instar',
    port: 4042,
    hasTelegram: false,
    projectName: 'test-agent',
  });
}

describe('PostUpdateMigrator — complete context dispatch delivery', () => {
  for (const hookName of ['session-start', 'compaction-recovery'] as const) {
    it(`${hookName} emits the complete generated dispatch file`, () => {
      const hook = migrator().getHookContent(hookName);
      const dispatchBlock = hook.match(
        /--- CONTEXT DISPATCH[^\n]*---[\s\S]*?--- END CONTEXT DISPATCH ---/,
      )?.[0];

      expect(dispatchBlock).toBeDefined();
      expect(dispatchBlock).toContain('cat "$DISPATCH_FILE"');
      expect(dispatchBlock).not.toMatch(/head\s+-20/);
    });
  }
});
