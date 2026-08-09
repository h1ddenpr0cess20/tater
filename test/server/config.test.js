import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KNOWN_VOICES, loadConfig } from '../../src/server/config.js';

describe('loadConfig', () => {
  it('falls back to the published defaults on an empty environment', () => {
    const config = loadConfig({});
    assert.equal(config.port, 5173);
    assert.equal(config.baseUrl, 'https://api.openai.com/v1');
    assert.equal(config.defaultModel, 'gpt-realtime-2.1');
    assert.equal(config.defaultVoice, 'ash');
    assert.deepEqual(config.voices, [...KNOWN_VOICES]);
    assert.equal(config.apiKey, undefined);
  });

  it('publishes the whole realtime voice list, once each, the default first', () => {
    assert.equal(KNOWN_VOICES[0], 'ash');
    assert.equal(new Set(KNOWN_VOICES).size, KNOWN_VOICES.length);
    for (const voice of ['alloy', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse']) {
      assert.ok(KNOWN_VOICES.includes(voice), `${voice} is missing from the picker`);
    }
  });

  it('reads every override', () => {
    const config = loadConfig({
      PORT: '8080',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REALTIME_MODEL: 'gpt-realtime-mini',
      OPENAI_VOICE: 'ballad',
    });
    assert.equal(config.port, 8080);
    assert.equal(config.baseUrl, 'https://gateway.example/v1');
    assert.equal(config.apiKey, 'sk-test');
    assert.equal(config.defaultModel, 'gpt-realtime-mini');
    assert.equal(config.defaultVoice, 'ballad');
  });

  it('puts an unrecognised voice at the front of the picker rather than dropping it', () => {
    const { voices, defaultVoice } = loadConfig({ OPENAI_VOICE: 'unreleased' });
    assert.equal(defaultVoice, 'unreleased');
    assert.equal(voices[0], 'unreleased');
    assert.deepEqual(voices.slice(1), [...KNOWN_VOICES]);
  });

  it('does not duplicate a known voice that is also the default', () => {
    const { voices } = loadConfig({ OPENAI_VOICE: 'ballad' });
    assert.equal(voices.filter((v) => v === 'ballad').length, 1);
  });

  it('ignores a non-numeric PORT instead of listening on NaN', () => {
    assert.equal(loadConfig({ PORT: 'nonsense' }).port, 5173);
  });
});
