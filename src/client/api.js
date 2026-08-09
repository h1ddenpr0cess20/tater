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
