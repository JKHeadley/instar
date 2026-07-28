import crypto from 'node:crypto';
import pc from 'picocolors';
import { loadConfig, getInstarVersion } from '../core/Config.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { IssueBucket, IssueSeverity } from '../monitoring/FrameworkIssueLedger.js';

export type TranscriptUxCategory =
  | 'duplicate-notices-deliveries'
  | 'asks-of-user'
  | 'infra-noise'
  | 'content-free-updates';

export interface TranscriptMessage {
  messageId: number | string;
  topicId?: number | null;
  channelId?: number | string | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName?: string | null;
  senderName?: string;
  senderUsername?: string;
}

export interface TranscriptAuditWindow {
  start: string;
  end: string;
}

export interface TranscriptUxFinding {
  category: TranscriptUxCategory;
  topicId: number;
  messageIds: Array<number | string>;
  timestamps: string[];
  severity: IssueSeverity;
  title: string;
  reason: string;
  excerpt: string;
  dedupKey: string;
  frameworkIssue: {
    framework: string;
    bucket: IssueBucket;
    severity: IssueSeverity;
    title: string;
    dedupKey: string;
    signature: string;
    evidence: string;
    observedVersion: string;
    relatedSpec: string;
  };
}

export interface TranscriptAuditReport {
  topicIds: number[];
  window: TranscriptAuditWindow;
  generatedAt: string;
  summary: Record<TranscriptUxCategory, number> & { total: number };
  findings: TranscriptUxFinding[];
  observations: Array<{
    dedupKey: string;
    filed: boolean;
    created?: boolean;
    episodeRecorded?: boolean;
    issueId?: string;
    error?: string;
  }>;
}

export interface TranscriptAuditDeps {
  readTopicHistory(topicId: number, limit: number): Promise<TranscriptMessage[]>;
  observeFinding(input: TranscriptUxFinding['frameworkIssue']): Promise<{
    created?: boolean;
    episodeRecorded?: boolean;
    issueId?: string;
  }>;
  now?: () => Date;
}

export interface RunPostDriveTranscriptAuditOptions {
  topicIds: number[];
  start: string;
  end: string;
  limit?: number;
  dryRun?: boolean;
  deps: TranscriptAuditDeps;
}

export interface PostDriveTranscriptAuditCliOptions {
  topics?: string[];
  topic?: string[];
  start: string;
  end: string;
  limit?: number;
  baseUrl?: string;
  /** Where the drive TRANSCRIPT lives when it is not this agent's server —
   *  e.g. the MENTEE's server records the mentor's Playwright drive, so the
   *  mentor reads history there while filing findings into its OWN ledger.
   *  Defaults to baseUrl (single-server flow, byte-compatible with #864).
   *  Auth for the remote read comes from --history-auth-token or the
   *  INSTAR_HISTORY_AUTH_TOKEN env var (env preferred — flags leak via ps). */
  historyBaseUrl?: string;
  historyAuthToken?: string;
  dir?: string;
  dryRun?: boolean;
  json?: boolean;
}

const ZERO_SUMMARY: Record<TranscriptUxCategory, number> & { total: number } = {
  'duplicate-notices-deliveries': 0,
  'asks-of-user': 0,
  'infra-noise': 0,
  'content-free-updates': 0,
  total: 0,
};

const CATEGORY_TITLES: Record<TranscriptUxCategory, string> = {
  'duplicate-notices-deliveries': 'Post-drive transcript showed duplicate notices or deliveries',
  'asks-of-user': 'Post-drive transcript asked the operator to resend, retry, or re-paste',
  'infra-noise': 'Post-drive transcript surfaced internal infrastructure noise to the operator',
  'content-free-updates': 'Post-drive transcript contained progress updates without usable content',
};

const CATEGORY_REASON: Record<TranscriptUxCategory, string> = {
  'duplicate-notices-deliveries': 'The same operator-visible notice appeared more than once in the audit window.',
  'asks-of-user': 'The assistant shifted recovery work onto the operator by asking for a resend, retry, or re-paste.',
  'infra-noise': 'The assistant exposed queue, restart, process, watchdog, or terminal chatter instead of translating it into user-relevant status.',
  'content-free-updates': 'The assistant sent a progress update that did not contain a concrete state change, artifact, decision, or next action.',
};

const RELATED_SPEC = 'Observation Needs Structure (PR #861); UX-blindspot arc / operatorSeatUx gate (PR #856)';
const DEFAULT_FRAMEWORK = 'codex-cli';

const ASK_OF_USER_RE =
  /\b(?:re-?send|send (?:it|that|this|the file|the screenshot) again|try again|retry|re-?paste|paste (?:it|that|this) again|upload (?:it|that|this) again|can you send|could you send|please send).{0,80}\b(?:again|retry|re-?paste|re-?send)?/i;

const INFRA_NOISE_RE =
  /\b(?:restart|restarting|queue|queued|sentinel|standby|watchdog|terminal output|child process|pid|daemon|tmux|relaunch|boot loop|stalled|unstick|heartbeat|session respawn|process exited)\b/i;

const CONTENT_FREE_RE =
  /\b(?:working on it|still working|still digging|quick update|no terminal output|has not produced terminal output|actively working|continuing to monitor|unchanged|will keep going|keeping an eye on it)\b/i;

const SECRET_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function canonicalWindow(start: string, end: string): TranscriptAuditWindow {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs)) throw new Error(`Invalid --start timestamp: ${start}`);
  if (!Number.isFinite(endMs)) throw new Error(`Invalid --end timestamp: ${end}`);
  if (endMs < startMs) throw new Error('--end must be at or after --start');
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function normalizeForDuplicate(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeExcerpt(s: string): string {
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (SECRET_SHAPES.some((re) => re.test(cleaned))) return '[redacted: secret-shaped text]';
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function inWindow(message: TranscriptMessage, window: TranscriptAuditWindow): boolean {
  const ts = Date.parse(message.timestamp);
  return Number.isFinite(ts) && ts >= Date.parse(window.start) && ts <= Date.parse(window.end);
}

function isConcreteUpdate(text: string): boolean {
  return /\b(?:built|implemented|fixed|verified|opened|merged|pushed|committed|test(?:ed|s)?|report|pr #?\d+|artifact|link|blocked by|found|landed)\b/i.test(text);
}

function makeFinding(input: {
  category: TranscriptUxCategory;
  topicId: number;
  messages: TranscriptMessage[];
  window: TranscriptAuditWindow;
  observedVersion: string;
}): TranscriptUxFinding {
  const ids = input.messages.map((m) => m.messageId);
  const timestamps = input.messages.map((m) => m.timestamp);
  const evidenceSeed = `${input.category}:${input.topicId}:${input.window.start}:${input.window.end}:${ids.join(',')}:${timestamps.join(',')}`;
  const dedupKey = `post-drive-transcript-audit::${input.category}::topic-${input.topicId}::${hash(evidenceSeed)}`;
  const evidence = `telegram-topic:${input.topicId}:messages:${ids.join(',')}:window:${input.window.start}..${input.window.end}`;
  const excerpt = input.messages.map((m) => sanitizeExcerpt(m.text)).join(' | ');
  const severity: IssueSeverity = input.category === 'asks-of-user' ? 'high' : 'medium';
  const title = CATEGORY_TITLES[input.category];

  return {
    category: input.category,
    topicId: input.topicId,
    messageIds: ids,
    timestamps,
    severity,
    title,
    reason: CATEGORY_REASON[input.category],
    excerpt,
    dedupKey,
    frameworkIssue: {
      framework: DEFAULT_FRAMEWORK,
      bucket: 'instar-integration-gap',
      severity,
      title,
      dedupKey,
      signature: `${input.category}:${input.topicId}:${hash(excerpt)}`,
      evidence,
      observedVersion: input.observedVersion,
      relatedSpec: RELATED_SPEC,
    },
  };
}

export function classifyTranscriptUx(input: {
  topicId: number;
  messages: TranscriptMessage[];
  window: TranscriptAuditWindow;
  observedVersion?: string;
}): TranscriptUxFinding[] {
  const observedVersion = input.observedVersion ?? getInstarVersion();
  const scoped = input.messages
    .filter((m) => inWindow(m, input.window))
    .filter((m) => typeof m.text === 'string' && m.text.trim().length > 0);
  const findings: TranscriptUxFinding[] = [];

  const duplicateGroups = new Map<string, TranscriptMessage[]>();
  for (const m of scoped.filter((msg) => !msg.fromUser)) {
    const key = normalizeForDuplicate(m.text);
    if (key.length < 12) continue;
    if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
    duplicateGroups.get(key)!.push(m);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length >= 2) {
      findings.push(makeFinding({
        category: 'duplicate-notices-deliveries',
        topicId: input.topicId,
        messages: group,
        window: input.window,
        observedVersion,
      }));
    }
  }

  const contentFreeGroups = new Map<string, TranscriptMessage[]>();
  for (const m of scoped.filter((msg) => !msg.fromUser)) {
    if (ASK_OF_USER_RE.test(m.text)) {
      findings.push(makeFinding({
        category: 'asks-of-user',
        topicId: input.topicId,
        messages: [m],
        window: input.window,
        observedVersion,
      }));
    }
    if (INFRA_NOISE_RE.test(m.text)) {
      findings.push(makeFinding({
        category: 'infra-noise',
        topicId: input.topicId,
        messages: [m],
        window: input.window,
        observedVersion,
      }));
    }
    if (CONTENT_FREE_RE.test(m.text) && !isConcreteUpdate(m.text)) {
      const key = normalizeForDuplicate(m.text);
      if (!contentFreeGroups.has(key)) contentFreeGroups.set(key, []);
      contentFreeGroups.get(key)!.push(m);
    }
  }

  for (const group of contentFreeGroups.values()) {
    findings.push(makeFinding({
      category: 'content-free-updates',
      topicId: input.topicId,
      messages: group,
      window: input.window,
      observedVersion,
    }));
  }

  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.dedupKey)) return false;
    seen.add(f.dedupKey);
    return true;
  });
}

function summarize(findings: TranscriptUxFinding[]): TranscriptAuditReport['summary'] {
  const summary = { ...ZERO_SUMMARY };
  for (const f of findings) {
    summary[f.category] += 1;
    summary.total += 1;
  }
  return summary;
}

export async function runPostDriveTranscriptAudit(options: RunPostDriveTranscriptAuditOptions): Promise<TranscriptAuditReport> {
  if (options.topicIds.length === 0) throw new Error('At least one topic id is required');
  const window = canonicalWindow(options.start, options.end);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const generatedAt = (options.deps.now ?? (() => new Date()))().toISOString();
  const findings: TranscriptUxFinding[] = [];

  for (const topicId of options.topicIds) {
    const messages = await options.deps.readTopicHistory(topicId, limit);
    findings.push(...classifyTranscriptUx({ topicId, messages, window }));
  }

  const observations: TranscriptAuditReport['observations'] = [];
  for (const finding of findings) {
    if (options.dryRun) {
      observations.push({ dedupKey: finding.dedupKey, filed: false });
      continue;
    }
    try {
      const result = await options.deps.observeFinding(finding.frameworkIssue);
      observations.push({ dedupKey: finding.dedupKey, filed: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      DegradationReporter.getInstance().report({
        feature: 'post-drive-transcript-audit',
        primary: 'File transcript UX finding into the framework issue ledger',
        fallback: 'Structured report still includes the finding; ledger write failed for this observation',
        reason: message,
        impact: 'The auditor found a UX antipattern but could not persist that single observation automatically.',
      });
      observations.push({ dedupKey: finding.dedupKey, filed: false, error: message });
    }
  }

  return {
    topicIds: options.topicIds,
    window,
    generatedAt,
    summary: summarize(findings),
    findings,
    observations,
  };
}

function parseTopicIds(raw: PostDriveTranscriptAuditCliOptions): number[] {
  const values = [...(raw.topic ?? []), ...(raw.topics ?? [])];
  const ids = values.flatMap((v) => String(v).split(',')).map((v) => Number.parseInt(v.trim(), 10));
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error('Pass at least one positive topic id with --topic (repeatable) or --topics');
  }
  return [...new Set(ids)];
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch((err: unknown) => `failed to read response body: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function runPostDriveTranscriptAuditCli(options: PostDriveTranscriptAuditCliOptions): Promise<number> {
  const config = loadConfig(options.dir);
  const baseUrl = (options.baseUrl ?? `http://localhost:${config.port}`).replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;
  // Transcript reads may live on a DIFFERENT server than the ledger writes:
  // in the apprenticeship flow the MENTEE's server records the drive, while
  // findings belong in the auditing agent's OWN ledger. --history-base-url
  // splits the read side; filing always goes to baseUrl. Defaults preserve
  // the single-server #864 behavior byte-for-byte.
  const historyBaseUrl = (options.historyBaseUrl ?? baseUrl).replace(/\/+$/, '');
  const historyHeaders: Record<string, string> = { ...headers };
  if (historyBaseUrl !== baseUrl) {
    const remoteToken = options.historyAuthToken ?? process.env.INSTAR_HISTORY_AUTH_TOKEN;
    if (remoteToken) historyHeaders.Authorization = `Bearer ${remoteToken}`;
    else delete historyHeaders.Authorization; // local token is wrong for a remote server — send none rather than a misleading one
  }
  const topicIds = parseTopicIds(options);

  const report = await runPostDriveTranscriptAudit({
    topicIds,
    start: options.start,
    end: options.end,
    limit: options.limit,
    dryRun: options.dryRun,
    deps: {
      readTopicHistory: async (topicId, limit) => {
        const data = await fetchJson(`${historyBaseUrl}/telegram/topics/${topicId}/messages?limit=${limit}`, { headers: historyHeaders });
        const messages = (data as { messages?: unknown }).messages;
        if (!Array.isArray(messages)) throw new Error(`Topic ${topicId} history response did not include messages[]`);
        return messages as TranscriptMessage[];
      },
      observeFinding: async (input) => {
        return await fetchJson(`${baseUrl}/framework-issues/observe`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }) as { created?: boolean; episodeRecorded?: boolean; issueId?: string };
      },
    },
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.observations.some((o) => o.error) ? 1 : 0;
  }

  process.stdout.write(`${pc.bold('post-drive transcript audit')}\n`);
  process.stdout.write(`Topics: ${report.topicIds.join(', ')}\n`);
  process.stdout.write(`Window: ${report.window.start} .. ${report.window.end}\n`);
  process.stdout.write(`Findings: ${report.summary.total}\n`);
  for (const category of Object.keys(ZERO_SUMMARY).filter((k) => k !== 'total') as TranscriptUxCategory[]) {
    process.stdout.write(`  ${category}: ${report.summary[category]}\n`);
  }
  for (const finding of report.findings) {
    const obs = report.observations.find((o) => o.dedupKey === finding.dedupKey);
    const filed = obs?.filed ? (obs.episodeRecorded === false ? 'deduped' : 'filed') : options.dryRun ? 'dry-run' : 'not filed';
    process.stdout.write(`\n- [${finding.category}] topic ${finding.topicId} ${filed}\n`);
    process.stdout.write(`  ${finding.reason}\n`);
    process.stdout.write(`  evidence: ${finding.frameworkIssue.evidence}\n`);
    process.stdout.write(`  dedupKey: ${finding.dedupKey}\n`);
  }
  return report.observations.some((o) => o.error) ? 1 : 0;
}
