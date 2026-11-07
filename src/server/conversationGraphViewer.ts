/** Only the existing owner authorities may read the hierarchy. Ordinary agent
 * bearer access and notification tokens never become a human owner proof.
 * Spec: conversation-effort-hierarchy-v3 §7.1, §7.4.
 */
import type {Request} from 'express';
import {canonicalHash} from '../core/GraphWitnessTypes.js';
import {validateNodeRef} from '../core/conversationGraph.js';
import type {GraphViewer} from '../core/conversationGraphRead.js';
import type {MobilePairingService} from './mobilePairingRoutes.js';
import {mobileOwnerDeviceAdmission} from './mobileOwnerDeviceAdmission.js';

export function createConversationGraphViewerResolver(options:{agentId:string;pairing:MobilePairingService|null;
 verifyDashboardOwner(token:string|undefined):boolean}) {
  return (req:Request,surface:'dashboard'|'mobile'):GraphViewer|null=>{
    if(surface==='dashboard'){
      const token=req.get('X-Instar-Operator-Session');
      if(!token||!options.verifyDashboardOwner(token))return null;
      return {principalKey:`owner:${options.agentId}`,grantVersion:canonicalHash({surface,token}),
        hasFullCorrectionScope:()=>options.verifyDashboardOwner(token),
        mayView:ref=>options.verifyDashboardOwner(token)&&validateNodeRef(ref)!==null};
    }
    if(!options.pairing)return null;
    const admission=mobileOwnerDeviceAdmission(options.pairing,req);if(!admission)return null;
    // The helper retains the ACTUAL signature-verifier key/person snapshot.
    // A registry lookup at routing time must never replace that baseline.
    const grantVersion=canonicalHash({surface,deviceId:admission.deviceId,identity:admission.identity});
    return {principalKey:`owner:${options.agentId}`,grantVersion,
      hasFullCorrectionScope:()=>admission.isCurrent(),
      mayView:ref=>admission.isCurrent()&&validateNodeRef(ref)!==null};
  };
}
