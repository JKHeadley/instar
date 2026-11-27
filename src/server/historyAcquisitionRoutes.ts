import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { derivedEventId, isAppConversationKey } from '../core/appConversationText.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { deviceKeyOf, isBrowserDevice } from '../core/MobileDeviceKeys.js';
import { ImportWriterBusy } from '../import/ImportedHistoryStore.js';
import type { AcquisitionJob, OwnerChat, Provider } from '../import/HistoryAcquisition.js';
import type { AcquisitionNotice, HistoryAcquisitionWorker } from '../import/HistoryAcquisitionWorker.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { mobileOwnerDeviceAdmission, revalidateQueuedOwnerAdmissionSnapshot } from './mobileOwnerDeviceAdmission.js';

const capabilities = '/mobile/imported-history/capabilities';
const ownerKey = (id: string | null) => id === null ? 'owner:default' : 'profile:' + id;
const providerName = (p: Provider) => p === 'claude' ? 'Claude' : 'ChatGPT';
const starter = /^Bring over my personal history from (Claude|ChatGPT)(?: using ([^\s@<>]+@[^\s@<>]+))?$/;
const approval = /^Copy preview ([a-f0-9]{12})$/;
const actions = new Map([
  ['Check my history import', 'status'], ['Resume my history import', 'resume'],
  ['Preview my history import', 'preview'], ['Cancel my history import', 'cancel'],
]);
const phases: Record<AcquisitionJob['phase'], string> = {
  ready: 'The export request is ready for the provider.',
  submitting: 'I’m checking whether the provider received the request. I’ll check before another request can be made.',
  waiting: 'The provider accepted the request. I’m waiting for the export.',
  review: 'Your history is ready to review. Reply “Preview my history import” to see what would be copied.',
  applying: 'The copy is being reconciled. Check this conversation for its outcome.',
  cancelled: 'The import was cancelled.', expired: 'The export expired. You can request a fresh one.',
  complete: 'Your history was copied to this machine.',
};
const terminal = new Set(['cancelled','expired','complete']);
const next = 'You can reply “Check my history import”, “Resume my history import” or “Cancel my history import”.';
type Worker = Pick<HistoryAcquisitionWorker, 'providers'|'accounts'|'start'|'status'|'latest'|'step'|'preview'|'apply'|'cancel'>;
type Answer = 'ignored'|'refused'|'handled';
type Challenge = { id: string; token: string; code: string; previewMessage: string; expires: number };

const attention: Record<string,string> = {
  'mail-access': 'Grant access to the export delivery message on this machine, then resume the import.',
  'ambiguous-notice': 'Choose the export message for this personal account in the connected mailbox, then resume.',
  'open-message': 'Open the provider’s export message in the connected mailbox, then resume.',
  'verify-account': 'Switch the dedicated browser to the selected personal account and workspace, then resume.',
  'provider-sign-in': 'Sign in to the selected personal account in its dedicated browser, then resume.',
  'browser-unavailable': 'Open the dedicated browser on this machine, then resume.',
  'page-unverified': 'Open the selected account’s personal export settings in its dedicated browser, then resume.',
  'browser-in-use': 'Another export is using the dedicated browser. Resume when it finishes.',
  'existing-request': 'The provider shows an existing request. Check its status in your personal account before resuming.',
  expired: 'The provider’s delivery link expired. Cancel this import and start a new request for a fresh export.',
  'invalid-archive': 'The received file could not be read as an export from the selected account and provider. Check the account before starting a new import.',
  'wrong-export-provider': 'The archive came from a different provider. Cancel this import and request an export from the selected personal account.',
  'size-limit': 'The archive is too large for this machine’s importer. Cancel the import to discard this attempt.',
  'untrusted-notice': 'The message could not be verified as an export for this account. Check the selected mailbox and wait for the provider’s export message.',
  'unsupported-link': 'The delivery link could not be verified for this provider. Check the account’s official export message before resuming.',
  timeout: 'The provider timed out. Resume to check for the export again.',
  unavailable: 'The export service is unavailable. Resume to check again.',
};
function describe(out: {phase: AcquisitionJob['phase']; attention?: string; noticeDelivery?: 'exhausted'}): string {
  const help = out.attention ? attention[out.attention] ?? 'Check the connected account and export delivery permission on this machine, then resume.' : '';
  const missed = out.noticeDelivery === 'exhausted' ? 'An automatic update could not be confirmed. You can still check progress here.' : '';
  return [phases[out.phase], help, missed, terminal.has(out.phase) ? '' : next].filter(Boolean).join(' ');
}

/** The signed chat is the sole mutation surface. The GET only discovers bootstrap-proven providers. */
export class HistoryAcquisitionChat {
  private readonly challenges = new Map<string, Challenge>();
  constructor(private readonly pairing: MobilePairingService, private readonly app: AppConversationService | null,
    private readonly worker: Worker | null) {}

  private admission(req: Request) {
    const admission = mobileOwnerDeviceAdmission(this.pairing, req);
    if (!admission || isBrowserDevice(this.pairing.devices.get(admission.deviceId))) return null;
    return admission;
  }

  private machine(): string | undefined { return this.app?.deps.signer?.machineId(); }

  router(): Router {
    const router = Router();
    router.get(capabilities, (req, res) => {
      res.set('Cache-Control','no-store');
      const admission = this.admission(req);
      if (!admission) { res.status(403).json({error:'owner-device-required'}); return; }
      const machine = this.machine();
      let providers: Provider[] = [];
      try {
        const owner = ownerKey(admission.identity.userId);
        if (this.worker && machine && this.hasPrivateOwner(owner)) providers = this.worker.providers(owner, machine);
      } catch { /* Missing provider proof always leaves the action unavailable. */ }
      res.json({acquisition:{version:1,providers}});
    });
    return router;
  }

  private hasPrivateOwner(owner: string): boolean {
    if (Object.values(this.pairing.grants.all()).some(g => g.ownerConversations)) return false;
    let hasNativeOwner = false;
    for (const device of this.pairing.devices.list()) {
      const key = deviceKeyOf(device);
      if (!key || device.status !== 'active' || (device.role ?? 'owner') !== 'owner') continue;
      const userId = device.userId ?? null;
      const current = revalidateQueuedOwnerAdmissionSnapshot(this.pairing, {
        deviceId:device.id, identity:{userId,role:'owner',keyHash:deviceKeyHashOf(key)},
      });
      if (!current.ok) continue;
      // The normal app ACL lets every owner-role device read all owner-created chats. Two
      // distinct operator profiles cannot privately review one person's export in that chat.
      if (ownerKey(userId) !== owner) return false;
      if (!isBrowserDevice(device)) hasNativeOwner = true;
    }
    return hasNativeOwner;
  }

  /** Checked at dispatch, during provider work, and directly before appending any result. */
  authorized(chat: OwnerChat): boolean {
    const app = this.app;
    try {
      if (!app || !isAppConversationKey(chat.conversation) || this.machine() !== chat.machine || !app.serves(chat.conversation)) return false;
      const conversation = app.store.getConversation(chat.conversation);
      if (!conversation || conversation.tombstoned || conversation.ownerPerson || !conversation.createdAt) return false;
      const team = this.pairing.teamLog();
      const ref = chat.conversation; // MobilePeople normalizes an app reference to the bare conversation UUID.
      if (!team || team.healthState() === 'unreadable' || team.gaps().length || team.ownerOf(ref) || team.isConfined(ref) !== false
        || (this.pairing.teamOn() && this.pairing.teamRefusal() !== null)) return false;
      for (const grants of team.state().grants.values()) if (grants.has(ref)) return false;
      return this.hasPrivateOwner(chat.owner);
    } catch { return false; } // Fail closed when the conversation or its authority cannot be read.
  }

  publish(notice: AcquisitionNotice): void { this.append(notice.chat, 'notice-' + notice.noticeId, notice.text); }

  private append(chat: OwnerChat, seed: string, text: string): void {
    if (!this.authorized(chat)) throw new Error('private-owner-chat-required');
    const app = this.app!;
    const key = chat.conversation;
    const messageId = derivedEventId('am', key, 'history-acquisition', seed);
    if (app.store.getMessageEvent(key, messageId)) return;
    app.store.append({kind:'message',role:'agent',conversationKey:key,machineId:app.deps.machineId(),at:new Date().toISOString(),
      messageId,eventId:derivedEventId('reply', key, 'history-acquisition', seed),text});
    app.onAgentReplyAppended(key,messageId);
  }

  async handle(req: Request, key: string, messageId: string, text: string): Promise<Answer> {
    const begin = starter.exec(text);
    const confirm = approval.exec(text);
    const action = actions.get(text);
    if (!begin && !confirm && !action) return 'ignored';
    const admission = this.admission(req);
    const app = this.app;
    const machine = this.machine();
    if (!app || !admission || !machine) return 'refused';
    const chat: OwnerChat = {owner:ownerKey(admission.identity.userId),machine,conversation:key};
    const record = app.store.getMessageEvent(key, messageId);
    const signedBody = (req as Request & {rawBody?: Buffer}).rawBody;
    if (!this.authorized(chat) || record?.kind !== 'message' || record.conversationKey !== key || record.messageId !== messageId
      || record.role !== 'operator' || record.senderRole !== 'owner' || !signedBody || record.origin?.bodyB64 !== signedBody.toString('base64')
      || record.text !== text || record.origin?.deviceId !== admission.deviceId || record.origin.keyHash !== admission.identity.keyHash
      || record.machineId !== app.deps.machineId() || record.receipt?.machineId !== machine || app.verify(record) !== 'verified') return 'refused';
    const previous = app.store.getMessageEvent(key, derivedEventId('am', key, 'history-acquisition', messageId));
    if (previous?.kind === 'message' && previous.role === 'agent') return 'handled';
    const worker = this.worker;
    const reply = (answer: string): Answer => {
      if (!admission.isCurrent()) return 'refused';
      this.append(chat, messageId, answer);
      return 'handled';
    };
    if (!worker) return reply('Automatic history import is unavailable on this machine. You can still use an existing export file.');
    const scope = JSON.stringify(chat);
    try {
      const last = worker.latest(chat);
      if (begin) {
        const provider = begin[1].toLowerCase() as Provider;
        if (last && !terminal.has(last.phase)) {
          return reply('Your current import is for ' + providerName(last.provider) + ', personal workspace, ' + last.expectedEmail + '. '
            + describe(worker.status(chat,last.id)));
        }
        const accounts = worker.accounts(chat,provider);
        if (!accounts.length) return reply('This provider has no connected personal account available on this machine.');
        const name = providerName(provider);
        if (!begin[2]) {
          return reply('Choose the personal account whose history you want to request. Reply with one of these messages:\n'
            + accounts.map(a => 'Bring over my personal history from ' + name + ' using ' + a.expectedEmail).join('\n'));
        }
        const account = accounts.find(a => a.expectedEmail.toLowerCase() === begin[2].toLowerCase());
        if (!account) return reply('That personal account is unavailable on this machine. Choose the provider again to see its connected accounts.');
        return reply(describe(await worker.start(chat,provider,account.expectedEmail,messageId)));
      }
      if (!last) return reply('There is no history import in this conversation.');
      if (confirm) {
        const challenge = this.challenges.get(scope);
        if (!challenge || challenge.expires <= Date.now() || challenge.id !== last.id || challenge.code !== confirm[1]
          || challenge.previewMessage === messageId || last.phase !== 'review') return reply('Open a fresh preview with “Preview my history import”.');
        this.challenges.delete(scope);
        try {
          const copied = await worker.apply(chat,last.id,challenge.token);
          return reply('Copied ' + copied.messagesAdded + (copied.messagesAdded === 1 ? ' message.' : ' messages.') + ' You can open the imported history on this machine.');
        } catch (error) {
          // A writer lock is refused before the worker consumes approval. Concurrent submissions see
          // the removed challenge. A newer preview, cancellation or timeout always wins over a retry.
          if (!(error instanceof ImportWriterBusy)) throw error;
          const current = worker.latest(chat);
          if (current?.id !== last.id || current.phase !== 'review' || challenge.expires <= Date.now()
            || this.challenges.has(scope)) return reply('Open a fresh preview with “Preview my history import”.');
          this.challenges.set(scope,challenge);
          return reply('Another import is copying history on this machine. When it finishes, send this line again:\nCopy preview ' + challenge.code);
        }
      }
      if (action === 'cancel') {
        this.challenges.delete(scope);
        return reply(worker.cancel(chat,last.id) ? phases.cancelled : describe(worker.status(chat,last.id)));
      }
      if (action === 'preview' && last.phase === 'review') {
        const {preview,confirmation} = await worker.preview(chat,last.id);
        const code = randomBytes(6).toString('hex');
        const now = Date.now();
        for (const [key, value] of this.challenges) if (value.expires <= now) this.challenges.delete(key);
        this.challenges.set(scope,{id:last.id,token:confirmation,code,previewMessage:messageId,expires:now+30*60_000});
        return reply(providerName(last.provider) + ' personal workspace, ' + last.expectedEmail + '. ' + preview.summary
          + ' To confirm, copy and send this line:\nCopy preview ' + code);
      }
      return reply(describe(action === 'resume' ? await worker.step(chat,last.id) : worker.status(chat,last.id)));
    } catch {
      if (!admission.isCurrent() || !this.authorized(chat)) return 'refused';
      return reply('I couldn’t confirm that step. Reply “Check my history import” to check its status, or “Preview my history import” for a fresh preview.');
    }
  }
}
