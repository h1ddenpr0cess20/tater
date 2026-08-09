import { createOpenAIClient } from './openai.js';
import { sameOrigin } from './origin.js';

// A session request carries the page's memories, so the cap is the memory list
// rather than a model name.
const BODY_LIMIT = 64 * 1024;

function sendJSON(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Past the limit we stop keeping the body but keep reading it, up to a hard
// ceiling. Answering while the client is still uploading leaves it writing into
// a socket nobody is draining, which hangs the request instead of failing it.
const DRAIN_LIMIT = 4 * 1024 * 1024;

async function readJSON(req) {
  const chunks = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      over = true;
      chunks.length = 0;
      if (size > DRAIN_LIMIT) {
        req.destroy();
        break;
      }
      continue;
    }
    chunks.push(chunk);
  }
  if (over) throw new Error('request body too large');
  if (!chunks.length) return {};
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body === null || typeof body !== 'object') throw new Error('body is not an object');
  return body;
}

/**
 * The HTTP surface.
 *
 * `connectors` is the registry the app made, shared so that a task outlives the
 * call that dispatched it. Left out, this server simply has no connectors: the
 * routes below are not mounted and no agent is declared to the model. Nothing
 * creates a registry here, because doing so would read and write a settings
 * file on behalf of a caller that never asked for one.
 */
export function createApiMiddleware(config, connectors = null) {
  const openai = createOpenAIClient(config, connectors);

  return async function api(req, res, next) {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return next();

    /**
     * Anything that changes something has to have been asked for from this
     * page. A cross-site POST needs no preflight if it keeps the content type
     * simple, and this API takes a body without looking at that header — so
     * without this, a page in another tab can switch every agent on at its
     * loosest mode, point the workspace at the root of the disk, and dispatch
     * into it.
     */
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return sendJSON(res, 403, { error: 'that did not come from this page' });
    }

    try {
      if (path === '/api/models' && req.method === 'GET') {
        if (!config.apiKey) return sendJSON(res, 500, { error: 'OPENAI_API_KEY is not set' });
        return sendJSON(res, 200, {
          models: await openai.listRealtimeModels(),
          model: config.defaultModel,
          voices: config.voices,
          voice: config.defaultVoice,
          memory: config.memory,
          /** Which coding agents are on — the panel's business, not a switch. */
          connectors: connectors?.agents ?? [],
          /**
           * The tools the page may switch off for its own call. Empty until
           * this session declares one worth switching — the panel is built and
           * waiting for them. The connectors are not among them: an agent that
           * edits files on this machine is switched on in its own panel,
           * against the server, for everyone.
           */
          switches: [],
        });
      }

      if (path === '/api/session' && req.method === 'POST') {
        if (!config.apiKey) return sendJSON(res, 500, { error: 'OPENAI_API_KEY is not set' });
        let payload;
        try {
          payload = await readJSON(req);
        } catch {
          return sendJSON(res, 400, { error: 'malformed request body' });
        }
        return sendJSON(res, 200, await openai.mintClientSecret(payload));
      }

      if (connectors) {
        const answered = await connectorRoutes(path, req, res, connectors);
        if (answered) return answered;
      }
    } catch (err) {
      return sendJSON(res, 502, { error: err?.message ?? String(err) });
    }

    sendJSON(res, 404, { error: `no route for ${req.method} ${path}` });
  };
}

/**
 * The connector half of the API. It answers, or it says it did not, and the
 * caller falls through to the 404.
 *
 * Dispatching is reachable from here, which is the one place this parts company
 * with a server that proxies the call itself. Tater's conversation runs in the
 * browser over WebRTC, so a tool call the model makes arrives there and nowhere
 * else — the page is the only thing that can hand it back. The guard is the
 * same-origin check above plus the panel: an agent nobody switched on cannot be
 * dispatched to, whoever asks.
 */
async function connectorRoutes(path, req, res, connectors) {
  const answer = (status, body) => {
    sendJSON(res, status, body);
    return true;
  };

  /**
   * The connector setup, read and written from the panel. Which agents are on,
   * where they work, and how much they are allowed to do — applied to the
   * running server and saved, without an edit to a file or a restart.
   */
  if (path === '/api/connectors' && req.method === 'GET') {
    return answer(200, connectors.settings());
  }

  if (path === '/api/connectors' && (req.method === 'PUT' || req.method === 'POST')) {
    let patch;
    try {
      patch = await readJSON(req);
    } catch {
      return answer(400, { ok: false, error: 'malformed request body' });
    }
    const result = connectors.configure(patch);
    return answer(result.ok ? 200 : 400, result);
  }

  /**
   * A tool call the model made, handed over by the page that received it. The
   * name is checked against the three the registry answers — this runs
   * connector tools, and is not a way to reach anything else.
   */
  if (path === '/api/connectors/run' && req.method === 'POST') {
    let body;
    try {
      body = await readJSON(req);
    } catch {
      return answer(400, { ok: false, error: 'malformed request body' });
    }
    const name = typeof body.name === 'string' ? body.name : '';
    if (!connectors.handles(name)) {
      return answer(404, { ok: false, error: `${name || 'that'} is not a connector tool` });
    }
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    return answer(200, connectors.run(name, args));
  }

  /**
   * The tasks are read from here rather than only as they are dispatched, so
   * the panel still has them after a reload and between calls, and so a task
   * that settles while nobody asked is noticed at all.
   */
  if (path === '/api/tasks' && req.method === 'GET') {
    return answer(200, {
      agents: connectors.agents,
      announce: connectors.announce,
      tasks: connectors.tasks(),
    });
  }

  const stopping = /^\/api\/tasks\/([^/]+)\/stop$/.exec(path);
  if (stopping && req.method === 'POST') {
    let id;
    try {
      id = decodeURIComponent(stopping[1]);
    } catch {
      return answer(400, { ok: false, error: 'that is not a task number' });
    }
    const result = connectors.run('cancel_task', { id });
    return answer(result.ok ? 200 : 409, result);
  }

  return false;
}
