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

Tater has no tools beyond memory. He answers from what the model already knows:
no web search, no retrieval. Ask him about this morning and he should say he
doesn't know, which is what the system prompt asks for.

The two exceptions are `remember` and `forget`, which the page executes itself
against browser storage. Remote MCP servers, which the Realtime API executes on
its own, would be a few lines in the same place: `sessionConfig()` in
`src/server/persona.js` already builds the tool list, and anything needing auth
headers stays in the server-side `/v1/realtime/client_secrets` payload rather
than in the page.

### The tools panel, ahead of the tools

`tools` opens the panel those switches will live in. It is empty today, and says
so: Tater has nothing to switch beyond memory, which keeps its own switch in
the `memory` panel. `/api/models` publishes the list — `switches`, empty for now
— and the page renders one row per entry, so a tool declared in `sessionConfig()`
becomes a switch without a change to the panel.

The switches themselves are per browser, kept in `localStorage`, and they can
only ever take a tool away. What exists stays the server's to decide.

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
