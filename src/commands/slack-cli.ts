/**
 * Slack CLI commands — `instar add slack`
 *
 * Prompts for bot token and app token, then writes Slack config to .instar/config.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function addSlack(): Promise<void> {
  const configPath = path.join(process.cwd(), '.instar', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log(pc.red('No .instar/config.json found. Run `instar init` first.'));
    process.exit(1);
  }

  console.log(pc.bold('\nSlack Setup\n'));
  console.log('You need two tokens from your Slack app:');
  console.log(`  1. ${pc.cyan('Bot Token')} (xoxb-...) — from OAuth & Permissions`);
  console.log(`  2. ${pc.cyan('App Token')} (xapp-...) — from Basic Information > App-Level Tokens\n`);

  const botToken = await ask('Bot token (xoxb-...): ');
  if (!botToken.startsWith('xoxb-')) {
    console.log(pc.red('Bot token should start with xoxb-'));
    process.exit(1);
  }

  const appToken = await ask('App token (xapp-...): ');
  if (!appToken.startsWith('xapp-')) {
    console.log(pc.red('App token should start with xapp-'));
    process.exit(1);
  }

  const authorizedUsers = await ask('Authorized Slack user IDs (comma-separated, or empty for all): ');

  const config = loadConfig();
  const slackConfig: Record<string, unknown> = {
    botToken,
    appToken,
  };

  if (authorizedUsers) {
    slackConfig.authorizedUsers = authorizedUsers.split(',').map(s => s.trim()).filter(Boolean);
  }

  (config as unknown as Record<string, unknown>).slack = slackConfig;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(pc.green('\nSlack configured! Restart the server to connect.'));
}
