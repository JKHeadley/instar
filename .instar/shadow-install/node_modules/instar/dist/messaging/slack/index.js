/**
 * Slack messaging adapter — entry point and registry registration.
 */
export { SlackAdapter } from './SlackAdapter.js';
export { SlackApiClient, SlackApiError } from './SlackApiClient.js';
export { SocketModeClient } from './SocketModeClient.js';
export { ChannelManager } from './ChannelManager.js';
export { FileHandler } from './FileHandler.js';
export { RingBuffer } from './RingBuffer.js';
export * from './sanitize.js';
// Register with the adapter registry at module load time
import { registerAdapter } from '../AdapterRegistry.js';
import { SlackAdapter } from './SlackAdapter.js';
registerAdapter('slack', SlackAdapter);
//# sourceMappingURL=index.js.map