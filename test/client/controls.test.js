import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createControls } from '../../src/client/ui/controls.js';
import { loadPage, withGlobals } from '../helpers/dom.js';

const CATALOG = {
  models: [
    { id: 'gpt-realtime-2.1', display_name: 'gpt-realtime-2.1' },
    { id: 'gpt-realtime-mini', display_name: 'gpt-realtime-mini' },
  ],
  model: 'gpt-realtime-2.1',
  voices: ['ballad', 'cedar', 'ash'],
  voice: 'ballad',
};

describe('createControls', () => {
  let page;
  let restore;
  let status;
  let calls;
  let controls;

  beforeEach(async () => {
    page = await loadPage();
    restore = withGlobals({ Option: page.window.Option });

    status = { connected: false, busy: false, muted: false };
    calls = { mic: 0, submit: [], model: [], voice: [], cancel: 0 };

    controls = createControls({
      root: page.document,
      getStatus: () => status,
      onMicToggle: async () => { calls.mic++; },
      onSubmit: (text) => calls.submit.push(text),
      onModelChange: (m) => calls.model.push(m),
      onVoiceChange: (v) => calls.voice.push(v),
      onCancel: () => { calls.cancel++; },
    });
  });

  afterEach(() => {
    restore();
    page.close();
  });

  const click = (sel) => page.$(sel).dispatchEvent(new page.window.Event('click', { bubbles: true }));
  const submit = () => page.$('#composer').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  const key = (k) => page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

  describe('sync', () => {
    it('locks the typed path shut while there is no call', () => {
      controls.sync();
      assert.equal(page.$('#prompt').disabled, true);
      assert.equal(page.$('#send').disabled, true);
      assert.equal(page.$('#mic').getAttribute('aria-pressed'), 'false');
      assert.match(page.$('#prompt').placeholder, /Tap the mic/);
    });

    it('opens it once connected, and says so to a screen reader', () => {
      status.connected = true;
      controls.sync();
      assert.equal(page.$('#prompt').disabled, false);
      assert.equal(page.$('#send').disabled, false);
      assert.equal(page.$('#mic').getAttribute('aria-pressed'), 'true');
      assert.equal(page.$('#mic').getAttribute('aria-label'),
        'Turn the microphone off. Hold to hang up.');
      assert.match(page.$('#prompt').placeholder, /Or type/);
    });

    it('shows a muted call as a mic that is off, not a call that is over', () => {
      status.connected = true;
      status.muted = true;
      controls.sync();
      assert.equal(page.$('#mic').getAttribute('aria-pressed'), 'false');
      assert.equal(page.$('#mic').getAttribute('aria-label'),
        'Turn the microphone on. Hold to hang up.');
      assert.ok(page.$('#mic').classList.contains('muted'));
      assert.equal(page.$('#prompt').disabled, false);
      assert.match(page.$('#prompt').placeholder, /Or type/);
    });

    it('does not dress the mic as muted when there is no call at all', () => {
      status.connected = false;
      status.muted = true;
      controls.sync();
      assert.equal(page.$('#mic').getAttribute('aria-label'), 'Start talking');
      assert.equal(page.$('#mic').classList.contains('muted'), false);
    });

    it('disables send while Tater is mid-answer', () => {
      status.connected = true;
      status.busy = true;
      controls.sync();
      assert.equal(page.$('#send').disabled, true);
      assert.equal(page.$('#prompt').disabled, false);
    });
  });

  describe('the mic', () => {
    it('reports the toggle and re-syncs afterwards', async () => {
      await controls.toggleMic();
      assert.equal(calls.mic, 1);
    });

    it('ignores clicks while a dial is already in flight', async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const slow = createControls({
        root: page.document,
        getStatus: () => status,
        onMicToggle: async () => { calls.mic++; await gate; },
        onSubmit: () => {}, onModelChange: () => {}, onVoiceChange: () => {}, onCancel: () => {},
      });

      const first = slow.toggleMic();
      await slow.toggleMic();
      await slow.toggleMic();
      assert.equal(page.$('#mic').hasAttribute('data-busy'), true);

      release();
      await first;
      assert.equal(calls.mic, 1, 'only the first click should dial');
      assert.equal(page.$('#mic').hasAttribute('data-busy'), false);
    });

    it('unlocks even when dialling throws, so the page is never stuck', async () => {
      const failing = createControls({
        root: page.document,
        getStatus: () => status,
        onMicToggle: async () => { throw new Error('mic denied'); },
        onSubmit: () => {}, onModelChange: () => {}, onVoiceChange: () => {}, onCancel: () => {},
      });

      await assert.rejects(() => failing.toggleMic(), /mic denied/);
      assert.equal(page.$('#mic').hasAttribute('data-busy'), false);
    });

    it('is wired to its own click event', () => {
      click('#mic');
      assert.equal(calls.mic, 1);
    });
  });

  /**
   * The second job on the one button: a tap mutes, a press held down hangs up.
   * These build their own controls, with a hold short enough to wait for.
   */
  describe('holding the mic down', () => {
    let held;

    beforeEach(async () => {
      page.close();
      page = await loadPage();
      status = { connected: true, busy: false, muted: false };
      held = { mic: 0, hangUp: 0 };

      createControls({
        root: page.document,
        getStatus: () => status,
        onMicToggle: async () => { held.mic++; },
        onHangUp: () => { held.hangUp++; },
        onSubmit: () => {}, onModelChange: () => {}, onVoiceChange: () => {}, onCancel: () => {},
        hangMs: 15,
      });
    });

    const fire = (type) => page.$('#mic').dispatchEvent(new page.window.Event(type, { bubbles: true }));
    const key = (type, k) => page.$('#mic')
      .dispatchEvent(new page.window.KeyboardEvent(type, { key: k, bubbles: true }));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

    it('hangs the call up, and does not mute it on the way', async () => {
      fire('pointerdown');
      await settle();
      assert.equal(held.hangUp, 1);
      assert.equal(held.mic, 0);
    });

    it('swallows the click that ends the press, which would toggle a dead call', async () => {
      fire('pointerdown');
      await settle();
      fire('pointerup');
      fire('click');
      assert.equal(held.hangUp, 1);
      assert.equal(held.mic, 0);
    });

    it('is the tap it always was when the press is let go in time', async () => {
      fire('pointerdown');
      fire('pointerup');
      fire('click');
      await settle();
      assert.equal(held.hangUp, 0);
      assert.equal(held.mic, 1);
    });

    it('takes the next tap normally, once a hold has ended a call', async () => {
      fire('pointerdown');
      await settle();
      fire('pointerup');
      fire('click');

      status.connected = false;
      fire('click');
      assert.equal(held.mic, 1, 'the tap after a hang-up dials again');
    });

    it('does not arm when there is no call to end', async () => {
      status.connected = false;
      fire('pointerdown');
      assert.equal(page.$('#mic').classList.contains('holding'), false);
      await settle();
      assert.equal(held.hangUp, 0);
    });

    it('shows that it is being held, and stops showing it when it lands', async () => {
      fire('pointerdown');
      assert.ok(page.$('#mic').classList.contains('holding'));
      await settle();
      assert.equal(page.$('#mic').classList.contains('holding'), false);
    });

    it('calls the hold off when the pointer leaves the button', async () => {
      fire('pointerdown');
      fire('pointerleave');
      assert.equal(page.$('#mic').classList.contains('holding'), false);
      await settle();
      assert.equal(held.hangUp, 0);
    });

    it('ignores a right-click, which is a menu and not a hold', async () => {
      page.$('#mic').dispatchEvent(
        new page.window.MouseEvent('pointerdown', { bubbles: true, button: 2 }),
      );
      await settle();
      assert.equal(held.hangUp, 0);
    });

    it('holds from the keyboard on Space, where Enter stays a tap', async () => {
      key('keydown', ' ');
      await settle();
      assert.equal(held.hangUp, 1);

      key('keydown', 'Enter');
      await settle();
      assert.equal(held.hangUp, 1);
    });

    it('lets go when the button loses focus mid-hold', async () => {
      key('keydown', ' ');
      fire('blur');
      await settle();
      assert.equal(held.hangUp, 0);
    });
  });

  describe('the composer', () => {
    it('hands over the text and clears the field', () => {
      page.$('#prompt').value = 'hello Tater';
      submit();
      assert.deepEqual(calls.submit, ['hello Tater']);
      assert.equal(page.$('#prompt').value, '');
    });

    it('ignores whitespace-only input without clearing it', () => {
      page.$('#prompt').value = '   ';
      submit();
      assert.deepEqual(calls.submit, []);
      assert.equal(page.$('#prompt').value, '   ');
    });

    it('prevents the default submit, which would navigate', () => {
      page.$('#prompt').value = 'hi';
      const event = new page.window.Event('submit', { bubbles: true, cancelable: true });
      page.$('#composer').dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    });
  });

  describe('the pickers', () => {
    it('fills both from the catalog and preselects the proxy\'s defaults', () => {
      const chosen = controls.setCatalog(CATALOG);
      assert.deepEqual(
        [...page.$('#model').options].map((o) => o.value),
        ['gpt-realtime-2.1', 'gpt-realtime-mini'],
      );
      assert.equal(page.$('#model').value, 'gpt-realtime-2.1');
      assert.equal(page.$('#voice').value, 'ballad');
      assert.deepEqual(chosen, { model: 'gpt-realtime-2.1', voice: 'ballad' });
    });

    it('falls back to the first model when the key cannot reach the default', () => {
      const chosen = controls.setCatalog({ ...CATALOG, model: 'gpt-realtime-unreleased' });
      assert.equal(chosen.model, 'gpt-realtime-2.1');
      assert.equal(page.$('#model').value, 'gpt-realtime-2.1');
    });

    it('replaces the loading placeholder rather than appending to it', () => {
      controls.setCatalog(CATALOG);
      assert.equal(page.$('#model').options.length, 2);
      controls.setCatalog(CATALOG);
      assert.equal(page.$('#model').options.length, 2);
    });

    it('prefers a display name when one differs from the id', () => {
      controls.setCatalog({ ...CATALOG, models: [{ id: 'gpt-realtime-2.1', display_name: 'Realtime 2.1' }] });
      assert.equal(page.$('#model').options[0].textContent, 'Realtime 2.1');
      assert.equal(page.$('#model').options[0].value, 'gpt-realtime-2.1');
    });

    it('reports a change', () => {
      controls.setCatalog(CATALOG);
      page.$('#model').value = 'gpt-realtime-mini';
      page.$('#model').dispatchEvent(new page.window.Event('change', { bubbles: true }));
      assert.deepEqual(calls.model, ['gpt-realtime-mini']);

      page.$('#voice').value = 'cedar';
      page.$('#voice').dispatchEvent(new page.window.Event('change', { bubbles: true }));
      assert.deepEqual(calls.voice, ['cedar']);
    });

    it('locks the mic when there is no catalog to dial with', () => {
      controls.catalogUnavailable();
      assert.equal(page.$('#mic').disabled, true);
      assert.equal(page.$('#model').textContent, 'unavailable');
    });

    it('keeps the mic locked through a click that was already in the air', async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const slow = createControls({
        root: page.document,
        getStatus: () => status,
        onMicToggle: async () => { await gate; },
        onSubmit: () => {}, onModelChange: () => {}, onVoiceChange: () => {}, onCancel: () => {},
      });

      const dialling = slow.toggleMic();
      slow.catalogUnavailable();
      release();
      await dialling;

      assert.equal(page.$('#mic').disabled, true, 'a mic with no catalog must stay locked');
    });
  });

  describe('escape', () => {
    it('reports a cancel', () => {
      key('Escape');
      assert.equal(calls.cancel, 1);
    });

    it('ignores every other key', () => {
      key('Enter');
      key('a');
      assert.equal(calls.cancel, 0);
    });
  });
});
