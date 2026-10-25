import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OriginActivationObservation, OriginEnrollmentSnapshot } from './OriginActivation.js';
import type { TelegramOriginRuntime } from './TelegramOriginRuntime.js';
import { originToolGuardHook, originToolGuardDigest } from './OriginToolGuard.js';
import { originBotEgressStatus } from './OriginBotEgress.js';
import { tokenHash } from '../../lifeline/TelegramPollOwnerLease.js';
import { originHookSettingsDigest } from './OriginNativeHookProof.js';

async function boundedFile(file: string): Promise<string | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('origin-installation-file-bound');
    return bytes.toString('utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Inspect installed artifacts, not only the source tree that can generate them.
 * Unobserved obligations are deliberately left missing for the conjunction. */
export async function inspectOriginInstallation(input: {
  runtime: TelegramOriginRuntime; projectDir: string; stateDir: string;
  sessions?: Array<{ sessionId: string; harnessId: string | null }>;
  automationOnly: boolean;
  storageHealthy: boolean;
  additionalObservations?: OriginActivationObservation[];
}): Promise<OriginEnrollmentSnapshot> {
  const now = Date.now(), observations: OriginActivationObservation[] = [];
  const add = (obligation: OriginActivationObservation['obligation'], subject: string,
    state: OriginActivationObservation['state'], reason: string) => observations.push({ obligation, subject, state, reason, observedAt: now, validUntil: now + 30_000 });
  add('storage-readers', 'canonical-outbox', input.storageHealthy ? 'ready' : 'unknown', input.storageHealthy ? 'durable-health-transaction' : 'storage-unavailable');
  const egress = originBotEgressStatus();
  add('bot-writers', 'in-process-egress', egress.active ? 'ready' : 'held', egress.active ? 'prepared-egress-installed' : 'legacy-egress-open');
  const requiresSendPolicy = !input.automationOnly || input.runtime.browsers.size > 0 || !!input.sessions?.length;
  const policy = input.runtime.service?.options.sendPolicy;
  const policyAttached = typeof policy?.review === 'function' && typeof policy?.authorizeDispatch === 'function' &&
    typeof policy.reserveContent === 'function' && typeof policy.completeContent === 'function';
  add('send-policy', 'covered-writers', requiresSendPolicy ? policyAttached ? 'ready' : 'held' : 'not-applicable',
    requiresSendPolicy ? policyAttached ? 'send-policy-authority-attached' : 'send-policy-authority-unavailable' : 'automation-only-process');
  const bindings = new Map(input.runtime.sessions.listBindings().map(binding => [binding.sessionId, binding]));
  if (input.automationOnly) add('sessions', 'this-process', 'not-applicable', 'automation-only-process');
  else if (!input.sessions) add('sessions', 'inventory', 'unknown', 'live-session-inventory-unavailable');
  else if (input.sessions.length > 1000) add('sessions', 'inventory', 'held', 'live-session-inventory-bound');
  else if (!input.sessions.length) add('sessions', 'this-process', 'ready', 'no-running-sessions');
  else for (const session of input.sessions) {
    const binding = bindings.get(session.sessionId);
    const ready = binding && binding.harnessId === session.harnessId && input.runtime.options.isSessionLive?.(binding) === true;
    add('sessions', session.sessionId, ready ? 'ready' : 'held', ready ? 'current-live-preparation-binding' : 'session-enrollment-required');
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const [expectedReply, reply, legacyReply, guard, claude, codex, profiles, lifelineLock, lifelineLease, configFile] = await Promise.all([
    boundedFile(path.join(root, 'src/templates/scripts/telegram-reply.sh')),
    boundedFile(path.join(input.stateDir, 'scripts/telegram-reply.sh')),
    boundedFile(path.join(input.projectDir, '.claude/scripts/telegram-reply.sh')),
    boundedFile(path.join(input.stateDir, 'hooks/instar/telegram-origin-guard.js')),
    boundedFile(path.join(input.projectDir, '.claude/settings.json')),
    boundedFile(path.join(input.projectDir, '.codex/hooks.json')),
    boundedFile(path.join(input.stateDir, 'state/playwright-profiles.json')),
    boundedFile(path.join(input.stateDir, 'lifeline.lock')),
    boundedFile(path.join(input.stateDir, 'telegram-poll-owner.json')),
    boundedFile(path.join(input.stateDir, 'config.json')),
  ]);
  try {
    const lock = lifelineLock ? JSON.parse(lifelineLock) : null, lease = lifelineLease ? JSON.parse(lifelineLease) : null;
    if (lock != null && !Number.isSafeInteger(lock.pid) || lease != null && !Number.isSafeInteger(lease.pid)) throw new Error('invalid lifeline inventory');
    const pid = lock?.pid ?? lease?.pid;
    let alive = false;
    if (pid != null) {
      if (pid <= 0) throw new Error('invalid lifeline process');
      try { process.kill(pid, 0); alive = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    if (!alive) add('lifeline', 'process', 'not-applicable', 'no-live-lifeline-process');
    else {
      const ready = lease?.pid === pid && lease.originProtocol === 'instar-telegram-origin-v1' &&
        Number.isSafeInteger(lease.heartbeatTs) && lease.heartbeatTs <= now && now - lease.heartbeatTs <= 30_000 &&
        input.runtime.options.bot.token && lease.tokenHash === tokenHash(input.runtime.options.bot.token);
      add('lifeline', 'process', ready ? 'ready' : 'held', ready ? 'current-compatible-writer-lease' : 'live-lifeline-writer-not-enrolled');
      if (ready) observations[observations.length - 1].validUntil = lease.heartbeatTs + 30_000;
    }
  } catch { add('lifeline', 'process', 'unknown', 'lifeline-process-inventory-unavailable'); }
  for (const [subject, installed] of [['neutral-relay', reply], ['claude-relay', legacyReply]] as const) {
    add('installed-scripts', subject, expectedReply && installed === expectedReply ? 'ready' : 'held',
      expectedReply && installed === expectedReply ? 'shipped-relay-byte-match' : 'relay-refresh-or-customization-review-required');
  }
  const harnesses = new Set(input.sessions?.map(session => session.harnessId).filter((id): id is string => !!id) ?? []);
  try {
    if (!configFile) throw new Error('framework inventory unavailable');
    const config = JSON.parse(configFile), configured = config.enabledFrameworks ?? ['claude-code'];
    if (!Array.isArray(configured) || configured.length > 16 || configured.some(id => typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id))) throw new Error('invalid framework inventory');
    for (const framework of configured.length ? configured : ['claude-code']) harnesses.add(framework);
  } catch { add('tool-guards', 'configured-inventory', 'unknown', 'enabled-framework-inventory-unavailable'); }
  for (const harness of harnesses) {
    let enrolled = false;
    try {
      const settings = harness === 'claude-code' ? claude : harness === 'codex-cli' ? codex : null;
      const parsed = settings ? JSON.parse(settings) : null;
      const groups = parsed?.hooks?.PreToolUse;
      const expected = path.join(input.stateDir, 'hooks/instar/telegram-origin-guard.js');
      enrolled = parsed?.disableAllHooks !== true && guard === originToolGuardHook() && Array.isArray(groups) && groups.some(group =>
        group.matcher === (harness === 'codex-cli' ? '.*' : '*') && Array.isArray(group.hooks) && group.hooks.some((hook: { command?: string }) =>
          typeof hook.command === 'string' && (hook.command.includes(expected) || hook.command.includes('.instar/hooks/instar/telegram-origin-guard.js'))));
    } catch { /* Corrupt/missing hook settings are not enrollment. */ }
    add('tool-guards', harness, enrolled ? 'ready' : 'held', enrolled ? 'current-hook-and-wildcard-installation' : 'harness-tool-guard-enrollment-required');
    const live = input.sessions?.filter(session => session.harnessId === harness);
    const settings = harness === 'claude-code' ? claude : harness === 'codex-cli' ? codex : null;
    const launchSettingsCurrent = !!settings && !!live?.length && live.every(session =>
      bindings.get(session.sessionId)?.launchHookSettingsDigest === originHookSettingsDigest(settings));
    const expectedPath = path.join(input.stateDir, 'hooks/instar/telegram-origin-guard.js');
    const commands = new Set([`node ${expectedPath}`, `node "${expectedPath}"`, `node '${expectedPath}'`,
      'node .instar/hooks/instar/telegram-origin-guard.js']);
    let proved = enrolled && launchSettingsCurrent;
    try {
      proved = proved && live!.every(session => {
        const proof = input.runtime.observer?.getNativeHookProof(session.sessionId);
        return proof && commands.has(proof.command) && input.runtime.sessions.verifyNativeHookProof(session.sessionId, proof, originToolGuardDigest());
      });
    } catch { proved = false; }
    const idle = enrolled && live?.length === 0;
    add('tool-guards', `${harness}:native-enforcement`, !enrolled ? 'held' : idle ? 'not-applicable' : proved ? 'ready' : 'unknown',
      !enrolled ? 'native-hook-enforcement-unavailable' : idle ? 'no-running-harness-incarnations' :
        proved ? 'native-hook-result-and-incarnation-challenge' : !launchSettingsCurrent ? 'native-hook-settings-load-unverified-requires-restart' : 'native-hook-incarnation-proof-unavailable');
  }
  if (!harnesses.size && input.sessions) add('tool-guards', 'running-sessions', 'not-applicable', 'no-running-harnesses');
  try {
    const parsed = profiles ? JSON.parse(profiles) : null;
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error('profile inventory unavailable');
    const telegram = parsed.profiles.filter((profile: { accounts?: Array<{ service?: string }> }) => profile.accounts?.some(account => account.service?.toLowerCase() === 'telegram'));
    if (!telegram.length) add('browser-profiles', 'inventory', 'not-applicable', 'no-agent-telegram-profiles');
    for (const profile of telegram) {
      const broker = input.runtime.browsers.get(profile.id)?.executor.broker.readStatus();
      const ready = profile.executionOwner === 'telegram-origin-broker' && profile.telegramBroker?.exclusiveEnrollment &&
        typeof broker?.canaryObservedAt === 'number' && broker.canaryObservedAt <= now && now - broker.canaryObservedAt <= 30_000 &&
        broker.canary?.supported && broker.canary.accountId === profile.telegramBroker.accountId && !broker.closed && !broker.held;
      add('browser-profiles', profile.id, ready ? 'ready' : 'held', ready ? 'exclusive-profile-and-authenticated-canary' : 'exclusive-browser-enrollment-and-live-canary-required');
      if (ready) { observations[observations.length - 1].observedAt = broker!.canaryObservedAt!; observations[observations.length - 1].validUntil = broker!.canaryObservedAt! + 30_000; }
    }
  } catch { add('browser-profiles', 'inventory', 'unknown', 'browser-profile-inventory-unavailable'); }
  try {
    const destinations = input.runtime.options.alertDestinations();
    if (!Array.isArray(destinations) || destinations.length > 1000) throw new Error('notice destination inventory bound');
    if (!destinations.length) add('notice-policy', 'operator-alert-destinations', 'unknown', 'notice-destination-or-policy-unavailable');
    for (const destination of destinations) {
      const policy = input.runtime.options.getAlertPolicy(destination.id);
      const complete = policy && policy.alertDestinationId === destination.id && policy.observerHealthy === true &&
        policy.clientPreferences === 'telegram-managed' && ['authorized', 'ownershipValid', 'optedOut'].every(key => typeof policy[key as keyof typeof policy] === 'boolean') &&
        policy.destination?.accountId === input.runtime.options.bot.accountId && policy.destination.chatId === destination.chatId && policy.destination.topicId === destination.topicId &&
        Number.isSafeInteger(policy.observedAt) && Number.isSafeInteger(policy.validUntil) && policy.observedAt <= now && now - policy.observedAt <= 30_000 &&
        policy.validUntil > now && policy.validUntil - policy.observedAt <= 30_000;
      add('notice-policy', destination.id, complete ? 'ready' : 'unknown', complete ? 'independent-current-notice-policy' : 'notice-destination-policy-unavailable');
      if (complete) {
        observations[observations.length - 1].observedAt = policy.observedAt;
        observations[observations.length - 1].validUntil = policy.validUntil;
      }
    }
  } catch { add('notice-policy', 'observer', 'unknown', 'notice-policy-observer-unavailable'); }
  observations.push(...input.additionalObservations ?? []);
  // A local installed-file inspection alone cannot certify the independent
  // process/peer and sender census. Their observations must accompany it.
  const inventoryComplete = ['lifeline', 'peers', 'sender-census'].every(obligation => observations.some(item =>
    item.obligation === obligation && ['ready', 'not-applicable'].includes(item.state)));
  return { inventoryComplete, observations };
}
