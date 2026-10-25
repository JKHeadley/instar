import type { Server } from 'node:http';
import type { AgentServer } from '../../src/server/AgentServer.js';

/** Read the listener reserved by the real AgentServer after awaited start(). */
export function boundAgentServerBase(server: AgentServer): string {
  const address = (server as unknown as { server: Server }).server.address();
  if (!address || typeof address === 'string' || address.port <= 0) {
    throw new Error('AgentServer fixture must own a bound TCP listener');
  }
  return `http://127.0.0.1:${address.port}`;
}
