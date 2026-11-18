// E2E-PAIRING: EXEMPT — internal admission helpers only; this file mounts no route and production wires no caller (dark).
import type { AcquisitionJob } from '../import/HistoryAcquisition.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import type { Request } from 'express';
import { isBrowserDevice } from '../core/MobileDeviceKeys.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { mobileOwnerDeviceAdmission, revalidateQueuedOwnerAdmissionSnapshot } from './mobileOwnerDeviceAdmission.js';
import { sameMacHost, localBindingOk } from './mobileLocalOwnerDevice.js';
import { pairedLocally } from './mobileTrustApproval.js';

/** Created only after the ordinary signature middleware verifies this request. Never deserialize a caller. */
export class NativeCaptureCaller {
  private constructor(readonly owner:string, readonly machine:string, readonly deviceId:string, readonly keyHash:string,
    readonly isCurrent:() => boolean) {}

  static from(req:Request,pairing:MobilePairingService,machine:string): NativeCaptureCaller | null {
    const admission = mobileOwnerDeviceAdmission(pairing,req);
    if (!admission || !machine || machine === 'local') return null;
    const current = () => {
      const device = pairing.devices.get(admission.deviceId);
      return admission.isCurrent() && !!device && device.status === 'active' && !isBrowserDevice(device)
        && device.deviceKind === 'computer' && pairedLocally(device) && device.approvedVia === 'local-install'
        && device.localBinding?.machineId === machine && !!sameMacHost(req,pairing.deps.config.port)
        && localBindingOk(device,req,machine);
    };
    if (!current()) return null;
    const owner = admission.identity.userId === null ? 'owner:default' : 'profile:'+admission.identity.userId;
    return new NativeCaptureCaller(owner,machine,admission.deviceId,admission.identity.keyHash,current);
  }
}


/** Reverify the original phone or Mac account selection from its durable signed app message. */
export function verifyNativeCaptureStart(app:AppConversationService,pairing:MobilePairingService,job:AcquisitionJob,messageId:string):boolean {
  const record = app.store.getMessageEvent(job.conversation,messageId);
  if (!app.serves(job.conversation) || !record || record.kind!=='message' || record.role!=='operator' || record.senderRole!=='owner'
    || record.messageId!==messageId || record.conversationKey!==job.conversation || !record.origin || !record.receipt
    || app.deps.signer?.machineId()!==job.machine || record.receipt.machineId!==job.machine
    || record.machineId!==app.deps.machineId() || app.verify(record)!=='verified') return false;
  const selection = /^Bring over my personal history from (Claude|ChatGPT) using ([^\s@<>]+@[^\s@<>]+)$/.exec(record.text);
  if (!selection || selection[1].toLowerCase()!==job.provider || selection[2].toLowerCase()!==job.expectedEmail) return false;
  const userId = job.owner==='owner:default' ? null : job.owner.startsWith('profile:') ? job.owner.slice(8) : '';
  if (userId==='' || isBrowserDevice(pairing.devices.get(record.origin.deviceId))) return false;
  return revalidateQueuedOwnerAdmissionSnapshot(pairing,{deviceId:record.origin.deviceId,identity:{userId,role:'owner',keyHash:record.origin.keyHash}}).ok;
}
