import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createToolSwitches } from '../../src/client/tools.js';
import { createToolsPanel } from '../../src/client/ui/tools.js';
import { loadPage } from '../helpers/dom.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('createToolsPanel', () => {
  let page;
  let switches;
  let panel;
  let changes;

  beforeEach(async () => {
    page = await loadPage();
    switches = createToolSwitches({ storage: fakeStorage() });
    changes = 0;
    panel = createToolsPanel({ root: page.document, switches, onChange: () => { changes++; } });
  });

  afterEach(() => page.close());

  it('finds every element it needs in the shipped markup', () => {
    for (const sel of ['#toolbox', '#toolbox-list', '#toolbox-toggle', '#toolbox-close']) {
      assert.ok(page.$(sel), `${sel} is missing from index.html`);
    }
  });

  it('opens and closes from the one button, and says so out loud', () => {
    assert.equal(panel.isOpen, false);
    page.$('#toolbox-toggle').click();
    assert.equal(panel.isOpen, true);
    assert.equal(page.$('#toolbox-toggle').getAttribute('aria-expanded'), 'true');

    page.$('#toolbox-close').click();
    assert.equal(panel.isOpen, false);
    assert.equal(page.$('#toolbox-toggle').getAttribute('aria-expanded'), 'false');
  });

  it('says the switches are still to come, which today they all are', () => {
    panel.open();
    assert.match(page.$('#toolbox-list').textContent, /Nothing to switch yet/);
  });

  it('renders a switch per tool once the server has some to offer', () => {
    switches.setCatalog([
      { name: 'web_search', label: 'web search' },
      { name: 'mcp:orders', label: 'orders' },
    ]);
    panel.open();

    const rows = [...page.document.querySelectorAll('.tool-item')];
    assert.deepEqual(rows.map((row) => row.querySelector('.tool-name').textContent),
      ['web search', 'orders']);
    assert.deepEqual(rows.map((row) => row.querySelector('.switch').textContent), ['on', 'on']);
  });

  it('switches one off, tells the page, and keeps saying so', () => {
    switches.setCatalog([{ name: 'web_search', label: 'web search' }]);
    panel.open();

    page.document.querySelector('.tool-item .switch').click();

    assert.equal(switches.enabled('web_search'), false);
    assert.equal(changes, 1);
    const row = page.document.querySelector('.tool-item');
    assert.equal(row.dataset.on, 'false');
    assert.equal(row.querySelector('.switch').getAttribute('aria-pressed'), 'false');
    assert.equal(row.querySelector('.switch').textContent, 'off');
  });
});
