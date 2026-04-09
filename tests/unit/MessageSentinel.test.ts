import { describe, it, expect, beforeEach } from 'vitest';
import { MessageSentinel } from '../../src/core/MessageSentinel.js';
import type { MessageSentinelConfig, SentinelCategory } from '../../src/core/MessageSentinel.js';

describe('MessageSentinel', () => {
  let sentinel: MessageSentinel;

  beforeEach(() => {
    sentinel = new MessageSentinel();
  });

  describe('fast-path — slash commands', () => {
    it('/stop → emergency-stop', async () => {
      const result = await sentinel.classify('/stop');
      expect(result.category).toBe('emergency-stop');
      expect(result.action.type).toBe('kill-session');
      expect(result.method).toBe('fast-path');
      expect(result.confidence).toBe(1.0);
    });

    it('/kill → emergency-stop', async () => {
      const result = await sentinel.classify('/kill');
      expect(result.category).toBe('emergency-stop');
      expect(result.action.type).toBe('kill-session');
    });

    it('/abort → emergency-stop', async () => {
      const result = await sentinel.classify('/abort');
      expect(result.category).toBe('emergency-stop');
    });

    it('/cancel → emergency-stop', async () => {
      const result = await sentinel.classify('/cancel');
      expect(result.category).toBe('emergency-stop');
    });

    it('/terminate → emergency-stop', async () => {
      const result = await sentinel.classify('/terminate');
      expect(result.category).toBe('emergency-stop');
    });

    it('/pause → pause', async () => {
      const result = await sentinel.classify('/pause');
      expect(result.category).toBe('pause');
      expect(result.action.type).toBe('pause-session');
      expect(result.confidence).toBe(1.0);
    });

    it('/wait → pause', async () => {
      const result = await sentinel.classify('/wait');
      expect(result.category).toBe('pause');
    });

    it('/hold → pause', async () => {
      const result = await sentinel.classify('/hold');
      expect(result.category).toBe('pause');
    });
  });

  describe('fast-path — exact matches', () => {
    it('"stop" → emergency-stop', async () => {
      const result = await sentinel.classify('stop');
      expect(result.category).toBe('emergency-stop');
      expect(result.confidence).toBe(0.95);
    });

    it('"stop!" → emergency-stop', async () => {
      const result = await sentinel.classify('stop!');
      expect(result.category).toBe('emergency-stop');
    });

    it('"abort" → emergency-stop', async () => {
      const result = await sentinel.classify('abort');
      expect(result.category).toBe('emergency-stop');
    });

    it('"cancel everything" → emergency-stop', async () => {
      const result = await sentinel.classify('cancel everything');
      expect(result.category).toBe('emergency-stop');
    });

    it('"stop now" → emergency-stop', async () => {
      const result = await sentinel.classify('stop now');
      expect(result.category).toBe('emergency-stop');
    });

    it('"stop immediately" → emergency-stop', async () => {
      const result = await sentinel.classify('stop immediately');
      expect(result.category).toBe('emergency-stop');
    });

    it('"wait" → pause', async () => {
      const result = await sentinel.classify('wait');
      expect(result.category).toBe('pause');
      expect(result.confidence).toBe(0.95);
    });

    it('"hold on" → pause', async () => {
      const result = await sentinel.classify('hold on');
      expect(result.category).toBe('pause');
    });

    it('"one moment" → pause', async () => {
      const result = await sentinel.classify('one moment');
      expect(result.category).toBe('pause');
    });
  });

  describe('fast-path — regex patterns', () => {
    it('"don\'t do that" → emergency-stop', async () => {
      const result = await sentinel.classify("don't do that");
      expect(result.category).toBe('emergency-stop');
      expect(result.confidence).toBe(0.85);
    });

    it('"dont do that" → emergency-stop', async () => {
      const result = await sentinel.classify('dont do that');
      expect(result.category).toBe('emergency-stop');
    });

    it('"don\'t do anything" → emergency-stop', async () => {
      const result = await sentinel.classify("don't do anything");
      expect(result.category).toBe('emergency-stop');
    });

    it('"No! Stop" → emergency-stop', async () => {
      const result = await sentinel.classify('No! Stop');
      expect(result.category).toBe('emergency-stop');
    });

    it('"please stop" → emergency-stop', async () => {
      const result = await sentinel.classify('please stop');
      expect(result.category).toBe('emergency-stop');
    });

    it('"Stop it" → emergency-stop', async () => {
      const result = await sentinel.classify('Stop it');
      expect(result.category).toBe('emergency-stop');
    });

    it('"Stop this" → emergency-stop', async () => {
      const result = await sentinel.classify('Stop this');
      expect(result.category).toBe('emergency-stop');
    });

    it('"wait a second" → pause', async () => {
      const result = await sentinel.classify('wait a second');
      expect(result.category).toBe('pause');
    });

    it('"hold on a minute" → pause', async () => {
      const result = await sentinel.classify('hold on a minute');
      expect(result.category).toBe('pause');
    });

    it('"let me think" → pause (short, within word gate)', async () => {
      const result = await sentinel.classify('let me think');
      expect(result.category).toBe('pause');
    });

    it('"one sec" → pause', async () => {
      const result = await sentinel.classify('one sec');
      expect(result.category).toBe('pause');
    });
  });

  describe('fast-path — all caps detection', () => {
    it('"STOP NOW" → emergency-stop', async () => {
      const result = await sentinel.classify('STOP NOW');
      expect(result.category).toBe('emergency-stop');
    });

    it('"NO STOP DON\'T" → emergency-stop', async () => {
      const result = await sentinel.classify("NO STOP DON'T");
      expect(result.category).toBe('emergency-stop');
    });

    it('"CANCEL EVERYTHING" → emergency-stop', async () => {
      const result = await sentinel.classify('CANCEL EVERYTHING');
      expect(result.category).toBe('emergency-stop');
    });

    it('all caps without stop words → no fast-path match', async () => {
      const result = await sentinel.classify('HELLO WORLD');
      // Should fall through to default (no LLM configured)
      expect(result.category).toBe('normal');
    });
  });

  describe('word count gate — prevents false positives on conversational messages', () => {
    it('"stop by the store later" → normal (too many words for fast-path)', async () => {
      const result = await sentinel.classify('stop by the store later');
      // 5 words — exceeds MAX_FAST_PATH_WORDS, skips regex patterns
      expect(result.category).toBe('normal');
    });

    it('"Please stop warning me about any memory issue" → normal (conversational)', async () => {
      const result = await sentinel.classify('Please stop warning me about any memory issue. That\'s below 90%.');
      // The exact message from the bug report — this is an instruction, NOT an emergency
      expect(result.category).toBe('normal');
    });

    it('"please stop doing that thing" → normal (5+ words)', async () => {
      const result = await sentinel.classify('please stop doing that thing');
      expect(result.category).toBe('normal');
    });

    it('"stop sending me notifications about this" → normal (6 words)', async () => {
      const result = await sentinel.classify('stop sending me notifications about this');
      expect(result.category).toBe('normal');
    });

    it('"wait I need to check something first" → normal (7 words)', async () => {
      const result = await sentinel.classify('wait I need to check something first');
      expect(result.category).toBe('normal');
    });

    it('"please stop" (short) still triggers emergency-stop', async () => {
      const result = await sentinel.classify('please stop');
      // 2 words — within MAX_FAST_PATH_WORDS, regex pattern fires
      expect(result.category).toBe('emergency-stop');
    });

    it('"stop it now" (short) still triggers emergency-stop', async () => {
      const result = await sentinel.classify('stop it now');
      // 3 words — within limit
      expect(result.category).toBe('emergency-stop');
    });

    it('"don\'t do that" (short) still triggers emergency-stop', async () => {
      const result = await sentinel.classify("don't do that");
      // 3 words — within limit
      expect(result.category).toBe('emergency-stop');
    });
  });

  describe('fast-path — no false positives', () => {
    it('"can you help me with something?" → normal', async () => {
      const result = await sentinel.classify('can you help me with something?');
      expect(result.category).toBe('normal');
    });

    it('"what time is it?" → normal', async () => {
      const result = await sentinel.classify('what time is it?');
      expect(result.category).toBe('normal');
    });

    it('"please send the email" → normal', async () => {
      const result = await sentinel.classify('please send the email');
      expect(result.category).toBe('normal');
    });

    it('long normal message → normal', async () => {
      const result = await sentinel.classify(
        'Hey, I was thinking about the project timeline and wanted to discuss some changes to the roadmap'
      );
      expect(result.category).toBe('normal');
    });
  });

  describe('disabled sentinel', () => {
    it('passes everything through when disabled', async () => {
      sentinel = new MessageSentinel({ enabled: false });
      const result = await sentinel.classify('STOP');
      expect(result.category).toBe('normal');
      expect(result.action.type).toBe('pass-through');
      expect(result.reason).toContain('disabled');
    });
  });

  describe('LLM classification', () => {
    it('uses LLM for ambiguous messages', async () => {
      let promptReceived = '';
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async (prompt) => {
            promptReceived = prompt;
            return 'redirect';
          },
        },
      });

      const result = await sentinel.classify('actually, change the approach to use archives instead');
      expect(result.category).toBe('redirect');
      expect(result.method).toBe('llm');
      expect(result.action.type).toBe('priority-inject');
      expect(promptReceived).toContain('actually, change the approach');
    });

    it('LLM failure defaults to pass-through', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => { throw new Error('LLM down'); },
        },
      });

      const result = await sentinel.classify('hmm I am not sure about this');
      expect(result.category).toBe('normal');
      expect(result.action.type).toBe('pass-through');
    });

    it('unparseable LLM response defaults to pass-through (not disruptive)', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => 'I think this is probably a stop command but maybe not',
        },
      });

      const result = await sentinel.classify('maybe we should reconsider');
      expect(result.category).toBe('normal');
      expect(result.action.type).toBe('pass-through');
    });

    it('extracts category from verbose LLM response (short)', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => 'The classification is: normal',
        },
      });

      const result = await sentinel.classify('please proceed');
      expect(result.category).toBe('normal');
      expect(result.reason).toContain('extracted');
    });

    it('extracts emergency-stop from verbose LLM response', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => 'This is an emergency-stop signal',
        },
      });

      const result = await sentinel.classify('STOP RIGHT NOW');
      expect(result.category).toBe('emergency-stop');
    });

    it('rejects long conversational responses (>100 chars)', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => 'You are right. I have been heads-down on implementation without checking the design scope. I can see you have got several planning documents that define the broader context.',
        },
      });

      const result = await sentinel.classify('please proceed');
      expect(result.category).toBe('normal');
      expect(result.action.type).toBe('pass-through');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('prioritizes higher-severity category when multiple appear', async () => {
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => 'not normal, this is a pause',
        },
      });

      const result = await sentinel.classify('hold on');
      // "pause" should win over "normal" since it's checked first
      expect(result.category).toBe('pause');
    });

    it('long messages with stop-like words route to LLM (word count gate)', async () => {
      let llmCalled = false;
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'normal';
          },
        },
      });

      // This is the exact scenario from the bug report:
      // "Please stop warning me about any memory issue" should NOT trigger emergency-stop
      // With LLM wired, it routes through LLM classification instead of defaulting
      const result = await sentinel.classify('Please stop warning me about any memory issue');
      expect(result.category).toBe('normal');
      expect(result.method).toBe('llm');
      expect(llmCalled).toBe(true);
    });

    it('LLM prompt disambiguates "hold on" with substantive content as normal (regression: cluster-messagesentinel-llm-classifier)', async () => {
      let promptReceived = '';
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async (prompt) => {
            promptReceived = prompt;
            return 'normal';
          },
        },
      });

      // This is the exact bug report scenario: long message starting with "OK hold on"
      // followed by substantive disagreement — should be classified as normal
      const result = await sentinel.classify(
        "OK hold on I don't think that's how it works either. I'm pretty sure the algorithm is always optimizing."
      );
      expect(result.category).toBe('normal');
      expect(result.method).toBe('llm');
      // Verify the prompt includes disambiguation guidance
      expect(promptReceived).toContain('substantive content');
      expect(promptReceived).toContain('prefer normal');
    });

    it('LLM prompt treats "hold on let me think" as normal example — not pause (regression: cluster-messagesentinel-llm-classifier)', async () => {
      let promptReceived = '';
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async (prompt) => {
            promptReceived = prompt;
            // Simulate LLM returning "normal" after seeing the updated prompt
            // which now places "hold on let me think" in the normal examples
            return 'normal';
          },
        },
      });

      const result = await sentinel.classify('hold on let me think');
      expect(result.category).toBe('normal');
      expect(result.method).toBe('llm');
      // Verify the prompt correctly categorizes hold-on variants as normal
      expect(promptReceived).toContain('hold on let me think');
      expect(promptReceived).toContain('normal');
      // And that pause examples no longer include conversational hold-on phrases
      expect(promptReceived).not.toContain('pause: User wants the agent to pause and wait (examples: "hold on let me think"');
    });

    it('fast-path takes precedence over LLM', async () => {
      let llmCalled = false;
      sentinel = new MessageSentinel({
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'normal';
          },
        },
      });

      const result = await sentinel.classify('stop');
      expect(result.category).toBe('emergency-stop');
      expect(result.method).toBe('fast-path');
      expect(llmCalled).toBe(false);
    });

    it('fastPathOnly skips LLM', async () => {
      let llmCalled = false;
      sentinel = new MessageSentinel({
        fastPathOnly: true,
        intelligence: {
          evaluate: async () => {
            llmCalled = true;
            return 'emergency-stop';
          },
        },
      });

      const result = await sentinel.classify('I have a bad feeling about this');
      expect(result.category).toBe('normal');
      expect(result.method).toBe('default');
      expect(llmCalled).toBe(false);
    });
  });

  describe('custom patterns', () => {
    it('recognizes custom stop patterns', async () => {
      sentinel = new MessageSentinel({
        customStopPatterns: ['emergency', 'red alert'],
      });

      const result = await sentinel.classify('emergency');
      expect(result.category).toBe('emergency-stop');
    });

    it('recognizes custom pause patterns', async () => {
      sentinel = new MessageSentinel({
        customPausePatterns: ['brb', 'gimme a sec'],
      });

      const result = await sentinel.classify('brb');
      expect(result.category).toBe('pause');
    });
  });

  describe('stats', () => {
    it('tracks classification stats', async () => {
      await sentinel.classify('stop');
      await sentinel.classify('wait');
      await sentinel.classify('hello');

      const stats = sentinel.getStats();
      expect(stats.totalClassified).toBe(3);
      expect(stats.byCategory['emergency-stop']).toBe(1);
      expect(stats.byCategory.pause).toBe(1);
      expect(stats.byCategory.normal).toBe(1);
      expect(stats.emergencyStops).toBe(1);
    });

    it('tracks average latency', async () => {
      await sentinel.classify('stop');
      const stats = sentinel.getStats();
      expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('resets stats', async () => {
      await sentinel.classify('stop');
      sentinel.resetStats();
      const stats = sentinel.getStats();
      expect(stats.totalClassified).toBe(0);
    });
  });

  describe('isEnabled', () => {
    it('returns true by default', () => {
      expect(sentinel.isEnabled()).toBe(true);
    });

    it('returns false when disabled', () => {
      sentinel = new MessageSentinel({ enabled: false });
      expect(sentinel.isEnabled()).toBe(false);
    });
  });
});
