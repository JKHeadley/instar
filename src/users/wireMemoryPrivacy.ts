/**
 * wireMemoryPrivacy — connects memory privacy to a running agent.
 * Spec: docs/specs/memory-privacy.md. Called once at boot, from startServer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserProfile } from '../core/types.js';
import type { SessionManager } from '../core/SessionManager.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { claudeMeetsFloor, installBwrapProfile, memorySandboxWorks } from '../core/memorySandboxProbe.js';
import { MemoryInboundTracker } from './MemoryInboundTracker.js';
import { MemoryPrivacy, type MemoryPrivacyConfig, type ReachableLists } from './MemoryPrivacy.js';

/** The oldest Claude Code these session settings were verified on. */
export const MEMORY_PRIVACY_CLAUDE_FLOOR = '2.1.316';

const BASELINE_WAIT_MS = 2 * 60_000;

const REPLY_SCRIPTS = ['telegram-reply.sh', 'slack-reply.sh', 'app-reply.sh', 'whatsapp-reply.sh', 'app-media-path'];

interface MessagingEntry { type: string; config?: Record<string, unknown> }

export interface WireMemoryPrivacyInput {
  projectDir: string;
  stateDir: string;
  projectName: string;
  framework: () => string;
  memoryPrivacy: () => MemoryPrivacyConfig | undefined;
  messaging: () => MessagingEntry[];
  initialUsers?: UserProfile[];
  sessionManager: SessionManager;
  telegramOwnerId?: () => number | null;
  slackBotUserId?: () => string | null;
  slackChannelForSession?: (sessionName: string) => string | null;
  claudePath?: string;
  instarRoot?: string;
  probe?: () => Promise<boolean>;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    // @silent-fallback-ok — the file not existing yet is normal; callers treat it as empty.
    return fallback;
  }
}

export function wireMemoryPrivacy(input: WireMemoryPrivacyInput): {
  privacy: MemoryPrivacy;
  tracker: MemoryInboundTracker;
  users: () => UserProfile[];
  ready: Promise<void>;
} {
  const users = (): UserProfile[] => readJson(path.join(input.stateDir, 'users.json'), input.initialUsers ?? []);
  const entry = (type: string) => input.messaging().find((m) => m.type === type && (m as { enabled?: boolean }).enabled !== false)?.config ?? {};
  const telegramKey = (): string | null => {
    const chatId = entry('telegram').chatId;
    return chatId !== undefined && chatId !== '' ? `telegram:${String(chatId)}` : null;
  };
  const reachable = (): ReachableLists => ({
    slackAuthorizedIds: (entry('slack').authorizedUserIds as string[] | undefined) ?? [],
    slackBotUserId: input.slackBotUserId?.() ?? null,
    telegramAuthorizedIds: (entry('telegram').authorizedUserIds as (number | string)[] | undefined) ?? [],
    whatsappAuthorizedNumbers: (entry('whatsapp').authorizedNumbers as string[] | undefined) ?? [],
    imessageAuthorizedContacts: (entry('imessage').authorizedContacts as string[] | undefined) ?? [],
    mspDeviceUserIds: readJson<{ devices?: Array<{ role?: string; status?: string; userId?: string }> }>(
      path.join(input.stateDir, 'state', 'mobile-devices.json'), {},
    ).devices?.filter((d) => d.role === 'msp' && d.status === 'active' && d.userId).map((d) => d.userId as string) ?? [],
    telegramOwnerId: input.telegramOwnerId?.()
      ?? (entry('telegram').ownerUserId as number | undefined)
      ?? ((entry('telegram').promptGate as { ownerId?: number } | undefined)?.ownerId)
      ?? null,
  });

  const privacy = new MemoryPrivacy({
    stateDir: input.stateDir,
    instarRoot: input.instarRoot ?? path.join(os.homedir(), '.instar'),
    agentId: input.projectName,
    config: () => input.memoryPrivacy() ?? {},
    users,
    reachable,
    telegramGroupKey: () => telegramKey(),
  });

  let sandboxReady = false;
  input.sessionManager.setMemoryPrivacy({
    privacy,
    telegramGroupKey: () => telegramKey(),
    slackChannelForSession: input.slackChannelForSession,
    sandboxReady: () => sandboxReady,
    replyScripts: () => REPLY_SCRIPTS.map((s) => path.join(input.projectDir, '.instar', 'scripts', s)),
  });

  privacy.establishBaseline();
  // Slack may never connect (bad token), and the baseline must not wait forever.
  setTimeout(() => privacy.establishBaseline({ force: true }), BASELINE_WAIT_MS).unref();

  const tracker = new MemoryInboundTracker({
    privacy,
    retireSessions: () => input.sessionManager.retireSessionsForAudienceChange(),
    retireSessionUnlessAudience: (name, audience) => input.sessionManager.retireSessionUnlessAudience(name, audience),
    sandboxReady: () => sandboxReady,
    framework: input.framework,
  });

  const probe = input.probe ?? (async () => (await memorySandboxWorks()) && (await claudeMeetsFloor(input.claudePath, MEMORY_PRIVACY_CLAUDE_FLOOR)));
  const ready = probe().then(async (first) => {
    let works = first;
    if (!works && process.platform === 'linux' && !input.probe) {
      await installBwrapProfile();
      works = await probe();
    }
    sandboxReady = works;
    if (!works) {
      DegradationReporter.getInstance().report({
        feature: 'MemoryPrivacy.sandbox',
        primary: 'Run sessions for people and shared places inside the OS sandbox',
        fallback: 'Those conversations get a fixed reply; nothing runs unprotected',
        reason: 'Why: the sandbox did not start on this machine',
        impact: process.platform === 'linux'
          ? 'Install bubblewrap and socat, and on Ubuntu 24.04 add the bubblewrap AppArmor profile (one root step).'
          : 'This platform has no supported sandbox.',
      });
    }
  });

  return { privacy, tracker, users, ready };
}
