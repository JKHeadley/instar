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
  BINDING_TYPE,
  createBinding,
  threadlineFingerprint,
  verifyBinding,
  type BindingResult,
  type KeyBinding,
} from './binding.js';
export { WitnessStore, type AddResult, type KeyResolver, type RecordStatus } from './store.js';
