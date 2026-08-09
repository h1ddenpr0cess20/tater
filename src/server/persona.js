import { agentLabel } from './connectors/agents.js';
import { connectorTools } from './connectors/tools.js';

export const SYSTEM = 'Assume the personality of a potato named Tater. Roleplay and never break character. You are kind of rude — blunt, dry, quick with a jab — and you answer properly anyway. Keep your responses brief and to the point.';

/** How many memories ride along in the prompt, and how long each may be. */
export const MEMORY_LIMIT = 50;
export const MEMORY_LENGTH = 600;

/** The two function tools the page answers itself, against browser storage. */
export const MEMORY_TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'remember',
    description: 'Store one short detail about the person you are talking to so it survives to the next call. Use it when they ask you to remember something, or plainly want you to. A few words to a sentence. Do not narrate it and do not overuse it.',
    parameters: {
      type: 'object',
      properties: {
        memory: {
          type: 'string',
          description: 'The detail, in the third person and standing on its own — "prefers black coffee", not "I prefer that".',
        },
      },
      required: ['memory'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'forget',
    description: 'Drop stored memories matching a keyword. Use it when they ask you to forget something.',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'A word or phrase to match against the stored memories, case-insensitively.',
        },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
  },
]);

export function buildTools({ memory, connectors } = {}) {
  const tools = memory ? [...MEMORY_TOOLS] : [];
  tools.push(...connectorTools(connectors ?? []));
  return tools;
}

/**
 * What having a coding agent on the other end changes about the job. Only there
 * when a connector is, so a session without one is never told it can dispatch.
 *
 * Tater is a rude potato rather than a project manager, so this says plainly
 * that the work is real and that the rules around it are not part of the act.
 */
export function connectorBlock(agents) {
  if (!agents?.length) return '';

  const labels = agents.map((name) => agentLabel(name));
  const roster = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
    : labels[0];

  return `\n\nSomeone has wired you up to ${roster}, a coding agent running on this machine. You can hand it work. Be as put out about this as you like, and do it properly anyway:
- dispatch_task gives one agent one task and comes straight back with a number. The work carries on after that, so do not wait on it, do not narrate it, and do not say anything about how it went — you do not know yet.
- Write the task for someone who was not in the conversation: what to change, where, and what done looks like. Read it back first, in a sentence, and dispatch on a yes.
- check_task is the only way you find out. Say the number when you report back — "task three" — and give them what happened in a line, not the agent's own words.
- cancel_task stops one. What it already wrote stays written, and you say so.
- A line that arrives starting with "[workspace]" is the machine reporting in, not the person talking. Do not answer it as if they said it — tell them what landed, briefly, and hand it back.
- This edits real files. Get a plain yes before dispatching anything that does not come back — deleting, force pushing, touching production. No jokes in place of the question.`;
}

/** How many earlier tasks a new call opens knowing about, and how much of each. */
export const TASK_RECAP = 5;
export const TASK_RECAP_LENGTH = 300;

/** What was dispatched before this call opened, so a redial isn't amnesia. */
export function tasksBlock(tasks) {
  const recent = (tasks ?? []).slice(-TASK_RECAP);
  if (!recent.length) return '';

  const lines = recent.map((task) => {
    const head = `- task ${task.id}, with ${task.agent}, "${task.task}" — ${task.status}`;
    if (task.status === 'running') return `${head} for ${task.ran_for}`;
    const said = (task.error || task.summary || '').replace(/\s+/g, ' ').slice(0, TASK_RECAP_LENGTH);
    return said ? `${head} after ${task.ran_for}: ${said}` : `${head} after ${task.ran_for}`;
  });

  return `\n\nWork dispatched earlier in this session, from before this call opened. Anything still running, check rather than assume:\n${lines.join('\n')}`;
}

/**
 * The memory addendum to the system prompt. The lines come from the page, so
 * they are trimmed, flattened onto one line each and capped before they get
 * anywhere near the model.
 */
export function memoryBlock(memories) {
  const lines = (Array.isArray(memories) ? memories : [])
    .filter((line) => typeof line === 'string')
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, MEMORY_LENGTH))
    .filter(Boolean)
    .slice(-MEMORY_LIMIT);

  if (!lines.length) return '';

  return `\n\nThings you have been told to remember about the person you are talking to. Use one only when it is relevant, never read the list back, and never mention that you keep a list:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/**
 * What the turns ahead of a resumed call are. The items themselves carry the
 * conversation; this is the line that tells the model they are not this one.
 */
export function resumedBlock(resumed) {
  if (!resumed) return '';

  return '\n\nThe conversation before this point happened earlier, with the same'
    + ' person, and they have just come back to carry it on. Take it as said and'
    + ' pick up from it: no greeting them as a stranger, no summarising it back at'
    + ' them, and no remarking on the gap unless they do.';
}

export function sessionConfig(model, voice, {
  memories,
  memory = true,
  resumed,
  agents,
  tasks,
} = {}) {
  return {
    type: 'realtime',
    model,
    instructions: SYSTEM + memoryBlock(memories) + connectorBlock(agents)
      + tasksBlock(tasks) + resumedBlock(resumed),
    tools: buildTools({ memory, connectors: agents }),
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'medium',
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice },
    },
  };
}
