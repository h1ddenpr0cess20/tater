import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTaskBoard, taskNote } from '../../src/client/tasks.js';

const task = (over = {}) => ({
  id: '1',
  agent: 'claude',
  label: 'Claude Code',
  status: 'running',
  task: 'fix the build',
  ran_for: '4s',
  cwd: '/work',
  startedAt: 1000,
  endedAt: null,
  ...over,
});

/** A loader that hands back whatever the test queued, one call at a time. */
function feed(...pages) {
  let i = 0;
  const calls = [];
  const load = async () => {
    calls.push(i);
    return pages[Math.min(i++, pages.length - 1)];
  };
  return { load, calls };
}

const body = (tasks, over = {}) => ({ agents: ['claude'], announce: true, tasks, ...over });

/** Long enough that nothing polls under the test, unless the test wants it to. */
const QUIET = 60_000;

describe('createTaskBoard', () => {
  it('mirrors what the server says, newest first', async () => {
    const { load } = feed(body([task({ id: '1' }), task({ id: '2' })]));
    const board = createTaskBoard({ load, interval: QUIET });

    assert.deepEqual(await board.refresh(), ['claude']);
    assert.deepEqual(board.items.map((t) => t.id), ['2', '1']);
    assert.equal(board.running, 2);
    board.close();
  });

  it('tells its subscribers when the board changed', async () => {
    const { load } = feed(body([task()]));
    const board = createTaskBoard({ load, interval: QUIET });

    let told = 0;
    board.subscribe(() => { told++; });
    await board.refresh();
    assert.equal(told, 1);

    board.apply(task({ id: '9' }));
    assert.equal(told, 2);
    assert.equal(board.items.length, 2);
    board.close();
  });

  /**
   * The page has no socket back from the server, so a task that settles while
   * nobody is asking is only ever noticed by a poll. It has to be announced
   * once, on the move out of `running`, and never again.
   */
  it('announces a task that settles, once', async () => {
    const { load } = feed(
      body([task({ id: '1', status: 'running' })]),
      body([task({ id: '1', status: 'done', summary: 'fixed it', endedAt: 5000 })]),
      body([task({ id: '1', status: 'done', summary: 'fixed it', endedAt: 5000 })]),
    );

    const settled = [];
    const board = createTaskBoard({ load, interval: QUIET, onSettled: (t) => settled.push(t) });

    await board.refresh();
    assert.deepEqual(settled, [], 'still running');

    await board.refresh();
    assert.deepEqual(settled.map((t) => t.id), ['1']);

    await board.refresh();
    assert.deepEqual(settled.map((t) => t.id), ['1'], 'it does not land twice');
    board.close();
  });

  /** Work that ended before this page opened is not news to announce. */
  it('seeds quietly on the first look', async () => {
    const { load } = feed(body([task({ id: '1', status: 'done', endedAt: 5000 })]));
    const settled = [];
    const board = createTaskBoard({ load, interval: QUIET, onSettled: (t) => settled.push(t) });

    await board.refresh();
    assert.equal(board.items.length, 1);
    assert.deepEqual(settled, []);
    board.close();
  });

  it('says nothing when the server has announcing switched off', async () => {
    const { load } = feed(
      body([task({ id: '1' })], { announce: false }),
      body([task({ id: '1', status: 'done', endedAt: 5000 })], { announce: false }),
    );
    const settled = [];
    const board = createTaskBoard({ load, interval: QUIET, onSettled: (t) => settled.push(t) });

    await board.refresh();
    await board.refresh();
    assert.deepEqual(settled, [], 'the server said not to');
    board.close();
  });

  it('polls while something is running and stops when nothing is', async () => {
    const { load, calls } = feed(
      body([task({ id: '1', status: 'running' })]),
      body([task({ id: '1', status: 'done', endedAt: 5000 })]),
    );
    const board = createTaskBoard({ load, interval: 5 });

    await board.refresh();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterSettling = calls.length;
    assert.ok(afterSettling >= 2, 'it polled while the task was running');

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls.length, afterSettling, 'and stopped once nothing was');
    board.close();
  });

  it('drops a task the server no longer has', async () => {
    const { load } = feed(body([task({ id: '1' }), task({ id: '2' })]), body([task({ id: '2' })]));
    const board = createTaskBoard({ load, interval: QUIET });

    await board.refresh();
    await board.refresh();
    assert.deepEqual(board.items.map((t) => t.id), ['2']);
    board.close();
  });

  it('reports a failed stop rather than throwing at the panel', async () => {
    const { load } = feed(body([task()]));
    const board = createTaskBoard({
      load,
      interval: QUIET,
      stop: async () => { throw new Error('it already finished'); },
    });

    await board.refresh();
    assert.deepEqual(await board.stop('1'), { ok: false, error: 'it already finished' });
    board.close();
  });

  it('keeps the status the server settled on when a stop lands', async () => {
    const { load } = feed(body([task()]));
    const board = createTaskBoard({
      load,
      interval: QUIET,
      stop: async (id) => task({ id, status: 'cancelled', endedAt: 5000 }),
    });

    await board.refresh();
    assert.deepEqual(await board.stop('1'), { ok: true });
    assert.equal(board.items[0].status, 'cancelled');
    assert.equal(board.running, 0);
    board.close();
  });

  it('stops polling once the page is done with it', async () => {
    const { load, calls } = feed(body([task()]));
    const board = createTaskBoard({ load, interval: 5 });

    await board.refresh();
    board.close();
    const seen = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, seen);
  });
});

describe('taskNote', () => {
  it('marks the line as the workspace rather than the person', () => {
    const note = taskNote(task({ status: 'done', summary: 'fixed it', ran_for: '4s' }));
    assert.match(note, /^\[workspace\] task 1, claude, "fix the build" finished after 4s\. It reports: fixed it$/);
  });

  it('has a line for each way a task can end', () => {
    assert.match(taskNote(task({ status: 'cancelled' })), /was stopped after 4s/);
    assert.match(taskNote(task({ status: 'timeout' })), /still going after 4s and was stopped/);
    assert.match(taskNote(task({ status: 'failed', error: 'it broke' })), /failed after 4s\. it broke/);
  });
});
