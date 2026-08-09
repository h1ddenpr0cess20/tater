import { sessionConfig } from './persona.js';

const NOT_CONVERSATIONAL = /translate|whisper|transcribe|tts/;

export function createOpenAIClient({
  baseUrl,
  apiKey,
  defaultModel,
  defaultVoice,
  voices,
  secretTtl,
  memory = true,
}) {
  async function request(path, init = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(body?.error?.message ?? `OpenAI returned ${res.status}`);
    }
    return body;
  }

  function rank(id) {
    if (id === defaultModel) return 0;
    if (id.includes('preview')) return 2;
    return 1;
  }

  return {
    async listRealtimeModels() {
      const { data } = await request('/models');
      return data
        .filter((m) => m.id.includes('realtime') && !NOT_CONVERSATIONAL.test(m.id))
        .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
        .map((m) => ({ id: m.id, display_name: m.id }));
    },

    async mintClientSecret({ model, voice, memories, resumed } = {}) {
      const chosen = voices.includes(voice) ? voice : defaultVoice;
      const chosenModel = typeof model === 'string'
        && model.includes('realtime') && !NOT_CONVERSATIONAL.test(model)
        ? model
        : defaultModel;
      const secret = await request('/realtime/client_secrets', {
        method: 'POST',
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: secretTtl },
          session: sessionConfig(chosenModel, chosen, { memories, memory, resumed: Boolean(resumed) }),
        }),
      });
      return {
        value: secret.value,
        expires_at: secret.expires_at,
        model: secret.session?.model ?? chosenModel,
        voice: chosen,
      };
    },
  };
}
