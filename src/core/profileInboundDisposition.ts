/** In-process disposition handshake for the exact server-owned inbound object.
 * No JSON body, metadata flag or copied message can mint this receipt.
 */
export type ProfileInboundDisposition = 'profile-control-handled';
interface DispositionState {
  settled: boolean;
  disposition?: ProfileInboundDisposition;
  promise: Promise<ProfileInboundDisposition | undefined>;
  resolve: (value: ProfileInboundDisposition | undefined) => void;
}
const dispositions = new WeakMap<object, DispositionState>();
function state(message: object): DispositionState {
  let entry = dispositions.get(message);
  if (!entry) {
    let resolve!: DispositionState['resolve'];
    const promise = new Promise<ProfileInboundDisposition | undefined>(done => { resolve = done; });
    entry = { settled: false, promise, resolve }; dispositions.set(message, entry);
  }
  return entry;
}
/** Must be prepared before invoking ingress; waits only for profile admission, not session startup. */
export function prepareProfileInboundDisposition(message: object): Promise<ProfileInboundDisposition | undefined> {
  return state(message).promise;
}
export function markProfileControlHandled(message: object): void {
  const entry = state(message); if (entry.settled) return;
  entry.settled = true; entry.disposition = 'profile-control-handled'; entry.resolve(entry.disposition);
}
/** Set immediately after profile ingress declines, before long ordinary routing; also safe in finally. */
export function markProfileControlPassed(message: object): void {
  const entry = state(message); if (entry.settled) return;
  entry.settled = true; entry.resolve(undefined);
}
export function profileInboundDisposition(message: object): ProfileInboundDisposition | undefined {
  return dispositions.get(message)?.disposition;
}
