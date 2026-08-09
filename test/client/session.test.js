import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createVoiceSession } from '../../src/client/session/index.js';
import { installMediaStack } from '../helpers/fake-rtc.js';

describe('createVoiceSession', () => {
  let env;
  let session;
  let events;

  function record(s) {
    events = [];
    for (const name of ['state', 'text', 'user', 'level', 'pulse', 'busy', 'done', 'error']) {
      s.on(name, (payload) => events.push([name, payload]));
    }
  }

  const of = (name) => events.filter(([e]) => e === name).map(([, p]) => p);
  const peer = () => env.peers.at(-1);

  const dial = () => session.start();

  beforeEach(() => {
    env = installMediaStack();
    session = createVoiceSession();
    record(session);
  });

  afterEach(() => {
    session.stop();
    env.restore();
  });

  describe('starting', () => {
    it('is idle and disconnected before anything happens', () => {
      assert.equal(session.state, 'idle');
      assert.equal(session.connected, false);
      assert.equal(session.busy, false);
    });

    it('asks for the microphone before spending a token', async () => {
      env.secretStatus = 500;
      await session.start();
      assert.equal(env.micTracks.length, 1);
      assert.equal(env.secretRequests.length, 1);
    });

    it('requests echo cancellation and noise suppression', async () => {
      await dial();
      assert.deepEqual(env.lastConstraints, {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    });

    it('sends the chosen model and voice to the proxy', async () => {
      session.model = 'gpt-realtime-mini';
      session.voice = 'cedar';
      await dial();
      assert.deepEqual(env.secretRequests.at(-1), {
        model: 'gpt-realtime-mini',
        voice: 'cedar',
        memories: [],
        resumed: false,
      });
    });

    it('lets the proxy overrule both', async () => {
      session.model = 'gpt-realtime-mini';
      session.voice = 'not-a-voice';
      env.secret = { value: 'ek_test', model: 'gpt-realtime-2.1', voice: 'ballad' };

      await dial();

      assert.equal(session.model, 'gpt-realtime-2.1');
      assert.equal(session.voice, 'ballad');
    });

    it('posts the SDP offer to OpenAI with the ephemeral secret, never the key', async () => {
      await dial();
      const sdp = env.sdpRequests.at(-1);
      assert.match(sdp.url, /realtime\/calls$/);
      assert.equal(sdp.init.headers.authorization, 'Bearer ek_test');
      assert.equal(sdp.init.headers['content-type'], 'application/sdp');
      assert.equal(sdp.init.body, 'v=0 fake offer');
    });

    it('adds the mic track and opens the events channel', async () => {
      await dial();
      assert.equal(peer().tracks.length, 1);
      assert.ok(peer().channel);
      assert.equal(session.connected, true);
      assert.equal(session.state, 'listening');
    });

    it('starts metering once the call is up', async () => {
      await dial();
      assert.ok(env.pendingFrames.size > 0);
    });

    it('ignores a second start while one is already connected', async () => {
      await dial();
      await session.start();
      assert.equal(env.peers.length, 1);
    });

    it('announces the call only once it can carry one', async () => {
      const seen = [];
      session.on('state', (s) => seen.push([s, session.connected]));

      await dial();

      assert.deepEqual(seen, [['listening', true]]);
    });
  });

  describe('when starting fails', () => {
    it('reports a denied microphone and stays idle', async () => {
      env.restore();
      env = installMediaStack({ micRejects: 'Permission denied' });
      session = createVoiceSession();
      record(session);

      await session.start();

      assert.deepEqual(of('error'), [{ message: 'Permission denied' }]);
      assert.equal(session.connected, false);
      assert.equal(session.state, 'idle');
    });

    it('says what to do about an insecure page instead of throwing on undefined', async () => {
      env.restore();
      env = installMediaStack({ mediaDevices: false, secureContext: false });
      session = createVoiceSession();
      record(session);

      await session.start();

      assert.match(of('error')[0].message, /secure page/);
      assert.match(of('error')[0].message, /dev:lan/);
      assert.equal(env.secretRequests.length, 0, 'a mic we cannot ask for must not spend a token');
      assert.equal(session.state, 'idle');
    });

    it('reports a secure browser that still withholds capture', async () => {
      env.restore();
      env = installMediaStack({ mediaDevices: false });
      session = createVoiceSession();
      record(session);

      await session.start();

      assert.match(of('error')[0].message, /won’t hand over a microphone/);
      assert.equal(session.connected, false);
    });

    it('reports a proxy that will not mint, and releases the mic', async () => {
      env.secretStatus = 502;
      await session.start();

      assert.deepEqual(of('error'), [{ message: 'mint failed' }]);
      assert.ok(env.micTracks.every((t) => t.stopped), 'the mic must not stay hot');
      assert.equal(session.state, 'idle');
    });

    it('reports a rejected handshake', async () => {
      env.restore();
      env = installMediaStack({ sdpStatus: 401 });
      session = createVoiceSession();
      record(session);

      await session.start();

      assert.match(of('error')[0].message, /realtime handshake failed \(401\)/);
      assert.equal(session.connected, false);
    });

    it('closes the peer it had already opened', async () => {
      env.restore();
      env = installMediaStack({ sdpStatus: 401 });
      session = createVoiceSession();
      record(session);

      await session.start();

      assert.ok(peer().closed, 'the abandoned peer connection is still open');
    });

    it('gives up on a call whose events channel never opens', async () => {
      env.restore();
      env = installMediaStack({ channelOpens: false });
      session = createVoiceSession();
      record(session);

      const started = session.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      peer().drop('failed');
      await started;

      assert.deepEqual(of('error'), [{ message: 'the call dropped before it was ready' }]);
      assert.equal(session.connected, false);
      assert.equal(session.state, 'idle');
      assert.ok(env.micTracks.every((t) => t.stopped), 'the mic must not stay hot');
    });

    it('tears the whole stack down after a failure', async () => {
      env.secretStatus = 502;
      await session.start();

      assert.ok(env.audioContexts.every((c) => c.closed) || env.audioContexts.length === 0);
      assert.equal(env.pendingFrames.size, 0, 'the meter must not keep spinning');
    });
  });

  describe('a conversation picked back up', () => {
    const earlier = [
      { role: 'user', content: 'what should I call it?' },
      { role: 'assistant', content: 'Something you can shout.' },
    ];

    it('lays the turns down as items, in the shape each role takes', async () => {
      session.context = earlier;
      await dial();

      assert.deepEqual(peer().channel.sent, [
        {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [{ type: 'input_text', text: 'what should I call it?' }],
          },
        },
        {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Something you can shout.' }],
          },
        },
      ]);
    });

    it('tells the server to explain them, so the persona is not the page\'s to write', async () => {
      session.context = earlier;
      await dial();

      assert.equal(env.secretRequests.at(-1).resumed, true);
    });

    it('says nothing extra on a call that was not picked up', async () => {
      await dial();

      assert.deepEqual(peer().channel.sent, []);
      assert.equal(env.secretRequests.at(-1).resumed, false);
    });

    it('keeps them for the next dial, so a voice change keeps the thread', async () => {
      session.context = earlier;
      await dial();
      session.stop();
      await dial();

      assert.equal(peer().channel.sent.length, 2);
    });

    it('takes nothing but a list of turns', async () => {
      session.context = null;
      assert.deepEqual(session.context, []);
      await dial();
      assert.deepEqual(peer().channel.sent, []);
    });
  });

  describe('a live call', () => {
    beforeEach(() => dial());

    it('routes server events through to Tater\'s vocabulary', () => {
      peer().channel.deliver({ type: 'response.created' });
      peer().channel.deliver({ type: 'response.output_audio_transcript.delta', delta: 'Hello!' });

      assert.deepEqual(of('text'), ['Hello!']);
      assert.deepEqual(of('pulse'), [0.32]);
      assert.equal(session.state, 'speaking');
    });

    it('shrugs off a frame it cannot parse', () => {
      assert.doesNotThrow(() => peer().channel.deliverRaw('<not json>'));
      assert.deepEqual(of('error'), []);
    });

    it('keeps a transcript of both sides', () => {
      peer().channel.deliver({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'what are you?',
      });
      peer().channel.deliver({ type: 'response.output_text.delta', delta: 'A potato!' });
      peer().channel.deliver({ type: 'response.done', response: {} });

      assert.deepEqual(session.messages, [
        { role: 'user', content: 'what are you?' },
        { role: 'assistant', content: 'A potato!' },
      ]);
    });

    it('announces a response starting and finishing, not just its state', () => {
      peer().channel.deliver({ type: 'input_audio_buffer.speech_stopped' });
      peer().channel.deliver({ type: 'response.created' });
      assert.deepEqual(of('busy'), [true]);
      assert.equal(session.busy, true);

      peer().channel.deliver({ type: 'response.done', response: {} });
      assert.deepEqual(of('busy'), [true, false]);
      assert.equal(session.busy, false);
    });

    it('emits a level every frame', () => {
      const before = of('level').length;
      env.tick();
      assert.ok(of('level').length > before);
    });

    describe('typed input', () => {
      it('sends the item and asks for a response', () => {
        session.send('  hello Tater  ');
        assert.deepEqual(peer().channel.sent, [
          {
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello Tater' }] },
          },
          { type: 'response.create' },
        ]);
        assert.equal(session.state, 'thinking');
        assert.deepEqual(session.messages, [{ role: 'user', content: 'hello Tater' }]);
      });

      it('refuses empty text', () => {
        session.send('   ');
        assert.deepEqual(peer().channel.sent, []);
        assert.deepEqual(session.messages, []);
      });
    });

    describe('muting', () => {
      it('starts with the mic on', () => {
        assert.equal(session.muted, false);
        assert.ok(env.micTracks.every((t) => t.enabled !== false));
      });

      it('silences the track without touching the call', () => {
        session.muted = true;

        assert.equal(session.muted, true);
        assert.ok(env.micTracks.every((t) => t.enabled === false), 'mic still live');
        assert.equal(session.connected, true);
        assert.ok(env.micTracks.every((t) => !t.stopped), 'mic track was released');
        assert.equal(peer().closed, false);
        assert.equal(peer().channel.closed, false);
      });

      it('turns back on, on the same call', () => {
        session.muted = true;
        session.muted = false;
        assert.ok(env.micTracks.every((t) => t.enabled === true));
        assert.equal(session.connected, true);
      });

      it('leaves the conversation where it was', () => {
        peer().channel.deliver({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'before the mute',
        });
        session.muted = true;
        assert.deepEqual(session.messages.map((m) => m.content), ['before the mute']);
      });
    });

    describe('cancel', () => {
      it('does nothing when Tater is not talking', () => {
        session.cancel();
        assert.deepEqual(peer().channel.sent, []);
      });

      it('sends response.cancel mid-answer', () => {
        peer().channel.deliver({ type: 'response.created' });
        session.cancel();
        assert.deepEqual(peer().channel.sent, [{ type: 'response.cancel' }]);
      });
    });
  });

  describe('stopping', () => {
    beforeEach(() => dial());

    it('releases the mic, the audio context, the peer and the meter', () => {
      session.stop();

      assert.ok(env.micTracks.every((t) => t.stopped), 'mic still hot');
      assert.ok(env.audioContexts.every((c) => c.closed), 'audio context still open');
      assert.ok(peer().closed, 'peer connection still open');
      assert.ok(peer().channel.closed, 'data channel still open');
      assert.equal(env.pendingFrames.size, 0, 'meter still running');
    });

    it('un-mutes, so the next call starts with the mic on', () => {
      session.muted = true;
      session.stop();
      assert.equal(session.muted, false);
    });

    it('settles Tater: level zero, state idle', () => {
      session.stop();
      assert.equal(of('level').at(-1), 0);
      assert.equal(session.state, 'idle');
      assert.equal(session.connected, false);
    });

    it('does not re-enter when closing the peer fires a state change', () => {
      session.stop();
      peer().drop('closed');
      assert.deepEqual(of('error'), [], 'our own hangup must not look like a failure');
    });

    it('is safe to call twice', () => {
      session.stop();
      assert.doesNotThrow(() => session.stop());
    });

    it('forgets the in-flight response, so the next call starts clean', () => {
      peer().channel.deliver({ type: 'response.created' });
      assert.equal(session.busy, true);
      session.stop();
      assert.equal(session.busy, false);
    });
  });

  describe('a pick that lands mid-dial', () => {
    it('marks the call stale, since redial() had no live call to hang up', async () => {
      const started = session.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.model = 'gpt-realtime-mini';
      await started;

      assert.equal(session.connected, true);
      assert.equal(session.stale, true, 'the call is on a model the picker no longer shows');
    });

    it('is not stale merely because the proxy had the last word', async () => {
      session.model = 'gpt-realtime-mini';
      env.secret = { value: 'ek_test', model: 'gpt-realtime-2.1', voice: 'ballad' };

      await dial();

      assert.equal(session.stale, false);
    });

    it('is not stale once the redial has caught up', async () => {
      const started = session.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      session.model = 'gpt-realtime-mini';
      await started;

      session.stop();
      await dial();
      assert.equal(session.stale, false);
    });
  });

  describe('hanging up mid-dial', () => {
    it('abandons a call nobody is waiting for any more', async () => {
      const started = session.start();
      session.stop();
      await started;

      assert.ok(env.micTracks.every((t) => t.stopped), 'the mic must not stay hot');
      assert.equal(env.peers.length, 0, 'a hung-up call must not go on to dial');
      assert.equal(session.connected, false);
      assert.equal(session.state, 'idle');
      assert.equal(env.pendingFrames.size, 0, 'the meter must not keep spinning');
    });
  });

  describe('a dropped call', () => {
    beforeEach(() => dial());

    it('reports the drop and tears down', () => {
      peer().drop('failed');

      assert.deepEqual(of('error'), [{ message: 'the call dropped' }]);
      assert.equal(session.state, 'idle');
      assert.ok(env.micTracks.every((t) => t.stopped));
    });

    it('tears down quietly when the far end simply disconnects', () => {
      peer().drop('disconnected');
      assert.deepEqual(of('error'), []);
      assert.equal(session.state, 'idle');
    });
  });

  describe('redial', () => {
    it('carries the newly picked voice into the next call', async () => {
      await dial();
      session.stop();

      session.voice = 'cedar';
      env.secret = { value: 'ek_test', model: 'gpt-realtime-2.1', voice: 'cedar' };
      await dial();

      assert.equal(env.secretRequests.at(-1).voice, 'cedar');
      assert.equal(session.voice, 'cedar');
      assert.equal(env.peers.length, 2);
    });
  });
});
