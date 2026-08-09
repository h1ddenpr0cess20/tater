import { runConnectorTool } from '../api.js';

const LABELS = {
  remember: 'remembering that',
  forget: 'forgetting that',
  dispatch_task: 'handing it over',
  check_task: 'checking on it',
  cancel_task: 'calling it off',
};

/** The HUD caption for a tool call, or null for a name we don't run. */
export function toolLabel(name) {
  return LABELS[name] ?? null;
}

/** The three the server answers: they spawn agents, so they are not ours to run. */
export const CONNECTOR_TOOLS = Object.freeze(['dispatch_task', 'check_task', 'cancel_task']);

/**
 * The function tools this page answers, keyed by the name the model calls. Each
 * takes the parsed arguments and returns the object sent back as the call's
 * output, or a promise of one.
 *
 * The memory tools are answered here, against browser storage. The connector
 * tools are only routed from here: the work happens on the server, which is the
 * machine with the files on it. They arrive in the page at all because the call
 * runs browser-to-OpenAI, so there is nowhere else for a tool call to land.
 */
export function createTools({ memory, connectors = true, run = runConnectorTool } = {}) {
  const tools = {};

  if (memory) {
    tools.remember = (args) => {
      if (!memory.enabled) return { ok: false, error: 'memory is switched off' };
      const stored = memory.add(args?.memory);
      if (!stored) return { ok: false, error: 'nothing worth storing in that' };
      return { ok: true, remembered: stored.text, total: memory.items.length };
    };

    tools.forget = (args) => {
      if (!memory.enabled) return { ok: false, error: 'memory is switched off' };
      const keyword = typeof args?.keyword === 'string' ? args.keyword : '';
      if (!keyword.trim()) return { ok: false, error: 'no keyword to match on' };
      const forgotten = memory.forget(keyword);
      if (!forgotten.length) return { ok: false, keyword, error: 'nothing stored matches that' };
      return { ok: true, keyword, forgotten, total: memory.items.length };
    };
  }

  if (connectors) {
    for (const name of CONNECTOR_TOOLS) {
      tools[name] = async (args) => {
        try {
          return await run(name, args ?? {});
        } catch (err) {
          /** The model is waiting on this: a reachable failure beats a silence. */
          return { ok: false, error: err?.message ?? String(err) };
        }
      };
    }
  }

  return tools;
}
