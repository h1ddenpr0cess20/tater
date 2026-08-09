import { fetchClientSecret } from '../api.js';
import { createEmitter } from './emitter.js';
import { createEventHandler } from './events.js';
import { createAnalyser, createMeter } from './metering.js';
import { createTools, toolLabel } from './tools.js';
import { connect } from './webrtc.js';

const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** How much of an earlier conversation rides along when one is picked up. */
const PRIOR_TURNS = 40;
const PRIOR_CHARS = 6000;

/**
 * The turns of an earlier conversation, trimmed to what is worth carrying and
 * cut down to the two roles a conversation has. They travel as turns rather
 * than as a summary of turns, because that is what the realtime API takes: one
 * `conversation.item.create` each, a user message holding `input_text` and an
 * assistant message holding `output_text`. Describing the history inside a
 * single message instead leaves the model with no history at all — only
 * somebody telling it about one.
 *
 * The oldest go first when there are too many: what was said last is what the
 * next sentence is most likely to follow from.
 */
export function prior(turns = []) {
  const kept = turns
    .filter((turn) => turn?.content && (turn.role === 'user' || turn.role === 'assistant'))
    .slice(-PRIOR_TURNS)
    .map((turn) => ({ role: turn.role, content: String(turn.content).slice(0, PRIOR_CHARS) }));

  let total = kept.reduce((sum, turn) => sum + turn.content.length, 0);
  while (total > PRIOR_CHARS && kept.length > 1) {
    total -= kept.shift().content.length;
  }

  return kept;
}

/** One replayed turn, in the shape the API takes for that role. */
export function historyItem({ role, content }) {
  const part = role === 'assistant'
    ? { type: 'output_text', text: content }
    : { type: 'input_text', text: content };

  return {
    type: 'conversation.item.create',
    item: { type: 'message', role, status: 'completed', content: [part] },
  };
}

function micUnavailable() {
  if (navigator.mediaDevices?.getUserMedia) return null;
  return globalThis.isSecureContext === false
    ? 'the microphone needs a secure page, and this one is plain http:// — serve it over https (npm run dev:lan) or open it on localhost'
    : 'this browser won’t hand over a microphone — try opening the page in Safari or Chrome';
}

export function createVoiceSession({ model, voice, memory } = {}) {
  const { on, emit } = createEmitter();
  const messages = [];
  const tools = memory ? createTools({ memory }) : {};

  let current = model;
  let currentVoice = voice;

  let call = null;
  let audio = null;
  let audioEl = null;
  let micStream = null;
  let micAnalyser = null;
  let outAnalyser = null;

  let state = 'idle';
  let context = [];
  let muted = false;
  let connecting = false;
  let generation = 0;
  let picked = 0;
  let mintedPick = 0;

  function setState(next) {
    if (state === next) return;
    state = next;
    emit('state', next);
  }

  function fail(message) {
    emit('error', { message });
  }

  /**
   * Answers a function call the model made. The result has to go back as a
   * `function_call_output` item followed by a fresh `response.create` — without
   * the second frame the model waits forever on its own tool.
   */
  function runTool({ call_id: callId, name, args }) {
    const tool = tools[name];
    if (!tool) return;

    emit('tool', toolLabel(name));
    let output;
    try {
      output = tool(args);
    } catch (err) {
      output = { ok: false, error: err?.message ?? String(err) };
    }

    call?.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    call?.send({ type: 'response.create' });
    emit('memory', output);
  }

  const events = createEventHandler({
    setState,
    emit,
    fail,
    messages,
    getModel: () => current,
    onFunctionCall: runTool,
  });

  const meter = createMeter(
    () => (state === 'speaking' ? outAnalyser : state === 'listening' ? micAnalyser : null),
    (level) => emit('level', level),
  );

  async function start() {
    if (call || connecting) return;
    connecting = true;
    const mine = ++generation;
    const abandoned = () => mine !== generation;
    try {
      const unavailable = micUnavailable();
      if (unavailable) throw new Error(unavailable);
      micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      if (abandoned()) return stop();

      mintedPick = picked;
      /** The turns are settled before the session is minted: the instructions
       *  have to say what they are, and that is decided server-side. */
      const earlier = prior(context);
      const secret = await fetchClientSecret({
        model: current,
        voice: currentVoice,
        memories: memory?.lines() ?? [],
        resumed: earlier.length > 0,
      });
      if (abandoned()) return stop();
      current = secret.model ?? current;
      currentVoice = secret.voice ?? currentVoice;

      audio = new AudioContext();
      micAnalyser = createAnalyser(audio, micStream);

      audioEl = new Audio();
      audioEl.autoplay = true;

      call = await connect({
        secret: secret.value,
        micStream,
        onEvent: events.handle,
        onTrack: (stream) => {
          if (abandoned()) return;
          audioEl.srcObject = stream;
          outAnalyser = createAnalyser(audio, stream);
        },
        onClose: (reason) => {
          if (!call) return;
          if (reason) fail(reason);
          stop();
        },
      });
      if (abandoned()) return stop();

      /**
       * An earlier conversation, laid back down turn by turn ahead of anything
       * said in this one. No `response.create` behind it: it is history to be
       * read, not a question waiting on an answer.
       */
      for (const turn of earlier) call.send(historyItem(turn));

      meter.start();
      setState('listening');
    } catch (err) {
      fail(err?.message ?? String(err));
      stop();
    } finally {
      connecting = false;
    }
  }

  function stop() {
    generation++;
    const closing = call;
    call = null;
    meter.stop();
    closing?.close();
    micStream?.getTracks().forEach((track) => track.stop());
    audio?.close();
    if (audioEl) audioEl.srcObject = null;
    micStream = audio = audioEl = null;
    muted = false;
    micAnalyser = outAnalyser = null;
    events.reset();
    setState('idle');
  }

  function send(text) {
    const content = text.trim();
    if (!content || !call?.open) return;
    messages.push({ role: 'user', content });
    emit('message', { role: 'user', content });
    call.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] },
    });
    call.send({ type: 'response.create' });
    setState('thinking');
  }

  return {
    on,
    start,
    stop,
    send,
    /**
     * The turns of a conversation being picked up again. They are handed over
     * on the next dial rather than now — there may be no call yet, and this is
     * what a redial re-sends, so a voice change mid-conversation keeps it.
     */
    get context() { return context; },
    set context(turns) { context = Array.isArray(turns) ? turns : []; },
    get messages() { return messages; },
    get connected() { return call?.open ?? false; },
    get busy() { return events.responding; },
    get state() { return state; },
    get muted() { return muted; },
    set muted(next) {
      muted = Boolean(next);
      micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    },
    get model() { return current; },
    set model(next) { current = next; picked++; },
    get voice() { return currentVoice; },
    set voice(next) { currentVoice = next; picked++; },
    get stale() { return !!call && picked !== mintedPick; },
    cancel() {
      if (events.responding) call?.send({ type: 'response.cancel' });
    },
  };
}
