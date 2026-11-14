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
import { writeConfigAtomic } from '../core/BootSelfKnowledge.js';
import {
  claudeMeetsFloor, findClaudeAtFloor, installBwrapProfile, installSandboxPackages, knownClaudePaths,
  memorySandboxWorks, readClaudeVersion, type MemorySandboxBlocker,
} from '../core/memorySandboxProbe.js';
import { MemoryInboundTracker } from './MemoryInboundTracker.js';
import { memoryFixText, MemoryPrivacyRecovery, type RecoveryFacts } from './MemoryPrivacyRecovery.js';
import { MemoryPrivacy, type MemoryPrivacyConfig, type ReachableLists } from './MemoryPrivacy.js';
import { ReachablePeople, type PhoneFact } from './ReachablePeople.js';
import { TeamConfinement } from './TeamConfinement.js';

/** The oldest Claude Code these session settings were verified on. */
export const MEMORY_PRIVACY_CLAUDE_FLOOR = '2.1.316';

const BASELINE_WAIT_MS = 2 * 60_000;

const REPLY_SCRIPTS = ['telegram-reply.sh', 'slack-reply.sh', 'app-reply.sh', 'whatsapp-reply.sh', 'app-media-path', 'threadline-reply.sh'];

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
  /** Other places to look for a Claude binary at the floor. Defaults to the usual ones. */
  claudeCandidates?: string[];
  /** The address of a path on this server, for the owner's link. */
  linkFor?: (urlPath: string) => string | null;
  /** The owner's display name, for the People read. */
  ownerName?: () => string;
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
  recovery: MemoryPrivacyRecovery;
  sandboxReady: () => boolean;
  reachablePeople: ReachablePeople;
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
    ).devices?.filter((d) => (d.role === 'msp' || d.role === 'team') && d.status === 'active' && d.userId).map((d) => d.userId as string) ?? [],
    telegramOwnerId: input.telegramOwnerId?.()
      ?? (entry('telegram').ownerUserId as number | undefined)
      ?? ((entry('telegram').promptGate as { ownerId?: number } | undefined)?.ownerId)
      ?? null,
  });

  const privacy = new MemoryPrivacy({
    stateDir: input.stateDir,
    instarRoot: input.instarRoot ?? path.join(os.homedir(), '.instar'),
    agentId: input.projectName,
    // Off unless asked for. An agent must never be restricted by an update, including
    // the first boot before its migration has reached this in-memory config.
    config: () => {
      const memoryConfig = input.memoryPrivacy() ?? {};
      return { ...memoryConfig, enabled: memoryConfig.enabled === true };
    },
    users,
    reachable,
    telegramGroupKey: () => telegramKey(),
  });

  // Who can reach the agent, kept whatever the privacy setting (team-roles-and-access §3.10).
  const reachablePeople = new ReachablePeople({
    stateDir: input.stateDir,
    users,
    reachable,
    sharedMemoryPeople: () => input.memoryPrivacy()?.sharedMemoryPeople ?? [],
    privacyOn: () => privacy.enabled,
    ownerUserId: () => privacy.ownerUserId(),
    ownerName: () => input.ownerName?.() ?? '',
    phones: () => (readJson<{ devices?: Array<{ role?: string; status?: string; userId?: string; deviceName?: string; label?: string; personName?: string }> }>(
      path.join(input.stateDir, 'state', 'mobile-devices.json'), {},
    ).devices ?? []).filter((d) => d.status === 'active').map((d): PhoneFact => {
      const person = d.userId ? users().find((u) => u.id === d.userId) : undefined;
      return {
        userId: d.userId ?? null, role: d.role === 'msp' || d.role === 'team' ? d.role : 'owner',
        name: person?.name ?? d.personName ?? d.userId ?? 'Unknown person',
        deviceName: d.label || d.deviceName || 'Phone',
      };
    }),
  });

  const confinement = new TeamConfinement(input.stateDir);
  privacy.confinement = confinement;

  let sandboxReady = false;
  let claudePath = input.claudePath;
  let blockerFacts: RecoveryFacts | null = null;
  input.sessionManager.setMemoryPrivacy({
    privacy,
    confinement,
    telegramGroupKey: () => telegramKey(),
    slackChannelForSession: input.slackChannelForSession,
    sandboxReady: () => sandboxReady,
    blocker: () => blockerFacts?.blocker ?? null,
    fix: () => (blockerFacts ? memoryFixText(blockerFacts) : null),
    recovery: () => recovery,
    replyScripts: () => REPLY_SCRIPTS.map((s) => path.join(input.projectDir, '.instar', 'scripts', s)),
  });

  privacy.establishBaseline();
  // Slack may never connect (bad token), and the baseline must not wait forever.
  setTimeout(() => privacy.establishBaseline({ force: true }), BASELINE_WAIT_MS).unref();

  const findBlocker = async (): Promise<MemorySandboxBlocker | null> => {
    if (input.probe) return (await input.probe()) ? null : 'sandbox';
    if (!(await memorySandboxWorks())) return 'sandbox';
    if (await claudeMeetsFloor(claudePath, MEMORY_PRIVACY_CLAUDE_FLOOR)) return null;
    return (await readClaudeVersion(claudePath)) ? 'claude-too-old' : 'claude-missing';
  };

  const assess = async (): Promise<void> => {
    let blocker = await findBlocker();
    if (blocker === 'sandbox' && process.platform === 'linux' && !input.probe) {
      await installSandboxPackages();
      await installBwrapProfile();
      blocker = await findBlocker();
    }
    sandboxReady = blocker === null;
    if (blocker === null) { blockerFacts = null; return; }
    const elsewhere = (input.claudeCandidates ?? knownClaudePaths(os.homedir())).filter((p) => p !== claudePath);
    blockerFacts = {
      blocker,
      platform: process.platform,
      floor: MEMORY_PRIVACY_CLAUDE_FLOOR,
      haveVersion: await readClaudeVersion(claudePath),
      candidate: blocker === 'sandbox' ? null : await findClaudeAtFloor(elsewhere, MEMORY_PRIVACY_CLAUDE_FLOOR),
    };
  };

  const recovery = new MemoryPrivacyRecovery({
    facts: () => blockerFacts,
    linkFor: (urlPath) => input.linkFor?.(urlPath) ?? null,
    repair: async () => {
      const chosen = blockerFacts?.candidate;
      // Measured again here: the binary may have changed since boot.
      if (!chosen || !(await claudeMeetsFloor(chosen, MEMORY_PRIVACY_CLAUDE_FLOOR))) {
        await assess();
        return false;
      }
      writeConfigAtomic(path.join(input.projectDir, '.instar', 'config.json'), (cfg) => {
        const sessions = (cfg.sessions ??= {}) as { claudePath?: string; frameworkBinaryPaths?: Record<string, string> };
        sessions.claudePath = chosen;
        if (sessions.frameworkBinaryPaths?.['claude-code']) sessions.frameworkBinaryPaths['claude-code'] = chosen;
        return { value: chosen };
      });
      claudePath = chosen;
      input.sessionManager.setClaudeBinary(chosen);
      await assess();
      return sandboxReady;
    },
  });

  const tracker = new MemoryInboundTracker({
    privacy,
    retireSessions: () => input.sessionManager.retireSessionsForAudienceChange(),
    retireSessionUnlessAudience: (name, audience) => input.sessionManager.retireSessionUnlessAudience(name, audience),
    sandboxReady: () => sandboxReady,
    framework: input.framework,
    recovery,
    onSender: (senderKey) => {
      try { reachablePeople.observeSender(senderKey); } catch (err) {
        // @silent-fallback-ok — the People read loses one sender; a message must never depend on it.
        console.warn(`[reachable-people] ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // With it off there is nothing to protect: no probe, no install, no report. Turning it
  // on takes a restart, which runs this.
  const ready = !privacy.enabled ? Promise.resolve() : assess().then(() => {
    if (!blockerFacts) return;
    DegradationReporter.getInstance().report({
      feature: 'MemoryPrivacy.sandbox',
      primary: 'Run sessions for people and shared places inside the OS sandbox',
      fallback: 'Those conversations get a fixed reply; nothing runs unprotected',
      reason: `Why: ${blockerFacts.blocker}`,
      // This report can leave the machine, so it carries no paths.
      impact: `Everyone but the owner in private chats gets a fixed reply instead of an answer. ${memoryFixText(blockerFacts, true)}`,
    });
  });

  return { privacy, tracker, users, ready, recovery, reachablePeople, sandboxReady: () => sandboxReady };
}
