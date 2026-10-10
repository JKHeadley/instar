export { canonicalize } from './canonical.js';
export {
  generateWitnessKey,
  keyIdFor,
  publicKeyFromPrivate,
  signBytes,
  verifyBytes,
  type WitnessKeyPair,
} from './keys.js';
export { loadOrCreateWitnessKey, KEY_FILE_NAME } from './keyfile.js';
export {
  CLAIMS,
  DEFAULT_VALIDITY_DAYS,
  MAX_CLOCK_SKEW_MS,
  RECORD_TYPE,
  createRecord,
  createRevocation,
  recordHash,
  validateShape,
  verifyRecord,
  type Claim,
  type CreateRecordInput,
  type UnsignedRecord,
  type VerifyResult,
  type WitnessRecord,
} from './record.js';
export {
  BINDING_REVOCATION_TYPE,
  BINDING_TYPE,
  bindingHash,
  bindingRevocationHash,
  createBinding,
  createBindingRevocation,
  createSuccessorBinding,
  threadlineFingerprint,
  verifyBinding,
  verifyBindingRevocation,
  verifySuccessor,
  type BindingResult,
  type BindingRevocation,
  type KeyBinding,
  type KeyRole,
} from './binding.js';
export { WitnessStore, type AddResult, type RecordStatus } from './store.js';
