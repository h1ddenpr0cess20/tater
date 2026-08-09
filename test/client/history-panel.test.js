import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createHistory } from '../../src/client/history.js';
import { createHistoryPanel } from '../../src/client/ui/history.js';
import { loadPage } from '../helpers/dom.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('createHistoryPanel', () => {
  let page;
  let history;
  let panel;
  let fresh;
  let picked;

  beforeEach(async () => {
    page = await loadPage();
    history = createHistory({ storage: fakeStorage() });
    fresh = 0;
    picked = [];
    panel = createHistoryPanel({
      root: page.document,
      history,
      onNew: () => { fresh++; },
      onResume: (id) => picked.push(id),
    });
  });

  afterEach(() => page.close());

  it('finds every element it needs in the shipped markup', () => {
    for (const sel of ['#history', '#history-log', '#history-toggle', '#history-new', '#history-clear', '#history-close']) {
      assert.ok(page.$(sel), `${sel} is missing from index.html`);
    }
  });

  it('opens and closes from the one button, and says so out loud', () => {
    assert.equal(panel.isOpen, false);
    page.$('#history-toggle').click();
    assert.equal(panel.isOpen, true);
    assert.equal(page.$('#history-toggle').getAttribute('aria-expanded'), 'true');

    page.$('#history-close').click();
    assert.equal(panel.isOpen, false);
    assert.equal(page.$('#history-toggle').getAttribute('aria-expanded'), 'false');
  });

  it('renders both sides of a stored conversation', () => {
    history.begin({ model: 'gpt-realtime', voice: 'cedar' });
    history.append({ role: 'user', content: 'what are you, exactly?' });
    history.append({ role: 'assistant', content: 'A potato. Ask the follow-up, everyone does.' });
    panel.open();

    const turns = [...page.document.querySelectorAll('#history-log .turn')];
    assert.deepEqual(turns.map((el) => el.dataset.role), ['user', 'assistant']);
    assert.match(turns[1].textContent, /A potato/);
    assert.match(page.$('#history-log header').textContent, /cedar/);
  });

  it('renders model output as text, never as markup', () => {
    history.append({ role: 'assistant', content: '<img src=x onerror=alert(1)>' });
    panel.open();
    const turn = page.$('#history-log .turn[data-role="assistant"]');
    assert.equal(turn.querySelector('img'), null);
    assert.match(turn.textContent, /<img src=x/);
  });

  it('redraws while it is open, and leaves it alone while it is not', () => {
    panel.open();
    history.append({ role: 'user', content: 'live' });
    assert.equal(page.document.querySelectorAll('#history-log .turn').length, 1);

    panel.close();
    history.append({ role: 'assistant', content: 'unseen for now' });
    assert.equal(page.document.querySelectorAll('#history-log .turn').length, 1);
    panel.open();
    assert.equal(page.document.querySelectorAll('#history-log .turn').length, 2);
  });

  it('says there is nothing rather than showing an empty box', () => {
    panel.open();
    assert.ok(page.$('#history-log .empty'));
    assert.equal(page.$('#history-clear').disabled, true);
  });

  describe('starting a new one', () => {
    it('hands the decision to the page, and gets out of the way', () => {
      history.append({ role: 'user', content: 'the old conversation' });
      panel.open();

      page.$('#history-new').click();
      assert.equal(fresh, 1);
      assert.equal(panel.isOpen, false);
    });

    it('offers nothing to start anew when nothing has been said', () => {
      panel.open();
      assert.equal(page.$('#history-new').disabled, true);

      history.append({ role: 'user', content: 'said something' });
      assert.equal(page.$('#history-new').disabled, false);
    });

    it('goes quiet again once the conversation is closed', () => {
      history.append({ role: 'user', content: 'said something' });
      history.end();
      panel.open();
      assert.equal(page.$('#history-new').disabled, true);
      assert.equal(page.document.querySelectorAll('#history-log .turn').length, 1);
    });
  });

  describe('picking one back up', () => {
    function stored() {
      history.begin({ voice: 'cedar' });
      history.append({ role: 'user', content: 'what should I call it?' });
      const [{ id }] = history.conversations;
      history.end();
      return id;
    }

    it('offers a continue on every entry, and hands the id to the page', () => {
      const id = stored();
      panel.open();

      const button = page.$('#history-log .resume');
      assert.equal(button.textContent, 'continue');
      button.click();

      assert.deepEqual(picked, [id]);
      assert.equal(panel.isOpen, false, 'it gets out of the way to let you talk');
    });

    it('offers nothing to pick up on the conversation already being talked in', () => {
      stored();
      const id = history.conversations[0].id;
      history.resume(id);
      panel.open();

      const button = page.$('#history-log .resume');
      assert.equal(button.textContent, 'live');
      assert.equal(button.disabled, true);
      button.click();
      assert.deepEqual(picked, []);
    });

    it('names the conversation it would continue, for a screen reader', () => {
      stored();
      panel.open();
      assert.match(page.$('#history-log .resume').getAttribute('aria-label'), /^Continue the conversation from /);
    });
  });

  it('asks once before clearing', () => {
    history.append({ role: 'user', content: 'goes away' });
    panel.open();

    page.$('#history-clear').click();
    assert.equal(page.$('#history-clear').textContent, 'sure?');
    assert.equal(history.conversations.length, 1, 'the first click only arms it');

    page.$('#history-clear').click();
    assert.deepEqual(history.conversations, []);
    assert.equal(page.$('#history-clear').textContent, 'clear');
    assert.ok(page.$('#history-log .empty'));
  });
});
