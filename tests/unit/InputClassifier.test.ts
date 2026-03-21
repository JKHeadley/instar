/**
 * InputClassifier — Unit tests.
 *
 * Tests rule-based classification, path validation, destructive detection,
 * LLM fallback, dry-run mode, and security edge cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InputClassifier,
  type InputClassifierConfig,
  type ClassificationResult,
} from '../../src/monitoring/InputClassifier.js';
import type { DetectedPrompt, PromptType } from '../../src/monitoring/PromptGate.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makePrompt(overrides: Partial<DetectedPrompt> = {}): DetectedPrompt {
  return {
    type: 'permission',
    raw: 'Do you want to create test.py?\n1. Yes\n2. No\n',
    summary: 'Permission: Do you want to create test.py?',
    options: [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No' },
    ],
    sessionName: 'test-session',
    detectedAt: Date.now(),
    id: 'test-id-abc',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<InputClassifierConfig> = {}): InputClassifierConfig {
  return {
    projectDir: '/Users/dev/project',
    autoApprove: {
      enabled: true,
      fileCreation: true,
      fileEdits: true,
      planApproval: true,
    },
    dryRun: false,
    ...overrides,
  };
}

function makeClassifier(overrides: Partial<InputClassifierConfig> = {}): InputClassifier {
  return new InputClassifier(makeConfig(overrides));
}

// ── File Creation Classification ──────────────────────────────────

describe('InputClassifier.fileCreation', () => {
  it('auto-approves file creation in project dir', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create src/utils.ts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('auto-approve');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('relays file creation outside project dir', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create /Users/other/project/foo.ts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('outside project');
  });

  it('relays file creation when auto-approve disabled for files', async () => {
    const classifier = makeClassifier({
      autoApprove: { enabled: true, fileCreation: false, fileEdits: true, planApproval: true },
    });
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create src/index.ts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('disabled');
  });
});

// ── File Edit Classification ──────────────────────────────────────

describe('InputClassifier.fileEdit', () => {
  it('auto-approves file edits in project dir', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to edit src/main.ts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('auto-approve');
  });

  it('relays file edits outside project dir', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to edit /home/user/.bashrc?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });

  it('relays write-to operations outside project', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to write to /tmp/output.txt?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });
});

// ── Question Classification ───────────────────────────────────────

describe('InputClassifier.question', () => {
  it('always relays clarifying questions', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      type: 'question',
      summary: 'What email address should I use for the sender filter?',
      raw: 'What email address should I use for the sender filter?',
      options: undefined,
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('Clarifying questions');
  });
});

// ── Plan Classification ───────────────────────────────────────────

describe('InputClassifier.plan', () => {
  it('auto-approves plan when enabled', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      type: 'plan',
      summary: 'Plan approval requested',
      raw: 'Plan: Read config, update DB\n\nDo you want to proceed?',
      options: [
        { key: 'y', label: 'Approve' },
        { key: 'n', label: 'Reject' },
      ],
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('auto-approve');
  });

  it('relays plan when disabled', async () => {
    const classifier = makeClassifier({
      autoApprove: { enabled: true, fileCreation: true, fileEdits: true, planApproval: false },
    });
    const prompt = makePrompt({
      type: 'plan',
      summary: 'Plan approval requested',
      raw: 'Plan: Read config\nDo you want to proceed?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });
});

// ── Destructive Operations ────────────────────────────────────────

describe('InputClassifier.destructive', () => {
  it('relays operations with rm -rf', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create cleanup.sh?',
      raw: 'rm -rf /tmp/build\nDo you want to create cleanup.sh?\n1. Yes\n2. No',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('Destructive');
  });

  it('relays operations with --force', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create deploy.sh?',
      raw: 'git push --force origin main\nDo you want to create deploy.sh?\n1. Yes\n2. No',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });

  it('relays overwrite operations', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to overwrite config.json?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });
});

// ── Blocked Paths ─────────────────────────────────────────────────

describe('InputClassifier.blockedPaths', () => {
  it('relays file creation in /etc', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create /etc/hosts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('Sensitive path');
  });

  it('relays .env file creation', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create .env?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });

  it('relays credential file creation', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create credentials.json?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
  });
});

// ── Path Traversal Security ───────────────────────────────────────

describe('InputClassifier.pathTraversal', () => {
  it('rejects path traversal via ../', async () => {
    const classifier = makeClassifier();
    // ../../etc/passwd from project dir should resolve outside project
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create ../../etc/passwd?',
    });

    // The resolved path should be outside project dir
    expect(classifier.isInProjectDir('../../etc/passwd')).toBe(false);
  });

  it('handles symlink-style paths correctly', () => {
    const classifier = makeClassifier({ projectDir: '/Users/dev/project' });
    expect(classifier.isInProjectDir('/Users/dev/project/src/foo.ts')).toBe(true);
    expect(classifier.isInProjectDir('/Users/dev/other/foo.ts')).toBe(false);
  });

  it('handles relative paths as project-relative', () => {
    const classifier = makeClassifier({ projectDir: '/Users/dev/project' });
    expect(classifier.isInProjectDir('src/foo.ts')).toBe(true);
    expect(classifier.isInProjectDir('./src/foo.ts')).toBe(true);
  });
});

// ── Auto-Approve Disabled ─────────────────────────────────────────

describe('InputClassifier.autoApproveDisabled', () => {
  it('relays everything when auto-approve is globally disabled', async () => {
    const classifier = makeClassifier({
      autoApprove: { enabled: false, fileCreation: true, fileEdits: true, planApproval: true },
    });
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create src/index.ts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('disabled');
  });
});

// ── Dry Run Mode ──────────────────────────────────────────────────

describe('InputClassifier.dryRun', () => {
  it('converts auto-approve to relay in dry-run mode', async () => {
    const classifier = makeClassifier({ dryRun: true });
    const prompt = makePrompt({
      summary: 'Permission: Do you want to create src/index.ts?',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('DRY RUN');
  });
});

// ── LLM Classification ───────────────────────────────────────────

describe('InputClassifier.llm', () => {
  it('uses LLM for ambiguous prompts', async () => {
    const mockIntelligence = {
      evaluate: async () => 'APPROVE',
    };
    const classifier = makeClassifier({
      intelligence: mockIntelligence,
    });
    // Selection type is ambiguous and falls through to LLM
    const prompt = makePrompt({
      type: 'selection',
      summary: 'Numbered selection',
      raw: 'Which test runner?\n1) vitest\n2) jest\n',
      options: [
        { key: '1', label: 'vitest' },
        { key: '2', label: 'jest' },
      ],
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('auto-approve');
    expect(result.llmClassified).toBe(true);
  });

  it('relays when LLM says RELAY', async () => {
    const mockIntelligence = {
      evaluate: async () => 'RELAY',
    };
    const classifier = makeClassifier({ intelligence: mockIntelligence });
    const prompt = makePrompt({
      type: 'selection',
      summary: 'Numbered selection',
      raw: 'Which environment?\n1) dev\n2) prod\n',
      options: [
        { key: '1', label: 'dev' },
        { key: '2', label: 'prod' },
      ],
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.llmClassified).toBe(true);
  });

  it('relays on LLM failure (fail-closed)', async () => {
    const mockIntelligence = {
      evaluate: async () => { throw new Error('API timeout'); },
    };
    const classifier = makeClassifier({ intelligence: mockIntelligence });
    const prompt = makePrompt({
      type: 'selection',
      summary: 'Numbered selection',
      raw: 'Pick one?\n1) a\n2) b\n',
      options: [{ key: '1', label: 'a' }, { key: '2', label: 'b' }],
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.reason).toContain('failed');
  });

  it('falls through to relay without LLM for ambiguous prompts', async () => {
    const classifier = makeClassifier(); // No intelligence provider
    const prompt = makePrompt({
      type: 'selection',
      summary: 'Numbered selection',
      raw: 'Pick?\n1) a\n2) b\n',
      options: [{ key: '1', label: 'a' }, { key: '2', label: 'b' }],
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('relay');
    expect(result.llmClassified).toBe(false);
  });
});

// ── Confirmation Classification ──────────────────────────────────

describe('InputClassifier.confirmation', () => {
  it('auto-approves "Esc to cancel" when file edits enabled', async () => {
    const classifier = makeClassifier();
    const prompt = makePrompt({
      type: 'confirmation',
      summary: 'Confirmation prompt (Esc to cancel)',
      raw: 'File changes:\n+ new line\nEsc to cancel · Tab to amend',
    });

    const result = await classifier.classify(prompt);
    expect(result.action).toBe('auto-approve');
  });

  it('relays "Esc to cancel" when file edits disabled', async () => {
    const classifier = makeClassifier({
      autoApprove: { enabled: true, fileCreation: true, fileEdits: false, planApproval: true },
    });
    const prompt = makePrompt({
      type: 'confirmation',
      summary: 'Confirmation prompt (Esc to cancel)',
      raw: 'Esc to cancel · Tab to amend',
    });

    const result = await classifier.classify(prompt);
    // Falls through to LLM or relay since "Esc to cancel" path requires fileEdits
    expect(result.action).toBe('relay');
  });
});
