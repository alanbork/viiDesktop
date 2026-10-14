/* ChatPlus plugin: ask user.
 *
 * The Phase 2 reference for a card that PARKS the turn: the handler calls
 * t.awaitAnswer(payload) and the chat shows an interactive chooser until the
 * user answers. This file is also the reference implementation of the typing
 * guarantee: whatever the user has typed is remembered (host.state) before it
 * could ever be repainted away, survives chat switches and reloads, restores
 * caret + focus, and respects IME composition. Any plugin with a text field
 * should copy this shape.
 *
 * Install: copy this file to <DATA_ROOT>\plugins\ and approve it in
 * Settings > Plugins. */
define({
  apiVersion: 1,
  // TODO (LOUD, NOT APPROVED SHAPE): the colors in this style string are a
  // shortcut, not the design. Plugins are supposed to own their theming: ship a
  // dark table and a light table and pick one with window.isDarkMode(), exactly
  // as plugins/proofreader.js does (see plugins/README.md contract). Instead
  // this uses translucent neutrals plus color:inherit, which quietly depends on
  // the host card color and also changed the dark look slightly (the original
  // fixed dark values are gone). Refactor: restore the original dark colors as
  // THEMES.dark byte-for-byte, add THEMES.light, build the CSS per theme.
  // Check first whether pluginhost.js accepts a computed style string.
  // Scoped by the host to this plugin's cards: plain class names are safe.
  style:
    '.cp-au{display:flex;flex-direction:column;gap:8px;min-width:min(100%,360px);max-width:520px}' +
    '.cp-au-q{font-weight:600;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.cp-au-opts{display:flex;flex-direction:column;gap:6px}' +
    // Surfaces are translucent neutrals over the host card with inherited ink,
    // so they read on dark and light hosts without asking the theme. Provisional.
    '.cp-au-btn{border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.14);color:inherit;border-radius:8px;padding:7px 10px;cursor:pointer;text-align:left;font:inherit;line-height:1.4}' +
    '.cp-au-btn:hover{border-color:#4f7cff}' +
    '.cp-au-btn.reco{border-color:#4f7cff99}' +
    '.cp-au-btn.chosen{border-color:#3fb950;background:rgba(63,185,80,.2)}' +
    '.cp-au-tag{float:right;font-size:11px;color:inherit;opacity:.65;margin-left:8px}' +
    '.cp-au-text{display:flex;gap:6px}' +
    '.cp-au-in{flex:1;min-width:0;background:rgba(128,128,128,.1);color:inherit;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:7px 10px;font:inherit;line-height:1.4}' +
    '.cp-au-in:focus{outline:none;border-color:#4f7cff}' +
    '.cp-au-send{border:1px solid #4f7cff;background:#4f7cff22;color:inherit;border-radius:8px;padding:0 12px;cursor:pointer}' +
    '.cp-au-hint{font-size:11px;color:inherit;opacity:.65}' +
    '.cp-au-answered .cp-au-opts{opacity:.85}',
  name: 'ask_user',
  description:
    '#CHAT Ask the user one question with 1-12 tappable choices (plus an optional ' +
    'free-text box). The turn waits for the answer; you receive the exact ' +
    'answer text as the tool result. Use for decisions you cannot make from ' +
    'the files alone (ambiguous naming, destructive confirmations, taste). ' +
    'Make the first option the one you recommend. End the turn after calling ' +
    'this - do not also ask the same question in prose.',
  params: [
    { name: 'question', type: 'string', required: true,
      description: 'One-sentence question shown above the choices.' },
    { name: 'options', type: 'array', required: true,
      description: '1-12 short strings, each a complete self-describing answer.' },
    { name: 'allow_text', type: 'boolean', required: false,
      description: 'Also offer a free-text box (default true).' }
  ],
  access: { op: 'chat' },

  async handler(args, t) {
    const question = String(args.question || '').trim();
    if (!question) throw new Error('ask_user: question must be a non-empty string');
    let options = Array.isArray(args.options) ? args.options.map(function (o) { return String(o).trim(); }).filter(Boolean) : [];
    if (!options.length) throw new Error('ask_user: options must contain 1-12 non-empty strings');
    if (options.length > 12) options = options.slice(0, 12);
    const allowText = args.allow_text !== false;
    const payload = { question, options, allowText };
    let answer;
    try {
      answer = await t.awaitAnswer(payload);
    } catch (e) {
      if (e && e.stopped) {
        // Turn stopped mid-question: report it honestly, keep no card state
        // claim, and let the model await further instructions.
        return { text: 'The user did not answer (the turn was stopped before an answer arrived). Do not assume anything; await further instructions.' };
      }
      throw e;
    }
    return {
      text: 'The user answered: ' + JSON.stringify(answer) + '\nContinue with this answer in mind. Do not re-ask this question.',
      widget: { question, options, allowText, answered: answer }
    };
  },

  summary(data, state) {
    if (data && typeof data.answered === 'string') return { text: 'answered: ' + data.answered, open: false };
    if (state && state.draft) return { text: 'waiting for your answer (draft kept)', open: true };
    return { text: 'waiting for your answer', open: true };
  },

  render(body, data, host) {
    const wrap = document.createElement('div');
    wrap.className = 'cp-au';
    // The widget owns keyboard focus semantics inside this subtree; the host
    // hotkey guard (amendment A4) keys on data-widget-ui.
    wrap.setAttribute('data-widget-ui', '1');

    const q = document.createElement('div');
    q.className = 'cp-au-q';
    q.textContent = (data && data.question) || '';
    wrap.appendChild(q);

    const optsBox = document.createElement('div');
    optsBox.className = 'cp-au-opts';
    const options = (data && data.options) || [];
    const answered = data && typeof data.answered === 'string' ? data.answered : null;

    let input = null, ta = null;
    if (answered === null) {
      const remember = function (extra) {
        const cur = host.state.get() || {};
        const next = Object.assign({}, cur, extra || {});
        try { host.state.set(next); } catch (e) { /* unserializable state: drop silently, typing itself must never break */ }
      };
      options.forEach(function (label, i) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cp-au-btn' + (i === 0 ? ' reco' : '');
        const tag = document.createElement('span');
        tag.className = 'cp-au-tag';
        tag.textContent = i === 0 ? 'recommended' : '';
        b.appendChild(tag);
        b.appendChild(document.createTextNode(label));
        b.addEventListener('click', function () {
          remember({ draft: null, answeredLocally: true });
          host.answer(label);
        });
        optsBox.appendChild(b);
      });
      wrap.appendChild(optsBox);

      if (data && data.allowText !== false) {
        const row = document.createElement('div');
        row.className = 'cp-au-text';
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'cp-au-in';
        input.placeholder = 'or type your own answer...';
        input.setAttribute('aria-label', 'Your answer');
        ta = input;
        let composing = false;
        input.addEventListener('compositionstart', function () { composing = true; });
        input.addEventListener('compositionend', function () {
          composing = false;
          remember({ draft: input.value, selStart: input.selectionStart, selEnd: input.selectionEnd });
        });
        input.addEventListener('input', function () {
          if (composing) return; // wait for compositionend: partial IME text is not the user's text yet
          remember({ draft: input.value, selStart: input.selectionStart, selEnd: input.selectionEnd });
        });
        const send = function () {
          const v = input.value.trim();
          if (!v) return;
          remember({ draft: null, answeredLocally: true });
          host.answer(v);
        };
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); send(); }
          if (ev.key === 'Escape') ev.stopPropagation(); // Esc in a card must not hit app-level Esc handlers
        });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cp-au-send';
        btn.textContent = 'Send';
        btn.addEventListener('click', send);
        row.append(input, btn);
        wrap.appendChild(row);
      }
      const hint = document.createElement('div');
      hint.className = 'cp-au-hint';
      hint.textContent = 'Pick a choice or type an answer - the turn continues as soon as you do. Your typing is kept if you switch away and back.';
      wrap.appendChild(hint);
      // Restore an in-progress draft (this render may be a repaint after a
      // chat switch). Caret first, then focus, only when there is something
      // to place it in - stealing focus on an empty restore is rude.
      const saved = host.state.get() || {};
      if (input && typeof saved.draft === 'string' && saved.draft) {
        input.value = saved.draft;
        try {
          input.focus({ preventScroll: true });
          const s = Math.min(saved.selStart == null ? input.value.length : saved.selStart, input.value.length);
          const e2 = Math.min(saved.selEnd == null ? s : saved.selEnd, input.value.length);
          input.setSelectionRange(s, e2);
        } catch (e) { /* a detached render (harness) cannot focus; fine */ }
      }
    } else {
      // Settled: show what was picked, others dimmed. Read-only, keeps the
      // transcript row self-explanatory years later.
      wrap.classList.add('cp-au-answered');
      options.forEach(function (label) {
        const d = document.createElement('button');
        d.type = 'button';
        d.disabled = true;
        d.className = 'cp-au-btn' + (label === answered ? ' chosen' : '');
        d.style.cursor = 'default';
        const tag = document.createElement('span');
        tag.className = 'cp-au-tag';
        tag.textContent = label === answered ? 'chosen' : '';
        d.appendChild(tag);
        d.appendChild(document.createTextNode(label));
        optsBox.appendChild(d);
      });
      const line = document.createElement('div');
      line.className = 'cp-au-hint';
      line.textContent = 'Answered: ' + answered;
      wrap.appendChild(optsBox);
      wrap.appendChild(line);
    }
    body.appendChild(wrap);
  }
});


