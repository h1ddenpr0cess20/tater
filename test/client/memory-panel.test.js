import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createMemory } from '../../src/client/memory.js';
import { createMemoryPanel } from '../../src/client/ui/memory.js';
import { loadPage } from '../helpers/dom.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('createMemoryPanel', () => {
  let page;
  let memory;
  let panel;
  let changes;

  beforeEach(async () => {
    page = await loadPage();
    memory = createMemory({ storage: fakeStorage() });
    changes = 0;
    panel = createMemoryPanel({ root: page.document, memory, onChange: () => { changes++; } });
  });

  afterEach(() => page.close());

  it('finds every element it needs in the shipped markup', () => {
    const needed = [
      '#memory', '#memory-list', '#memory-toggle', '#memory-switch',
      '#memory-clear', '#memory-close', '#memory-add', '#memory-input',
    ];
    for (const sel of needed) assert.ok(page.$(sel), `${sel} is missing from index.html`);
  });

  it('opens and closes from the one button, and says so out loud', () => {
    assert.equal(panel.isOpen, false);
    page.$('#memory-toggle').click();
    assert.equal(panel.isOpen, true);
    assert.equal(page.$('#memory-toggle').getAttribute('aria-expanded'), 'true');

    page.$('#memory-close').click();
    assert.equal(panel.isOpen, false);
    assert.equal(page.$('#memory-toggle').getAttribute('aria-expanded'), 'false');
  });

  it('says so when there is nothing remembered yet', () => {
    panel.open();
    assert.match(page.$('#memory-list').textContent, /Nothing remembered yet/);
    assert.equal(page.$('#memory-clear').disabled, true);
  });

  it('adds what is typed into the form, and clears the field', () => {
    panel.open();
    page.$('#memory-input').value = 'drinks his coffee black';
    page.$('#memory-add').dispatchEvent(new page.window.Event('submit', { cancelable: true }));

    assert.deepEqual(memory.items.map((m) => m.text), ['drinks his coffee black']);
    assert.equal(page.$('#memory-input').value, '');
    assert.equal(page.$$('.memory-item').length, 1);
    assert.equal(changes, 1);
  });

  it('ignores an empty submission rather than storing a blank line', () => {
    panel.open();
    page.$('#memory-input').value = '   ';
    page.$('#memory-add').dispatchEvent(new page.window.Event('submit', { cancelable: true }));

    assert.deepEqual(memory.items, []);
    assert.equal(changes, 0);
  });

  it('forgets the line whose own button was pressed', () => {
    memory.add('drinks his coffee black');
    memory.add('has a dog called Pebble');
    panel.open();

    page.$$('.memory-item button')[0].click();
    assert.deepEqual(memory.items.map((m) => m.text), ['has a dog called Pebble']);
    assert.equal(page.$$('.memory-item').length, 1);
  });

  it('switches memory off without dropping what is stored', () => {
    memory.add('drinks his coffee black');
    panel.open();

    page.$('#memory-switch').click();
    assert.equal(memory.enabled, false);
    assert.equal(page.$('#memory-switch').textContent, 'off');
    assert.equal(page.$('#memory-switch').getAttribute('aria-pressed'), 'false');
    assert.equal(page.$('#memory-input').disabled, true);
    assert.equal(memory.items.length, 1, 'switching off is not deleting');
    assert.deepEqual(memory.lines(), []);
  });

  it('asks once before clearing the lot', () => {
    memory.add('drinks his coffee black');
    panel.open();

    page.$('#memory-clear').click();
    assert.equal(memory.items.length, 1, 'the first press only arms it');
    assert.equal(page.$('#memory-clear').textContent, 'sure?');

    page.$('#memory-clear').click();
    assert.deepEqual(memory.items, []);
    assert.equal(page.$('#memory-clear').textContent, 'clear');
  });

  it('re-renders while open when the model stores something itself', () => {
    panel.open();
    memory.add('walks the dog at six');
    assert.equal(page.$$('.memory-item').length, 1);
  });
});
