/**
 * Integration canary for setup wizard dispatch.
 *
 * This pins the production setup.ts routing contract: gemini-cli uses the
 * hybrid driver and cannot fall through to the Claude setup skill prompt.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETUP_SRC = path.resolve(__dirname, '../../src/commands/setup.ts');

describe('setup.ts routes gemini-cli to the hybrid driver', () => {
  const source = fs.readFileSync(SETUP_SRC, 'utf-8');

  it('dispatches framework === gemini-cli to runGeminiWizard', () => {
    expect(source).toMatch(/if\s*\(\s*framework\s*===\s*'gemini-cli'\s*\)/);
    expect(source).toMatch(/import\(.*setup-wizard\/gemini-driver/);
    expect(source).toMatch(/runGeminiWizard\s*\(/);
    expect(source).toMatch(/geminiPath:\s*geminiPath!/);
  });

  it('keeps the Claude setup skill path Claude-only', () => {
    expect(source).toMatch(/framework\s*===\s*'claude-code'\s*&&\s*!fs\.existsSync\(skillPath\)/);
    expect(source).not.toMatch(/framework\s*===\s*'gemini-cli'[\s\S]{0,500}setup-wizard\/SKILL\.md/);
    expect(source).not.toMatch(/Read \$\{wizardSkillPath\} and follow its instructions/);
  });
});
