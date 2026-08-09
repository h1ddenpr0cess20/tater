# Configuration

Both `npm run dev` and `npm start` read `.env`.

| Variable | Default | Role |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. Stays in the Node process. |
| `MEMORY` | `true` | The `remember` and `forget` tools, and the memory block in the prompt |
| `OPENAI_VOICE` | `ash` | Which voice the picker opens on (`ash`, `alloy`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`) |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | Preselected in the picker when the key can reach it |
| `OPENAI_BASE_URL` | OpenAI | Points the proxy at a gateway or a stub |
| `PORT` | `5173` | |
| `SSL_KEY`, `SSL_CERT` | — | Paths to a real certificate; `npm start` then serves HTTPS |
| `CONNECTORS` | — | Coding agents Tater may hand work to: `claude`, `codex`, `opencode`, `grok` |
| `CONNECTOR_CWD` | `process.cwd()` | The workspace agents run in |
| `CONNECTOR_TIMEOUT` | `900` | Seconds before a task is stopped |
| `CONNECTOR_LIMIT` | `3` | How many tasks may run at once |
| `CONNECTOR_FILE` | `connectors.json` | Where the panel saves the setup |
| `CONNECTOR_ANNOUNCE` | `true` | Tell Tater when a task finishes |
| `<AGENT>_COMMAND` | the CLI's own name | A whole command line, so the CLI can be wrapped |
| `<AGENT>_MODEL`, `<AGENT>_ARGS`, `<AGENT>_CWD` | — | Per agent |
| `CLAUDE_PERMISSION_MODE` | `acceptEdits` | |
| `CODEX_SANDBOX` | `workspace-write` | |
| `OPENCODE_PERMISSION_MODE` | `default` | |
| `GROK_PERMISSION_MODE` | `acceptEdits` | |

The picker lists every voice the Realtime API takes. `ash` is the default: dry
and a little put out, which is the register the persona is written in. `cedar`
and `marin` are the realtime-native pair and the most naturalistic; `ballad` has
a drier lift; `alloy`, `coral`, `echo`, `sage`, `shimmer` and `verse` predate
them and read flatter. The voice is pinned into the client secret, so picking one
mid-call hangs up and dials again rather than switching voices under the
conversation — which would make him a different character between turns. An
`OPENAI_VOICE` outside the list is still honoured and joins the picker at the
front: the list in `src/server/config.js` goes stale, the API doesn't.

## On a phone

```sh
npm run dev:lan           # → https://192.168.x.x:5173, printed on start
```

Microphone access needs a secure context. `localhost` is one; a LAN address over
plain HTTP is not — `navigator.mediaDevices` doesn't exist there, so the page
can't even raise the mic prompt. The `:lan` scripts serve HTTPS with a
self-signed certificate, cached in `node_modules/.vite/`.

No browser trusts that certificate, so the phone shows a warning the first time
("Advanced" → proceed on Chrome, "Show details" → "visit this website" on
Safari). Tap through it once per device. To skip it, point `SSL_KEY` and
`SSL_CERT` at a certificate the device already trusts —
[mkcert](https://github.com/FiloSottile/mkcert) issues one for a LAN IP.

## Docker

```sh
docker run --rm -p 5173:5173 -e OPENAI_API_KEY=sk-... h1ddenpr0cess20/tater
```

Images go to Docker Hub on every push to `main` (`latest`) and on `v*` tags
(`1.2.3`, `1.2`), for `linux/amd64` and `linux/arm64`. Configuration is the same
set of variables as `.env` — pass them with `-e` or `--env-file .env`.

The container serves HTTP on `PORT` and expects TLS to be terminated in front of
it; to serve TLS from the container, mount a certificate and set `SSL_KEY` and
`SSL_CERT`. Build it yourself with `docker build -t tater .`. Publishing from a
fork needs a `DOCKERHUB_TOKEN` secret, plus a `DOCKERHUB_USERNAME` variable if
your Docker Hub account isn't `h1ddenpr0cess20`.

## Tools

Tater has no search and no retrieval. He answers from what the model already
knows — ask him about this morning and he should say he doesn't know, which is
what the system prompt asks for.

What he does have is `remember` and `forget`, which the page executes itself
against browser storage, and the connectors below, which the server executes.
Remote MCP servers, which the Realtime API executes on its own, would be a few
lines in the same place: `sessionConfig()` in `src/server/persona.js` already
builds the tool list, and anything needing auth headers stays in the
server-side `/v1/realtime/client_secrets` payload rather than in the page.

### The tools panel, ahead of the tools

`tools` opens the panel those switches will live in. It is empty today, and says
so: Tater has nothing to switch beyond memory, which keeps its own switch in
the `memory` panel. `/api/models` publishes the list — `switches`, empty for now
— and the page renders one row per entry, so a tool declared in `sessionConfig()`
becomes a switch without a change to the panel.

The switches themselves are per browser, kept in `localStorage`, and they can
only ever take a tool away. What exists stays the server's to decide.

## Connectors

`connectors` opens the panel for the coding agents Tater can hand work to:
Claude Code, Codex, OpenCode and Grok Build, each run headless, once per task,
in a workspace directory. Say what you want built, Tater reads the task back,
and on a yes it goes out to an agent that reads, writes and runs things for
real.

Nothing is on by default. A connector runs a CLI that edits files on the machine
serving the page, so it is opt-in there — `CONNECTORS` names the agents to start
with, and the panel turns them on and off while the server runs. What the panel
writes goes to `connectors.json` and survives a restart.

One thing is deliberately not editable from the browser: the command each agent
is run as. That is the difference between configuring a tool and choosing which
binary this server executes, and the second one does not belong to anything a
page can reach. It comes from `<AGENT>_COMMAND`, and it takes a whole command
line, so `docker exec -w /work dev codex` wraps the CLI as well as names it.

Permission modes come from each CLI, safest first, and the panel warns on the
ones that can act outside the workspace. The agents inherit the server's
environment minus `OPENAI_API_KEY` — the key that dials the call is not the
agent's to spend.

Three tools do the work: `dispatch_task` hands one task to one agent and returns
a number immediately, `check_task` reports where it stands, and `cancel_task`
stops it. Whatever an agent already wrote to disk stays written when a task is
stopped or times out.

### How a tool call gets to the server

Tater's call runs browser-to-OpenAI over WebRTC, so a tool call the model makes
arrives in the page and nowhere else. The page hands the connector ones back to
the server at `POST /api/connectors/run`, which is the only reason this server
can dispatch at all. Anything that changes something — that route, and saving
the setup — is refused unless it came from this page, since there are no
accounts here and these routes spawn processes that edit files.

The panel polls `/api/tasks` while something is running, for the same reason:
there is no socket back from the server to push a status down. A task that
settles is told to the model as it lands, as a line marked `[workspace]` so it
is not mistaken for the person talking. `CONNECTOR_ANNOUNCE=false` keeps the
board and drops the telling.

Which agents are on is settled when a session is minted, so switching one on
mid-call redials — the conversation is kept, and the new tool list goes out with
it.

## The log and the memory

`log` opens past conversations, newest first. `new` closes the record and, if a
call is up, dials again — the model's memory of what was said is the call
itself, so a new call is the only thing that clears it. `clear` asks once, then
removes the log.

`memory` opens the short list of details Tater carries between calls. Ask him to
remember something and he calls `remember`; ask him to forget it and he calls
`forget`, which drops every stored line matching the keyword. You can also add a
line by hand, drop one, switch the whole thing off, or clear it. `MEMORY=false`
removes the tools and the prompt block for everyone the server serves.

Editing the list by hand takes effect on the next call rather than the current
one — the instructions are baked into the client secret, and the page has no
copy of the persona to re-send with. A `remember` the model makes mid-call needs
no such round trip: it already knows what it just stored, because the tool
result said so.

Both live in `localStorage`, in the browser that made the call — see the
[design notes](design.md#storage) for the caps and what crosses the wire.
