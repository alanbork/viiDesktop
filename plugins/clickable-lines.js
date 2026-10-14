/* ChatPlus plugin: clickable lines.
 *
 * The Phase 1 demo of the plugin contract: a tool the model calls to show
 * numbered, copyable lines the user can act on, then the turn ends. No file
 * access, no waiting. Two jobs it has to do well:
 *  1. the result text tells the model exactly what the card already did, so
 *     it stops instead of repeating the lines in prose;
 *  2. the card renders from (data + remembered state) alone, so chat
 *     switches and repaints reproduce it identically.
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
    '.cp-cl{display:flex;flex-direction:column;gap:4px;min-width:min(100%,420px)}' +
    '.cp-cl-row{display:flex;gap:10px;align-items:start;border:1px solid transparent;border-radius:6px;padding:4px 8px;cursor:pointer;font:13px/1.5 ui-monospace,Consolas,monospace;background:rgba(128,128,128,.14);text-align:left;color:inherit}' +
    '.cp-cl-row:hover{border-color:#4f7cff}' +
    '.cp-cl-row.copied{border-color:#3fb950;background:rgba(63,185,80,.2)}' +
    // translucent neutrals + inherited ink: readable on dark and light hosts. Provisional.
    '.cp-cl-n{color:inherit;opacity:.6;flex:0 0 2.5ch;text-align:right;user-select:none}' +
    '.cp-cl-t{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}' +
    '.cp-cl-c{margin-left:auto;flex:0 0 auto;padding-top:1px;color:inherit;opacity:.6;font-size:11px;user-select:none}',
  name: 'clickable_lines',
  description:
    '#CHAT Present text to the user in a card as numbered, tappable rows. ' +
    'Each row is one tap-to-copy block: the row shows exactly the text that ' +
    'lands on the clipboard. Use it whenever the user ' +
    'needs to copy something: paths, commands, config blocks, etc. The card is already the answer; do not ' +
    'repeat the text in your reply. It should be one of the last things you do in your turn, or it will scroll off the screen and disappear.',
  params: [
    { name: 'lines', type: 'array', required: true, items: { type: 'string' },
      description: '1-200 entries. Each entry is one row and one copy ' +
        'payload. newlines are allowed but often go against the intent letting the user select a subset of what was presented.' }
  ],
  access: { op: 'chat' },

  async handler(args) {
    let items = args.lines;
    if (!Array.isArray(items)) {
      if (typeof items === 'string') items = items.split(/\r?\n/);
      else throw new Error('clickable_lines: lines must be an array');
    }
    // One text per row. An object is tolerated so older calls do not hard
    // fail, but it collapses to a single string: there is no short form to
    // display. copy wins over label because copy is the payload.
    items = items
      .map(function (it) {
        if (typeof it === 'string') return it;
        if (it && typeof it === 'object') {
          if (typeof it.copy === 'string') return it.copy;
          if (typeof it.label === 'string') return it.label;
        }
        return null;
      })
      .filter(function (it) { return typeof it === 'string' && it.length > 0; });
    if (!items.length) throw new Error('clickable_lines: no usable lines (expected 1-200 non-empty strings)');
    if (items.length > 200) items = items.slice(0, 200);
    const n = items.length;
    return {
      text: 'Displayed ' + n + ' copyable line' + (n === 1 ? '' : 's') +
        ' to the user in a card. The lines are already in front of them: do not repeat their contents in your reply. ' +
        'End the turn now with at most a short closing note.',
      widget: { n, items }
    };
  },

  /* Head line. state = remembered per-call blob or null; copied tracks which
     row the user copied (cosmetic, survives repaints). */
  summary(data, state) {
    const n = (data && data.n) || 0;
    let text = n + ' line' + (n === 1 ? '' : 's') + ' offered';
    if (state && typeof state.copied === 'number' && state.copied >= 0) text += ' · copied #' + (state.copied + 1);
    return { text, open: true };
  },

  render(body, data, host) {
    const remember = host.state.get() || {};
    const copied = typeof remember.copied === 'number' ? remember.copied : -1;
    const wrap = document.createElement('div');
    wrap.className = 'cp-cl';
    const items = (data && data.items) || [];
    items.forEach(function (it, i) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cp-cl-row' + (i === copied ? ' copied' : '');
      const num = document.createElement('span');
      num.className = 'cp-cl-n';
      num.textContent = String(i + 1);
      const txt = document.createElement('span');
      txt.className = 'cp-cl-t';
      txt.textContent = it;
      const hint = document.createElement('span');
      hint.className = 'cp-cl-c';
      hint.textContent = i === copied ? 'copied' : 'copy';
      row.append(num, txt, hint);
      row.addEventListener('click', function () {
        host.copy(it, function () {
          const cur = host.state.get() || {};
          host.state.set({ copied: i, copiedCount: (cur.copiedCount || 0) + 1 });
          hint.textContent = 'copied';
          row.classList.add('copied');
        });
      });
      wrap.appendChild(row);
    });
    const foot = document.createElement('div');
    foot.className = 'cp-cl-c';
    foot.style.marginTop = '2px';
    foot.textContent = 'Click a line to copy it';
    wrap.appendChild(foot);
    body.appendChild(wrap);
  }
});


