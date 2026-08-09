import { createOpenAIClient } from './openai.js';

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

export function createApiMiddleware(config) {
  const openai = createOpenAIClient(config);

  return async function api(req, res, next) {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return next();

    if (!config.apiKey) {
      return sendJSON(res, 500, { error: 'OPENAI_API_KEY is not set' });
    }

    try {
      if (path === '/api/models' && req.method === 'GET') {
        return sendJSON(res, 200, {
          models: await openai.listRealtimeModels(),
          model: config.defaultModel,
          voices: config.voices,
          voice: config.defaultVoice,
          memory: config.memory,
          /**
           * The tools the page may switch off for its own call. Empty until
           * this session declares one worth switching — the panel is built and
           * waiting for them.
           */
          switches: [],
        });
      }

      if (path === '/api/session' && req.method === 'POST') {
        let payload;
        try {
          payload = await readJSON(req);
        } catch {
          return sendJSON(res, 400, { error: 'malformed request body' });
        }
        return sendJSON(res, 200, await openai.mintClientSecret(payload));
      }
    } catch (err) {
      return sendJSON(res, 502, { error: err?.message ?? String(err) });
    }

    sendJSON(res, 404, { error: `no route for ${req.method} ${path}` });
  };
}
