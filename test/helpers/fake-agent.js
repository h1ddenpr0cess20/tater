/**
 * Stands in for `claude`, `codex`, `opencode`, `grok` and `muse` — same flags, same
 * output shapes, no model behind it. Which one it is playing comes first on the
 * command line, and what it does comes from the task text itself:
 *
 *   ...fail     writes to stderr and exits non-zero
 *   ...sleep    stays up until it is killed
 *   ...quiet    exits cleanly having said nothing
 *   ...where    reports the directory it was actually started in
 */
const [shape, ...argv] = process.argv.slice(2);

/** Claude and Grok take the task behind `-p`; the other two take it last. */
const flagged = shape === 'claude' || shape === 'grok';
const task = flagged ? argv[argv.indexOf('-p') + 1] : argv[argv.length - 1];

/** One finished answer, in whichever machine format this one speaks. */
function said(text) {
  switch (shape) {
    case 'claude':
      return JSON.stringify({ type: 'result', is_error: false, result: text });
    case 'opencode':
      return JSON.stringify({ type: 'text', sessionID: 'fake-session', part: { type: 'text', text } });
    case 'grok':
      return JSON.stringify({ text, stopReason: 'end_turn', sessionId: 'fake-session' });
    case 'muse':
      return JSON.stringify(record(3, 'agent_end', {
        type: 'result', subtype: 'success', is_error: false, result: text,
      }));
    default:
      return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
  }
}

/** One line of Muse's event log: a record about the run, around the event. */
function record(seq, payloadType, payload) {
  return { seq, at: '2026-08-09T12:00:00Z', type: 'event', durable: true, payloadType, payload };
}

if (/\bfail\b/.test(task)) {
  process.stderr.write('the build is on fire\n');
  process.exit(3);
}

if (/\bsleep\b/.test(task)) {
  setInterval(() => {}, 1000);
} else if (/\bquiet\b/.test(task)) {
  process.exit(0);
} else if (/\bwhere\b/.test(task)) {
  process.stdout.write(`${said(`cwd=${process.cwd()} PWD=${process.env.PWD} key=${process.env.OPENAI_API_KEY}`)}\n`);
} else if (shape === 'claude') {
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    session_id: 'fake-session',
    result: `claude did: ${task}`,
  })}\n`);
} else if (shape === 'opencode') {
  const lines = [
    { type: 'step_start', sessionID: 'fake-session', part: { type: 'step-start' } },
    { type: 'tool_use', sessionID: 'fake-session', part: { type: 'tool', tool: 'edit' } },
    { type: 'text', sessionID: 'fake-session', part: { type: 'text', text: `opencode did: ${task}` } },
  ];
  process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
} else if (shape === 'grok') {
  process.stdout.write(`${JSON.stringify({
    text: `grok did: ${task}`,
    stopReason: 'end_turn',
    sessionId: 'fake-session',
    num_turns: 2,
  })}\n`);
} else if (shape === 'muse') {
  const lines = [
    record(1, 'agent_start', { type: 'agent_start', session_id: 'fake-session' }),
    record(2, 'message_update', { type: 'message_update', message: { content: [{ type: 'text', text: 'on it' }] } }),
    record(3, 'message_end', { type: 'message_end', message: { content: [{ type: 'text', text: `muse did: ${task}` }] } }),
    record(4, 'agent_end', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      session_id: 'fake-session',
      result: `muse did: ${task}`,
    }),
  ];
  process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
} else {
  const lines = [
    { type: 'thread.started', thread_id: 'fake-thread' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'thinking about it' } },
    { type: 'item.completed', item: { type: 'agent_message', text: `codex did: ${task}` } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 34 } },
  ];
  process.stdout.write(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}
