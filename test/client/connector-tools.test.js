import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONNECTOR_TOOLS, createTools, toolLabel } from '../../src/client/session/tools.js';

/** A stand-in for the round trip to `/api/connectors/run`. */
function server(reply = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    run: async (name, args) => {
      calls.push({ name, args });
      return reply(name, args);
    },
  };
}

describe('the connector tools the page routes', () => {
  it('offers the three the server answers, alongside memory', () => {
    const tools = createTools({ memory: null });
    assert.deepEqual(Object.keys(tools), [...CONNECTOR_TOOLS]);
    assert.deepEqual([...CONNECTOR_TOOLS], ['dispatch_task', 'check_task', 'cancel_task']);
  });

  it('leaves them out when this page is not routing them', () => {
    const tools = createTools({ memory: null, connectors: false });
    assert.deepEqual(Object.keys(tools), []);
  });

  /**
   * The work is the server's to do: it is the machine with the files on it.
   * All the page does is carry the call there and the answer back.
   */
  it('hands the call to the server and returns what it said', async () => {
    const { run, calls } = server(() => ({ ok: true, id: '4', status: 'running' }));
    const tools = createTools({ memory: null, run });

    const result = await tools.dispatch_task({ task: 'fix the build', agent: 'claude' });
    assert.deepEqual(result, { ok: true, id: '4', status: 'running' });
    assert.deepEqual(calls, [{ name: 'dispatch_task', args: { task: 'fix the build', agent: 'claude' } }]);
  });

  it('passes an empty object when the model calls with no arguments', async () => {
    const { run, calls } = server();
    const tools = createTools({ memory: null, run });

    await tools.check_task();
    assert.deepEqual(calls[0], { name: 'check_task', args: {} });
  });

  /** The model is waiting on this call: a reachable failure beats a silence. */
  it('turns a dead server into an answer rather than a throw', async () => {
    const run = async () => { throw new Error('/api/connectors/run returned 500'); };
    const tools = createTools({ memory: null, run });

    const result = await tools.cancel_task({ id: '1' });
    assert.deepEqual(result, { ok: false, error: '/api/connectors/run returned 500' });
  });

  it('has a caption for each, so the HUD says what is happening', () => {
    assert.equal(toolLabel('dispatch_task'), 'handing it over');
    assert.equal(toolLabel('check_task'), 'checking on it');
    assert.equal(toolLabel('cancel_task'), 'calling it off');
    assert.equal(toolLabel('remember'), 'remembering that');
    assert.equal(toolLabel('not_a_tool'), null);
  });
});
