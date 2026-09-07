import './styles.css';
import './vendor/three-d-stage.js';

import { fetchCatalog } from './api.js';
import { createTaterBuddy } from './tater/index.js';
import { createHistory } from './history.js';
import { createMemory } from './memory.js';
import { createVoiceSession } from './session/index.js';
import { createTaskBoard, taskNote } from './tasks.js';
import { createControls } from './ui/controls.js';
import { createConnectorsPanel } from './ui/connectors.js';
import { createHistoryPanel } from './ui/history.js';
import { createToolSwitches } from './tools.js';
import { createMemoryPanel } from './ui/memory.js';
import { createMenu } from './ui/menu.js';
import { createToolsPanel } from './ui/tools.js';
import { createHud } from './ui/hud.js';
import { stripStageChrome } from './ui/stage.js';
import { trackKeyboardInset } from './ui/viewport.js';

const stage = stripStageChrome(document.querySelector('three-d-stage'));

const { THREE } = await stage.ready;

const tater = createTaterBuddy({ stage, THREE });
const memory = createMemory();
const session = createVoiceSession({ memory });
const hud = createHud();
const menu = createMenu();
const history = createHistory();
const historyPanel = createHistoryPanel({ history, onNew: startFresh, onResume: pickUp });
const memoryPanel = createMemoryPanel({ memory });
const switches = createToolSwitches();
const toolsPanel = createToolsPanel({ switches });

/**
 * Work handed to a coding agent, and the panel that sets one up.
 *
 * A task that settles is told to the model as it lands, so Tater says what
 * happened instead of the person having to go and look. Nothing is announced
 * when there is no call up — the board still has it either way.
 */
const board = createTaskBoard({
  onSettled: (task) => session.note(taskNote(task)),
});

const connectorsPanel = createConnectorsPanel({
  board,
  /** The count of running work belongs where it is visible: the menu chip. */
  onBusy: (running) => menu.setLive(running),
  /**
   * Which agents are on is settled when a session is minted, so a call that is
   * already up was minted with the old set and cannot be told. A redial is the
   * cheap fix: the conversation is kept, and the new tools go out with it.
   */
  onAgents: () => {
    if (session.connected) redial();
  },
});

trackKeyboardInset();

const controls = createControls({
  getStatus: () => ({ connected: session.connected, busy: session.busy, muted: session.muted }),

  async onMicToggle() {
    if (session.connected) {
      session.muted = !session.muted;
      hud.setState(chipState());
      armIdleMute();
      return;
    }
    hud.setState('connecting');
    hud.clearCaption();
    /** A conversation picked up in the log is already open: this joins it. */
    if (!history.live) history.begin({ model: session.model, voice: session.voice });
    await session.start();
    if (session.stale) setTimeout(redial, 0);
  },

  /** Held down rather than tapped: end the call instead of muting it. */
  onHangUp() {
    session.stop();
  },

  onSubmit(text) {
    if (!session.connected) return;
    hud.showUser(text);
    hud.clearCaption();
    session.send(text);
  },

  onModelChange(model) {
    session.model = model;
    redial();
  },

  onVoiceChange(voice) {
    session.voice = voice;
    redial();
  },

  onCancel() {
    if (toolsPanel.isOpen) return toolsPanel.close();
    if (connectorsPanel.isOpen) return connectorsPanel.close();
    if (memoryPanel.isOpen) return memoryPanel.close();
    if (historyPanel.isOpen) return historyPanel.close();
    if (menu.isOpen) return menu.close();
    session.cancel();
  },
});

const IDLE_MUTE_MS = 60_000;
let idle = 0;

function armIdleMute() {
  clearTimeout(idle);
  idle = 0;
  if (!session.connected || session.muted) return;
  if (session.busy || session.state === 'thinking' || session.state === 'speaking') return;
  idle = setTimeout(() => {
    if (!session.connected || session.muted) return;
    session.muted = true;
    hud.setState(chipState());
    controls.sync();
  }, IDLE_MUTE_MS);
}

function startFresh() {
  history.end();
  session.context = [];
  if (session.connected) redial();
}

/**
 * Carries on an old conversation. Whatever call is up ends first — this is a
 * different conversation, and the model is handed the stored turns as it dials
 * — and from here what is said lands back in that same entry in the log.
 */
async function pickUp(id) {
  if (session.connected) session.stop();
  const earlier = history.resume(id);
  if (!earlier) return;
  session.context = earlier.messages;
  await controls.toggleMic();
}

function chipState() {
  if (!session.connected || !session.muted) return tater.state;
  return tater.state === 'listening' || tater.state === 'idle' ? 'muted' : tater.state;
}

/**
 * A new call for the same conversation, after a pick or a stale one. Where the
 * conversation was picked up out of the log it stays picked up, turns and all,
 * including the ones from the call being replaced — a voice is worth changing
 * mid-sentence, and losing the thread over it is not.
 */
function redial() {
  if (!session.connected) return;
  const thread = session.context.length ? history.live : null;
  session.stop();
  if (thread) session.context = history.resume(thread)?.messages ?? [];
  controls.toggleMic();
}

session.on('state', (state) => {
  if (state === 'idle') {
    history.end();
    hud.hideUser();
  }
  if (state === 'thinking') hud.clearCaption();
  tater.setState(state);
  hud.setState(chipState());
  armIdleMute();
  controls.sync();
});

session.on('busy', () => {
  armIdleMute();
  controls.sync();
});

session.on('level', (level) => tater.setLevel(level));
session.on('pulse', (weight) => tater.pulse(weight));
session.on('text', (chunk) => {
  hud.appendCaption(chunk);
  armIdleMute();
});
session.on('user', (text) => {
  hud.showUser(text);
  armIdleMute();
});

session.on('message', (message) => history.append(message));

/** A dispatch or a stop, straight from the tool call that did it. */
session.on('task', (task) => board.apply(task));

session.on('error', ({ message }) => {
  hud.showError(message);
  hud.setState(chipState());
  controls.sync();
});

try {
  const catalog = await fetchCatalog();
  if (!catalog.models.length) throw new Error('this key can’t reach any realtime model');
  const chosen = controls.setCatalog(catalog);
  session.model = chosen.model;
  session.voice = chosen.voice;
} catch (err) {
  controls.catalogUnavailable();
  hud.showError(`${err.message} — is the proxy running? (npm run dev)`);
}

/** What was dispatched before this page existed, and whether there is an agent at all. */
board.refresh().catch(() => {});

window.addEventListener('pagehide', () => {
  session.stop();
  board.close();
});

controls.sync();

if (window.matchMedia('(pointer: fine)').matches) controls.focus();
