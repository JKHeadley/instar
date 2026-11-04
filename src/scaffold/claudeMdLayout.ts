/**
 * CLAUDE.md reference layout (docs/specs/claude-md-reference-layout.md).
 *
 * `generateClaudeMd()` (plus the migrator's append chain) produces the FULL agent
 * awareness document — ~570k characters by 2026-11. Claude Code loads CLAUDE.md
 * into every session, so this module splits the full document into:
 *
 *   1. a small CORE block (always-needed rules + a "when X, read Y" dispatch
 *      table) written into CLAUDE.md between two markers, and
 *   2. topic reference files under `.instar/reference/` (plus INDEX.md) that the
 *      agent reads on demand.
 *
 * Pure string functions only — the file I/O lives in PostUpdateMigrator.
 * Every unit of the full document lands in exactly one output (tested).
 */

import crypto from 'node:crypto';

export const CLAUDE_MD_CORE_START =
  '<!-- instar:claude-md-core:start — written by instar and rewritten on every update. Put your own notes BELOW the end marker; instar keeps them (it only takes back out instar sections an older instar version appends there later; a section with an instar:keep comment line is never moved). Off switch: claudeMd.layout "full" in .instar/config.json -->';
export const CLAUDE_MD_CORE_START_PREFIX = '<!-- instar:claude-md-core:start';
export const CLAUDE_MD_CORE_END = '<!-- instar:claude-md-core:end -->';

/** Agent-home-relative directory holding the generated reference files. */
export const REFERENCE_DIR_REL = '.instar/reference';
/** First line of every generated reference file — the ownership mark. */
export const REFERENCE_FILE_HEADER = '<!-- instar:generated-reference — rewritten by instar on every update; do not edit (put your own notes in CLAUDE.md below the instar block) -->';
/** Where the pre-conversion CLAUDE.md is kept (agent-home relative). Written once. */
export const CLAUDE_MD_LEGACY_BACKUP_REL = '.instar/CLAUDE.md.before-reference-layout.md';

/**
 * Size budget for the generated core (CLAUDE.md), argued from its content: the
 * always-applied rules plus a one-line list naming every capability measure
 * ~65k. Claude Code warns above 150,000 (measured, Claude Code 2.1.317); the
 * margin leaves room for an agent's own kept sections.
 */
export const CLAUDE_MD_CORE_BUDGET_CHARS = 80_000;

/**
 * Headings whose sections stay in CLAUDE.md (prefix match on the heading text
 * without the leading #s). Everything else goes to a reference file. Growing
 * this list grows every session's context — the budget test guards it.
 */
export const CLAUDE_MD_CORE_HEADINGS: readonly string[] = [
  'Who I Am',
  'Identity Files',
  'Operator handoff',
  'Two Memory Systems',
  'Identity Hooks',
  'Compaction Survival',
  'Quick Dispatch',
  'Agent-as-Interface Principle',
  'Agent Infrastructure',
  'Runtime',
  'API Authentication',
  'Reporting Issues & Feedback',
  'Self-Discovery',
  'Building New Capabilities',
  'Execution Context',
  'Core Principles',
  'Anti-Patterns to Override',
  'Conversational Tone',
  'Evidence Hierarchy',
  'Standing Ground',
  'Self-Diagnosis',
  // How to answer a message: needed on every turn of a messaging session.
  'Telegram Relay',
  'iMessage Relay',
  'Session Continuity (CRITICAL)',
  // Rules applied on every turn, not looked up: traps go unnoticed from inside
  // them, proactive triggers fire on what the user says, and the state-file map
  // answers questions before any search.
  'Gravity Wells',
  'Feature Proactivity',
  'Registry First',
  'Outbound Message Gate',
  'Cross-Agent Communication Discipline',
  'If I am the session standing down',
  // Holds the identity-pinned Context-Death Self-Stop rule, which applies exactly
  // when the agent is about to stop — the moment it would not go and read a file.
  'Critical Anti-Patterns',
];

/**
 * Core headings whose sub-sections are classified on their own (the template
 * nests every feature card under "Agent Infrastructure"). A sub-section of any
 * other core heading must itself be on CLAUDE_MD_CORE_HEADINGS — a test fails
 * otherwise, so splitting a core section never happens silently.
 */
export const CLAUDE_MD_CORE_CONTAINER_HEADINGS: readonly string[] = ['Agent Infrastructure'];

export interface ReferenceTopic {
  /** File name under REFERENCE_DIR_REL. */
  file: string;
  /** Title of the reference file. */
  title: string;
  /** Dispatch-table "when" text (plain words). */
  when: string;
  /** Lower-case substrings matched against a unit's title (first topic wins). */
  keywords: readonly string[];
}

/** Ordered: the first topic whose keyword matches a unit title wins. */
export const REFERENCE_TOPICS: readonly ReferenceTopic[] = [
  {
    file: 'principles-and-practices.md',
    title: 'Principles and working practices',
    when: 'checking the Registry First table, gravity wells (traps), feature proactivity, architecture lookups, web fetching, browser obstacles, agent removal',
    keywords: ['registry first', 'gravity well', 'feature proactivity', 'architecture knowledge', 'web content fetching', 'browser automation', 'remote control', 'agent removal', 'feedback loop', 'innovation detection', '" trap', 'serendipity', 'homeostasis', 'intent engineering'],
  },
  {
    file: 'mobile-app.md',
    title: 'The Instar iPhone app',
    when: 'pairing a phone, the Instar iPhone app, app conversations and media, push notifications',
    keywords: ['mobile', 'iphone', 'instar app', 'app conversation', 'pairing a phone', 'push notification'],
  },
  {
    file: 'agent-to-agent.md',
    title: 'Talking to other agents (Threadline, A2A)',
    when: 'messaging or pairing with another agent, Threadline, A2A delivery, relay, peer trust, agent identity',
    keywords: ['threadline', 'a2a', 'agent-to-agent', 'cross-agent', 'peer', 'relay', 'verified pairing', 'connecting to another agent', 'canonical identity', 'trust model', 'trust audit', 'routing fingerprint', 'one identity across', 'agent-signature', 'coordination mandate', 'reviewexchange'],
  },
  {
    file: 'messaging.md',
    title: 'Messaging: Telegram, Slack, WhatsApp, iMessage, notices',
    when: 'sending or receiving Telegram/Slack/WhatsApp/iMessage messages, topics, outbound review, attention items, notices, private views, publishing',
    keywords: ['telegram', 'slack', 'whatsapp', 'imessage', 'message', 'outbound', 'notification', 'attention', 'topic', 'notice', 'standby', 'publishing', 'private view', 'agent updates', 'sender', 'relationships'],
  },
  {
    file: 'machines.md',
    title: 'Multiple machines, the pool, and this machine',
    when: 'running on more than one machine, moving a conversation, the mesh, leases, machine load, git sync, secrets across machines, remote desktop',
    keywords: ['machine', 'mesh', 'pool', 'lease', 'rope', 'failover', 'write admission', 'git sync', 'working-set', 'coherence journal', 'one memory', 'follow-me', 'secret sync', 'seamless', 'placement', 'desktop', 'restart care', 'cold-start', 'lifeline'],
  },
  {
    file: 'accounts-and-models.md',
    title: 'Accounts, quota, models and frameworks',
    when: 'subscription accounts, quota and usage limits, sign-in problems, credentials, model or framework routing, spend, Codex, browser profiles',
    keywords: ['subscription', 'quota', 'codex', 'credential', 'login', 'token', 'routing', 'money', 'spend', 'doorway', 'model', 'framework', 'grok', 'topic profile', 'playwright', 'anthropic', 'ultracode', 'mcp', 'secret drop'],
  },
  {
    file: 'sessions-and-jobs.md',
    title: 'Sessions, jobs and the scheduler',
    when: 'starting or ending sessions, why a session vanished, scheduled jobs, scripts, stalls, compaction and context recovery, hooks',
    keywords: ['session', 'job', 'schedul', 'reaper', 'reap-log', 'stall', 'compaction', 'context', 'watchdog', 'script', 'skip ledger', 'handoff', 'hook', 'clock', 'permission-prompt', 'dispatch system', 'event stream', 'server status'],
  },
  {
    file: 'autonomy-and-commitments.md',
    title: 'Autonomy, commitments and follow-through',
    when: 'autonomous runs, promises and commitments, progress messages, approvals and authorization, blockers, apprenticeship',
    keywords: ['autonom', 'commitment', 'promise', 'beacon', 'follow-through', 'honest progress', 'approval', 'mandate', 'authorization', 'blocker', 'self-unblock', 'throughput', 'real-check', 'scope-accretion', 'apprenticeship', 'carries the loop', 'standing down', 'stand-down', 'loop', 'context-death'],
  },
  {
    file: 'dashboard-and-web.md',
    title: 'Dashboard, tunnel, files and browsers',
    when: 'the dashboard or console, sharing a link, the tunnel, the file viewer, browser and Chrome tasks, backups',
    keywords: ['dashboard', 'tunnel', 'file viewer', 'console', 'browser', 'chrome', 'web', 'backup', 'memory search', 'live insights', 'process health'],
  },
  {
    file: 'safety-and-monitoring.md',
    title: 'Safety guards and monitoring',
    when: 'guards and sentinels, health checks, coherence and external-operation gates, resource use, spawn caps, LLM decision quality, self-healing',
    keywords: ['guard', 'sentinel', 'health', 'coherence', 'external operation', 'resource', 'spawn cap', 'backpressure', 'load', 'quality meter', 'benchmark', 'metrics', 'tcc', 'hog', 'emergency', 'version-skew', 'self-heal', 'sleep/wake', 'flood', 'duplicate', 'gate', 'posture', 'identity recovery', 'recovery', 'escalation', 'trust levels'],
  },
  {
    file: 'development-and-updates.md',
    title: 'Development, testing and updates',
    when: 'worktrees, tests and Local Verify, releases and updates, CI and merges, the cartographer, feedback processing, skills and scripts',
    keywords: ['worktree', 'test', 'local verify', 'release', 'ci health', 'green-pr', 'cartographer', 'standards', 'feedback', 'update', 'failure-learning', 'review', 'cutover', 'native hook', 'skills', 'scripts', 'audit', 'throwaway', 'project map', 'org-intent', 'topic-project'],
  },
  {
    file: 'learning-and-memory.md',
    title: 'Learning, memory and self-evolution',
    when: 'memory, preferences and corrections, the evolution and learning queues, the playbook, Jev, growth and maturation, parallel work',
    keywords: ['evolution', 'learning', 'playbook', 'memory', 'preference', 'correction', 'jev', 'intent', 'capability gaps', 'growth', 'maturation', 'ideas', 'queue pace', 'dsar', 'action queue', 'agent registry', 'parallel-work', 'self-evolution'],
  },
];

export const OTHER_TOPIC: ReferenceTopic = {
  file: 'other.md',
  title: 'Other capabilities',
  when: 'anything not covered above',
  keywords: [],
};

export interface AwarenessUnit {
  /** The line that starts the unit ('' for the preamble). */
  titleLine: string;
  /** Normalised title (no #s / ** / trailing description). */
  title: string;
  /** Heading level 2–6, or 0 for a bold-lead feature paragraph, -1 for preamble. */
  level: number;
  /** Exact text of the unit (including its trailing newline(s)). */
  text: string;
}

const HEADING_RE = /^(#{2,6}) (.+)$/;
// A column-0 bold-lead feature paragraph: **Name** — ..., optionally with a
// parenthetical between the bold name and the dash.
const BOLD_LEAD_RE = /^\*\*([^*\n]{2,}?)\*\*(?:\s*\([^)\n]*\))?\s*—/;

/** Normalise a unit title for matching. */
export function normaliseTitle(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Split a markdown document into units. Concatenating `units.map(u => u.text)`
 * returns the input exactly. The first unit is the preamble (level -1), which may be ''.
 */
export function parseAwarenessUnits(doc: string): AwarenessUnit[] {
  const lines = doc.split('\n');
  const units: AwarenessUnit[] = [{ titleLine: '', title: '', level: -1, text: '' }];
  // Open fence: its character (` or ~) and length; closed by a line of the same
  // character at least as long (CommonMark).
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const piece = isLast ? line : line + '\n';
    const trimmed = line.trimStart();
    let start: { level: number; title: string } | null = null;
    if (!fence) {
      const h = HEADING_RE.exec(line);
      if (h) start = { level: h[1].length, title: h[2] };
      else {
        const b = BOLD_LEAD_RE.exec(line);
        if (b) start = { level: 0, title: b[1] };
      }
    }
    const fm = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!fence) fence = { ch, len };
      else if (ch === fence.ch && len >= fence.len && trimmed.slice(len).trim() === '') fence = null;
    }
    if (start) {
      units.push({ titleLine: line, title: normaliseTitle(start.title), level: start.level, text: piece });
    } else {
      units[units.length - 1].text += piece;
    }
  }
  return units;
}

function isCoreHeading(title: string): boolean {
  return CLAUDE_MD_CORE_HEADINGS.some(h => title.startsWith(h.toLowerCase()));
}

function isCoreContainerHeading(title: string): boolean {
  return CLAUDE_MD_CORE_CONTAINER_HEADINGS.some(h => title.startsWith(h.toLowerCase()));
}

function topicMatch(title: string): ReferenceTopic | null {
  return REFERENCE_TOPICS.find(tp => tp.keywords.some(k => title.includes(k))) ?? null;
}

export interface ReferencePart {
  /** File name under REFERENCE_DIR_REL. */
  file: string;
  /** Units' text in document order (without header). */
  body: string;
  /** Unit titles (display form) in document order. */
  titles: string[];
}

export interface SplitResult {
  /** The preamble of the full document (e.g. "# CLAUDE.md — Name"). */
  preamble: string;
  /** Core units' text in document order. */
  coreBody: string;
  /** Topic file name → units' text in document order (without header). */
  referenceBodies: Map<string, string>;
  /** Topic file name → unit titles (display form) in document order. */
  referenceTitles: Map<string, string[]>;
  /**
   * Topic file name → the files it is written as. A topic over
   * MAX_REFERENCE_FILE_CHARS is cut at unit boundaries into `name.md`,
   * `name-2.md`, ... so one Read of a file stays well inside a tool call.
   */
  referenceParts: Map<string, ReferencePart[]>;
  /** Headings nested inside a core section but not on the core allowlist (should be empty). */
  nestedOutsideCore: string[];
}

/** Largest reference file (characters, about 10k tokens). Bigger topics are cut into parts. */
export const MAX_REFERENCE_FILE_CHARS = 40_000;

/** Display form of a unit's title for INDEX.md. */
function displayTitle(u: AwarenessUnit): string {
  const raw = u.level > 0
    ? u.titleLine.replace(/^#+\s*/, '')
    : (BOLD_LEAD_RE.exec(u.titleLine)?.[1] ?? u.title);
  const clean = raw.replace(/\*\*/g, '').trim();
  return clean.length > 140 ? clean.slice(0, 137) + '...' : clean;
}

/** Short feature name for the core's always-loaded feature list. */
function shortName(display: string): string {
  const cut = display.split(/ \(| — | - |: /)[0].replace(/`/g, '').trim();
  return cut.length > 60 ? cut.slice(0, 57) + '...' : cut;
}

function partFileName(topicFile: string, index: number): string {
  return index === 0 ? topicFile : topicFile.replace(/\.md$/, `-${index + 1}.md`);
}

export function splitAwareness(full: string): SplitResult {
  const units = parseAwarenessUnits(full);
  const preamble = units[0].text;
  let enclosingCore = false;
  // Topic of the nearest enclosing heading unit (for bold-lead paragraphs).
  let enclosingTopic: ReferenceTopic = OTHER_TOPIC;
  // Open heading ancestry: a generic sub-section of a reference section
  // ("What It Does", "Restrictions") follows its nearest ancestor's file so it
  // keeps its context.
  const stack: Array<{ level: number; topic: ReferenceTopic | null; core: boolean; container: boolean }> = [];
  let coreBody = '';
  const nestedOutsideCore: string[] = [];
  const topicUnits = new Map<string, Array<{ text: string; title: string; cuttable: boolean }>>();
  for (const u of units.slice(1)) {
    let topic: ReferenceTopic | null = null;
    if (u.level > 0) {
      while (stack.length && stack[stack.length - 1].level >= u.level) stack.pop();
      const parent = stack[stack.length - 1];
      const container = isCoreContainerHeading(u.title);
      enclosingCore = isCoreHeading(u.title);
      // A sub-heading nested inside a core section that is not itself on the
      // allowlist is reported (tests fail on it in the canonical document), not
      // pulled into the core: an instar section appended at the end of the file
      // after a trailing core heading must not silently grow every session.
      if (!enclosingCore && parent && parent.core && !parent.container) nestedOutsideCore.push(u.title);
      if (!enclosingCore) {
        const ancestor = [...stack].reverse().find(x => x.topic !== null);
        // A #### (or deeper) heading is part of its parent section: it always
        // goes to the parent's file, even when its own title matches another topic.
        topic = (u.level >= 4 && ancestor?.topic) ? ancestor.topic : (topicMatch(u.title) ?? ancestor?.topic ?? OTHER_TOPIC);
        enclosingTopic = topic;
      }
      stack.push({ level: u.level, topic, core: enclosingCore, container });
    }
    if (enclosingCore) {
      coreBody += u.text;
      continue;
    }
    // A bold-lead paragraph inside a #### (or deeper) sub-section is part of it:
    // same file, same part. Elsewhere bold-leads are independent feature entries.
    const insideSubsection = u.level === 0 && (stack[stack.length - 1]?.level ?? 0) >= 4;
    if (!topic) topic = insideSubsection ? enclosingTopic : (topicMatch(u.title) ?? enclosingTopic);
    const list = topicUnits.get(topic.file) ?? [];
    // Parts are never cut before a #### (or deeper) heading or inside one, so a
    // sub-section never lands in a different part from its section.
    list.push({ text: u.text, title: displayTitle(u), cuttable: u.level > 0 ? u.level < 4 : !insideSubsection });
    topicUnits.set(topic.file, list);
  }
  const referenceBodies = new Map<string, string>();
  const referenceTitles = new Map<string, string[]>();
  const referenceParts = new Map<string, ReferencePart[]>();
  for (const [file, list] of topicUnits) {
    referenceBodies.set(file, list.map(x => x.text).join(''));
    referenceTitles.set(file, list.map(x => x.title));
    const parts: ReferencePart[] = [];
    let cur: ReferencePart = { file: partFileName(file, 0), body: '', titles: [] };
    for (const x of list) {
      if (x.cuttable && cur.body.length > 0 && cur.body.length + x.text.length > MAX_REFERENCE_FILE_CHARS) {
        parts.push(cur);
        cur = { file: partFileName(file, parts.length), body: '', titles: [] };
      }
      cur.body += x.text;
      cur.titles.push(x.title);
    }
    parts.push(cur);
    referenceParts.set(file, parts);
  }
  return { preamble, coreBody, referenceBodies, referenceTitles, referenceParts, nestedOutsideCore };
}

function allTopics(): ReferenceTopic[] {
  return [...REFERENCE_TOPICS, OTHER_TOPIC];
}

/** The dispatch section that ends the core block. */
export function renderDispatchSection(split: SplitResult): string {
  const topics = allTopics().filter(t => split.referenceParts.has(t.file));
  const fileList = (t: ReferenceTopic) => split.referenceParts.get(t.file)!
    .map(part => `\`${REFERENCE_DIR_REL}/${part.file}\``).join(', ');
  const rows = topics.map(t => `| ${t.when} | ${fileList(t)} |`);
  const features = topics.map(t => {
    const names = [...new Set((split.referenceTitles.get(t.file) ?? []).map(shortName))];
    return `- **${t.title}**: ${names.join('; ')}.`;
  });
  return [
    '## Instar Reference — read on demand',
    '',
    `Most of my capabilities are described in reference files, not here, so every session starts small. The list below names every one of them. Before saying a capability does not exist, or before using one I have not used in this session, I read its section: \`${REFERENCE_DIR_REL}/INDEX.md\` says which file holds it, and \`grep -n '<name>' <file>\` finds the line to read from. A grep is word-match only: no hit means no literal match, not that the capability is missing, so I also check INDEX.md and \`GET /capabilities\` before concluding. These files are rewritten on every instar update.`,
    '',
    '| When the work touches | Read |',
    '|---|---|',
    ...rows,
    '',
    '### Every capability in the reference files',
    '',
    ...features,
    '',
  ].join('\n');
}

/** The full text between (and including) the core markers. */
export function renderCoreRegion(full: string, layout: 'reference' | 'full' = 'reference'): string {
  if (layout === 'full') {
    return `${CLAUDE_MD_CORE_START}\n${full.replace(/\n*$/, '\n')}${CLAUDE_MD_CORE_END}\n`;
  }
  const split = splitAwareness(full);
  const body = (split.preamble + split.coreBody).replace(/\n*$/, '\n\n') + renderDispatchSection(split);
  return `${CLAUDE_MD_CORE_START}\n${body.replace(/\n*$/, '\n')}${CLAUDE_MD_CORE_END}\n`;
}

/** Reference file name → full file content (header included), plus INDEX.md. */
export function renderReferenceFiles(full: string): Map<string, string> {
  const split = splitAwareness(full);
  const out = new Map<string, string>();
  const indexLines: string[] = [
    REFERENCE_FILE_HEADER,
    '# Instar reference — index',
    '',
    'Every capability section and the file that holds it. Read the file when a task needs the feature.',
    '',
  ];
  for (const t of allTopics()) {
    const parts = split.referenceParts.get(t.file);
    if (!parts) continue;
    parts.forEach((part, i) => {
      const partLabel = parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : '';
      out.set(part.file, `${REFERENCE_FILE_HEADER}\n# ${t.title}${partLabel}\n\n_When: ${t.when}._\n\n${part.body.replace(/\n*$/, '\n')}`);
      indexLines.push(`## ${part.file} — ${t.title}${partLabel}`, '');
      for (const title of part.titles) indexLines.push(`- ${title}`);
      indexLines.push('');
    });
  }
  out.set('INDEX.md', indexLines.join('\n'));
  return out;
}

export interface CoreRegionLocation {
  start: number;
  /** Index just past the end marker line (including its newline when present). */
  end: number;
}

/**
 * Locate the core region. Returns null when absent, 'broken' when only one
 * marker is present or they are out of order (the file is then left alone).
 */
export function findCoreRegion(content: string): CoreRegionLocation | null | 'broken' {
  const s = content.indexOf(CLAUDE_MD_CORE_START_PREFIX);
  const e = content.indexOf(CLAUDE_MD_CORE_END);
  if (s < 0 && e < 0) return null;
  if (s < 0 || e < 0 || e < s) return 'broken';
  if (content.indexOf(CLAUDE_MD_CORE_START_PREFIX, s + 1) >= 0 || content.indexOf(CLAUDE_MD_CORE_END, e + 1) >= 0) return 'broken';
  let end = e + CLAUDE_MD_CORE_END.length;
  if (content[end] === '\n') end += 1;
  return { start: s, end };
}

const TAIL_STAMP_RE = /^<!-- instar:claude-md-tail length=(\d+) sha256=([0-9a-f]{64}) -->\n/m;

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Put a fingerprint of the text below the end marker (as instar leaves it) on its
 * own line just before the end marker. It lives inside CLAUDE.md, so it travels
 * with the file to every machine of a synced agent; it is the evidence that later
 * text below the block was appended (by an older instar version).
 */
export function stampTail(region: string, tail: string): string {
  const clean = region.replace(TAIL_STAMP_RE, '');
  const at = clean.lastIndexOf(CLAUDE_MD_CORE_END);
  const stamp = `<!-- instar:claude-md-tail length=${tail.length} sha256=${sha256Hex(tail)} -->\n`;
  return clean.slice(0, at) + stamp + clean.slice(at);
}

/** The fingerprint stamped in a region, or null. */
export function readTailStamp(region: string): { length: number; sha256: string } | null {
  const m = TAIL_STAMP_RE.exec(region);
  return m ? { length: Number(m[1]), sha256: m[2] } : null;
}

/** A region without its fingerprint line (for "did the instar text change?" checks). */
export function withoutTailStamp(region: string): string {
  return region.replace(TAIL_STAMP_RE, '');
}

/** True when `tail` starts with exactly the text the stamp fingerprints. */
export function tailExtendsStamp(stamp: { length: number; sha256: string }, tail: string): boolean {
  return tail.length >= stamp.length && sha256Hex(tail.slice(0, stamp.length)) === stamp.sha256;
}

/** Replace the core region with `region` (which includes both markers). */
export function replaceCoreRegion(content: string, loc: CoreRegionLocation, region: string): string {
  return content.slice(0, loc.start) + region + content.slice(loc.end);
}

export interface LegacyExtraction {
  /** Operator-written text to keep in CLAUDE.md, in original order ('' if none). */
  kept: string;
  keptUnits: number;
  movedUnits: number;
  /** Display titles of kept units (for the migration report). */
  keptTitles: string[];
  /**
   * Moved units that held lines not in the current instar text (older instar
   * wording, or an operator's edit inside an instar section): title + those lines.
   */
  movedDiffering: Array<{ title: string; lines: string[] }>;
}

/** A line an operator puts in a section below the instar block so instar never moves it. */
export const CLAUDE_MD_KEEP_MARKER = '<!-- instar:keep -->';

const OWNED_LINE_FRACTION = 0.6;
/** Minimum verbatim-line share for a title match to count (below it: operator text under an instar title). */
const TITLE_MATCH_MIN_LINE_FRACTION = 0.4;

/**
 * A title without its trailing explanation: the text before the first " (",
 * " — " or ":" — so "Reap-Log — why a session vanished" and "Reap-log" match.
 */
export function baseTitle(normalised: string): string {
  return normalised.split(/ \(| — | - |:/)[0].trim();
}

/**
 * Decide which parts of a legacy (pre-layout) CLAUDE.md the operator wrote.
 * A unit is instar-owned when its normalised title is a unit title in the
 * canonical document and ≥40% of its lines appear verbatim (not for core
 * headings, which agents personalise), or when ≥60% of its non-empty lines
 * appear verbatim (trimmed) in the canonical document. Ambiguity resolves to KEEP.
 */
export function extractOperatorContent(legacy: string, canonicalFull: string, extraKnownText = ''): LegacyExtraction {
  // `extraKnownText`: other text instar itself writes into CLAUDE.md (e.g. the
  // migrator's append chain run over an empty document, which yields sections
  // the canonical document carries in a different form). Treated like canonical.
  const knownText = extraKnownText ? `${canonicalFull}\n${extraKnownText}` : canonicalFull;
  const canonicalUnits = parseAwarenessUnits(knownText);
  const canonicalTitles = new Set(canonicalUnits.slice(1).map(u => u.title));
  const canonicalBaseTitles = new Set(canonicalUnits.slice(1).map(u => baseTitle(u.title)).filter(b => b.length >= 6));
  const canonicalLines = new Set(
    knownText.split('\n').map(l => l.trim()).filter(l => l.length > 0),
  );
  const units = parseAwarenessUnits(legacy);
  let kept = '';
  let keptUnits = 0;
  let movedUnits = 0;
  const keptTitles: string[] = [];
  const movedDiffering: Array<{ title: string; lines: string[] }> = [];
  units.forEach((u, idx) => {
    // The document title line ("# CLAUDE.md — <name>") is instar's even when the
    // name's spelling changed since it was written.
    // A `#` heading line is not evidence: an operator section under an instar
    // title would otherwise score its own title as a matching line. (A bold-lead
    // paragraph's first line is its content, so it counts.)
    const isHeading = idx > 0 && u.level > 0;
    const lines = u.text.split('\n').map(l => l.trim())
      .filter(l => l.length > 0 && !(idx === 0 && /^# CLAUDE\.md\b/.test(l)))
      .filter((l, i) => !(isHeading && i === 0 && l === u.titleLine.trim()));
    if (lines.includes(CLAUDE_MD_KEEP_MARKER)) {
      kept += u.text.replace(/\n*$/, '\n\n');
      keptUnits++;
      keptTitles.push(idx === 0 ? '(text before the first heading)' : displayTitle(u));
      return;
    }
    if (lines.length === 0) {
      if (idx === 0) return;
      // A heading with no body: instar's only when instar has exactly that heading.
      if (canonicalTitles.has(u.title)) { movedUnits++; return; }
      kept += u.text.replace(/\n*$/, '\n\n');
      keptUnits++;
      keptTitles.push(displayTitle(u));
      return;
    }
    const lineFraction = lines.filter(l => canonicalLines.has(l)).length / lines.length;
    // A title match covers older wording of an instar section (a version's text
    // drifts; measured drift on real agents leaves ≥40% of lines verbatim). It
    // never applies to core headings ("Who I Am", "API Authentication", ...):
    // agents and operators personalise those, and their text must survive.
    const titleOwned = idx > 0
      && !isCoreHeading(u.title)
      && lineFraction >= TITLE_MATCH_MIN_LINE_FRACTION
      && (canonicalTitles.has(u.title) || canonicalBaseTitles.has(baseTitle(u.title)));
    const owned = titleOwned || lineFraction >= OWNED_LINE_FRACTION;
    if (owned) {
      if (idx > 0) movedUnits++;
      const differing = lines.filter(l => !canonicalLines.has(l));
      if (differing.length > 0) movedDiffering.push({ title: idx === 0 ? '(text before the first heading)' : displayTitle(u), lines: differing });
      return;
    }
    kept += u.text.replace(/\n*$/, '\n\n');
    keptUnits++;
    keptTitles.push(idx === 0 ? '(text before the first heading)' : displayTitle(u));
  });
  return { kept: kept.replace(/\n*$/, kept ? '\n' : ''), keptUnits, movedUnits, keptTitles, movedDiffering };
}

/** Agent-home-relative file listing lines of moved sections that differed from instar's text. */
export const CLAUDE_MD_DIFFERING_LINES_REL = '.instar/CLAUDE.md.differing-lines.md';

/** Body of the differing-lines review file (written once per conversion). */
export function renderDifferingLinesFile(items: Array<{ title: string; lines: string[] }>, when: string): string {
  const out = [
    '# Lines instar moved out of CLAUDE.md that differed from its current text',
    '',
    `Written ${when} when CLAUDE.md switched to the small layout. Each section below was instar's own, so its current text now lives in \`${REFERENCE_DIR_REL}/\`. These lines were in the old copy but not in instar's current text: usually older instar wording, sometimes an edit someone made by hand. Copy any line worth keeping into CLAUDE.md below the instar block (text there is kept; only instar's own sections are ever moved out of it), then delete this file. The whole old file is at \`${CLAUDE_MD_LEGACY_BACKUP_REL}\`.`,
    '',
  ];
  for (const it of items) {
    out.push(`## ${it.title}`, '');
    for (const l of it.lines) out.push(`    ${l}`);
    out.push('');
  }
  return out.join('\n');
}

/** One visible line below the instar block pointing at the differing-lines file. */
export function differingLinesPointer(count: number): string {
  return `Note from the CLAUDE.md layout change: ${count} instar section(s) of the previous CLAUDE.md held lines that differ from instar's current text (older wording, or hand edits). They are listed in \`${CLAUDE_MD_DIFFERING_LINES_REL}\`; copy anything worth keeping here, then delete this note.\n`;
}

/** A new-layout CLAUDE.md: the core region, then any kept operator text. */
export function renderLayoutClaudeMd(full: string, keptOperatorText: string, layout: 'reference' | 'full' = 'reference', note = ''): string {
  const region = renderCoreRegion(full, layout);
  if (!keptOperatorText.trim() && !note) return stampTail(region, '');
  const keptPart = keptOperatorText.trim()
    ? `<!-- Kept from the previous CLAUDE.md because instar did not write it. The whole previous file is at ${CLAUDE_MD_LEGACY_BACKUP_REL}. -->\n\n${keptOperatorText.replace(/\n*$/, '\n')}`
    : '';
  const tail = `\n${note ? note + (keptPart ? '\n' : '') : ''}${keptPart}`;
  return stampTail(region, tail) + tail;
}
