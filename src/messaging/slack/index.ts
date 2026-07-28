/**
 * Slack messaging adapter — entry point and registry registration.
 */

export { SlackAdapter } from './SlackAdapter.js';
export { SlackApiClient, SlackApiError } from './SlackApiClient.js';
export { SocketModeClient } from './SocketModeClient.js';
export { ChannelManager } from './ChannelManager.js';
export { FileHandler } from './FileHandler.js';
export { RingBuffer } from './RingBuffer.js';
export type { SlackConfig, SlackMessage, SlackUser, SlackChannel } from './types.js';
export * from './sanitize.js';
export {
  formatForSlack,
  applySlackFormatter,
  MAX_INPUT_LENGTH as SLACK_FORMATTER_MAX_INPUT_LENGTH,
} from './SlackMrkdwnFormatter.js';
export type { SlackFormatMode, SlackFormatResult } from './SlackMrkdwnFormatter.js';

// Register with the adapter registry at module load time
import { registerAdapter } from '../AdapterRegistry.js';
import { SlackAdapter } from './SlackAdapter.js';

registerAdapter('slack', SlackAdapter);
