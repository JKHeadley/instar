/**
 * The key shapes the agent recognises, in one list. The outbound policy layer blocks on them; the phone's
 * file text blanks them. Every quantifier that could rescan a long string is bounded.
 */
export const CREDENTIAL_SHAPES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OpenAI API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub personal access token', pattern: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub OAuth token', pattern: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub user-to-server token', pattern: /\bghu_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub server-to-server token', pattern: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub refresh token', pattern: /\bghr_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'Slack bot token', pattern: /\bxoxb-[0-9]{10,}-[A-Za-z0-9-]+\b/ },
  { name: 'Slack user token', pattern: /\bxoxp-[0-9]{10,}-[A-Za-z0-9-]+\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{24,}/ },
  { name: 'Stripe restricted key', pattern: /\brk_live_[A-Za-z0-9]{24,}/ },
  { name: 'Stripe test key', pattern: /\bsk_test_[A-Za-z0-9]{24,}/ },
  { name: 'Stripe webhook secret', pattern: /\bwhsec_[A-Za-z0-9]{16,}/ },
  // No leading word boundary: a key can sit straight after a word character.
  { name: 'Anthropic API key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Google OAuth token', pattern: /\bya29\.[A-Za-z0-9_-]{20,}/ },
  { name: 'SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'PyPI token', pattern: /\bpypi-[A-Za-z0-9_-]{20,}/ },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'Hugging Face token', pattern: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: 'age secret key', pattern: /\bAGE-SECRET-KEY-[A-Z0-9]{20,}/ },
  { name: 'Groq key', pattern: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'xAI key', pattern: /\bxai-[A-Za-z0-9]{20,}/ },
  { name: 'DigitalOcean token', pattern: /\bdop_v1_[a-f0-9]{20,}/ },
  { name: 'Password in a URL', pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/@:]{1,256}:[^\s/@]{1,256}@/i },
  { name: 'Token in a URL', pattern: /\bhttps?:\/\/[A-Za-z0-9_-]{16,256}@/i },
  { name: 'Generic bearer token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: 'Password assignment', pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/i },
  { name: 'Private key block', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
];
