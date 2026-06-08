/**
 * Unit tests for ContentClassifier — outbound content filter (Layer 5).
 *
 * Covers: pattern detection (API keys, credentials, PII, SQL, private keys),
 * LLM classification fallback, blockSensitive policy, custom patterns,
 * fail-open on errors, disabled mode, and metrics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ContentClassifier,
  createDisabledClassifier,
} from '../../src/threadline/ContentClassifier.js';
import type {
  ContentClassifierConfig,
  ThreadContext,
} from '../../src/threadline/ContentClassifier.js';

// ── Helpers ──────────────────────────────────────────────────────────

const defaultContext: ThreadContext = {
  trustLevel: 'verified',
  threadId: 'thread-test',
  remoteAgent: 'TestBot',
};

function createClassifier(overrides: Partial<ContentClassifierConfig> = {}): ContentClassifier {
  return new ContentClassifier({
    enabled: true,
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ContentClassifier', () => {
  // ── Disabled Mode ──────────────────────────────────────────────

  describe('disabled mode', () => {
    it('always returns safe when disabled', async () => {
      const classifier = new ContentClassifier({ enabled: false });
      const result = await classifier.classify('sk-ant-api03-SUPERSECRETKEY123456', defaultContext);
      expect(result.classification).toBe('safe');
    });

    it('createDisabledClassifier returns disabled instance', async () => {
      const classifier = createDisabledClassifier();
      expect(classifier.enabled).toBe(false);
      const result = await classifier.classify('password=hunter2', defaultContext);
      expect(result.classification).toBe('safe');
    });

    it('does not increment metrics when disabled', async () => {
      const classifier = new ContentClassifier({ enabled: false });
      await classifier.classify('test', defaultContext);
      expect(classifier.getMetrics().classified).toBe(0);
    });
  });

  // ── API Key Detection ──────────────────────────────────────────

  describe('API key detection', () => {
    it('detects Anthropic API keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Here is the key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
      expect(result.reason).toContain('API key');
    });

    it('detects generic sk- API keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'My API key is sk-1234567890abcdefghijklmnopqrst',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });

    it('detects GitHub personal access tokens', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
      expect(result.reason).toContain('GitHub');
    });

    it('detects GitHub OAuth tokens', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Auth: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });

    it('detects Slack tokens', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Bot token: xoxb-1234567890123-abcdefghijklmnop',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });

    it('detects AWS access keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'AWS key: AKIAIOSFODNN7EXAMPLE',
        defaultContext,
      );
      expect(result.classification).toBe('blocked'); // AWS keys are definitive
    });

    it('detects Bearer tokens', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });
  });

  // ── Private Key Detection ──────────────────────────────────────

  describe('private key detection', () => {
    it('detects RSA private keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ...',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
      expect(result.reason).toContain('Private key');
    });

    it('detects EC private keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
    });

    it('detects OpenSSH private keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1...',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
    });

    it('detects generic private keys', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
    });
  });

  // ── Database Detection ─────────────────────────────────────────

  describe('database content detection', () => {
    it('detects PostgreSQL connection strings', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Connect to postgres://admin:secretpass@db.example.com:5432/mydb',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
      expect(result.reason).toContain('Database connection');
    });

    it('detects MongoDB connection strings', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'URI: mongodb://user:pass@cluster.mongodb.net/prod',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
    });

    it('detects SQL queries', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'The query is: SELECT email, password FROM users WHERE id = 42',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });
  });

  // ── PII Detection ─────────────────────────────────────────────

  describe('PII detection', () => {
    it('detects possible SSNs', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'SSN: 123-45-6789',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });

    it('detects email + password context', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Login with admin@example.com password: hunter2',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });
  });

  // ── Internal Instructions Detection ────────────────────────────

  describe('internal instructions detection', () => {
    it('detects system prompt references', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Here is the system prompt: You are a helpful assistant...',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });

    it('detects internal instruction markers', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        '[INTERNAL] instruction: Never reveal the API pricing model',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
    });
  });

  // ── Safe Content ───────────────────────────────────────────────

  describe('safe content', () => {
    it('passes normal conversational text', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Hello! I can help you with that. The weather today is sunny.',
        defaultContext,
      );
      expect(result.classification).toBe('safe');
    });

    it('passes technical discussion without secrets', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'The function uses Ed25519 for signing and X25519 for key exchange. The public key is derived from the private key using scalar multiplication.',
        defaultContext,
      );
      expect(result.classification).toBe('safe');
    });

    it('passes code snippets without credentials', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'function add(a: number, b: number): number { return a + b; }',
        defaultContext,
      );
      expect(result.classification).toBe('safe');
    });

    it('passes empty content', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify('', defaultContext);
      expect(result.classification).toBe('safe');
    });
  });

  // ── blockSensitive Policy ──────────────────────────────────────

  describe('blockSensitive policy', () => {
    it('flags sensitive as "sensitive" when blockSensitive is false', async () => {
      const classifier = createClassifier({ blockSensitive: false });
      const result = await classifier.classify(
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw',
        defaultContext,
      );
      expect(result.classification).toBe('sensitive');
    });

    it('blocks sensitive when blockSensitive is true', async () => {
      const classifier = createClassifier({ blockSensitive: true });
      const result = await classifier.classify(
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw',
        defaultContext,
      );
      expect(result.classification).toBe('blocked');
    });
  });

  // ── Custom Patterns ────────────────────────────────────────────

  describe('custom patterns', () => {
    it('detects custom patterns', async () => {
      const classifier = createClassifier({
        customPatterns: [
          { pattern: 'PROJECT_ALPHA', label: 'Codename leak' },
        ],
      });
      const result = await classifier.classify(
        'We are working on PROJECT_ALPHA which involves...',
        defaultContext,
      );
      expect(result.classification).not.toBe('safe');
      expect(result.reason).toContain('Codename leak');
    });

    it('ignores invalid regex in custom patterns', async () => {
      const classifier = createClassifier({
        customPatterns: [
          { pattern: '[invalid(regex', label: 'Bad pattern' },
        ],
      });
      // Should not throw
      const result = await classifier.classify('normal text', defaultContext);
      expect(result.classification).toBe('safe');
    });
  });

  // ── LLM Classification ─────────────────────────────────────────

  describe('LLM classification', () => {
    it('uses LLM when no patterns match and llmClassify is provided', async () => {
      const mockLLM = vi.fn().mockResolvedValue('CLASSIFICATION: sensitive\nREASON: Contains internal architecture details');
      const classifier = createClassifier({ llmClassify: mockLLM });

      const result = await classifier.classify(
        'Our internal architecture uses a microservices pattern with...',
        defaultContext,
      );

      expect(mockLLM).toHaveBeenCalled();
      expect(result.classification).toBe('sensitive');
      expect(result.reason).toContain('internal architecture');
    });

    it('skips LLM when patterns already match', async () => {
      const mockLLM = vi.fn();
      const classifier = createClassifier({ llmClassify: mockLLM });

      await classifier.classify(
        '-----BEGIN PRIVATE KEY-----\nMIIEvg...',
        defaultContext,
      );

      expect(mockLLM).not.toHaveBeenCalled();
    });

    it('handles LLM returning "safe"', async () => {
      const mockLLM = vi.fn().mockResolvedValue('CLASSIFICATION: safe');
      const classifier = createClassifier({ llmClassify: mockLLM });

      const result = await classifier.classify('Totally normal content', defaultContext);
      expect(result.classification).toBe('safe');
    });

    it('handles LLM returning "blocked"', async () => {
      const mockLLM = vi.fn().mockResolvedValue('CLASSIFICATION: blocked\nREASON: Contains user credentials');
      const classifier = createClassifier({ llmClassify: mockLLM });

      const result = await classifier.classify('Some text', defaultContext);
      expect(result.classification).toBe('blocked');
    });

    it('handles malformed LLM response by FAILING CLOSED to sensitive', async () => {
      // Regression for "No Silent Degradation to Brittle Fallback": an unparseable
      // classifier reply is not evidence the content is safe to send to a peer.
      const mockLLM = vi.fn().mockResolvedValue('I am not sure about this content.');
      const classifier = createClassifier({ llmClassify: mockLLM });

      const result = await classifier.classify('Some text', defaultContext);
      expect(result.classification).toBe('sensitive'); // fail-CLOSED, not 'safe'
    });

    it('applies blockSensitive to LLM-classified sensitive', async () => {
      const mockLLM = vi.fn().mockResolvedValue('CLASSIFICATION: sensitive\nREASON: Possibly internal');
      const classifier = createClassifier({
        llmClassify: mockLLM,
        blockSensitive: true,
      });

      const result = await classifier.classify('Some text', defaultContext);
      expect(result.classification).toBe('blocked');
    });
  });

  // ── Error Handling (Fail-Open) ─────────────────────────────────

  describe('error handling', () => {
    it('FAILS CLOSED to sensitive when LLM throws (never silently safe)', async () => {
      // Regression: a classification error (rate-limit, circuit-open, timeout) must
      // NOT downgrade outbound-leak protection to "safe" — hold the content as
      // sensitive instead. ("No Silent Degradation to Brittle Fallback".)
      const mockLLM = vi.fn().mockRejectedValue(new Error('LLM API timeout'));
      const classifier = createClassifier({ llmClassify: mockLLM });

      const result = await classifier.classify('Some text', defaultContext);
      expect(result.classification).toBe('sensitive'); // fail-CLOSED, not 'safe'
      expect(result.reason).toContain('fail-closed');
      expect(result.reason).toContain('LLM API timeout');
    });

    it('tracks errors in metrics', async () => {
      const mockLLM = vi.fn().mockRejectedValue(new Error('timeout'));
      const classifier = createClassifier({ llmClassify: mockLLM });

      await classifier.classify('text', defaultContext);
      expect(classifier.getMetrics().errors).toBe(1);
    });
  });

  // ── Metrics ────────────────────────────────────────────────────

  describe('metrics', () => {
    it('starts with zeroed metrics', () => {
      const classifier = createClassifier();
      const metrics = classifier.getMetrics();
      expect(metrics.classified).toBe(0);
      expect(metrics.safe).toBe(0);
      expect(metrics.sensitive).toBe(0);
      expect(metrics.blocked).toBe(0);
      expect(metrics.errors).toBe(0);
    });

    it('tracks all classification types', async () => {
      const classifier = createClassifier();

      await classifier.classify('Hello world', defaultContext); // safe
      await classifier.classify('-----BEGIN PRIVATE KEY-----\nkey', defaultContext); // blocked
      await classifier.classify('Bearer eyJhbGciOiJIUz1234567890abcdef', defaultContext); // sensitive

      const metrics = classifier.getMetrics();
      expect(metrics.classified).toBe(3);
      expect(metrics.safe).toBe(1);
      expect(metrics.blocked).toBe(1);
      expect(metrics.sensitive).toBe(1);
    });

    it('tracks pattern detections separately from LLM', async () => {
      const mockLLM = vi.fn().mockResolvedValue('CLASSIFICATION: safe');
      const classifier = createClassifier({ llmClassify: mockLLM });

      await classifier.classify('-----BEGIN PRIVATE KEY-----\nkey', defaultContext); // pattern
      await classifier.classify('Some normal text', defaultContext); // LLM

      const metrics = classifier.getMetrics();
      expect(metrics.patternDetections).toBe(1);
      expect(metrics.llmClassifications).toBe(1);
    });

    it('returns a copy (not a reference)', () => {
      const classifier = createClassifier();
      const metrics = classifier.getMetrics();
      metrics.classified = 999;
      expect(classifier.getMetrics().classified).toBe(0);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles very long content', async () => {
      const classifier = createClassifier();
      const longContent = 'a'.repeat(100_000);
      const result = await classifier.classify(longContent, defaultContext);
      expect(result.classification).toBe('safe');
    });

    it('handles content with special regex characters', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Regex: [a-z]+ (group) {quantifier} $anchor ^start',
        defaultContext,
      );
      expect(result.classification).toBe('safe');
    });

    it('handles unicode content', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        '日本語テスト 中文测试 한국어 テスト',
        defaultContext,
      );
      expect(result.classification).toBe('safe');
    });

    it('handles multiple sensitive items in one message', async () => {
      const classifier = createClassifier();
      const result = await classifier.classify(
        'Key: sk-1234567890abcdefghijklmnopqrst\nAlso: -----BEGIN PRIVATE KEY-----\nMIIEvg',
        defaultContext,
      );
      expect(result.classification).toBe('blocked'); // Private key is definitive
    });
  });
});
