import { AGENT_NAMES, AGENTS, splitArgs } from './connectors/agents.js';

/** Every voice the Realtime API takes, the default first. */
export const KNOWN_VOICES = Object.freeze([
  'ash',
  'alloy',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'marin',
  'sage',
  'shimmer',
  'verse',
]);

const SECRET_TTL = 600;

function flag(value, fallback) {
  if (value == null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value);
}

/** Where each agent's own settings come from, and what it is called there. */
const CONNECTOR_ENV = Object.freeze({
  claude: { prefix: 'CLAUDE', mode: 'CLAUDE_PERMISSION_MODE', defaultMode: 'acceptEdits' },
  codex: { prefix: 'CODEX', mode: 'CODEX_SANDBOX', defaultMode: 'workspace-write' },
  opencode: { prefix: 'OPENCODE', mode: 'OPENCODE_PERMISSION_MODE', defaultMode: 'default' },
  grok: { prefix: 'GROK', mode: 'GROK_PERMISSION_MODE', defaultMode: 'acceptEdits' },
});

/** How long an agent may work before it is stopped, and how many may at once. */
const DEFAULT_TIMEOUT = 900;
const DEFAULT_LIMIT = 3;

/**
 * The coding agents this server may hand work to. Off unless `CONNECTORS` names
 * one: a connector runs a CLI that edits files, so it is opt-in on the machine
 * that would be edited, never a default.
 */
function loadConnectors(env) {
  const chosen = (env.CONNECTORS ?? '')
    .split(/[,\s]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const names = [];
  const agents = {};

  for (const name of chosen) {
    if (!AGENT_NAMES.includes(name)) {
      console.warn(`connectors: no agent called ${name} — known: ${AGENT_NAMES.join(', ')}`);
      continue;
    }
    if (names.includes(name)) continue;

    const { prefix, mode, defaultMode } = CONNECTOR_ENV[name];
    const command = splitArgs(env[`${prefix}_COMMAND`]);
    names.push(name);
    agents[name] = {
      command: command.length ? command : [AGENTS[name].command],
      model: env[`${prefix}_MODEL`] || '',
      mode: env[mode] ?? defaultMode,
      extra: splitArgs(env[`${prefix}_ARGS`]),
      cwd: env[`${prefix}_CWD`] || null,
    };
  }

  return {
    names,
    runtime: {
      agents,
      cwd: env.CONNECTOR_CWD || process.cwd(),
      file: env.CONNECTOR_FILE || 'connectors.json',
      timeoutMs: (Number(env.CONNECTOR_TIMEOUT) || DEFAULT_TIMEOUT) * 1000,
      limit: Number(env.CONNECTOR_LIMIT) || DEFAULT_LIMIT,
      announce: flag(env.CONNECTOR_ANNOUNCE, true),
    },
  };
}

export function loadConfig(env = process.env) {
  const defaultVoice = env.OPENAI_VOICE || KNOWN_VOICES[0];
  const connectors = loadConnectors(env);

  return {
    port: Number(env.PORT) || 5173,
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY,
    defaultModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
    defaultVoice,
    voices: KNOWN_VOICES.includes(defaultVoice)
      ? [...KNOWN_VOICES]
      : [defaultVoice, ...KNOWN_VOICES],
    secretTtl: SECRET_TTL,
    memory: flag(env.MEMORY, true),
    /** Which agents the environment seeded; the panel edits the rest. */
    connectorNames: connectors.names,
    connectors: connectors.runtime,
  };
}
