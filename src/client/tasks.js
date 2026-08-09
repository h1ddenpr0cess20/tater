import { fetchTasks, stopTask } from './api.js';

/** How often the server is asked about work that is still running. */
const POLL_MS = 2000;

/**
 * What the workspace says when a task settles, marked as not the person.
 *
 * The marker is the whole point: this goes up the same channel a spoken turn
 * does, and the instructions tell the model to read a "[workspace]" line as the
 * machine reporting in rather than as something it was just asked.
 */
export function taskNote(task) {
  const what = `task ${task.id}, ${task.agent}, "${task.task}"`;
  switch (task.status) {
    case 'done':
      return `[workspace] ${what} finished after ${task.ran_for}. It reports: ${task.summary}`;
    case 'cancelled':
      return `[workspace] ${what} was stopped after ${task.ran_for}.`;
    case 'timeout':
      return `[workspace] ${what} was still going after ${task.ran_for} and was stopped.`;
    default:
      return `[workspace] ${what} failed after ${task.ran_for}. ${task.error ?? ''}`.trim();
  }
}

/**
 * What the server is running on our behalf, mirrored in the page.
 *
 * Nothing here is authoritative: the tasks belong to the Node process, which
 * spawned them and is the only thing that can stop one. This holds the last
 * status of each and tells the panel when that changed.
 *
 * It polls, rather than being told. The call itself runs browser-to-OpenAI, so
 * there is no socket back from the server to push a status down — and an agent
 * that finishes while nobody is asking still has to be noticed, or the person
 * is left watching a task that ended minutes ago. Polling only runs while
 * something is actually running, and stops the moment nothing is.
 */
export function createTaskBoard({
  load = fetchTasks,
  stop = stopTask,
  onSettled = () => {},
  interval = POLL_MS,
} = {}) {
  const board = new Map();
  const listeners = new Set();
  let agents = [];
  let announce = true;
  let timer = 0;
  /** The first look is a seed: work that ended before this page opened is not news. */
  let seeded = false;

  const tell = () => {
    for (const listener of listeners) listener();
  };

  /** Newest first, by the number the person hears — which is the order given out. */
  const byNewest = (a, b) => Number(b.id) - Number(a.id);

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    const running = [...board.values()].some((task) => task.status === 'running');
    if (!running) return;
    timer = setTimeout(() => {
      refresh().catch(() => schedule());
    }, interval);
  }

  /**
   * Folds one task in, and says whether it just settled. A status only ever
   * moves out of `running` once, so that transition is what gets announced —
   * a task seen settled twice is not reported twice.
   */
  function fold(task) {
    const before = board.get(task.id);
    board.set(task.id, task);
    return Boolean(before) && before.status === 'running' && task.status !== 'running';
  }

  async function refresh() {
    const body = await load();
    agents = body.agents ?? [];
    announce = body.announce ?? true;

    const settled = [];
    const seen = new Set();
    for (const task of body.tasks ?? []) {
      seen.add(task.id);
      if (fold(task) && seeded) settled.push(task);
    }
    for (const id of [...board.keys()]) {
      if (!seen.has(id)) board.delete(id);
    }

    seeded = true;
    tell();
    schedule();
    if (announce) for (const task of settled) onSettled(task);
    return agents;
  }

  return {
    get items() {
      return [...board.values()].sort(byNewest);
    },

    get running() {
      return [...board.values()].filter((task) => task.status === 'running').length;
    },

    /** Which agents this server can dispatch to — none means the feature is off. */
    get agents() {
      return [...agents];
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * One task, as the server just reported it — the answer to a dispatch, or
     * to a stop. It goes in the board now rather than at the next poll, and
     * starts the polling if it is something to wait on.
     */
    apply(task) {
      if (!task?.id) return false;
      board.set(task.id, task);
      tell();
      schedule();
      return true;
    },

    refresh,

    /**
     * Stops one. The agent keeps whatever it has already written, and the
     * status that comes back is the one the server settled on, not a guess.
     */
    async stop(id) {
      try {
        const body = await stop(id);
        if (body.id) board.set(body.id, body);
        tell();
        schedule();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    /** Nothing keeps polling after the page is done with it. */
    close() {
      clearTimeout(timer);
      timer = 0;
      listeners.clear();
    },
  };
}
