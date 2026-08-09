const INLINE = [
  { tag: 'code', re: /`([^`\n]+)`/ },
  { tag: 'strong', re: /\*\*(\S|\S[\s\S]*?\S)\*\*/ },
  { tag: 'strong', re: /__(\S|\S[\s\S]*?\S)__/ },
  { tag: 's', re: /~~(\S|\S[\s\S]*?\S)~~/ },
  { tag: 'em', re: /(?<![\w*])\*(\S|\S[\s\S]*?\S)\*(?!\w)/ },
  { tag: 'em', re: /(?<![\w_])_(\S|\S[\s\S]*?\S)_(?!\w)/ },
];

function firstSpan(text) {
  let found = null;
  for (const { tag, re } of INLINE) {
    const m = re.exec(text);
    if (m && (!found || m.index < found.at)) {
      found = { tag, at: m.index, width: m[0].length, body: m[1] };
    }
  }
  return found;
}

function render(text, into) {
  let rest = text;
  for (let span = firstSpan(rest); span; span = firstSpan(rest)) {
    if (span.at) into.append(rest.slice(0, span.at));
    const el = into.ownerDocument.createElement(span.tag);
    if (span.tag === 'code') el.append(span.body);
    else render(span.body, el);
    into.append(el);
    rest = rest.slice(span.at + span.width);
  }
  if (rest) into.append(rest);
  return into;
}

export function createHud(root = document) {
  const statusEl = root.querySelector('#status');
  const captionEl = root.querySelector('#caption');
  const youEl = root.querySelector('#you');

  let turn = '';

  return {
    setState(state) {
      statusEl.dataset.state = state;
      statusEl.textContent = state;
    },

    showUser(text) {
      youEl.textContent = text;
      youEl.classList.add('visible');
    },

    hideUser() {
      youEl.classList.remove('visible');
    },

    appendCaption(chunk) {
      turn += chunk;
      captionEl.classList.remove('error');
      captionEl.classList.add('visible');
      captionEl.replaceChildren();
      render(turn, captionEl);
      captionEl.scrollTop = captionEl.scrollHeight;
    },

    clearCaption() {
      turn = '';
      captionEl.replaceChildren();
      captionEl.classList.remove('visible', 'error');
    },

    showError(message) {
      turn = '';
      captionEl.textContent = message;
      captionEl.classList.add('visible', 'error');
    },
  };
}
