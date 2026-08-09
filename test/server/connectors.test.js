import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApiMiddleware } from '../../src/server/api.js';
import { loadConfig } from '../../src/server/config.js';
import { AGENTS, splitArgs } from '../../src/server/connectors/agents.js';
import { createConnectors } from '../../src/server/connectors/index.js';
import { connectorTools } from '../../src/server/connectors/tools.js';
import { buildTools, connectorBlock, tasksBlock } from '../../src/server/persona.js';
import { startOpenAIStub } from '../helpers/openai-stub.js';
import { withServer } from '../helpers/request.js';

const FAKE = fileURLToPath(new URL('../helpers/fake-agent.js', import.meta.url));

/** A settings file per test, so no test ever writes the repo's own. */
function scratchSettings() {
  return join(tmpdir(), `tater-connectors-${Math.random().toString(36).slice(2)}.json`);
}

/** Wired to the stand-in CLI rather than a real one: same flags, no model. */
const wired = (extra = {}) => ({
  CONNECTORS: 'claude',
  CLAUDE_COMMAND: `node "${FAKE}" claude`,
  CONNECTOR_FILE: scratchSettings(),
  ...extra,
});

function registry(env = {}) {
  const connectors = createConnectors(loadConfig({ CONNECTOR_FILE: scratchSettings(), ...env }));
  after(() => connectors.close());
  return connectors;
}

async function until(ok, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = ok();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('nothing arrived in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('which agents are connected', () => {
  it('is nobody unless CONNECTORS says otherwise', () => {
    const config = loadConfig({});
    assert.deepEqual(config.connectorNames, []);
    assert.equal(buildTools({ memory: true }).some((t) => t.name === 'dispatch_task'), false);
  });

  it('takes the ones it knows, in the order they were named', () => {
    const { connectorNames, connectors } = loadConfig({ CONNECTORS: 'codex, claude, grok, opencode' });
    assert.deepEqual(connectorNames, ['codex', 'claude', 'grok', 'opencode']);
    assert.deepEqual(Object.keys(connectors.agents), ['codex', 'claude', 'grok', 'opencode']);
  });

  it('drops an agent it has never heard of rather than refusing to boot', () => {
    assert.deepEqual(loadConfig({ CONNECTORS: 'claude, cursor' }).connectorNames, ['claude']);
    assert.deepEqual(loadConfig({ CONNECTORS: 'devin' }).connectorNames, []);
  });

  it('defaults each agent to its own CLI and its safer mode', () => {
    const { connectors } = loadConfig({ CONNECTORS: 'claude, codex, opencode, grok' });
    assert.deepEqual(connectors.agents.claude.command, ['claude']);
    assert.equal(connectors.agents.claude.mode, 'acceptEdits');
    assert.equal(connectors.agents.codex.mode, 'workspace-write');
    assert.equal(connectors.agents.opencode.mode, 'default');
    assert.equal(connectors.agents.grok.mode, 'acceptEdits');
    assert.equal(connectors.timeoutMs, 900_000);
    assert.equal(connectors.limit, 3);
  });

  it('lets the command be a whole command line, so the CLI can be wrapped', () => {
    const { connectors } = loadConfig({
      CONNECTORS: 'codex',
      CODEX_COMMAND: 'docker exec -w "/work space" dev codex',
    });
    assert.deepEqual(connectors.agents.codex.command, ['docker', 'exec', '-w', '/work space', 'dev', 'codex']);
    assert.deepEqual(splitArgs(''), []);
    assert.deepEqual(splitArgs("a 'b c' d"), ['a', 'b c', 'd']);
  });

  it('is the seed for the registry, which is what the panel then edits', () => {
    const connectors = registry({ CONNECTORS: 'claude' });
    assert.deepEqual(connectors.agents, ['claude']);

    assert.equal(connectors.configure({ agents: { claude: { enabled: false } } }).ok, true);
    assert.deepEqual(connectors.agents, []);
    assert.deepEqual(connectors.tools, []);

    assert.equal(connectors.configure({ agents: { codex: { enabled: true, mode: 'read-only' } } }).ok, true);
    assert.deepEqual(connectors.agents, ['codex']);
    assert.ok(connectors.tools.some((t) => t.name === 'dispatch_task'));
  });

  it('turns down a setting that would not work, and keeps what it had', () => {
    const connectors = registry({ CONNECTORS: 'claude' });

    const bad = connectors.configure({ agents: { claude: { mode: 'yolo' } } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /no mode called yolo/);

    assert.equal(connectors.configure({ cwd: '/nowhere/at/all' }).ok, false);
    assert.equal(connectors.configure({ limit: 99 }).ok, false);
    assert.equal(connectors.configure({ agents: { cursor: { enabled: true } } }).ok, false);
    assert.deepEqual(connectors.agents, ['claude'], 'nothing changed');
  });

  it('describes the agents it is switched off as well as on', () => {
    const { agents, cwd } = registry().settings();
    assert.deepEqual(agents.map((a) => a.name), ['claude', 'codex', 'opencode', 'grok']);
    assert.deepEqual(agents.map((a) => a.enabled), [false, false, false, false]);
    assert.ok(agents[0].modes.includes('acceptEdits'));
    assert.ok(agents[1].modes.includes('workspace-write'));
    assert.equal(cwd, process.cwd());
  });

  it('saves the settings, and never the command line, so a restart keeps them', () => {
    const file = scratchSettings();
    const connectors = registry({ CONNECTORS: 'claude', CONNECTOR_FILE: file });

    assert.equal(connectors.configure({ agents: { codex: { enabled: true } }, limit: 2 }).saved, true);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.limit, 2);
    assert.equal(saved.agents.codex.enabled, true);
    assert.ok(!('command' in saved.agents.codex), 'which binary runs is not the browser’s to set');

    /** A second registry over the same file opens where the first left off. */
    const again = registry({ CONNECTOR_FILE: file });
    assert.deepEqual(again.agents, ['claude', 'codex']);
  });
});

describe('what the model is told', () => {
  it('declares no connector tool until an agent is on', () => {
    assert.deepEqual(connectorTools([]), []);
    assert.equal(connectorBlock([]), '');
    assert.equal(connectorBlock(undefined), '');
  });

  it('names the agents that are on, in the tools and in the prompt', () => {
    const tools = connectorTools(['claude', 'codex']);
    assert.deepEqual(tools.map((t) => t.name), ['dispatch_task', 'check_task', 'cancel_task']);

    const dispatch = tools[0];
    assert.deepEqual(dispatch.parameters.properties.agent.enum, ['claude', 'codex']);
    assert.match(dispatch.description, /Claude Code/);
    assert.match(dispatch.description, /Codex/);

    const block = connectorBlock(['claude', 'codex']);
    assert.match(block, /Claude Code and Codex/);
    assert.match(block, /\[workspace\]/, 'it has to know a workspace line is not the person');
  });

  it('carries the memory tools and the connector tools together', () => {
    const tools = buildTools({ memory: true, connectors: ['claude'] });
    assert.deepEqual(tools.map((t) => t.name), ['remember', 'forget', 'dispatch_task', 'check_task', 'cancel_task']);

    const without = buildTools({ memory: false, connectors: ['claude'] });
    assert.deepEqual(without.map((t) => t.name), ['dispatch_task', 'check_task', 'cancel_task']);
  });

  it('recaps the work from before this call, so a redial is not amnesia', () => {
    assert.equal(tasksBlock([]), '');
    const block = tasksBlock([
      { id: '1', agent: 'claude', task: 'fix the build', status: 'done', ran_for: '4s', summary: 'fixed it' },
      { id: '2', agent: 'claude', task: 'ship it', status: 'running', ran_for: '9s' },
    ]);
    assert.match(block, /task 1, with claude, "fix the build" — done after 4s: fixed it/);
    assert.match(block, /task 2, with claude, "ship it" — running for 9s/);
  });

  it('mints a session carrying whatever is on at that moment', async () => {
    const stub = await startOpenAIStub();
    after(() => stub.close());

    const connectors = registry({ CONNECTORS: 'claude' });
    const config = loadConfig({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: stub.baseUrl });
    const middleware = createApiMiddleware(config, connectors);

    await withServer(middleware, async (request) => {
      await request('/api/session', post({}));
      const { session } = stub.requests.at(-1).body;
      assert.ok(session.tools.some((t) => t.name === 'dispatch_task'));
      assert.match(session.instructions, /Claude Code/);

      /** Switched off between two calls, the next one goes out without them. */
      connectors.configure({ agents: { claude: { enabled: false } } });
      await request('/api/session', post({}));
      const after = stub.requests.at(-1).body.session;
      assert.equal(after.tools.some((t) => t.name === 'dispatch_task'), false);
      assert.equal(/Claude Code/.test(after.instructions), false);
    });
  });
});

describe('handing work to an agent', () => {
  it('dispatches, runs it for real, and reports what came back', async () => {
    const connectors = registry(wired());

    const dispatched = connectors.run('dispatch_task', { task: 'tidy the sauce' });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.status, 'running');
    assert.equal(dispatched.agent, 'claude');

    const done = await until(() => {
      const task = connectors.run('check_task', { id: dispatched.id });
      return task.status !== 'running' ? task : null;
    });
    assert.equal(done.status, 'done');
    assert.match(done.summary, /claude did: tidy the sauce/);
  });

  it('reports a failure as one, with what the agent said', async () => {
    const connectors = registry(wired());
    const { id } = connectors.run('dispatch_task', { task: 'fail on purpose' });

    const settled = await until(() => {
      const task = connectors.run('check_task', { id });
      return task.status !== 'running' ? task : null;
    });
    assert.equal(settled.status, 'failed');
    assert.match(settled.error, /the build is on fire/);
  });

  it('stops one that is still going, and says so', async () => {
    const connectors = registry(wired());
    const { id } = connectors.run('dispatch_task', { task: 'sleep for a while' });

    assert.equal(connectors.run('cancel_task', { id }).ok, true);
    const settled = await until(() => {
      const task = connectors.run('check_task', { id });
      return task.status !== 'running' ? task : null;
    });
    assert.equal(settled.status, 'cancelled');
  });

  it('runs the agent in the workspace, without handing it our key', async () => {
    const connectors = registry(wired({ CONNECTOR_CWD: tmpdir() }));
    process.env.OPENAI_API_KEY = 'sk-should-not-travel';
    after(() => { delete process.env.OPENAI_API_KEY; });

    const { id } = connectors.run('dispatch_task', { task: 'where am i' });
    const settled = await until(() => {
      const task = connectors.run('check_task', { id });
      return task.status !== 'running' ? task : null;
    });

    assert.match(settled.summary, /key=undefined/, 'the key stays in this process');
    assert.match(settled.summary, /PWD=/);
    assert.ok(settled.cwd.length, 'the task records where it ran');
  });

  it('refuses to dispatch when nothing is switched on', () => {
    const connectors = registry();
    const result = connectors.run('dispatch_task', { task: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.error, /no coding agent is switched on/);
  });

  it('refuses an empty task, and a task number that is not there', () => {
    const connectors = registry(wired());
    assert.equal(connectors.run('dispatch_task', { task: '   ' }).ok, false);
    assert.equal(connectors.run('check_task', { id: '404' }).ok, false);
    assert.equal(connectors.run('cancel_task', { id: '404' }).ok, false);
  });

  it('holds the line on how many run at once', () => {
    const connectors = registry(wired({ CONNECTOR_LIMIT: '1' }));
    assert.equal(connectors.run('dispatch_task', { task: 'sleep one' }).ok, true);
    const second = connectors.run('dispatch_task', { task: 'sleep two' });
    assert.equal(second.ok, false);
    assert.match(second.error, /already running/);
  });

  it('lists what was dispatched when asked for everything', () => {
    const connectors = registry(wired());
    assert.deepEqual(connectors.run('check_task', {}).tasks, []);
    connectors.run('dispatch_task', { task: 'sleep a bit' });
    assert.equal(connectors.run('check_task', {}).tasks.length, 1);
  });

  it('still reaches a running task after its agent is switched off', () => {
    const connectors = registry(wired());
    const { id } = connectors.run('dispatch_task', { task: 'sleep through it' });
    connectors.configure({ agents: { claude: { enabled: false } } });

    assert.equal(connectors.run('check_task', { id }).ok, true, 'you can still look');
    assert.equal(connectors.run('cancel_task', { id }).ok, true, 'and still stop it');
  });
});

describe('the connector API', () => {
  const serve = (env = {}) => {
    const connectors = registry(env);
    return { connectors, middleware: createApiMiddleware(loadConfig({}), connectors) };
  };

  it('reads the setup and writes a change back', async () => {
    const { middleware } = serve();

    await withServer(middleware, async (request) => {
      const read = await request('/api/connectors');
      assert.equal(read.status, 200);
      assert.equal(read.body.agents.length, 4);

      const saved = await request('/api/connectors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agents: { claude: { enabled: true } } }),
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.ok, true);
      assert.equal(saved.body.agents.find((a) => a.name === 'claude').enabled, true);
    });
  });

  it('turns down a setup it cannot apply with a 400', async () => {
    const { middleware } = serve();

    await withServer(middleware, async (request) => {
      const { status, body } = await request('/api/connectors', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/nowhere/at/all' }),
      });
      assert.equal(status, 400);
      assert.equal(body.ok, false);
    });
  });

  it('lists the tasks, and stops one', async () => {
    const { connectors, middleware } = serve(wired());

    await withServer(middleware, async (request) => {
      const empty = await request('/api/tasks');
      assert.deepEqual(empty.body.agents, ['claude']);
      assert.deepEqual(empty.body.tasks, []);
      assert.equal(empty.body.announce, true);

      const { id } = connectors.run('dispatch_task', { task: 'sleep on it' });
      const listed = await request('/api/tasks');
      assert.equal(listed.body.tasks.length, 1);

      const stopped = await request(`/api/tasks/${id}/stop`, { method: 'POST' });
      assert.equal(stopped.status, 200);

      /** The status lands when the child actually goes, not when it is asked to. */
      await until(() => connectors.run('check_task', { id }).status === 'cancelled');

      const gone = await request(`/api/tasks/${id}/stop`, { method: 'POST' });
      assert.equal(gone.status, 409, 'it is over — there is nothing left to stop');
    });
  });

  /**
   * The call runs browser-to-OpenAI, so a tool call lands in the page and the
   * page hands it back here. That route is the whole reason this server can
   * dispatch at all.
   */
  it('runs a tool call the page passes on', async () => {
    const { middleware } = serve(wired());

    await withServer(middleware, async (request) => {
      const dispatched = await request('/api/connectors/run', post({
        name: 'dispatch_task',
        args: { task: 'sleep on it' },
      }));
      assert.equal(dispatched.status, 200);
      assert.equal(dispatched.body.ok, true);
      assert.equal(dispatched.body.status, 'running');

      const checked = await request('/api/connectors/run', post({
        name: 'check_task',
        args: { id: dispatched.body.id },
      }));
      assert.equal(checked.body.ok, true);
      assert.equal(checked.body.id, dispatched.body.id);
    });
  });

  it('will not run anything that is not a connector tool', async () => {
    const { middleware } = serve(wired());

    await withServer(middleware, async (request) => {
      for (const name of ['remember', 'spawn', '', undefined]) {
        const { status, body } = await request('/api/connectors/run', post({ name, args: {} }));
        assert.equal(status, 404, `${name} should not be runnable`);
        assert.equal(body.ok, false);
      }
    });
  });

  it('answers a dispatch that fails with the reason, not a 500', async () => {
    const { middleware } = serve();

    await withServer(middleware, async (request) => {
      const { status, body } = await request('/api/connectors/run', post({
        name: 'dispatch_task',
        args: { task: 'anything' },
      }));
      assert.equal(status, 200, 'the model is waiting on this — it gets an answer');
      assert.equal(body.ok, false);
      assert.match(body.error, /no coding agent is switched on/);
    });
  });

  /**
   * There are no accounts here and these routes spawn processes that edit
   * files, so a request that names an origin has to name ours.
   */
  it('refuses a change that came from another page', async () => {
    const { middleware } = serve(wired());

    await withServer(middleware, async (request) => {
      const elsewhere = { origin: 'http://evil.example', 'content-type': 'application/json' };

      const configure = await request('/api/connectors', {
        method: 'PUT',
        headers: elsewhere,
        body: JSON.stringify({ agents: { claude: { mode: 'bypassPermissions' } } }),
      });
      assert.equal(configure.status, 403);

      const run = await request('/api/connectors/run', {
        method: 'POST',
        headers: elsewhere,
        body: JSON.stringify({ name: 'dispatch_task', args: { task: 'rm -rf' } }),
      });
      assert.equal(run.status, 403);

      /** Reading is left alone: it changes nothing and leaks nothing secret. */
      assert.equal((await request('/api/tasks', { headers: { origin: 'http://evil.example' } })).status, 200);
    });
  });

  it('has no connector routes at all on a server without a registry', async () => {
    const middleware = createApiMiddleware(loadConfig({ OPENAI_API_KEY: 'sk-test' }));

    await withServer(middleware, async (request) => {
      assert.equal((await request('/api/connectors')).status, 404);
      assert.equal((await request('/api/tasks')).status, 404);
      assert.equal((await request('/api/connectors/run', post({ name: 'check_task' }))).status, 404);
    });
  });
});

describe('reading what an agent printed', () => {
  const parse = (name, stdout, stderr = '') => AGENTS[name].parse(stdout, stderr);

  it('takes the result out of each CLI’s own shape', () => {
    assert.equal(parse('claude', JSON.stringify({ type: 'result', result: 'done it' })).summary, 'done it');
    assert.equal(
      parse('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done it' } })).summary,
      'done it',
    );
    assert.equal(
      parse('opencode', JSON.stringify({ type: 'text', part: { type: 'text', text: 'done it' } })).summary,
      'done it',
    );
    assert.equal(parse('grok', JSON.stringify({ text: 'done it' })).summary, 'done it');
  });

  it('reads an error as one rather than as a summary', () => {
    const claude = parse('claude', JSON.stringify({ type: 'result', is_error: true, result: 'it broke' }));
    assert.equal(claude.error, 'it broke');
    assert.equal(claude.summary, undefined);
  });

  it('keeps the tail of the output when it recognises no shape at all', () => {
    assert.match(parse('claude', 'just some prose about it').summary, /just some prose/);
    assert.match(parse('codex', '', 'it fell over').summary, /it fell over/);
  });

  it('is not thrown by a log line in the middle of the stream', () => {
    const stream = [
      'warning: something unrelated',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      '{ not json',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last' } }),
    ].join('\n');
    assert.equal(parse('codex', stream).summary, 'last');
  });
});
