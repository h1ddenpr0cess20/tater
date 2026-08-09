import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createTaskBoard } from '../../src/client/tasks.js';
import { createConnectorsPanel } from '../../src/client/ui/connectors.js';
import { loadPage, withGlobals } from '../helpers/dom.js';

const SETUP = {
  cwd: '/work',
  timeout: 900,
  limit: 3,
  announce: true,
  agents: [
    {
      name: 'claude',
      label: 'Claude Code',
      enabled: false,
      model: '',
      mode: 'acceptEdits',
      modes: ['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
      cwd: '',
      command: 'claude',
    },
    {
      name: 'codex',
      label: 'Codex',
      enabled: true,
      model: 'o3',
      mode: 'workspace-write',
      modes: ['read-only', 'workspace-write', 'danger-full-access'],
      cwd: '',
      command: 'codex',
    },
  ],
};

const task = (over = {}) => ({
  id: '1',
  agent: 'codex',
  label: 'Codex',
  status: 'running',
  task: 'fix the build',
  ran_for: '4s',
  cwd: '/work',
  startedAt: Date.now() - 4000,
  endedAt: null,
  ...over,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

describe('createConnectorsPanel', () => {
  let page;
  let panel;
  let board;
  let restore;
  let sent;

  /** The panel talks to the server through the api module, which uses fetch. */
  function wire({ tasks = [], put = (patch) => ({ ...clone(SETUP), ok: true, patch }) } = {}) {
    sent = [];
    restore = withGlobals({
      fetch: async (url, init = {}) => {
        sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
        let body = {};
        if (url === '/api/connectors') {
          body = init.method ? put(JSON.parse(init.body)) : clone(SETUP);
        } else if (url === '/api/tasks') {
          body = { agents: ['codex'], announce: true, tasks };
        } else if (url.endsWith('/stop')) {
          body = task({ status: 'cancelled', endedAt: Date.now() });
        }
        return { ok: true, status: 200, json: async () => body };
      },
    });
  }

  beforeEach(async () => {
    page = await loadPage();
    restore = () => {};
    wire();
    board = createTaskBoard({ interval: 60_000 });
    panel = createConnectorsPanel({ root: page.document, board });
  });

  afterEach(() => {
    restore();
    board.close();
    page.close();
  });

  it('finds every element it needs in the shipped markup', () => {
    for (const sel of [
      '#connectors', '#connectors-setup', '#connectors-list',
      '#connectors-toggle', '#connectors-save', '#connectors-close', '#connectors-note',
    ]) {
      assert.ok(page.$(sel), `${sel} is missing from index.html`);
    }
  });

  it('opens and closes from the one button, and says so out loud', async () => {
    assert.equal(panel.isOpen, false);
    page.$('#connectors-toggle').click();
    assert.equal(panel.isOpen, true);
    assert.equal(page.$('#connectors-toggle').getAttribute('aria-expanded'), 'true');

    page.$('#connectors-close').click();
    assert.equal(panel.isOpen, false);
    assert.equal(page.$('#connectors-toggle').getAttribute('aria-expanded'), 'false');
  });

  it('draws every agent the server knows, on or off', async () => {
    await panel.load();
    const agents = page.$$('#connectors-setup .agent');
    assert.equal(agents.length, 2);
    assert.equal(agents[0].dataset.on, 'false');
    assert.equal(agents[1].dataset.on, 'true');
    assert.equal(page.$$('#connectors-setup .agent-name')[1].textContent, 'Codex');
  });

  /** A mode that reaches past the workspace is the one thing worth a warning. */
  it('warns about a mode that can act outside the workspace', async () => {
    await panel.load();
    const [claude] = page.$$('#connectors-setup .agent');
    const mode = claude.querySelector('select');

    assert.equal(claude.querySelector('.agent-warn').textContent, '');

    mode.value = 'bypassPermissions';
    mode.dispatchEvent(new page.window.Event('change'));
    assert.match(claude.querySelector('.agent-warn').textContent, /outside the workspace/);
  });

  it('saves nothing until something is edited, then sends the whole setup', async () => {
    await panel.load();
    assert.equal(page.$('#connectors-save').disabled, true);

    const [claude] = page.$$('#connectors-setup .agent');
    claude.querySelector('.switch').click();
    assert.equal(page.$('#connectors-save').disabled, false);

    page.$('#connectors-save').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const put = sent.find((r) => r.method === 'PUT');
    assert.ok(put, 'the panel never sent the change');
    assert.equal(put.body.agents.claude.enabled, true);
    assert.equal(put.body.agents.codex.enabled, true, 'the untouched one rides along as it was');
    assert.equal(put.body.cwd, '/work');
    assert.equal(put.body.limit, 3);
  });

  it('says what the server said when a setup will not take', async () => {
    restore();
    wire({ put: () => { throw new Error('there is no directory at /nowhere'); } });

    await panel.load();
    page.$$('#connectors-setup .agent')[0].querySelector('.switch').click();
    page.$('#connectors-save').click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const note = page.$('#connectors-note');
    assert.match(note.textContent, /no directory at \/nowhere/);
    assert.ok(note.classList.contains('error'));
    assert.equal(page.$('#connectors-save').disabled, false, 'the edit is still there to fix');
  });

  it('tells you where to start when there is nothing to show', async () => {
    await panel.load();
    assert.match(page.$('#connectors-list .empty').textContent, /Switch an agent on/);

    await board.refresh();
    panel.render();
    assert.match(page.$('#connectors-list .empty').textContent, /Nothing dispatched yet/);
  });

  it('draws a task with what it is, where it ran and how it went', async () => {
    restore();
    wire({ tasks: [task({ status: 'done', summary: 'fixed it', endedAt: Date.now() })] });

    await board.refresh();
    panel.render();

    const row = page.$('#connectors-list .task');
    assert.equal(row.dataset.status, 'done');
    assert.equal(row.querySelector('.task-who').textContent, 'codex 1');
    assert.equal(row.querySelector('.task-state').textContent, 'done');
    assert.equal(row.querySelector('.task-where').textContent, '/work');
    assert.equal(row.querySelector('.task-what').textContent, 'fix the build');
    assert.equal(row.querySelector('.task-said').textContent, 'fixed it');
  });

  it('marks a failure as one, in the row and in the words', async () => {
    restore();
    wire({ tasks: [task({ status: 'failed', error: 'it broke', endedAt: Date.now() })] });

    await board.refresh();
    panel.render();

    const row = page.$('#connectors-list .task');
    assert.equal(row.dataset.status, 'failed');
    assert.equal(row.querySelector('.task-state').textContent, 'failed');
    assert.ok(row.querySelector('.task-said').classList.contains('error'));
  });

  /** Dispatching goes through the conversation. Stopping is the exception. */
  it('offers a stop only while a task is running, and only once', async () => {
    restore();
    wire({ tasks: [task()] });

    await board.refresh();
    panel.render();

    const stop = page.$('#connectors-list .task button');
    assert.equal(stop.textContent, 'stop');
    stop.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(sent.some((r) => r.url === '/api/tasks/1/stop' && r.method === 'POST'));
    assert.equal(page.$('#connectors-list .task-state').textContent, 'stopping');
    assert.equal(page.$('#connectors-list .task button').disabled, true);
  });

  it('counts the running work on the button that opens it', async () => {
    restore();
    wire({ tasks: [task({ id: '1' }), task({ id: '2' })] });

    await board.refresh();
    const toggle = page.$('#connectors-toggle');
    assert.equal(toggle.textContent, 'connectors 2');
    assert.ok(toggle.classList.contains('live'));

    restore();
    wire({ tasks: [task({ id: '1', status: 'done', endedAt: Date.now() })] });
    await board.refresh();
    assert.equal(toggle.textContent, 'connectors');
    assert.equal(toggle.classList.contains('live'), false);
  });
});
