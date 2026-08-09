# Design notes

How Tater is put together. The [README](../README.md) covers running it;
[configuration](configuration.md) covers the knobs.

## How the call is wired

The API key never reaches the browser, and the audio never reaches the proxy:

1. The page asks `POST /api/session` for a client secret, naming the model and
   voice it wants and sending whatever it has in memory. The proxy mints one
   from `/v1/realtime/client_secrets` with the persona, memories, voice, tool
   list and turn detection already attached, valid for ten minutes.
2. The page opens an `RTCPeerConnection`, adds the mic track, and POSTs its SDP
   offer straight to `/v1/realtime/calls` with that secret.
3. Audio flows browser ↔ OpenAI over WebRTC. Events flow over an `oai-events`
   data channel alongside it.

Turn-taking is server-side semantic VAD, so barge-in is free: speak over Tater and
the model truncates its own playback. `Escape` cancels the current response for
the typed path.

The picker lists every realtime model the key can reach, minus the ones that
can't hold a conversation — the `translate` and `whisper` tiers are streaming
translation and speech-to-text. Both pickers are pinned into the client secret,
so changing the model or the voice mid-call hangs up and dials again, and the
conversation doesn't carry over.

### The connectors, against the grain of that

Everything above keeps work out of the proxy: the audio bypasses it and the
events go straight to the page. The connectors are the one thing that cannot
follow, because the files an agent edits are the server's, not the browser's.

So the model's tool call lands in the page — there is nowhere else for it to
land — and the page hands the connector ones back to `POST /api/connectors/run`.
The registry that answers is made once per server rather than once per call, so
a dispatched task outlives the call that sent it out and the panel can see one
when there is no call up at all. Which agents are on is baked into the client
secret with everything else, so switching one on mid-call redials.

That inversion costs the push the other way. There is no socket from the server
down to the page, so the board polls `/api/tasks` while anything is running, and
a task that settles is injected into the conversation as a `[workspace]` line
rather than pushed as an event. It also means `/api/*` has state-changing routes
for the first time, which is what `origin.js` is for.

The proxy is connect-style middleware rather than a server, so there's only one
implementation of `/api/*`: `vite.config.js` mounts it in development and
`src/server/app.js` mounts it in front of the static handler in production. No
second process, and the key lives in one place either way.

## Storage

The log is one record per call under `tater.history.v1`; memory is a list of
lines under `tater.memory.v1`. A third key, `tater.tools.v1`, holds the tools
this browser has switched off — nothing writes it yet, because there is nothing
to switch. Neither is uploaded — audio already goes straight
to OpenAI without passing through the proxy, and the transcript doesn't go even
that far. The memory list rides in the `POST /api/session` body, which is the
same request that already names the model and voice, and the proxy keeps no
copy.

The last 40 conversations are kept, and the oldest are shed to stay inside a
300 KB budget, since that space belongs to the whole origin. Private-mode Safari
hands back a store that throws on write, so the log falls back to memory for the
life of the page rather than failing the call.

Old turns are not replayed into a new call on their own — that would make the
log a memory rather than a record. `continue` on an entry in the log is the one
way past that, and it is asked for, once, per conversation.

What goes up then is the conversation itself, not a description of one: one
`conversation.item.create` per turn on the data channel, a user message carrying
`input_text` and an assistant message carrying `output_text`, ahead of anything
said in the new call. That is the shape the realtime API takes for history, and
it is the only shape that works — flattening a transcript into a single message
leaves the model with no history at all, only somebody telling it about one.

The page says only whether it is resuming, as a boolean on the session request;
the line explaining what those turns are is written into the instructions when
the secret is minted, so it stays server-side. The replay is capped at 40 turns
and 6 KB, oldest shed first.

Memory is capped at 25 lines, each flattened to one line and cut at 600
characters; past the cap the oldest goes. `remember` and `forget` run in the
page: the model's call arrives on the data channel as
`response.function_call_arguments.done`, the page answers it against
`localStorage`, and the result goes back as a `function_call_output` followed by
a `response.create`. Without that second frame the model waits forever on its
own tool.

Memories are text the person typed or dictated, so they land inside the prompt.
Flattening and capping them in `persona.js` keeps a memory from opening a new
instruction paragraph, and the persona is always first in the string.

## States

`idle` · `listening` · `thinking` · `speaking` — each a set of targets for
jitter, lean, rock, step, spin, squash and stance. Tater eases between them, so
transitions read as the same potato changing mood rather than a cut.

- **idle** — rocks where he stands, with a fidget every few seconds.
- **listening** — leans in and settles, rocking a little quicker.
- **thinking** — lies down off his end and spins on the spot. It's the one pose
  the other three never take, which is what makes the state legible at a glance.
- **speaking** — walks a short way out and back with a waddle, squashing on
  every syllable.

The call maps onto them directly: `listening` from `speech_started` and between
turns, `thinking` from `speech_stopped` until the first audio frame, `speaking`
while the model's track is live, `idle` when there is no call.

Four nested groups keep those motions from fighting: the outer one carries world
tilt and tremor, the next spins about world up, the next owns the squash — which
stays vertical whatever the pose — and the innermost is the stance, standing him
on his end by default and laying him down to think.

## Layout

```
Dockerfile              Build the client, then serve it from src/server
index.html              Markup only — Vite's entry
src/
  client/
    main.js             The wiring, and nothing else
    styles.css          The HUD around Tater
    api.js              The server's endpoints, as functions
    history.js          Past conversations in localStorage, and picking one up
    memory.js           What it remembers between calls, in localStorage
    tools.js            Which of the server's tools this browser switched off
    tasks.js            The work agents are doing, mirrored and polled
    tater/              Geometry and animation. Knows nothing about transports
      index.js            The controller, the rig and the per-frame loop
      moods.js            Targets per conversational state
      motion.js           The spring and the chase every channel eases on
      shape.js            The tuber surface as plain numbers, no renderer
      noise.js            The value noise the lumps and the mottling share
      tuber.js            The mesh built off that surface, with the eyes on it
      skin.js             Russet mottling, painted per vertex
      environment.js      Warm even wash, so no facing of him goes dark
    session/            The call. Emits transport-agnostic events
      index.js            Lifecycle: mic, secret, connect, meter, tear down
      webrtc.js           Peer connection, data channel, SDP handshake
      events.js           Realtime server events → this vocabulary
      tools.js            remember/forget in the page; the rest routed to the server
      metering.js         Two analysers → one 0..1 number per frame
      emitter.js
    ui/
      hud.js              Status chip, transcript, caption
      history.js          The log panel behind `log`, and its `continue`
      memory.js           The memory panel behind the `memory` button
      tools.js            The tool switches behind the `tools` button — empty for now
      connectors.js       The agent setup and the work board, behind `connectors`
      controls.js         Mic (tap mutes, hold hangs up), field, send, pickers
      viewport.js         Keeps the composer above the on-screen keyboard
    vendor/
      three-d-stage.js    Starter component (renderer, lighting, camera, controls)
  server/
    index.js            Entry point
    app.js              The middleware chain
    api.js              /api/models + /api/session, and the connector routes
    openai.js           The two calls it makes
    persona.js          Who Tater is, and the session config
    origin.js           Who is allowed to ask for a change
    config.js           The environment, resolved once
    static.js           Hosting for dist/ — production only
    connectors/         Coding agents, and the tasks handed to them
      index.js            The registry: settings, tools, dispatch
      agents.js           Each CLI as a command line, and how to read it back
      settings.js         What the panel may change, checked and saved
      tasks.js            The child processes, and their status
      tools.js            The three function tools, as the model sees them
docs/                   These notes, configuration, policies, screenshots
test/                   node:test, against a stub OpenAI
.github/workflows/      CI (lint, tests, build smoke test), CodeQL, Docker publish
```

`src/client/vendor/three-d-stage.js` is a copied starter component with two
local changes, listed at the top of the file — re-copying it drops them.

## The transport seam

`session/index.js` exposes `on`, `start`, `stop`, `send`, `cancel`, `context`,
`messages`, `connected`, `busy`, `stale`, `state`, `muted`, `model`, `voice` —
and emits:

```
'state'   listening | thinking | speaking | idle
'text'    a chunk of assistant transcript
'tool'    a label while a tool works, or null
'memory'  the result of a remember/forget the model just called
'user'    a completed transcript of what the person said
'level'   0..1 sustained amplitude, per frame
'pulse'   0..1 transient, one per discrete event
'message' a completed turn, { role, content } — what the log stores
'busy'    whether a response is in flight
'done'    { model, usage }
'error'   { message }
```

Tater takes audio-shaped input:

```js
tater.setState('speaking')  // idle | listening | thinking | speaking
tater.setLevel(0.62)        // sustained amplitude 0..1, sampled per frame
tater.pulse(0.4)            // transient impulse 0..1, one per discrete event
```

Both land on the same internal energy value. `setLevel` carries the voice — two
`AnalyserNode`s, one on the mic and one on the model's track, read per frame and
smoothed with a fast attack and a slow release. `pulse` is for the beats where a
turn changes hands: it kicks the springs directly as well as the energy, so the
squash punctuates instead of strobing.

Swapping providers means writing a different `createVoiceSession()` with that
surface. `main.js` and the potato don't change.
