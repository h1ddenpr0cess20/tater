async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `${url} returned ${res.status}`);
  }
  return body;
}

export function fetchCatalog() {
  return json('/api/models');
}

export function fetchClientSecret({ model, voice, memories, resumed }) {
  return json('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, memories, resumed }),
  });
}

/** Every task this server has handed out, whether or not a call is up. */
export function fetchTasks() {
  return json('/api/tasks');
}

/** The connector setup: which agents exist, which are on, and how they run. */
export function fetchConnectors() {
  return json('/api/connectors');
}

export function saveConnectors(patch) {
  return json('/api/connectors', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * A connector tool call, run on the server.
 *
 * The call itself runs in this browser, so the model's tool calls arrive here
 * and the page is the only thing that can answer them — but the work is the
 * server's to do, since it is the server's machine being edited.
 */
export function runConnectorTool(name, args) {
  return json('/api/connectors/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
}

export function stopTask(id) {
  return json(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}
