import { isAppConversationKey } from './appConversationText.js';
import { isAppRemovalReadCustodyRecord, type AppRemovalReadCustody } from './AppRemovalReadCustody.js';

type CreationEvidence =
  | { kind: 'pending' | 'conflict' }
  | { kind: 'verified'; conversationKey: string; eventId: string; authenticatedOrigin: string };

type ImportResult = 'retained' | 'pending' | 'refused' | 'unavailable';
const recordKeys = ['version', 'conversationKey', 'creationEventId', 'custodianMachineId'];

/**
 * Retain one peer enrollment after transport and creation have been independently verified.
 * Both authenticated origins must come from the verifier, never application payload fields.
 * A retained import is positive evidence, but does not prove completeness of the fleet index.
 */
export function retainPeerRemovalReadCustody(input: {
  conversationKey: string;
  authenticatedOrigin: string;
  payload: unknown;
  creation: CreationEvidence;
  local: Pick<AppRemovalReadCustody, 'observe' | 'record'>;
}): ImportResult {
  const { conversationKey, authenticatedOrigin, payload, creation, local } = input;
  if (!isAppConversationKey(conversationKey) || !isAppRemovalReadCustodyRecord(payload, conversationKey)
    || Object.keys(payload).length !== recordKeys.length || !recordKeys.every((key) => Object.hasOwn(payload, key))
    || payload.custodianMachineId !== authenticatedOrigin) return 'refused';
  if (creation.kind !== 'verified') return creation.kind === 'pending' ? 'pending' : 'refused';
  if (creation.conversationKey !== conversationKey || creation.eventId !== payload.creationEventId
    || creation.authenticatedOrigin !== authenticatedOrigin) return 'refused';

  const observed = local.observe(conversationKey);
  if (observed.kind === 'unavailable') return 'unavailable';
  if (observed.kind === 'recorded' && (observed.record.creationEventId !== payload.creationEventId
    || observed.record.custodianMachineId !== authenticatedOrigin)) return 'refused';
  return local.record(conversationKey, { eventId: payload.creationEventId, machineId: authenticatedOrigin }) ? 'retained' : 'unavailable';
}
