/**
 * ContextScopeControl: same as anthropic-headless. Interactive REPL also
 * respects --setting-sources but it's applied at pool-spawn time, not per
 * request.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ContextScopeControl,
  ContextScopeRules,
  ContextScopeSpec,
  ContextScope,
} from '../../../primitives/control/contextScopeControl.js';
import { CapabilityFlag } from '../../../capabilities.js';

class InteractivePoolContextScopeControl implements ContextScopeControl {
  readonly capability = CapabilityFlag.ContextScopeControl;

  buildSpec(rules: ContextScopeRules): ContextScopeSpec {
    return { __brand: 'ContextScopeSpec', rules } as ContextScopeSpec;
  }

  supportedScopes(): ReadonlySet<ContextScope> {
    return new Set<ContextScope>(['builtin', 'user', 'project', 'directory']);
  }

  async writeInstructionFile(
    _scope: ContextScope,
    filePath: string,
    content: string,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

export function createContextScopeControl(): ContextScopeControl {
  return new InteractivePoolContextScopeControl();
}
