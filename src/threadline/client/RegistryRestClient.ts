/**
 * RegistryRestClient — Lightweight REST client for the Threadline agent registry.
 *
 * Connects to the relay via WebSocket to authenticate and obtain a JWT token,
 * then uses that token for REST API calls to the registry.
 *
 * Used by mcp-stdio-entry to give built-in Threadline MCP tools registry access.
 * Part of Threadline Agent Registry Phase 3.
 */

import { WebSocket } from 'ws';
import { sign } from '../ThreadlineCrypto.js';
import type { RegistryClient } from '../ThreadlineMCPServer.js';
import type { IdentityInfo } from './IdentityManager.js';

export interface RegistryRestClientConfig {
  /** Relay WebSocket URL (e.g., wss://threadline-relay.fly.dev/v1/connect) */
  relayUrl: string;
  /** Agent identity (Ed25519 keys) */
  identity: IdentityInfo;
  /** Agent display name */
  agentName: string;
  /** Agent capabilities */
  capabilities?: string[];
  /** Agent framework */
  framework?: string;
  /** Whether to register in the registry */
  listed?: boolean;
}

export class RegistryRestClient implements RegistryClient {
  private readonly config: RegistryRestClientConfig;
  private token: string | null = null;
  private tokenExpires: string | null = null;
  private baseUrl: string;

  constructor(config: RegistryRestClientConfig) {
    this.config = config;
    // Derive REST URL from WebSocket URL
    const wsUrl = new URL(config.relayUrl);
    const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    this.baseUrl = `${protocol}//${wsUrl.host}`;
  }

  /**
   * Connect to the relay to authenticate and obtain a registry JWT token.
   * Must be called before using fetch().
   */
  async authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Registry auth timeout'));
      }, 15000);

      const ws = new WebSocket(this.config.relayUrl);

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Registry auth connection failed: ${err.message}`));
      });

      ws.on('message', (raw) => {
        try {
          const frame = JSON.parse(raw.toString());

          if (frame.type === 'challenge') {
            // Sign the challenge
            const signature = sign(
              this.config.identity.privateKey,
              Buffer.from(frame.nonce),
            );

            ws.send(JSON.stringify({
              type: 'auth',
              publicKey: this.config.identity.publicKey.toString('base64'),
              signature: signature.toString('base64'),
              metadata: {
                name: this.config.agentName,
                capabilities: this.config.capabilities ?? ['chat'],
                framework: this.config.framework ?? 'instar',
              },
              registry: {
                listed: this.config.listed ?? false,
              },
            }));
          } else if (frame.type === 'auth_ok') {
            // Capture registry token
            if (frame.registry_token) {
              this.token = frame.registry_token;
              this.tokenExpires = frame.registry_token_expires || null;
            }

            clearTimeout(timeout);
            // Disconnect — we only needed the token
            ws.close();
            resolve();
          } else if (frame.type === 'auth_error') {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`Registry auth failed: ${frame.message}`));
          }
        } catch (err) {
          // Ignore parse errors
        }
      });

      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  hasToken(): boolean {
    if (!this.token) return false;
    if (this.tokenExpires) {
      const expires = new Date(this.tokenExpires).getTime();
      if (Date.now() > expires) {
        this.token = null;
        return false;
      }
    }
    return true;
  }

  async fetch(path: string, options?: {
    method?: string;
    body?: unknown;
  }): Promise<{ status: number; data: unknown }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await globalThis.fetch(url, {
      method: options?.method ?? 'GET',
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }
}
