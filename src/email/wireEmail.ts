/**
 * Builds the email sender from a running server's parts (docs/specs/backup-email-sending.md). Kept apart from
 * AgentServer so the wiring the E2E test exercises is the wiring that ships.
 */
import crypto from 'node:crypto';
import { EmailOutbox, EMAIL_OUTBOX_STORE_KEY, type OutboxRecord, type OutboxRow } from './EmailOutbox.js';
import { EmailOptInStore } from './emailOptIn.js';
import { EmailService, type TopicDeliveryResult } from './EmailService.js';
import { buildEmailOutboxRecordData } from './EmailOutboxReplicatedStore.js';
import { emailDay } from './emailCore.js';
import type { EmailCredential } from './emailCore.js';
import type { EmailTransport, SmtpClientFactory } from './transports.js';
import type { RecommendedServicesLedger, ChoiceRow } from '../recommended/RecommendedServicesLedger.js';
import type { JobDefinition } from '../core/types.js';
import { Cron } from 'croner';

export interface EmailWiringInput {
  stateDir: string;
  agentName: string;
  machineId: string;
  /** Keys recipient hashes: derived from this machine's identity key. */
  recipientKey: string | Buffer;
  ledger: () => RecommendedServicesLedger | null;
  readSecret: (name: string) => string | null;
  holdsLease: () => boolean;
  detectCredential: (text: string) => boolean;
  config: () => { enabled?: boolean; statusWindowMinutes?: number; transportTimeoutSeconds?: number; fallbackLineEvery?: 'hour' | 'day'; timezone?: string } | undefined;
  /** The scheduler's jobs and its report path. */
  jobs?: () => JobDefinition[];
  deliverJobReport?: (job: JobDefinition, text: string) => Promise<TopicDeliveryResult>;
  /** A plain send to the session's topic, for a one-off's fallback. */
  deliverToSessionTopic?: (topicId: number, text: string) => Promise<TopicDeliveryResult>;
  /** The durable relay queue (PendingRelayStore). False when nothing new was inserted. */
  relayEnqueue?: (deliveryId: string, topicId: number, text: string) => boolean;
  /** Replication of outbox records. False when the record was not emitted. */
  emit?: (record: OutboxRecord) => boolean;
  onCredentialRefused?: () => void;
  report?: (what: string, detail: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
  createSmtpClient?: SmtpClientFactory;
  transportFor?: (credential: EmailCredential, recipient: string, timeoutMs: number) => EmailTransport;
}

/** The agent's email day timezone: the config's, else the one on the standing yes, else this machine's. */
export function resolveEmailTimezone(configured: string | undefined, yes: ChoiceRow | null): string {
  if (configured) return configured;
  if (yes?.timezone) return yes.timezone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } // @silent-fallback-ok — UTC is one day for every holder
}

/** Remaining scheduled runs today (to midnight in the email timezone) of jobs that email their report. */
export function remainingEmailedJobsToday(jobs: JobDefinition[], nowMs: number, timeZone: string): number {
  const today = emailDay(nowMs, timeZone);
  let n = 0;
  for (const job of jobs) {
    if (!job.enabled || !job.deliver?.includes('email') || job.execute?.type === 'script') continue;
    try {
      const cron = new Cron(job.schedule, { timezone: timeZone, paused: true });
      let next = cron.nextRun(new Date(nowMs));
      let guard = 0;
      while (next && emailDay(next.getTime(), timeZone) === today && guard++ < 1440) {
        n++;
        next = cron.nextRun(next);
      }
      cron.stop();
    } catch { /* @silent-fallback-ok — an unparseable schedule reserves nothing; its job never runs either */ }
  }
  return n;
}

export function emailRowIdForExecution(executionId: string): string {
  return `em-run-${crypto.createHash('sha256').update(executionId).digest('hex').slice(0, 32)}`;
}

export function buildEmailService(input: EmailWiringInput): { service: EmailService; outbox: EmailOutbox; optIn: EmailOptInStore } {
  const outbox = new EmailOutbox({ stateDir: input.stateDir, machineId: input.machineId, now: input.now, emit: input.emit });
  const optIn = new EmailOptInStore({ stateDir: input.stateDir, machineId: input.machineId, macKey: input.recipientKey, now: input.now });
  const grant = (): ChoiceRow | null => {
    const ledger = input.ledger();
    return ledger ? ledger.activeGrant('email', ledger.machineId()) : null;
  };
  const timezone = (): string => resolveEmailTimezone(input.config()?.timezone, grant());
  const findJob = (slug: string | undefined): JobDefinition | undefined => (slug ? input.jobs?.().find((j) => j.slug === slug) : undefined);
  const deliverToTopic = async (row: OutboxRow, text: string): Promise<TopicDeliveryResult> => {
    const job = findJob(row.jobSlug);
    if (job && input.deliverJobReport) return input.deliverJobReport(job, text);
    if (row.fallbackTopicId !== null && input.deliverToSessionTopic) return input.deliverToSessionTopic(row.fallbackTopicId, text);
    return { ok: false };
  };
  const service = new EmailService({
    outbox, optIn, stateDir: input.stateDir, machineId: input.machineId, recipientKey: input.recipientKey, agentName: input.agentName,
    readSecret: input.readSecret,
    enabled: () => input.config()?.enabled !== false,
    hasGrant: () => grant() !== null,
    grantRecipientHash: () => grant()?.recipientHash ?? null,
    holdsLease: () => { try { return input.holdsLease(); } catch { return false; } }, // @silent-fallback-ok — an unreadable lease reads as not held: this machine never sends
    detectCredential: input.detectCredential,
    deliverToTopic,
    relayEnqueue: input.relayEnqueue ? (row, relayId, text) => {
      const topicId = row.fallbackTopicId ?? findJob(row.jobSlug)?.topicId ?? null;
      if (topicId === null || topicId === undefined) return false;
      return input.relayEnqueue!(relayId, topicId, text);
    } : undefined,
    topicOf: (row) => row.fallbackTopicId ?? findJob(row.jobSlug)?.topicId ?? null,
    reservedForReports: () => remainingEmailedJobsToday(input.jobs?.() ?? [], input.now?.() ?? Date.now(), timezone()),
    timezone,
    statusWindowMinutes: () => input.config()?.statusWindowMinutes,
    transportTimeoutSeconds: () => input.config()?.transportTimeoutSeconds,
    fallbackLineEveryMs: () => (input.config()?.fallbackLineEvery === 'hour' ? 60 * 60_000 : undefined),
    onCredentialRefused: input.onCredentialRefused,
    report: input.report,
    now: input.now,
    fetch: input.fetch,
    createSmtpClient: input.createSmtpClient,
    transportFor: input.transportFor,
  });
  return { service, outbox, optIn };
}

export { EMAIL_OUTBOX_STORE_KEY, buildEmailOutboxRecordData };
