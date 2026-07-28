/**
 * SlackMrkdwnFormatter unit tests (roadmap 0.1).
 *
 * Covers every conversion case in the module contract (bold / italic /
 * bold-italic / strike / inline + fenced code / links / lists / quotes /
 * headings / tables / horizontal rules / emoji), mixed documents, the
 * escaping rules (&, <, > escaped exactly once; code segments never
 * re-processed), the legacy-passthrough rollback + per-call opt-out, and the
 * applySlackFormatter wire-up helper's skip rules.
 */
import { describe, it, expect } from 'vitest';
import {
  formatForSlack,
  applySlackFormatter,
  MAX_INPUT_LENGTH,
  type SlackFormatMode,
} from '../../src/messaging/slack/SlackMrkdwnFormatter.js';

const fmt = (text: string, mode: SlackFormatMode = 'mrkdwn') =>
  formatForSlack(text, mode).text;

describe('formatForSlack — emphasis', () => {
  it('converts **bold** to *bold*', () => {
    expect(fmt('this is **bold** text')).toBe('this is *bold* text');
  });

  it('converts __bold__ to *bold*', () => {
    expect(fmt('this is __bold__ text')).toBe('this is *bold* text');
  });

  it('does NOT convert intraword double underscores (snake_case identifiers)', () => {
    expect(fmt('the my__var__name identifier')).toBe('the my__var__name identifier');
  });

  it('converts *italic* to _italic_', () => {
    expect(fmt('this is *italic* text')).toBe('this is _italic_ text');
  });

  it('leaves _italic_ as _italic_ (already mrkdwn)', () => {
    expect(fmt('this is _italic_ text')).toBe('this is _italic_ text');
  });

  it('converts ***bold italic*** to *_bold italic_*', () => {
    expect(fmt('a ***both*** b')).toBe('a *_both_* b');
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(fmt('a ~~gone~~ b')).toBe('a ~gone~ b');
  });

  it('bold output is NOT re-eaten by the italic pass (order regression guard)', () => {
    // If bold ran before italic without protection, *bold* would become _bold_.
    expect(fmt('**bold** and *it*')).toBe('*bold* and _it_');
  });

  it('leaves math/glob asterisks untouched (tight italic boundary)', () => {
    expect(fmt('3*5 and f(x) = x * y and a*b*c')).toBe('3*5 and f(x) = x * y and a*b*c');
  });

  it('supports underscore italic nested inside bold', () => {
    expect(fmt('**a _b_ c**')).toBe('*a _b_ c*');
  });
});

describe('formatForSlack — code', () => {
  it('passes inline code through as mrkdwn inline code', () => {
    expect(fmt('run `pnpm build` now')).toBe('run `pnpm build` now');
  });

  it('does not convert markdown inside inline code', () => {
    expect(fmt('literal `**not bold**` here')).toBe('literal `**not bold**` here');
  });

  it('preserves fenced blocks and drops the language tag', () => {
    expect(fmt('```ts\nconst a = 1;\n```')).toBe('```\nconst a = 1;\n```');
  });

  it('does not convert markdown inside fenced blocks', () => {
    expect(fmt('```\n**raw** and [x](y)\n```')).toBe('```\n**raw** and [x](y)\n```');
  });

  it('escapes &, <, > inside code segments exactly once', () => {
    expect(fmt('`a < b && c > d`')).toBe('`a &lt; b &amp;&amp; c &gt; d`');
    expect(fmt('```\nList<Map<K, V>>\n```')).toBe('```\nList&lt;Map&lt;K, V&gt;&gt;\n```');
  });

  it('emits unclosed fences as literal backticks', () => {
    expect(fmt('```\nunterminated')).toBe('```\nunterminated');
  });

  it('degrades gracefully on nested code fences (4-backtick outer), never crashing', () => {
    // GFM 4-backtick outer fences are out of contract (parity with the
    // Telegram formatter's scanner): the first ``` pair wins. Pinned so the
    // degradation stays graceful — content preserved, no markdown leakage.
    expect(fmt('````\ncode with ``` inside\n````')).toBe(
      '```\ncode with \n``` inside\n````',
    );
  });

  it('equal-fence nesting closes at the first fence; trailing fence stays literal', () => {
    expect(fmt('```\na **not bold** b\n```\ntail\n```')).toBe(
      '```\na **not bold** b\n```\ntail\n```',
    );
  });
});

describe('formatForSlack — escaping (Slack specials)', () => {
  it('escapes &, <, > in prose', () => {
    expect(fmt('salt & pepper, a < b, c > d')).toBe(
      'salt &amp; pepper, a &lt; b, c &gt; d',
    );
  });

  it('never double-escapes: one pass over prose, code extracted first', () => {
    const out = fmt('a & b `c & d`');
    expect(out).toBe('a &amp; b `c &amp; d`');
    expect(out).not.toContain('&amp;amp;');
  });

  it('escapes raw angle-bracket sequences so Slack cannot parse them as entities', () => {
    // A raw <@U123> in agent GFM output is DATA, not a mention.
    expect(fmt('mention syntax is <@U123>')).toBe('mention syntax is &lt;@U123&gt;');
  });
});

describe('formatForSlack — links', () => {
  it('converts [text](url) to <url|text>', () => {
    expect(fmt('see [the docs](https://example.com/a)')).toBe(
      'see <https://example.com/a|the docs>',
    );
  });

  it('handles Wikipedia-style balanced parens in URLs', () => {
    expect(fmt('[entity](https://en.wikipedia.org/wiki/Entity_(computer_science))')).toBe(
      '<https://en.wikipedia.org/wiki/Entity_(computer_science)|entity>',
    );
  });

  it('escapes & in the URL (post-escape URL is what Slack link syntax wants)', () => {
    expect(fmt('[q](https://example.com/?a=1&b=2)')).toBe(
      '<https://example.com/?a=1&amp;b=2|q>',
    );
  });

  it('percent-encodes | in the URL (it would terminate the link)', () => {
    expect(fmt('[x](https://example.com/a|b)')).toBe('<https://example.com/a%7Cb|x>');
  });

  it('refuses unsafe schemes and leaves the construct literal', () => {
    // eslint-disable-next-line no-script-url
    const out = fmt('[click](javascript:alert(1))');
    expect(out).not.toContain('<javascript:');
    expect(out).toContain('[click](javascript:alert(1))');
  });

  it('allows mailto links', () => {
    expect(fmt('[mail me](mailto:a@b.co)')).toBe('<mailto:a@b.co|mail me>');
  });

  it('converts links inside **bold** (RAW-sentinel content is link-converted at emission)', () => {
    expect(fmt('**see [docs](https://x.co) now**')).toBe('*see <https://x.co|docs> now*');
  });

  it('converts links inside ***bold-italic*** and __bold__', () => {
    expect(fmt('***see [d](https://x.co)***')).toBe('*_see <https://x.co|d>_*');
    expect(fmt('__see [d](https://x.co)__')).toBe('*see <https://x.co|d>*');
  });

  it('converts links inside *italic* (inline path through the main link pass)', () => {
    expect(fmt('read *the [guide](https://x.co) first* ok')).toBe(
      'read _the <https://x.co|guide> first_ ok',
    );
  });

  it('converts links inside headings', () => {
    expect(fmt('# See [docs](https://x.co)')).toBe('*See <https://x.co|docs>*');
  });

  it('leaves an unsafe-scheme link inside bold literal (same rule as prose)', () => {
    // eslint-disable-next-line no-script-url
    expect(fmt('**[x](javascript:alert(1))**')).toBe('*[x](javascript:alert(1))*');
  });

  it('leaves bare URLs untouched (Slack auto-links them); only & is entity-escaped', () => {
    expect(fmt('visit https://example.com/path now')).toBe('visit https://example.com/path now');
    // Slack decodes &amp; back to & everywhere, so the link target is preserved.
    expect(fmt('see https://x.co/?a=1&b=2')).toBe('see https://x.co/?a=1&amp;b=2');
  });

  it('does not italicize/bold inside bare URLs with underscores', () => {
    expect(fmt('https://en.wikipedia.org/wiki/Snake_case and https://x.co/__init__/done')).toBe(
      'https://en.wikipedia.org/wiki/Snake_case and https://x.co/__init__/done',
    );
  });
});

describe('formatForSlack — block structure', () => {
  it('converts headings to bold lines', () => {
    expect(fmt('# Title')).toBe('*Title*');
    expect(fmt('## Sub')).toBe('*Sub*');
    expect(fmt('### Deep')).toBe('*Deep*');
  });

  it('does not double-wrap a fully-bold heading', () => {
    expect(fmt('# **Bold title**')).toBe('*Bold title*');
  });

  it('converts dash/star/plus bullets to •, preserving indent', () => {
    expect(fmt('- one\n* two\n+ three\n  - nested')).toBe(
      '• one\n• two\n• three\n  • nested',
    );
  });

  it('passes numbered lists through as-is', () => {
    expect(fmt('1. first\n2. second')).toBe('1. first\n2. second');
  });

  it('preserves > blockquotes (marker survives the escape pass)', () => {
    expect(fmt('> quoted line')).toBe('> quoted line');
    expect(fmt('> multi\n> line')).toBe('> multi\n> line');
  });

  it('escapes a mid-line > normally (only line-leading markers are quotes)', () => {
    expect(fmt('a -> b')).toBe('a -&gt; b');
  });

  it('renders tables as fenced code blocks', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(fmt(table)).toBe('```\n| a | b |\n| 1 | 2 |\n```');
  });

  it('converts horizontal rules to a rule line', () => {
    expect(fmt('above\n---\nbelow')).toBe('above\n──────────\nbelow');
    expect(fmt('above\n***\nbelow')).toBe('above\n──────────\nbelow');
    expect(fmt('above\n___\nbelow')).toBe('above\n──────────\nbelow');
  });
});

describe('formatForSlack — emoji and shortcodes', () => {
  it('leaves unicode emoji untouched', () => {
    expect(fmt('done ✅ ship 🚀')).toBe('done ✅ ship 🚀');
  });

  it('leaves :shortcodes: untouched', () => {
    expect(fmt('nice :tada: work :+1:')).toBe('nice :tada: work :+1:');
  });
});

describe('formatForSlack — mixed documents', () => {
  it('converts a realistic agent reply end-to-end', () => {
    const input = [
      '# Status update',
      '',
      'The build is **green** — see [CI](https://ci.example.com/run?id=1&x=2).',
      '',
      '- fixed the *flaky* test',
      '- bumped `vitest` to 2.x',
      '',
      '```bash',
      'pnpm test && echo "ok"',
      '```',
      '',
      '> Zero-Failure standard upheld.',
    ].join('\n');
    const expected = [
      '*Status update*',
      '',
      'The build is *green* — see <https://ci.example.com/run?id=1&amp;x=2|CI>.',
      '',
      '• fixed the _flaky_ test',
      '• bumped `vitest` to 2.x',
      '',
      '```',
      'pnpm test &amp;&amp; echo "ok"',
      '```',
      '',
      '> Zero-Failure standard upheld.',
    ].join('\n');
    expect(fmt(input)).toBe(expected);
  });

  it('handles a table plus prose plus emphasis together', () => {
    const input = 'Summary **matters**\n\n| k | v |\n|---|---|\n| a | 1 |\n\ntail';
    expect(fmt(input)).toBe('Summary *matters*\n\n```\n| k | v |\n| a | 1 |\n```\n\ntail');
  });
});

describe('formatForSlack — modes and guards', () => {
  it('legacy-passthrough is byte-for-byte (rollback + already-mrkdwn opt-out)', () => {
    const already = '*bold mrkdwn* and <https://x.co|link> & raw';
    const r = formatForSlack(already, 'legacy-passthrough');
    expect(r.text).toBe(already);
    expect(r.legacyPassthrough).toBe(true);
    expect(r.modeApplied).toBe('legacy-passthrough');
  });

  it('idempotency via opt-out: formatting once then passing through changes nothing', () => {
    const once = fmt('**bold** and *it* and [l](https://x.co)');
    const twice = formatForSlack(once, 'legacy-passthrough').text;
    expect(twice).toBe(once);
  });

  it('skips conversion above MAX_INPUT_LENGTH (ReDoS guard) and preserves bytes', () => {
    const big = '**x** '.repeat(Math.ceil(MAX_INPUT_LENGTH / 6) + 10);
    const r = formatForSlack(big, 'mrkdwn');
    expect(r.conversionSkipped).toBe(true);
    expect(r.text).toBe(big);
  });

  it('strips NUL bytes and PUA-B sentinels from input (collision defense)', () => {
    const evil = 'a\x00b' + String.fromCodePoint(0x100001) + 'c';
    expect(fmt(evil)).toBe('abc');
  });
});

describe('applySlackFormatter — wire-up helper', () => {
  it('formats chat.postMessage text with default mode (undefined config → mrkdwn ON)', () => {
    const r = applySlackFormatter('chat.postMessage', { channel: 'C1', text: '**b**' }, undefined);
    expect(r.didFormat).toBe(true);
    expect(r.outgoingParams.text).toBe('*b*');
  });

  it('formats chat.update and chat.postEphemeral too', () => {
    expect(
      applySlackFormatter('chat.update', { channel: 'C1', ts: '1', text: '**b**' }, undefined)
        .outgoingParams.text,
    ).toBe('*b*');
    expect(
      applySlackFormatter('chat.postEphemeral', { channel: 'C1', user: 'U1', text: '**b**' }, undefined)
        .outgoingParams.text,
    ).toBe('*b*');
  });

  it('bypasses non-send methods', () => {
    const r = applySlackFormatter('conversations.list', { types: 'public_channel' }, 'mrkdwn');
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams).toEqual({ types: 'public_channel' });
  });

  it('bypasses when config mode is legacy-passthrough (the rollback lever)', () => {
    const r = applySlackFormatter(
      'chat.postMessage',
      { channel: 'C1', text: '**b**' },
      'legacy-passthrough',
    );
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams.text).toBe('**b**');
  });

  it('honors the per-call _formatMode opt-out and strips it from outgoing params', () => {
    const r = applySlackFormatter(
      'chat.postMessage',
      { channel: 'C1', text: '*already mrkdwn*', _formatMode: 'legacy-passthrough' },
      'mrkdwn',
    );
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams.text).toBe('*already mrkdwn*');
    expect('_formatMode' in r.outgoingParams).toBe(false);
  });

  it('per-call mode WINS over config rollback (explicit mrkdwn on a passthrough config)', () => {
    const r = applySlackFormatter(
      'chat.postMessage',
      { channel: 'C1', text: '**b**', _formatMode: 'mrkdwn' },
      'legacy-passthrough',
    );
    expect(r.didFormat).toBe(true);
    expect(r.outgoingParams.text).toBe('*b*');
  });

  it('bypasses Block Kit sends (blocks are authored deliberately)', () => {
    const r = applySlackFormatter(
      'chat.postMessage',
      { channel: 'C1', blocks: [{ type: 'section' }], text: '**fallback**' },
      'mrkdwn',
    );
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams.text).toBe('**fallback**');
  });

  it('bypasses mrkdwn:false sends (caller asked Slack for plain text)', () => {
    const r = applySlackFormatter(
      'chat.postMessage',
      { channel: 'C1', text: '**b**', mrkdwn: false },
      'mrkdwn',
    );
    expect(r.didFormat).toBe(false);
    expect(r.outgoingParams.text).toBe('**b**');
  });

  it('bypasses when text is not a string', () => {
    const r = applySlackFormatter('chat.postMessage', { channel: 'C1' }, 'mrkdwn');
    expect(r.didFormat).toBe(false);
  });
});
