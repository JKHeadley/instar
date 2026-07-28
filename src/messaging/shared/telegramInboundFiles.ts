import path from 'node:path';

export function getTelegramInboundDir(projectDir: string): string {
  return path.join(projectDir, '.instar', 'telegram-inbound');
}
