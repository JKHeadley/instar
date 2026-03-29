/**
 * iMessage messaging adapter — entry point and registry registration.
 */
export { IMessageAdapter } from './IMessageAdapter.js';
export { IMessageRpcClient } from './IMessageRpcClient.js';
export { NativeBackend } from './NativeBackend.js';
// Register with the adapter registry at module load time
import { registerAdapter } from '../AdapterRegistry.js';
import { IMessageAdapter } from './IMessageAdapter.js';
registerAdapter('imessage', IMessageAdapter);
//# sourceMappingURL=index.js.map