#!/usr/bin/env node

/**
 * call-llm.cjs — Bridge to external LLM APIs
 *
 * Calls GPT, Gemini, or Grok via their REST APIs using native fetch.
 * Reads prompt from file to avoid shell escaping issues.
 *
 * Usage:
 *   node call-llm.cjs --model gpt --prompt-file /tmp/prompt.txt [--max-tokens 4000] [--system "You are..."]
 *
 * Requires API keys in environment (loaded from .env.local / .env.secrets.local via dotenv):
 *   - gpt:    OPENAI_API_KEY
 *   - gemini: GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY)
 *   - grok:   XAI_API_KEY
 *
 * Output: model response text to stdout, errors to stderr.
 */

const fs = require('fs');
const path = require('path');

// Load env files from project root, then fall back to the-portal's env files
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const portalRoot = '/Users/justin/Documents/Projects/the-portal';
const envFiles = ['.env.local', '.env.secrets.local', '.env'];
const envRoots = [projectRoot, portalRoot];
for (const root of envRoots) {
for (const envFile of envFiles) {
  const envPath = path.join(root, envFile);
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}
}

// --- Model Configuration ---

const MODELS = {
  gpt: {
    id: 'gpt-5.4',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    format: 'openai',
    envKey: 'OPENAI_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
  gemini: {
    id: 'gemini-3.1-pro-preview',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
    format: 'google',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    envKeyAlt: 'GEMINI_API_KEY',
    authHeader: (key) => ({ 'x-goog-api-key': key }),
  },
  grok: {
    id: 'grok-4-1-fast',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    format: 'openai',
    envKey: 'XAI_API_KEY',
    envKeyAlt: 'GROK_API_KEY',
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
};

// --- Argument Parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { maxTokens: 4000 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
        parsed.model = args[++i];
        break;
      case '--prompt-file':
        parsed.promptFile = args[++i];
        break;
      case '--max-tokens':
        parsed.maxTokens = parseInt(args[++i], 10);
        break;
      case '--system':
        parsed.system = args[++i];
        break;
      default:
        fatal(`Unknown argument: ${args[i]}`);
    }
  }

  if (!parsed.model) fatal('--model is required (gpt, gemini, grok)');
  if (!parsed.promptFile) fatal('--prompt-file is required');
  if (!MODELS[parsed.model]) fatal(`Unknown model: ${parsed.model}. Available: ${Object.keys(MODELS).join(', ')}`);

  return parsed;
}

function fatal(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

// --- API Call Functions ---

function buildOpenAIBody(prompt, system, maxTokens, modelId) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  return {
    model: modelId,
    messages,
    max_completion_tokens: maxTokens,
    temperature: 0.7,
  };
}

function buildGoogleBody(prompt, system, maxTokens) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.7,
    },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  return body;
}

function extractOpenAIResponse(data) {
  if (data.error) throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
  if (!data.choices || !data.choices[0]) throw new Error(`Unexpected response format: ${JSON.stringify(data).slice(0, 500)}`);
  return data.choices[0].message.content;
}

function extractGoogleResponse(data) {
  if (data.error) throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
  if (!data.candidates || !data.candidates[0]) throw new Error(`Unexpected response format: ${JSON.stringify(data).slice(0, 500)}`);
  const parts = data.candidates[0].content?.parts;
  if (!parts || !parts[0]) throw new Error(`No content in response: ${JSON.stringify(data).slice(0, 500)}`);
  return parts[0].text;
}

// --- Main ---

async function main() {
  const args = parseArgs();
  const config = MODELS[args.model];

  // Get API key
  const apiKey = process.env[config.envKey] || (config.envKeyAlt && process.env[config.envKeyAlt]);
  if (!apiKey) {
    fatal(`Missing API key for ${args.model}. Set ${config.envKey} in .env.secrets.local`);
  }

  // Read prompt
  let prompt;
  try {
    prompt = fs.readFileSync(args.promptFile, 'utf8');
  } catch (err) {
    fatal(`Cannot read prompt file: ${args.promptFile} — ${err.message}`);
  }

  if (!prompt.trim()) {
    fatal('Prompt file is empty');
  }

  // Build request
  let body, extractResponse;
  if (config.format === 'openai') {
    body = buildOpenAIBody(prompt, args.system, args.maxTokens, config.id);
    extractResponse = extractOpenAIResponse;
  } else if (config.format === 'google') {
    body = buildGoogleBody(prompt, args.system, args.maxTokens);
    extractResponse = extractGoogleResponse;
  }

  // Make API call
  const headers = {
    'Content-Type': 'application/json',
    ...config.authHeader(apiKey),
  };

  process.stderr.write(`Calling ${args.model} (${config.id})...\n`);

  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    fatal(`Network error calling ${args.model}: ${err.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    const text = await response.text().catch(() => '(could not read response body)');
    fatal(`Failed to parse ${args.model} response (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    const errMsg = data?.error?.message || JSON.stringify(data).slice(0, 500);
    fatal(`${args.model} API returned HTTP ${response.status}: ${errMsg}`);
  }

  // Extract and output response
  try {
    const text = extractResponse(data);
    process.stdout.write(text);
  } catch (err) {
    fatal(err.message);
  }
}

main();
