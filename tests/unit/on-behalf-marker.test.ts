/**
 * The on-behalf marker (Echo Bugs topic 10000002506, 2026-11-09): messages an
 * agent sends through its operator's own account are marked, and the inbound
 * Slack path tags a marked message as not written by the account holder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatOnBehalfMarker,
  markOnBehalf,
  detectOnBehalfMarker,
  onBehalfSenderLabel,
  markedHistoryLabel,
  markedInboundPrefix,
} from '../../src/messaging/shared/onBehalfMarker.js';
import { PostUpdateMigrator, ACTING_AS_OPERATOR_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

describe('formatOnBehalfMarker / markOnBehalf', () => {
  it('formats the marker, with and without the test note', () => {
    expect(formatOnBehalfMarker('Echo', 'Justin')).toBe("[Sent by Echo on Justin's behalf]");
    expect(formatOnBehalfMarker('Echo', 'Justin', { test: true })).toBe("[Sent by Echo on Justin's behalf, test]");
  });

  it('strips bracket and control characters from names so the marker cannot be broken', () => {
    expect(formatOnBehalfMarker('Ec]ho\n', '[Jus]tin')).toBe("[Sent by Echo on Justin's behalf]");
    expect(formatOnBehalfMarker('', '')).toBe("[Sent by the agent on the operator's behalf]");
  });

  it('is idempotent', () => {
    const once = markOnBehalf('hello', 'Echo', 'Justin', { test: true });
    expect(once).toBe("[Sent by Echo on Justin's behalf, test] hello");
    expect(markOnBehalf(once, 'Echo', 'Justin')).toBe(once);
  });
});

describe('detectOnBehalfMarker', () => {
  it('reads the founding live message (marker at the start, test note)', () => {
    expect(detectOnBehalfMarker("[Sent by Echo on Justin's behalf, test] checking the Slack conversation list")).toEqual({
      marked: true, agentName: 'Echo', operatorName: 'Justin', test: true,
    });
  });

  it('reads a marker at the end, a curly apostrophe, and any case', () => {
    expect(detectOnBehalfMarker('ping from the bench [sent by Luna on Adriana’s behalf]')).toEqual({
      marked: true, agentName: 'Luna', operatorName: 'Adriana', test: false,
    });
  });

  it('ignores a marker quoted mid-message, unmarked text and non-strings', () => {
    expect(detectOnBehalfMarker("The format is [Sent by Echo on Justin's behalf] and it goes first, ok?").marked).toBe(false);
    expect(detectOnBehalfMarker('just a normal message').marked).toBe(false);
    expect(detectOnBehalfMarker(undefined).marked).toBe(false);
    expect(detectOnBehalfMarker(42).marked).toBe(false);
  });
});

describe('inbound labels', () => {
  it('relabels a marked line and leaves unmarked lines and the agent\'s own bot lines alone', () => {
    const marked = "[Sent by Echo on Justin's behalf, test] hi";
    expect(markedHistoryLabel('Justin', marked)).toBe("Echo on Justin's behalf, marked, not written by Justin");
    expect(markedHistoryLabel('Justin', 'hi')).toBe('Justin');
    expect(markedHistoryLabel('Agent', marked)).toBe('Agent');
    expect(onBehalfSenderLabel('Justin', { marked: false })).toBe('Justin');
  });

  it('adds the note inside the live injection tag only for a marked message', () => {
    const prefix = '[slack:C123 from Justin (uid:U9)]';
    expect(markedInboundPrefix(prefix, "[Sent by Echo on Justin's behalf, test] hi", 'Justin')).toBe(
      "[slack:C123 from Justin (uid:U9) (marked: sent by Echo on Justin's behalf, not written by Justin)]",
    );
    expect(markedInboundPrefix(prefix, 'hi', 'Justin')).toBe(prefix);
    expect(markedInboundPrefix('no-bracket', "[Sent by Echo on Justin's behalf] hi", 'Justin')).toBe('no-bracket');
  });

  it('is wired into the live Slack inbound path (tag and thread history)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf8');
    expect(src).toContain('prefix = markedInboundPrefix(prefix, message.content, safeSenderName);');
    expect(src).toContain('const label = markedHistoryLabel(slackHistoryLabel(');
  });
});

describe('agent awareness — Before I ask my operator to check or send something', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/on-behalf-marker.test.ts' }); });

  type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
  function migrate(projectDir: string): Result {
    const result: Result = { upgraded: [], skipped: [], errors: [] };
    const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'echo' });
    (migrator as unknown as { migrateClaudeMd(value: Result): void }).migrateClaudeMd(result);
    return result;
  }

  it('generateClaudeMd carries the section once, with the reach routes and the marker format', () => {
    const fresh = generateClaudeMd('instar', 'Echo', 4042, true);
    expect(fresh.split(ACTING_AS_OPERATOR_CLAUDEMD_MARKER)).toHaveLength(2);
    expect(fresh).toContain('http://localhost:4042/mobile/conversations');
    expect(fresh).toContain('http://localhost:4042/playwright-profiles');
    expect(fresh).toContain("`[Sent by <my name> on <operator name>'s behalf]`");
  });

  it('migrateClaudeMd adds it once to an existing agent (content-sniffed, idempotent)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acting-as-operator-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing agent\n');
    const label = 'CLAUDE.md: added Before I ask my operator to check or send something section';
    expect(migrate(projectDir).upgraded).toContain(label);
    expect(migrate(projectDir).upgraded).not.toContain(label);
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(after.split(ACTING_AS_OPERATOR_CLAUDEMD_MARKER)).toHaveLength(2);
  });
});
