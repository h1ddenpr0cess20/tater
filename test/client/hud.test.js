import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createHud } from '../../src/client/ui/hud.js';
import { loadPage } from '../helpers/dom.js';

describe('createHud', () => {
  let page;
  let hud;

  beforeEach(async () => {
    page = await loadPage();
    hud = createHud(page.document);
  });

  afterEach(() => page.close());

  it('finds every element it needs in the shipped markup', () => {
    for (const sel of ['#status', '#caption', '#you']) {
      assert.ok(page.$(sel), `${sel} is missing from index.html`);
    }
  });

  it('drives the status chip through both text and the state attribute', () => {
    hud.setState('speaking');
    assert.equal(page.$('#status').textContent, 'speaking');
    assert.equal(page.$('#status').dataset.state, 'speaking');
  });

  it('accepts the synthetic connecting state the CSS also styles', () => {
    hud.setState('connecting');
    assert.equal(page.$('#status').dataset.state, 'connecting');
  });

  it('shows and hides the line of what the person said', () => {
    hud.showUser('what are you?');
    assert.equal(page.$('#you').textContent, 'what are you?');
    assert.ok(page.$('#you').classList.contains('visible'));

    hud.hideUser();
    assert.ok(!page.$('#you').classList.contains('visible'));
    assert.equal(page.$('#you').textContent, 'what are you?');
  });

  it('appends caption chunks in order rather than replacing', () => {
    hud.appendCaption('Hello. ');
    hud.appendCaption('I am a potato.');
    assert.equal(page.$('#caption').textContent, 'Hello. I am a potato.');
    assert.ok(page.$('#caption').classList.contains('visible'));
  });

  it('renders text as text, never as markup', () => {
    hud.appendCaption('<img src=x onerror=alert(1)>');
    assert.equal(page.$('#caption').querySelector('img'), null);
    assert.equal(page.$('#caption').textContent, '<img src=x onerror=alert(1)>');
  });

  it('clears the caption and its error state together', () => {
    hud.showError('the call dropped');
    hud.clearCaption();
    const caption = page.$('#caption');
    assert.equal(caption.textContent, '');
    assert.ok(!caption.classList.contains('visible'));
    assert.ok(!caption.classList.contains('error'));
  });

  it('marks an error and drops the mark when normal text resumes', () => {
    hud.showError('the call dropped');
    assert.ok(page.$('#caption').classList.contains('error'));

    hud.appendCaption('Hello!');
    assert.ok(!page.$('#caption').classList.contains('error'));
  });

  it('replaces the previous error rather than appending to it', () => {
    hud.showError('first');
    hud.showError('second');
    assert.equal(page.$('#caption').textContent, 'second');
  });

  describe('the markdown the model was told not to use', () => {
    it('renders bold, emphasis and code as elements', () => {
      hud.appendCaption('A **big** _russeted_ `potato`!');
      const caption = page.$('#caption');

      assert.equal(caption.querySelector('strong').textContent, 'big');
      assert.equal(caption.querySelector('em').textContent, 'russeted');
      assert.equal(caption.querySelector('code').textContent, 'potato');
      assert.equal(caption.textContent, 'A big russeted potato!');
    });

    it('nests one inside another', () => {
      hud.appendCaption('**very _very_ starchy**');
      assert.equal(page.$('#caption').querySelector('strong em').textContent, 'very');
    });

    it('formats a span whose halves arrive in different chunks', () => {
      hud.appendCaption('I am a **pot');
      assert.equal(page.$('#caption').querySelector('strong'), null);

      hud.appendCaption('ato**!');
      assert.equal(page.$('#caption').querySelector('strong').textContent, 'potato');
      assert.equal(page.$('#caption').textContent, 'I am a potato!');
    });

    it('leaves ordinary prose punctuation alone', () => {
      hud.appendCaption('level_up_time costs 3 * 4 gold');
      const caption = page.$('#caption');

      assert.equal(caption.querySelector('em'), null);
      assert.equal(caption.textContent, 'level_up_time costs 3 * 4 gold');
    });

    it('keeps the line breaks the model sent', () => {
      hud.appendCaption('One thing.\n\nAnother thing.');
      assert.equal(page.$('#caption').textContent, 'One thing.\n\nAnother thing.');
    });

    it('still never produces markup, inside a span or out', () => {
      hud.appendCaption('**<img src=x onerror=alert(1)>** and `<b>bold</b>`');
      const caption = page.$('#caption');

      assert.equal(caption.querySelector('img'), null);
      assert.equal(caption.querySelector('b'), null);
      assert.equal(caption.querySelector('code').textContent, '<b>bold</b>');
    });

    it('starts each turn from an empty transcript', () => {
      hud.appendCaption('**first**');
      hud.clearCaption();
      hud.appendCaption('second');
      assert.equal(page.$('#caption').textContent, 'second');
    });
  });
});
