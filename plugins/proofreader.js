/* ChatPlus plugin: proofreader card.
 *
 * The model proposes edits by resending the passage with inline edit marks;
 * the chat shows a card where every group displays its recommendation, the
 * user picks alternatives from a menu, tweaks wording directly (typing "bakes"
 * that choice in as plain text), and copies the resolved result. The turn
 * ends right after the card; everything the user does afterwards is local,
 * remembered in the chat's widgets.json, and never sent anywhere.
 *
 * Interface: one tool with a required verb (unlock, check, present). The
 * always-on description is a thin stub; the full usage text is returned only
 * by the unlock verb (see PROOF_USAGE and the seam comment above define()).
 *
 * Markup:
 *     ASCII with backslash escaping:   {recommended|original}
 * Rules:
 *   - { opens a group, | separates alternatives, } closes it.
 *   - To include literal {, |, }, or \ characters inside text, escape them
 *     with a backslash: \{, \|, \}, \\.
 *   - the FIRST alternative is the recommended correction (shown by default);
 *   - the LAST alternative is the original text, exactly;
 *   - middle alternatives are optional suggestions;
 *   - empty first alternative = recommended deletion; empty last = insertion;
 *     both empty with middle alternatives = rare recommendation-free suggestion;
 *   - spaces are literal; at least two alternatives, not all empty;
 *   - no nesting; unescaped marker characters outside groups are errors.
 *
 * Unadvertised Unicode dialect (deliberate, do not remove or re-advertise):
 *   The parser also accepts a Unicode delimiter set (U+27EA open, U+2016
 *   separator, U+27EB close) in place of { | }. It is kept on purpose so
 *   saved chats containing Unicode cards keep working, and it is not dead
 *   code. It is not mentioned in the tool stub or the unlock text, and must
 *   not be re-advertised. Known hazard: any single Unicode delimiter
 *   character anywhere in a passage flips the whole parse into that dialect.
 *   No accidental trigger has ever been observed; if the hazard is ever seen
 *   in practice, the right response is a real refactor that removes the
 *   dialect, not a patch.
 *
 * Theme: the plugin never chooses it and never stores it. At draw time the
 *   card asks the app's public predicate, window.isDarkMode(), and picks one
 *   of the two color tables below. The tables are this plugin's own colors,
 *   deliberately not a mirror of the app's stylesheet.
 *
 * Contract showcase: click-to-choose menus through the floating overlay host
 * (amendment A1), the full typing guarantee with caret + selection carry
 * across repaints (A3), in-memory undo (deliberately NOT persisted),
 * decisions persisted as markup+selections rather than copies of the text
 * (A5). The parse engine below is DOM-free and unit-testable under Node; it
 * mirrors the prototype's parse.ts/present.ts semantics (error taxonomy with
 * positions and excerpts, all-or-nothing validity, nested-group recovery,
 * merged menu entries, kind labels, selection carry-over).
 *
 * Install: copy to <DATA_ROOT>\plugins\ and approve in Settings > Plugins.
 * check echoes the resolved passage so the model can proofread itself while it
 * can still fix the markup; present returns a count only, because by then the
 * user owns the wording and can change every choice in the card. */
'use strict';

const PROOF = (function () {
  const OPEN = '{', SEP = '|', CLOSE = '}';
  const UNI_OPEN = '⟪', UNI_SEP = '‖', UNI_CLOSE = '⟫';
  const BS = String.fromCharCode(92); // backslash '\'
  const TYPE_LABEL = {
    'no-edit-groups': 'No edit groups',
    'unexpected-opener': 'Unexpected opener',
    'unexpected-separator': 'Unexpected separator',
    'unexpected-closer': 'Unexpected closer',
    'unterminated-edit-group': 'Unterminated group',
    'nested-edit-group': 'Nested group',
    'too-few-alternatives': 'Too few alternatives',
    'all-alternatives-empty': 'All alternatives empty'
  };

  /* ---------- parse + presentation engine (pure text in/out) ---------- */

  const EXCERPT_RADIUS = 18;
  function lineCol(src, pos) {
    let line = 1, lastNewline = -1;
    for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) { line++; lastNewline = i; }
    return { line: line, column: pos - lastNewline };
  }
  const isLowSurrogate = function (code) { return code >= 0xdc00 && code <= 0xdfff; };
  function excerptAround(src, pos, withMarker) {
    let from = Math.max(0, pos - EXCERPT_RADIUS);
    let to = Math.min(src.length, pos + EXCERPT_RADIUS + 1);
    if (from > 0 && isLowSurrogate(src.charCodeAt(from))) from--;
    if (to < src.length && isLowSurrogate(src.charCodeAt(to))) to++;
    const lead = from > 0 ? '\u2026' : '';
    const tail = to < src.length ? '\u2026' : '';
    const body = src.slice(from, to).replace(/[\n\r\t]/g, function (c) { return c === '\t' ? '\u21E5' : '\u23CE'; });
    return { excerpt: lead + body + tail, marker: withMarker && pos < src.length ? lead.length + (pos - from) : -1 };
  }

  function detectDelimiterStyle(text) {
    if (typeof text === 'string' && (text.includes(UNI_OPEN) || text.includes(UNI_SEP) || text.includes(UNI_CLOSE))) {
      return 'unicode';
    }
    return 'curly';
  }

  function escapeCurlyText(s) {
    return String(s)
      .split(BS).join(BS + BS)
      .split('{').join(BS + '{')
      .split('|').join(BS + '|')
      .split('}').join(BS + '}');
  }

  /* Inverse of escapeCurlyText for the all-baked local state: markup with no
     groups is still escaped (a literal "{" lives as "\{"), but the surface
     and the clipboard need the visible form. Lone backslashes pass through,
     mirroring parse(). */
  function unescapeCurlyText(s) {
    return String(s).replace(/\\([\\{|}])/g, '$1');
  }

  /* Local-only validity: plain text with no groups is a legal card state
     (every edit baked), even though check/present still reject it for the
     model. True only when no-edit-groups is the single error. */
  function isOnlyNoGroups(cp) {
    return !!cp && !cp.ok && Array.isArray(cp.errors) &&
      cp.errors.length > 0 && cp.errors.every(function (e) { return e && e.type === 'no-edit-groups'; });
  }

  /**
   * Parse and validate the complete input exactly like the prototype's
   * parseProofreadingMarkup: collects every error in one pass, never returns
   * parts when anything is wrong. Groups: alternatives[0] = recommended,
   * alternatives[n-1] = original, middle = optional suggestions.
   * Supports both curly { | } with backslash escaping and Unicode ⟪ ‖ ⟫.
   */
  function parse(text, forcedStyle) {
    const style = forcedStyle || detectDelimiterStyle(text);
    const isCurly = (style === 'curly');
    const OPEN_CH = isCurly ? OPEN : UNI_OPEN;
    const SEP_CH = isCurly ? SEP : UNI_SEP;
    const CLOSE_CH = isCurly ? CLOSE : UNI_CLOSE;

    const errors = [];
    const parts = [];
    const groups = [];
    let sawOpener = false, editCount = 0;

    function fail(type, position, message, withMarker) {
      const lc = lineCol(text, position);
      const ex = excerptAround(text, position, withMarker !== false);
      errors.push({ type: type, message: message, position: position, line: lc.line, col: lc.column, excerpt: ex.excerpt, marker: ex.marker });
    }

    let buffer = '';
    let bufferStart = 0;
    let inGroup = false;
    let groupStart = -1;
    let alts = null;
    let current = '';
    let depth = 0;
    let nestedAt = [];

    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const ch = text[i];

      // Handle backslash escaping in curly mode
      if (isCurly && ch === BS) {
        if (i + 1 < text.length) {
          const next = text[i + 1];
          if (next === '{' || next === '|' || next === '}' || next === BS) {
            if (!inGroup) {
              if (buffer === '') bufferStart = i;
              buffer += next;
            } else {
              if (depth === 0) current += next;
            }
            i++; // consume escaped character
            continue;
          }
        }
        if (!inGroup) {
          if (buffer === '') bufferStart = i;
          buffer += ch;
        } else {
          if (depth === 0) current += ch;
        }
        continue;
      }

      if (!inGroup) {
        if (ch === OPEN_CH) {
          sawOpener = true;
          if (buffer !== '') {
            parts.push({ lit: buffer, start: bufferStart, end: i });
            buffer = '';
          }
          bufferStart = i + 1;
          inGroup = true;
          groupStart = i;
          alts = [];
          current = '';
          depth = 0;
          nestedAt = [];
        } else if (!isCurly && ch === SEP_CH) {
          fail('unexpected-separator', i, 'Separator ' + SEP_CH + ' appears outside an edit group.');
        } else if (ch === CLOSE_CH) {
          fail('unexpected-closer', i, 'Closer ' + CLOSE_CH + ' has no matching opener ' + OPEN_CH + '.');
        } else {
          if (buffer === '') bufferStart = i;
          buffer += ch;
        }
        continue;
      }

      // Inside a group
      if (ch === OPEN_CH) {
        depth++;
        nestedAt.push(i);
      } else if (ch === CLOSE_CH) {
        if (depth > 0) {
          depth--;
          continue;
        }
        alts.push(current);
        inGroup = false;
        if (nestedAt.length > 0) {
          for (const pos of nestedAt) {
            fail('nested-edit-group', pos, 'Edit groups cannot be nested (this ' + OPEN_CH + ' is inside the group opened at char ' + groupStart + ').');
          }
        } else {
          const issues = [];
          if (alts.length < 2) {
            issues.push(['too-few-alternatives', 'An edit group needs at least 2 alternatives (' + (isCurly ? 'recommended|original' : 'recommended‖original') + ') - found ' + alts.length + '.']);
          }
          let nonEmpty = false;
          for (let k = 0; k < alts.length; k++) {
            if (alts[k] !== '') { nonEmpty = true; break; }
          }
          if (!nonEmpty) {
            issues.push(['all-alternatives-empty', alts.length < 2 ? 'The edit group is empty.' : 'All ' + alts.length + ' alternatives in this edit group are empty.']);
          }
          if (issues.length) {
            for (const item of issues) fail(item[0], groupStart, item[1]);
          } else {
            const grp = {
              g: alts,
              start: groupStart,
              end: i + 1,
              index: editCount++,
              rec: 0,
              orig: alts.length - 1,
              delimiterStyle: style
            };
            parts.push(grp);
            groups.push(grp);
          }
        }
        bufferStart = i + 1;
      } else if (ch === SEP_CH) {
        if (depth === 0) {
          alts.push(current);
          current = '';
        }
      } else if (depth === 0) {
        current += ch;
      }
    }

    if (inGroup) {
      for (const pos of nestedAt) {
        fail('unexpected-opener', pos, 'Opener ' + OPEN_CH + ' found while the group opened at char ' + groupStart + ' is still open - is a ' + CLOSE_CH + ' missing?');
      }
      fail('unterminated-edit-group', groupStart, 'Edit group is never closed with ' + CLOSE_CH + '.');
    } else if (buffer !== '') {
      parts.push({ lit: buffer, start: bufferStart, end: text.length });
    }

    if (!sawOpener) {
      fail('no-edit-groups', 0, "No edit groups found - the reply doesn't contain " + OPEN_CH + 'recommended' + SEP_CH + 'original' + CLOSE_CH + '.', false);
    }

    if (errors.length > 0) {
      errors.sort(function (a, b) { return a.position - b.position; });
      return { ok: false, errors: errors, parts: [], groups: [], text: text, delimiterStyle: style };
    }
    return { ok: true, errors: [], parts: parts, groups: groups, text: text, delimiterStyle: style };
  }

  function serializeGroup(g, forcedStyle) {
    const style = forcedStyle || g.delimiterStyle || 'curly';
    const alts = g.g || g.alternatives || [];
    if (style === 'curly') {
      const escaped = alts.map(escapeCurlyText);
      return OPEN + escaped.join(SEP) + CLOSE;
    }
    return UNI_OPEN + alts.join(UNI_SEP) + UNI_CLOSE;
  }

  function defaultSel(p) { return p.groups.map(function (g) { return g.rec; }); }
  function originalSel(p) { return p.groups.map(function (g) { return g.orig; }); }

  /** Concatenate text parts and each group's selected alternative. */
  function resolve(p, sel) {
    let out = '';
    for (const part of p.parts) {
      if (part.lit != null) {
        out += part.lit;
      } else {
        const choice = sel ? sel[part.index] : undefined;
        const cur = choice === undefined ? part.rec : choice;
        out += part.g[cur] != null ? part.g[cur] : part.g[part.rec];
      }
    }
    return out;
  }

  /**
   * After the markup is edited and reparsed, keep the user's choices for
   * edits whose alternatives are unchanged (matched in order); new edits
   * start at their recommendation. (Prototype carrySelections.)
   */
  function carrySelections(prev, prevSel, next) {
    const pgroups = prev ? prev.groups : [];
    let from = 0;
    return next.groups.map(function (g) {
      const sep = g.delimiterStyle === 'unicode' ? UNI_SEP : SEP;
      const k = g.g.join(sep);
      for (let j = from; j < pgroups.length; j++) {
        const psep = pgroups[j].delimiterStyle === 'unicode' ? UNI_SEP : SEP;
        if (pgroups[j].g.join(psep) === k) {
          from = j + 1;
          const sel = prevSel ? prevSel[j] : undefined;
          return sel !== undefined && sel >= 0 && sel < g.g.length ? sel : g.rec;
        }
      }
      return g.rec;
    });
  }

  function carryChosen(prev, prevChosen, next) {
    const pgroups = prev ? prev.groups : [];
    let from = 0;
    return next.groups.map(function (g) {
      const sep = g.delimiterStyle === 'unicode' ? UNI_SEP : SEP;
      const k = g.g.join(sep);
      for (let j = from; j < pgroups.length; j++) {
        const psep = pgroups[j].delimiterStyle === 'unicode' ? UNI_SEP : SEP;
        if (pgroups[j].g.join(psep) === k) {
          from = j + 1;
          return !!(prevChosen && prevChosen[j]);
        }
      }
      return false;
    });
  }

  /**
   * Code-point range [start,end) of `current` to underline, or null for
   * the whole text. A localized edit (home=>homes) underlines only the
   * changed characters; unrelated words (home=>the) underline everything,
   * because a partial mark there would be noise. Pure deletion
   * (colour=>color) marks the single character at the edit boundary,
   * since there is no new character to underline. Pure, DOM-free,
   * testable like the rest of the parse engine.
   */
  function underlineRange(original, current) {
    if (original === current) return null;
    const O = Array.from(original), C = Array.from(current);
    const maxPre = Math.min(O.length, C.length);
    let p = 0;
    while (p < maxPre && O[p] === C[p]) p++;
    let s = 0;
    while (s < maxPre - p && O[O.length - 1 - s] === C[C.length - 1 - s]) s++;
    if (p + s === 0) return null;
    const midCur = C.length - p - s;
    const midOrig = O.length - p - s;
    if (midCur + midOrig > Math.max(2, Math.ceil(Math.max(O.length, C.length) * 0.5))) return null;
    if (midCur === 0) {
      return p > 0 ? { start: p - 1, end: p } : { start: C.length - s, end: C.length - s + 1 };
    }
    if (midCur >= C.length) return null;
    return { start: p, end: C.length - s };
  }

  /**
   * How an edit currently looks, derived from its selected text vs. its
   * original (prototype describeEdit):
   *  replacement / insertion / deletion (shown struck through) /
   *  unchanged (faint underline) / insertion-point (residual caret marker).
   * isChosen = true applies "your choice" styling (overridden: true),
   * even when selecting what was already recommended.
   */
  function describeEdit(g, selected, isChosen) {
    const rec = g.g[g.rec], orig = g.g[g.orig];
    const cur = selected === undefined ? rec : (g.g[selected] != null ? g.g[selected] : rec);
    let kind;
    if (cur === orig) kind = cur === '' ? 'insertion-point' : 'unchanged';
    else if (orig === '') kind = 'insertion';
    else if (cur === '') kind = 'deletion';
    else kind = 'replacement';
    const overridden = Boolean(isChosen || (cur !== rec));
    return { kind: kind, current: cur, original: orig, recommended: rec, changed: cur !== orig, overridden: overridden, underline: underlineRange(orig, cur) };
  }

  function kindLabel(view) {
    switch (view.kind) {
      case 'replacement': return 'Replacement';
      case 'insertion': return 'Insertion';
      case 'deletion': return 'Deletion';
      case 'unchanged': return view.overridden ? 'Original kept' : 'Suggestion only';
      default: return view.overridden ? 'Insertion declined' : 'Optional insertion';
    }
  }

  const q = function (s) { return '\u201C' + s + '\u201D'; };
  function editTooltip(view) {
    const open = 'click for alternatives';
    switch (view.kind) {
      case 'replacement': return 'Was ' + q(view.original) + ' - ' + open;
      case 'insertion': return 'Inserted - ' + open;
      case 'deletion': return 'Proposed deletion of ' + q(view.original) + ' - click to keep it';
      case 'unchanged': return view.overridden
        ? 'Original kept - recommended: ' + (view.recommended ? q(view.recommended) : '[remove text]')
        : 'No change recommended - ' + open;
      default: return view.overridden
        ? 'Nothing inserted - click to insert ' + q(view.recommended)
        : 'Optional insertion - ' + open;
    }
  }

  function editAriaLabel(g, view, total) {
    const n = 'Edit ' + (g.index + 1) + ' of ' + total;
    switch (view.kind) {
      case 'replacement': return n + ': ' + q(view.current) + ', replaces ' + q(view.original);
      case 'insertion': return n + ': inserted ' + q(view.current);
      case 'deletion': return n + ': deleted ' + q(view.original);
      case 'unchanged': return n + ': ' + q(view.current) + ', unchanged';
      default: return n + ': insertion point, nothing inserted';
    }
  }

  /**
   * Distinct alternatives in order; identical texts merge into one entry (e.g.
   * when the recommendation keeps the original) so the menu never shows two
   * indistinguishable options. (Prototype menuEntries + entryChoice.)
   */
  function menuEntries(g) {
    const byText = new Map(); const entries = [];
    g.g.forEach(function (t, i) {
      let e = byText.get(t);
      if (!e) { e = { text: t, indices: [], rec: false, orig: false }; byText.set(t, e); entries.push(e); }
      e.indices.push(i);
      if (i === g.rec) e.rec = true;
      if (i === g.orig) e.orig = true;
    });
    return entries;
  }

  function entryChoice(g, entry) { return entry.rec ? g.rec : entry.orig ? g.orig : entry.indices[0]; }
  /** Label for an empty alternative: depends on what the original is. */
  function emptyLabel(g) { return g.g[g.orig] === '' ? '[empty]' : '[remove text]'; }

  /**
   * Leading/trailing whitespace (and any inner tab/newline) become faint
   * glyphs in the menu, so alternatives differing only in spacing stay
   * distinguishable. Ordinary inner spaces are left as spaces.
   */
  const WS_GLYPH = { ' ': '\u2423', '\t': '\u21E5', '\n': '\u23CE', '\r': '\u23CE' };
  function visibleWhitespace(text) {
    const segs = [];
    function push(t, ws) {
      const prev = segs[segs.length - 1];
      if (prev && prev.ws === ws) prev.t += t; else segs.push({ t: t, ws: ws });
    }
    const first = text.search(/\S/);
    let last = text.length - 1;
    while (last >= 0 && /\s/.test(text[last])) last--;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const atEdge = first === -1 || i < first || i > last;
      if (/\s/.test(c) && (atEdge || c !== ' ')) push(WS_GLYPH[c] || '\u00B7', true);
      else push(c, false);
    }
    return segs;
  }

  /** Head-line stats over live groups. Counts overridden choices accurately. */
  function stats(p, sel, chosen) {
    let changes = 0, differ = 0;
    for (let i = 0; i < p.groups.length; i++) {
      const g = p.groups[i];
      const k = sel ? sel[g.index] : undefined;
      const isChosen = chosen ? !!chosen[i] : false;
      const v = describeEdit(g, k, isChosen);
      if (v.changed) changes++;
      if (v.overridden) differ++;
    }
    return { edits: p.groups.length, changes: changes, differ: differ };
  }

  function stripMarkers(s, delimiterStyle) {
    if (delimiterStyle === 'unicode') {
      return s.split(UNI_OPEN).join('').split(UNI_SEP).join('').split(UNI_CLOSE).join('');
    }
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === BS && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === OPEN || next === SEP || next === CLOSE || next === BS) {
          out += BS + next;
          i++;
          continue;
        }
      }
      if (c === OPEN || c === SEP || c === CLOSE) {
        continue;
      }
      out += c;
    }
    return out;
  }

  /* ---------- DOM-free parts end here; the card starts ---------- */

  // Theme support: light and dark. Each theme is one flat table of fully
  // resolved CSS values (no shared hue ramp, no per-call-site composition).
  // Every consumer (buildThemeCSS, the legend swatches, the inline kind
  // badges) reads the same keys from the same table. Which table is used is
  // decided once per draw by getTheme(), never by a caller and never by the
  // model.
  const THEMES = {
    light: {
      // chrome
      bgCard: '#ffffff', bgSurface: '#ffffff', bgRaised: '#f8fafc',
      fg: '#0f172a', fgMuted: '#64748b',
      border: '#e2e8f0', borderLight: '#f1f5f9',
      menuShadow: '0 20px 25px -5px rgba(15,23,42,0.12),0 8px 10px -6px rgba(15,23,42,0.10)',
      // Carried at the value the card rule used inline before the key existed,
      // so light renders unchanged. Dark is the verified theme; this key is
      // here only so buildThemeCSS never reads an undefined one.
      cardShadow: '0 1px 3px 0 rgba(0,0,0,0.03)',
      btnBg: '#f8fafc', btnBorder: '#cbd5e1', btnHoverBorder: '#6366f1',
      btnPrimaryBg: '#6366f1', btnPrimaryFg: '#ffffff', btnPrimaryBorder: '#4f46e5',
      btnDisabledFg: '#94a3b8', btnDisabledBorder: '#e2e8f0',
      slate400: '#64748b',
      accentBlue: '#6366f1', accentGreen: '#3fb950',
      noteBorder: '#6b5bff', noteFg: '#4338ca',
      // replacement (amber)
      replBg: 'rgba(254,240,138,0.7)', replBgHover: 'rgba(253,230,138,0.85)',
      replFg: '#451a03', replUnderline: '#f59e0b',
      replBadgeBg: '#fef3c7', replBadgeFg: '#92400e',
      // insertion (emerald)
      insBg: 'rgba(209,250,229,0.7)', insBgHover: 'rgba(167,243,208,0.85)',
      insFg: '#022c22', insUnderline: '#10b981',
      insBadgeBg: '#d1fae5', insBadgeFg: '#065f46',
      // deletion (rose)
      delBg: 'rgba(255,228,230,0.75)', delBgHover: 'rgba(254,205,211,0.9)',
      delFg: 'rgba(190,18,60,0.75)', delUnderline: '#f43f5e',
      delBadgeBg: '#ffe4e6', delBadgeFg: '#be123c',
      // suggestion-only (neutral underline)
      suggUnderline: '#94a3b8', suggBgHover: '#f1f5f9',
      // nothing-to-insert (emerald, quiet)
      noneBg: '#ecfdf5', noneFg: '#059669', noneBgHover: '#d1fae5',
      unchangedBadgeBg: '#f1f5f9', unchangedBadgeFg: '#475569',
      insertionPointBadgeBg: '#ecfdf5', insertionPointBadgeFg: '#047857',
      // overridden ("your choice", blue)
      overriddenBg: 'rgba(224,231,255,0.75)', overriddenBgHover: 'rgba(199,210,254,0.9)',
      overriddenFg: '#1e1b4b', overriddenRing: '#818cf8',
      // error
      errBorder: '#f43f5e', errBg: '#fff1f2', errFg: '#be123c', errCodeBg: '#00000014',
      errMarkBg: '#f43f5e66', errMarkFg: '#ffffff'
    },
    dark: {
      // chrome. The planes track the app ramp in www/styles.css: the card is
      // --bg-input, which is also what .msg.toolline .toolbody paints behind
      // a widget row, so the 1rem radius plus a border one step brighter than
      // the fill is what separates the two, lifted further by cardShadow. That
      // border-over-fill rule - definition without raising overall brightness -
      // is the one handoff-theme.md settled; button.secondary now takes the
      // app's own pair rather than deriving one.
      // The mark block below is deliberately untouched. Every mark color here
      // is already light-on-card, so darkening the card raises all of their
      // contrast ratios: body text 7.3:1 -> 11.8:1, mark text 4.8:1 -> 6.8:1,
      // amber fill against the card 1.50:1 -> 1.73:1. Half the lightness was
      // all the markup needed, not new mark colors. The well sits one step
      // above the card now, so the marks composite over #33353b rather than
      // #2a2b30: body text 9.8:1, amber 1.66:1. That 0.07:1 is the price of
      // the box, and it is below the ratio it started from either way.
      // bgSurface is the editable well, and its only remaining reader (the
      // stat pills that shared the key are gone). One step above the card
      // plane is what makes the text area read as a box inside the card
      // instead of as more card. The value is --border in www/styles.css, the
      // same plane bgRaised uses. Dark only; light keeps its own.
      // bgCard matches bgSurface, so the card is one plane: the well stopped
      // being a distinct rectangle and the text area is now held by the
      // surface's own padding and the header/footer hairlines. Three planes
      // stack here - the tool call's own .msg.toolline .toolbody paints
      // --bg-input (#2a2b30) and is not the plugin's to touch, the card sits
      // one step above it, and border (#3b3e49) is one step above the card.
      // That is the app's own shape: #composer .inputbox is --bg-input on
      // --bg, a raised box on a darker page.
      bgCard: '#33353b', bgSurface: '#33353b', bgRaised: '#33353b',
      fg: '#e6e6e8', fgMuted: '#9a9ba3',
      // borderLight is an interior seam: the header and footer dividers. It was
      // a step above the card while the card was #2a2b30. The card moved to
      // #33353b and swallowed it - #32353d differs by 1/0/2 channels, which is
      // not a seam at all - so it is a step below the card now, a groove rather
      // than a highlight.
      border: '#3b3e49', borderLight: '#2b2d32',
      // A 0.1 black shadow is invisible against the app page; the popover and
      // the card both have to out-lift a near-black surface, so each carries
      // its own shadow key.
      menuShadow: '0 18px 40px -8px rgba(0,0,0,0.65),0 6px 14px -6px rgba(0,0,0,0.5)',
      cardShadow: '0 10px 30px -8px rgba(0,0,0,0.6)',
      // Button planes: literal duplicates of the app's tokens in
      // www/styles.css, not var() references - a plugin cannot depend on the
      // host stylesheet. --btn-secondary / --btn-secondary-border / --accent /
      // --fg. The light table above is the app's counterpart in shape only; it
      // keeps its own values and is not verified against anything yet.
      btnBg: '#3a3d46', btnBorder: '#515970',
      btnPrimaryBg: '#4f7cff', btnPrimaryFg: '#e6e6e8',
      slate400: '#b8b9c2',
      accentBlue: '#668bff', accentGreen: '#5fd97e',
      // replacement (amber) - light text on a muted, low-alpha fill
      replBg: 'rgba(245,158,11,0.28)', replBgHover: 'rgba(245,158,11,0.4)',
      replFg: '#fde9b8', replUnderline: '#f5c563',
      replBadgeBg: 'rgba(245,158,11,0.28)', replBadgeFg: '#fde9b8',
      // insertion (emerald)
      insBg: 'rgba(16,185,129,0.25)', insBgHover: 'rgba(16,185,129,0.38)',
      insFg: '#bdf3da', insUnderline: '#4fd8a3',
      insBadgeBg: 'rgba(16,185,129,0.25)', insBadgeFg: '#bdf3da',
      // deletion (rose)
      delBg: 'rgba(244,63,94,0.25)', delBgHover: 'rgba(244,63,94,0.38)',
      delFg: '#f8c6cf', delUnderline: '#fb7185',
      delBadgeBg: 'rgba(244,63,94,0.25)', delBadgeFg: '#f8c6cf',
      // suggestion-only (neutral underline)
      suggUnderline: '#b8b9c2', suggBgHover: '#333540',
      // nothing-to-insert (emerald, quiet)
      noneBg: 'rgba(16,185,129,0.18)', noneFg: '#7fe3b8', noneBgHover: 'rgba(16,185,129,0.3)',
      unchangedBadgeBg: '#33353b', unchangedBadgeFg: '#9a9ba3',
      insertionPointBadgeBg: 'rgba(16,185,129,0.18)', insertionPointBadgeFg: '#7fe3b8',
      // overridden ("your choice", blue)
      overriddenBg: 'rgba(129,140,248,0.3)', overriddenBgHover: 'rgba(129,140,248,0.42)',
      overriddenFg: '#e2e4ff', overriddenRing: '#9aa4ff',
      // error
      errBorder: '#fb7185', errBg: 'rgba(244,63,94,0.14)', errFg: '#f8c6cf', errCodeBg: '#ffffff14',
      errMarkBg: '#fb718566', errMarkFg: '#1a1a22'
    }
  };

  /* The one source for the active theme is window.isDarkMode(), the app's
     public predicate (themeManager owns the bit). This file does not read
     data-theme, does not read localStorage, and takes no argument on purpose:
     with nothing to pass, nothing can bake a theme into a card, into the
     widget payload or into persisted state. Theming is settled at load for
     the whole app, so the next draw is the next answer; no live flip is
     chased. */
  function getTheme() {
    return (window.isDarkMode && window.isDarkMode()) ? THEMES.dark : THEMES.light;
  }

  // Build the CSS string for the current theme
  function buildThemeCSS() {
    const t = getTheme();
    return (
      /* Proofreader Widget Styles */
      '.cp-pr-card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;border-radius:1rem;border:1px solid ' + t.border + ';background-color:' + t.bgCard + ';box-shadow:' + t.cardShadow + ';overflow:hidden}' +
      '.cp-pr-header{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 1rem;border-bottom:1px solid ' + t.borderLight + ';padding:0.75rem 1.25rem}' +
      '.cp-pr-body{padding:1.25rem 1.25rem 1.5rem 1.25rem}' +
      '.cp-pr-footer{display:flex;flex-wrap:wrap;align-items:center;gap:0.75rem 1rem;border-top:1px solid ' + t.borderLight + ';padding:0.75rem 1.25rem}' +
      
      /* Transient footer message. No display property: [hidden] is a UA rule,
         and any display here would defeat it. min-width:0 lets the item shrink
         below its min-content width, so a long message cannot wrap the footer
         onto a second line and move the buttons to its left. */
      '.cp-pr-flash{color:' + t.fgMuted + ';font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
      '.cp-pr-sp{flex:1}' +
      '.cp-pr-tog{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:' + t.fgMuted + ';cursor:pointer;user-select:none}' +
      
      /* Edit surface: the one field on the card, so it carries the app's own
         text box edge - 1px in the border color, the way #composer .inputbox
         uses one. An inset shadow rather than a border, so no box changes size
         and nothing reflows; the padding keeps the first line off the line.
         Without it the field is invisible, because bgSurface and bgCard are the
         same plane and the card is otherwise one flat block. No
         position:relative on edit spans, so the caret renders on top. */
      '.cp-pr-surface{min-height:3rem;padding:.375rem .5rem;border-radius:6px;cursor:text;white-space:pre-wrap;word-break:break-word;font-size:14.5px;line-height:2.15;color:' + t.fg + ';outline:none;caret-color:' + t.fg + ';background:' + t.bgSurface + ';box-shadow:inset 0 0 0 1px ' + t.border + '}' +
      '.cp-pr-surface.readonly{cursor:default}' +
      '.cp-pr-surface[data-alt="true"] .cp-pr-edit{cursor:text}' +
      '.cp-pr-edit{cursor:pointer;border-radius:4px;box-decoration-break:clone;-webkit-box-decoration-break:clone;display:inline;caret-color:' + t.fg + '}' +
      
      /* Circular highlight for narrow edits */
      '.cp-pr-circle{display:inline-flex;align-items:center;justify-content:center;width:1.45em;height:1.45em;min-width:1.45em;min-height:1.45em;border-radius:50%;text-align:center;vertical-align:-0.15em;margin:0 1.5px;line-height:1;box-sizing:border-box;box-decoration-break:slice;-webkit-box-decoration-break:slice;cursor:pointer;transition:transform 100ms ease,filter 100ms ease}' +
      '.cp-pr-circle:hover{filter:brightness(0.93);transform:scale(1.08)}' +
      '.cp-pr-circle.cp-pr-open{box-shadow:0 0 0 2px ' + t.accentBlue + ' !important;transform:scale(1.08)}' +
      '.cp-pr-circle.cp-pr-atomic{user-select:none;-webkit-user-select:none}' +
      
      /* Insertion point (empty) centered circle */
      '.cp-pr-insertion-point{width:1.15em;height:1.15em;min-width:1.15em;min-height:1.15em;border-radius:50%;vertical-align:-0.05em;margin:0 2px}' +
      '.cp-pr-caret{display:inline-block;width:5px;height:5px;border-radius:50%;background-color:currentColor;opacity:0.85}' +
      
      /* Old text display */
      '.cp-pr-old{color:' + t.slate400 + ';text-decoration:line-through;margin-right:3px;user-select:none}' +
      
      /* Overridden ("your choice" blue) state. No text-decoration here:
         the underline comes from .cp-pr-ul, so this only recolors it. */
      '.cp-pr-overridden{background-color:' + t.overriddenBg + ' !important;color:' + t.overriddenFg + ' !important;box-shadow:0 0 0 1.5px ' + t.overriddenRing + ' !important}' +
      '.cp-pr-overridden.cp-pr-ul,.cp-pr-overridden .cp-pr-ul{text-decoration-color:' + t.overriddenRing + ' !important}' +
      '.cp-pr-overridden:hover{background-color:' + t.overriddenBgHover + ' !important}' +
      '.cp-pr-circle.cp-pr-overridden{border-radius:50% !important;background-color:' + t.overriddenBg + ' !important;color:' + t.overriddenFg + ' !important;box-shadow:0 0 0 1.5px ' + t.overriddenRing + ' !important}' +
      '.cp-pr-open{box-shadow:0 0 0 2px ' + t.accentBlue + ' !important}' +
      '.cp-pr-atomic{user-select:none;-webkit-user-select:none}' +
      
      /* Kind-based styling. Kind classes carry the bubble (background +
         color) only; the dotted underline lives on .cp-pr-ul so it can
         sit on the whole span, or on a sub-span covering just the
         changed characters of a localized edit. */
      '.cp-pr-repl{background-color:' + t.replBg + ';color:' + t.replFg + '}' +
      '.cp-pr-repl:hover{background-color:' + t.replBgHover + '}' +
      '.cp-pr-ins{background-color:' + t.insBg + ';color:' + t.insFg + '}' +
      '.cp-pr-ins:hover{background-color:' + t.insBgHover + '}' +
      '.cp-pr-del{background-color:' + t.delBg + ';color:' + t.delFg + ';text-decoration:line-through;text-decoration-color:' + t.delUnderline + ';text-decoration-thickness:1.5px}' +
      '.cp-pr-del:hover{background-color:' + t.delBgHover + '}' +
      '.cp-pr-sugg:hover{background-color:' + t.suggBgHover + '}' +
      '.cp-pr-ul{text-decoration:underline;text-decoration-style:dotted}' +
      /* Single-code-point underline (a period, an i): the
         glyph can be a speck. The line moves to an
         out-of-flow pseudo-element, where min-width is safe
         (it is not editable content), so the underline is
         at least MIN wide and centered: narrow glyphs are
         widened to the floor, wide ones keep their exact
         width, with no text movement and no character
         snapping. line-height normal drops the box bottom
         to the font descent, within a fraction of the 4px
         underline offset. */
      '.cp-pr-ulmin{line-height:normal;text-decoration:none;position:relative}' +
      '.cp-pr-ulmin::after{content:"";position:absolute;left:50%;bottom:0;width:100%;min-width:0.55em;height:0;transform:translateX(-50%);border-bottom:2px dotted}' +
      '.cp-pr-repl .cp-pr-ulmin::after{border-bottom-color:' + t.replUnderline + '}' +
      '.cp-pr-ins .cp-pr-ulmin::after{border-bottom-color:' + t.insUnderline + '}' +
      '.cp-pr-sugg .cp-pr-ulmin::after{border-bottom-color:' + t.suggUnderline + ';border-bottom-width:1.5px}' +
      '.cp-pr-overridden .cp-pr-ulmin::after{border-bottom-color:' + t.overriddenRing + ' !important}' +
      '.cp-pr-repl.cp-pr-ul,.cp-pr-repl .cp-pr-ul{text-decoration-color:' + t.replUnderline + ';text-decoration-thickness:2px;text-underline-offset:4px}' +
      '.cp-pr-ins.cp-pr-ul,.cp-pr-ins .cp-pr-ul{text-decoration-color:' + t.insUnderline + ';text-decoration-thickness:2px;text-underline-offset:4px}' +
      '.cp-pr-sugg.cp-pr-ul,.cp-pr-sugg .cp-pr-ul{text-decoration-color:' + t.suggUnderline + ';text-decoration-thickness:1.5px;text-underline-offset:5px}' +
      '.cp-pr-none{background-color:' + t.noneBg + ';color:' + t.noneFg + '}' +
      '.cp-pr-none:hover{background-color:' + t.noneBgHover + '}' +
      
      /* Chevron indicator removed per specification */
      '.cp-pr-chev{display:none !important}' +
      
      /* Legend */
      '.cp-pr-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11.5px;color:' + t.fgMuted + ';align-items:center;padding:0.75rem 1.25rem 0.25rem 1.25rem}' +
      '.cp-pr-sw{display:inline-block;padding:0 4px;border-radius:3px;margin-right:3px}' +
      
      /* Buttons. The dark table is a literal duplicate of the app's tokens in
         www/styles.css - button, button.secondary, button.primary - because a
         plugin cannot depend on the host stylesheet, with one departure: the
         secondary fill is a step above the card, not the app's
         --btn-secondary. The card moved to #33353b and the app value then
         differed from it by 1.05:1, which is no fill at all - the button was
         surviving on its border and label alone. #3a3d46 is --user-bubble, the
         next value up the same ramp, and it keeps the rule that the border is
         brighter than the fill (1.56:1). The label is untouched at #e6e6e8:
         10.3:1 on the old fill, 8.7:1 on the new one, so the fill moved and
         the font did not have to.
         6px radius, 5px 10px padding, font 14px (the app body's size, forced
         so the card does not inherit a host-dependent one). Hover is
         brightness(1.08) with the border re-asserted, as
         button.secondary:hover does; that is not the app's bare button:hover,
         which goes to the accent, and the deviation is deliberate. Disabled is
         opacity:.4, the app's own idiom (styles.css uses that pair twice,
         alongside .55 and .5 elsewhere), so an off control fades rather than
         vanishing - the border goes with it. The primary takes its own fill as
         its border, as button.primary does; a tinted border exists nowhere in
         the app.
         The class name .cp-pr-dark is historical and now only means "primary"
         - the old buildThemeCSS shipped it as bgCard, the same value as the
         card it sat on, which left Copy text with no hierarchy at all over the
         secondary buttons. TODO rename to .cp-pr-primary when the markup is
         next touched.
         Light theme: same rules, light-native values, unverified. It loses its
         accent hover border, which was the only visible cue on a near-white
         fill. Deferred to the light pass. */
      '.cp-pr-bottom{display:flex;gap:8px;align-items:center;padding:0.75rem 1.25rem 1.25rem 1.25rem}' +
      '.cp-pr-b{display:inline-flex;align-items:center;justify-content:center;border:1px solid ' + t.btnBorder + ';background:' + t.btnBg + ';color:' + t.fg + ';border-radius:6px;padding:5px 10px;font:inherit;font-size:14px;cursor:pointer}' +
      '.cp-pr-b:hover:not(:disabled){filter:brightness(1.08);border-color:' + t.btnBorder + '}' +
      '.cp-pr-b:disabled{opacity:.4;cursor:default}' +
      '.cp-pr-dark{background:' + t.btnPrimaryBg + ';color:' + t.btnPrimaryFg + ';border-color:' + t.btnPrimaryBg + ';font-weight:600}' +
      '.cp-pr-dark:hover:not(:disabled){filter:brightness(1.08);border-color:' + t.btnPrimaryBg + '}' +
      
      /* Error styling */
      '.cp-pr-err{border:1px solid ' + t.errBorder + ';border-radius:8px;padding:8px 12px;color:' + t.errFg + ';background:' + t.errBg + ';font-size:12.5px;margin:0.75rem 1.25rem 0 1.25rem}' +
      '.cp-pr-err ol{margin:6px 0 0;padding-left:18px}' +
      '.cp-pr-err li{margin:3px 0}' +
      '.cp-pr-err code{background:' + t.errCodeBg + ';border-radius:4px;padding:0 4px;font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere;display:inline-block}' +
      '.cp-pr-err mark{background:' + t.errMarkBg + ';color:' + t.errMarkFg + ';border-radius:2px}' +
      
      /* Choice Menu Popover */
      '.cp-pr-menu{position:fixed;z-index:50;width:max-content;min-width:15rem;max-width:min(24rem,calc(100vw - 16px));border-radius:0.75rem;border:1px solid ' + t.border + ';background-color:' + t.bgRaised + ';padding:0.375rem;text-align:left;font-size:0.875rem;line-height:1.375;color:' + t.fgMuted + ';box-shadow:' + t.menuShadow + ';animation:cp-menu-in 120ms ease-out}' +
      '.cp-pr-mhead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0.25rem 0.5rem 0.375rem 0.5rem;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:' + t.fgMuted + '}' +
      '.cp-pr-mbadge{border-radius:999px;padding:1px 8px;font-weight:600;letter-spacing:0;text-transform:none;font-size:11px}' +
      '.cp-pr-mi{display:flex;gap:8px;align-items:baseline;width:100%;border:1px solid ' + t.border + ';background:' + t.bgRaised + ';color:inherit;border-radius:6px;padding:6px 10px;cursor:pointer;text-align:left;font:inherit;font-size:13px;line-height:1.45;box-sizing:border-box;margin-bottom:2px}' +
      '.cp-pr-mi:hover,.cp-pr-mi:focus{border-color:' + t.accentBlue + ';outline:none}' +
      '.cp-pr-mi.cur{border-color:' + t.accentGreen + '}' +
      '.cp-pr-mck{flex:0 0 auto;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:' + t.accentGreen + '}' +
      '.cp-pr-mt{margin-left:auto;flex:0 0 auto;font-size:10.5px;color:' + t.fgMuted + ';white-space:nowrap;padding-left:8px;text-transform:uppercase;letter-spacing:.04em}' +
      '.cp-pr-mtext{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;flex:1}' +
      '.cp-pr-mtext .cp-pr-ws{color:' + t.fgMuted + '}' +
      '.cp-pr-mtext .empt{font-style:italic;color:' + t.fgMuted + '}' +
      '.cp-pr-mfoot{font-size:11px;color:' + t.fgMuted + ';padding:4px 6px 2px 6px}' +
      
      /* Animations */
      '@keyframes cp-menu-in{from{opacity:0;transform:translateY(-3px) scale(0.98)}to{opacity:1;transform:none}}'
    );
  }

  /* The blob is decisions only (markup, selection, per-group "your choice",
     the open-menu index, undo depth). Theme used to live here as t; it is
     gone because a stored theme is a theme that outlives the paint. Blobs
     written by older builds still carry t and are simply not read. */
  function normalizeState(blob, data) {
    const src = (data && data.text != null) ? String(data.text) : '';
    const fallback = function () {
      const p = parse(src);
      return {
        m: src,
        s: p.ok ? defaultSel(p) : [],
        c: p.ok ? p.groups.map(function () { return false; }) : [],
        e: true,
        r: false,
        o: null
      };
    };
    if (!blob || typeof blob !== 'object') return fallback();
    if (typeof blob.m !== 'string' || !blob.m.length) return fallback();
    const p = parse(blob.m);
    if (!p.ok) {
      // All-baked plain text is valid local state (zero groups); keep it
      // instead of falling back to the model's original, which would resurrect
      // groups the user deliberately baked away.
      if (isOnlyNoGroups(p)) {
        return {
          m: blob.m,
          s: [],
          c: [],
          e: blob.e !== false,
          r: blob.r === true,
          o: null
        };
      }
      return fallback();
    }
    const s = Array.isArray(blob.s)
      ? p.groups.map(function (g, i) {
          const k = Number(blob.s[i]);
          return Number.isInteger(k) && k >= 0 && k < g.g.length ? k : g.rec;
        })
      : defaultSel(p);
    const c = Array.isArray(blob.c)
      ? p.groups.map(function (g, i) { return !!blob.c[i]; })
      : p.groups.map(function () { return false; });
    return {
      m: blob.m,
      s: s,
      c: c,
      e: blob.e !== false,
      r: blob.r === true,
      o: Number.isInteger(blob.o) ? blob.o : null
    };
  }

  function renderCard(body, data, host) {
    const t = getTheme();
    let st = normalizeState(host.state.get(), data);
    const past = [], future = [];
    let lastSnapAt = 0, lastSnapKey = '', lastSnap = '';
    let menu = null;
    let stWarned = false;
    let noteTimer = null;
    host.signal.addEventListener('abort', function () { clearTimeout(noteTimer); });

    const root = document.createElement('div');
    root.className = 'cp-pr-card';
    root.setAttribute('data-widget-ui', '1');
    root.setAttribute('data-proofreader', '1');

    /* Header */
    const header = document.createElement('div');
    header.className = 'cp-pr-header';
    const spacer = document.createElement('span');
    spacer.className = 'cp-pr-sp';
    
    function makeToggle(label, checked, on, title) {
      const lab = document.createElement('label');
      lab.className = 'cp-pr-tog';
      if (title) lab.title = title;
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = !!checked;
      lab.appendChild(inp);
      lab.appendChild(document.createTextNode(label));
      inp.addEventListener('change', function () { on(inp.checked); });
      return { lab: lab, inp: inp };
    }
    const togEdit = makeToggle('Editable text', st.e, function (v) { st.e = v; setEditable(); persistAndRender(); }, 'Type directly in the rendered text');
    const togOld = makeToggle('Show replaced text', st.r, function (v) { st.r = v; persistAndRender(); });
    header.append(spacer, togEdit.lab, togOld.lab);

    const errStrip = document.createElement('div');
    errStrip.className = 'cp-pr-err';
    errStrip.hidden = true;

    const surfaceWrap = document.createElement('div');
    surfaceWrap.className = 'cp-pr-body';
    const surface = document.createElement('div');
    surface.className = 'cp-pr-surface';
    let plaintext = false;
    try {
      surface.setAttribute('contenteditable', 'plaintext-only');
      plaintext = surface.contentEditable === 'plaintext-only';
    } catch (e) { plaintext = false; }
    if (!plaintext) surface.setAttribute('contenteditable', 'true');
    surfaceWrap.appendChild(surface);

    // Legend (editor hints removed per specification)
    const legend = document.createElement('div');
    legend.className = 'cp-pr-legend';
    [
      ['replaced', 'background:' + t.replBg + ';color:' + t.replFg + ';text-decoration:underline;text-decoration-color:' + t.replUnderline + ';text-decoration-style:dotted;text-decoration-thickness:2px;text-underline-offset:3px', 'replaced'],
      ['inserted', 'background:' + t.insBg + ';color:' + t.insFg + ';text-decoration:underline;text-decoration-color:' + t.insUnderline + ';text-decoration-style:dotted;text-decoration-thickness:2px;text-underline-offset:3px', 'inserted'],
      ['deleted', 'background:' + t.delBg + ';color:' + t.delFg + ';text-decoration:line-through;text-decoration-color:' + t.delUnderline + ';text-decoration-thickness:1.5px', 'deleted'],
      ['suggestion only', 'text-decoration:underline;text-decoration-color:' + t.suggUnderline + ';text-decoration-style:dotted;text-decoration-thickness:1.5px;text-underline-offset:3px', 'suggestion only'],
      ['nothing inserted', 'background:' + t.noneBg + ';color:' + t.noneFg + ';width:1.1em;height:1.1em;min-width:1.1em;min-height:1.1em;padding:0;margin:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center', null],
      ['your choice', 'box-shadow:0 0 0 1.5px ' + t.overriddenRing + ' !important;background:' + t.overriddenBg + ' !important;color:' + t.overriddenFg + ' !important;text-decoration:underline !important;text-decoration-color:' + t.overriddenRing + ' !important;text-decoration-style:dotted !important;text-decoration-thickness:2px !important;text-underline-offset:4px !important', 'your choice']
    ].forEach(function (item) {
      const wrap = document.createElement('span');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '0.375rem';
      if (item[2] == null) {
        const pre = document.createElement('span');
        pre.textContent = 'nothing';
        pre.setAttribute('style', 'color:' + t.noneFg);
        const sw = document.createElement('span');
        sw.className = 'cp-pr-sw';
        sw.setAttribute('style', item[1]);
        const dot = document.createElement('span');
        dot.className = 'cp-pr-caret';
        dot.setAttribute('style', 'width:5px;height:5px;border-radius:50%;margin:0;clip-path:none');
        sw.appendChild(dot);
        const post = document.createElement('span');
        post.textContent = 'inserted';
        post.setAttribute('style', 'color:' + t.noneFg);
        wrap.appendChild(pre);
        wrap.appendChild(sw);
        wrap.appendChild(post);
      } else {
        const sw = document.createElement('span');
        sw.className = 'cp-pr-sw';
        sw.setAttribute('style', item[1]);
        sw.textContent = item[2];
        wrap.appendChild(sw);
      }
      legend.appendChild(wrap);
    });

    const bottom = document.createElement('div');
    bottom.className = 'cp-pr-bottom';
    const btnUndo = document.createElement('button');
    btnUndo.type = 'button';
    btnUndo.className = 'cp-pr-b';
    btnUndo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h10a5 5 0 0 1 5 5v2"/><polyline points="7 6 3 10 7 14"/></svg>';
    btnUndo.title = 'Undo (Ctrl+Z)';
    const btnRedo = document.createElement('button');
    btnRedo.type = 'button';
    btnRedo.className = 'cp-pr-b';
    btnRedo.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10H11a5 5 0 0 0-5 5v2"/><polyline points="17 6 21 10 17 14"/></svg>';
    btnRedo.title = 'Redo (Ctrl+Shift+Z)';
    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'cp-pr-b';
    btnReset.textContent = 'Reset';
    btnReset.title = 'Set every edit back to its recommendation';
    const sp2 = document.createElement('span');
    sp2.className = 'cp-pr-sp';
    // Sits between Reset and the gap: sp2 is flex:1, so a message appearing and
    // expiring moves nothing to its left and Copy text keeps its right edge.
    const flash = document.createElement('span');
    flash.className = 'cp-pr-flash';
    flash.hidden = true;
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'cp-pr-b cp-pr-dark';
    btnCopy.textContent = 'Copy text';
    const copyLive = document.createElement('span');
    copyLive.setAttribute('aria-live', 'polite');
    copyLive.style.position = 'absolute';
    copyLive.style.width = '1px';
    copyLive.style.height = '1px';
    copyLive.style.overflow = 'hidden';
    bottom.append(btnUndo, btnRedo, btnReset, flash, sp2, btnCopy, copyLive);

    root.append(header, errStrip, surfaceWrap, legend, bottom);
    body.replaceChildren(root);

    // Inject theme CSS. The sheet is the card's whole palette: no color is
    // set as an inline style on the text itself, so this one element is the
    // only place a theme can be expressed.
    const styleEl = document.createElement('style');
    styleEl.textContent = buildThemeCSS();
    root.appendChild(styleEl);

    function flashNote(text) {
      flash.textContent = text;
      flash.hidden = false;
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { flash.hidden = true; }, 2600);
    }

    /* ---- caret utilities ---- */
    function eachText(node, fn) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { if (fn(c, 0) === false) return false; }
        else if (c.nodeName === 'BR') { if (fn(c, -1) === false) return false; }
        else if (c.classList && (c.classList.contains('cp-pr-ghost') || c.classList.contains('cp-pr-chev'))) {}
        else { if (eachText(c, fn) === false) return false; }
      }
      return true;
    }
    function caretOffset() {
      const sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      if (!surface.contains(r.startContainer) && r.startContainer !== surface) return null;
      let pos = 0, found = null;
      eachText(surface, function (n, kind) {
        if (n === r.startContainer) { found = pos + (kind === -1 ? 0 : r.startOffset); return false; }
        if (found === null) {
          if (kind === -1) pos += 1;
          else pos += n.data.length;
        }
        return true;
      });
      return found;
    }
    function setCaretAt(pos) {
      if (pos == null || pos < 0) return;
      const sel = window.getSelection && window.getSelection();
      if (!sel) return;
      let acc = 0, target = null, inside = 0;
      eachText(surface, function (n, kind) {
        if (target) return false;
        const len = kind === -1 ? 1 : n.data.length;
        if (acc + len >= pos) { target = n; inside = kind === -1 ? 0 : pos - acc; return false; }
        acc += len;
        return true;
      });
      if (!target) {
        const r = document.createRange();
        r.selectNodeContents(surface); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
        return;
      }
      try {
        const r = document.createRange();
        if (target.nodeName === 'BR') { r.setStartBefore(target); r.collapse(true); }
        else { r.setStart(target, Math.min(inside, target.data.length)); r.collapse(true); }
        sel.removeAllRanges(); sel.addRange(r);
      } catch (e) {}
    }
    function setCaretAfter(node) {
      const sel = window.getSelection && window.getSelection();
      if (!sel) return;
      try {
        const r = document.createRange();
        r.setStartAfter(node); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        surface.focus({ preventScroll: true });
      } catch (e) {}
    }
    function flatLen() {
      let n = 0;
      eachText(surface, function (node, kind) { if (kind !== undefined) n += kind === -1 ? 1 : node.data.length; return true; });
      return n;
    }
    function remap(oldLen, newLen, pos) {
      if (pos <= 0) return 0;
      if (pos >= oldLen) return newLen;
      return Math.min(pos, newLen);
    }

    /* ---- state write ---- */
    function persist() {
      try {
        host.state.set({ m: st.m, s: st.s, c: st.c, e: st.e, r: st.r, o: st.o == null ? undefined : st.o });
      } catch (e) {
        if (!stWarned) {
          stWarned = true;
          showErr([{ message: 'Card state could not be remembered (' + (e.message || e) + '). The card still works; nothing will be kept if you navigate away.' }]);
        }
      }
    }
    function persistAndRender() { persist(); render(); }

    /* ---- error strip ---- */
    function showErr(errors) {
      errStrip.replaceChildren();
      if (!errors || !errors.length) { errStrip.hidden = true; return; }
      const head = document.createElement('div');
      head.innerHTML = '<strong>' + errors.length + (errors.length === 1 ? ' problem' : ' problems') + ' in the markup</strong> \u2014 nothing new renders until it parses; the text you typed is kept.';
      errStrip.appendChild(head);
      const ol = document.createElement('ol');
      for (const e of errors.slice(0, 20)) {
        const li = document.createElement('li');
        if (e.type) li.appendChild(Object.assign(document.createElement('code'), { textContent: TYPE_LABEL[e.type] || e.type }));
        if (e.line) li.appendChild(document.createTextNode(' line ' + e.line + ', col ' + e.col + ': '));
        li.appendChild(document.createTextNode(e.message));
        if (e.excerpt) {
          const ex = document.createElement('div');
          const code = document.createElement('code');
          if (e.marker >= 0) {
            code.appendChild(document.createTextNode(e.excerpt.slice(0, e.marker)));
            code.appendChild(Object.assign(document.createElement('mark'), { textContent: e.excerpt[e.marker] || '' }));
            code.appendChild(document.createTextNode(e.excerpt.slice(e.marker + 1)));
          } else code.textContent = e.excerpt;
          ex.appendChild(code);
          li.appendChild(ex);
        }
        ol.appendChild(li);
      }
      if (errors.length > 20) { const li = document.createElement('li'); li.textContent = '\u2026and ' + (errors.length - 20) + ' more.'; ol.appendChild(li); }
      errStrip.appendChild(ol);
      errStrip.hidden = false;
    }
    function hideErr() { errStrip.hidden = true; }

    /* ---- build DOM from state ---- */
    let lastSig = '';
    let curParse = null;
    /* Render signature. Theme is deliberately absent: it is not state, so a
       theme change never has to reach into this card to repaint it. */
    function sig() {
      return st.m + '\u0001' +
        st.s.join(',') + '\u0001' +
        (st.c ? st.c.map(function (x) { return x ? 1 : 0; }).join(',') : '') + '\u0001' +
        (st.e ? 1 : 0) + '\u0001' +
        (st.r ? 1 : 0);
    }
    function setEditable() {
      const p = curParse;
      surface.setAttribute('contenteditable', p && p.ok && st.e ? (plaintext ? 'plaintext-only' : 'true') : 'false');
    }

    function buildSurface() {
      const p = parse(st.m);
      if (!p.ok) {
        // Plain-text local state (every group baked) renders as plain editable
        // text, not as an error. The model grammar still rejects it; this path
        // only arises from local edits, never from present().
        if (isOnlyNoGroups(p)) {
          hideErr();
          const style = p.delimiterStyle || 'curly';
          const visible = style === 'curly' ? unescapeCurlyText(st.m) : st.m;
          curParse = { ok: true, errors: [], parts: st.m ? [{ lit: visible, start: 0, end: st.m.length }] : [], groups: [], text: st.m, delimiterStyle: style };
          if (st.m) surface.replaceChildren(document.createTextNode(visible));
          else surface.replaceChildren();
          setEditable();
          return;
        }
        showErr(p.errors);
        if (!curParse) surface.replaceChildren(document.createTextNode('(no valid markup to display)'));
        curParse = p;
        setEditable();
        return;
      }
      hideErr();
      curParse = p;
      const frag = document.createDocumentFragment();
      const total = p.groups.length;
      for (const part of p.parts) {
        if (part.lit != null) {
          frag.appendChild(document.createTextNode(part.lit));
          continue;
        }
        const idx = part.index;
        const k = st.s[idx] == null ? part.rec : st.s[idx];
        const isChosen = st.c ? !!st.c[idx] : false;
        const view = describeEdit(part, k, isChosen);
        const span = document.createElement('span');
        span.className = 'cp-pr-edit';
        span.dataset.g = String(idx);
        span.title = editTooltip(view);
        span.setAttribute('aria-label', editAriaLabel(part, view, total));
        
        // Apply kind class
        span.classList.add('cp-pr-' + ({ replacement: 'repl', insertion: 'ins', deletion: 'del', unchanged: 'sugg', 'insertion-point': 'none' })[view.kind]);
        if (view.overridden) span.classList.add('cp-pr-overridden');
        
        if (view.kind === 'deletion') {
          span.dataset.fixed = '1';
          span.setAttribute('contenteditable', 'false');
          span.classList.add('cp-pr-atomic');
          span.textContent = view.original;
          if (Array.from(view.original).length <= 2) {
            span.classList.add('cp-pr-circle');
          }
        } else if (view.kind === 'insertion-point') {
          span.dataset.fixed = '1';
          span.setAttribute('contenteditable', 'false');
          span.classList.add('cp-pr-atomic');
          span.classList.add('cp-pr-circle');
          span.classList.add('cp-pr-insertion-point');
          const caret = document.createElement('span');
          caret.className = 'cp-pr-caret';
          span.appendChild(caret);
        } else {
          span.dataset.edit = '1';
          if (st.r && view.kind === 'replacement' && view.original) {
            const ghost = document.createElement('span');
            ghost.className = 'cp-pr-old';
            ghost.setAttribute('contenteditable', 'false');
            ghost.textContent = view.original + ' ';
            span.appendChild(ghost);
          }
          const cps = Array.from(view.current);
          const ul = view.underline;
          // Narrow edit highlight: circle centered on the visible edit; editable
          const textLen = cps.length;
          const originalLen = Array.from(view.original).length;
          const isShortEdit = textLen > 0 && textLen <= 2 &&
            (!st.r || !view.original || originalLen <= 2);
          // A single-code-point underline can be a speck (a period,
          // an i); a circled edit already carries a fixed 1.45em
          // mark, so it needs no minimum.
          const wantMin = !isShortEdit &&
            (ul ? ul.end - ul.start === 1 : cps.length === 1);
          if (ul && (ul.start > 0 || ul.end < cps.length)) {
            // Localized edit: dotted underline covers only the changed
            // characters; the bubble stays on the whole span.
            span.appendChild(document.createTextNode(cps.slice(0, ul.start).join('')));
            const mark = document.createElement('span');
            mark.className = 'cp-pr-ul' + (wantMin ? ' cp-pr-ulmin' : '');
            mark.textContent = cps.slice(ul.start, ul.end).join('');
            span.appendChild(mark);
            span.appendChild(document.createTextNode(cps.slice(ul.end).join('')));
          } else {
            span.classList.add('cp-pr-ul');
            if (wantMin) span.classList.add('cp-pr-ulmin');
            span.appendChild(document.createTextNode(view.current));
          }
          
          if (isShortEdit) {
            span.classList.add('cp-pr-circle');
          }
        }
        frag.appendChild(span);
      }
      surface.replaceChildren(frag);
      setEditable();
    }

    function updateMeta() {
      const p = curParse;
      if (p && p.ok) {
        const s = stats(p, st.s, st.c);
        // differ is not decoration: it is what disables Reset.
        btnReset.disabled = (s.differ === 0);
      } else {
        btnReset.disabled = false;
      }
      btnUndo.disabled = !past.length;
      btnRedo.disabled = !future.length;
    }

    function render() {
      const s2 = sig();
      if (s2 === lastSig && curParse && curParse.ok) { updateMeta(); return; }
      const caretPos = caretOffset();
      const oldLen = flatLen();
      buildSurface();
      lastSig = s2;
      updateMeta();
      const newLen = flatLen();
      if (caretPos != null && (document.activeElement === surface || surface.contains(document.activeElement))) {
        setCaretAt(remap(oldLen, newLen, caretPos));
      }
      if (st.o != null && !menu) openMenuForGroup(st.o, { fromState: true });
    }

    /* ---- commits + undo ---- */
    function snapshot(key) {
      const now = Date.now();
      if (past.length && key === 'input' && lastSnapKey === 'input' && now - lastSnapAt < 1200) return;
      past.push({ m: st.m, s: st.s.slice(), c: (st.c || []).slice() });
      if (past.length > 200) past.shift();
      future.length = 0;
      lastSnapAt = now; lastSnapKey = key; lastSnap = sig();
    }

    function commit(key, next) {
      snapshot(key);
      st = next;
      persist();
      render();
    }

    /* ---- read-back: DOM -> markup ---- */
    function readDom() {
      const p = curParse;
      if (!p || !p.ok) return null;
      let out = '';
      const newSel = [];
      const newChosen = [];
      const seen = new Set();
      let bakedHere = 0;
      let bad = false;
      const delimiterStyle = p.delimiterStyle || 'curly';

      function directText(el) {
        // Full visible text of an edit span: direct text nodes plus the nested
        // localized-underline mark (.cp-pr-ul), but never the ghost showing the
        // replaced text (.cp-pr-old, contenteditable=false). The old version
        // read direct children only, so any partial underline (the normal shape
        // for minimal-span single-character edits) was silently dropped and the
        // next input baked every such group with letters missing.
        let s = '';
        for (const c of el.childNodes) {
          if (c.nodeType === 3) s += c.data;
          else if (c.nodeName === 'BR') s += '\n';
          else if (c.nodeType === 1) {
            if (c.classList && (c.classList.contains('cp-pr-ghost') || c.classList.contains('cp-pr-old') || c.classList.contains('cp-pr-chev'))) continue;
            if (c.nodeName === 'DIV') {
              if (s.length) s += '\n';
              s += directText(c);
            } else {
              s += directText(c);
            }
          }
        }
        return s;
      }

      function walk(node) {
        for (const c of node.childNodes) {
          if (c.nodeType === 3) {
            out += delimiterStyle === 'curly' ? escapeCurlyText(c.data) : stripMarkers(c.data, delimiterStyle);
          } else if (c.nodeName === 'BR') {
            out += '\n';
          } else if (c.nodeType === 1 && c.dataset && c.dataset.g != null) {
            const idx = +c.dataset.g;
            const gd = p.groups[idx];
            if (!gd || seen.has(idx)) {
              const t = directText(c);
              out += delimiterStyle === 'curly' ? escapeCurlyText(t) : stripMarkers(t, delimiterStyle);
              bakedHere++;
              continue;
            }
            seen.add(idx);
            const k = st.s[idx] == null ? gd.rec : st.s[idx];
            const isChosen = st.c ? !!st.c[idx] : false;

            if (c.dataset.fixed === '1') {
              // Uneditable span (deletion or insertion-point)
              out += serializeGroup(gd, delimiterStyle);
              newSel.push(k);
              newChosen.push(isChosen);
            } else {
              const got = directText(c);
              const expected = gd.g[k] != null ? gd.g[k] : gd.g[gd.rec];
              if (got === expected) {
                out += serializeGroup(gd, delimiterStyle);
                newSel.push(k);
                newChosen.push(isChosen);
              } else {
                out += delimiterStyle === 'curly' ? escapeCurlyText(got) : stripMarkers(got, delimiterStyle);
                bakedHere++;
              }
            }
          } else if (c.nodeType === 1) {
            if (c.nodeName === 'DIV' && c.previousSibling) out += '\n';
            walk(c);
          }
        }
      }

      walk(surface);
      if (bad) return null;
      for (let i = 0; i < p.groups.length; i++) {
        if (!seen.has(i)) bakedHere++;
      }
      const reparsed = parse(out, delimiterStyle);
      if (!reparsed.ok) {
        // Baking the final group leaves plain text: valid locally, even though
        // the model grammar still requires at least one group.
        if (isOnlyNoGroups(reparsed) && newSel.length === 0) {
          return { m: out, s: [], c: [], baked: bakedHere };
        }
        return null;
      }
      if (reparsed.groups.length !== newSel.length) return null;
      return { m: out, s: newSel, c: newChosen, baked: bakedHere };
    }

    let inputQueued = false;
    function queueCommitFromDom() {
      if (inputQueued) return;
      inputQueued = true;
      const run = function () {
        inputQueued = false;
        const got = readDom();
        if (!got) {
          showErr([{ message: 'The markup got into a state this card cannot represent (reserved marker characters, most likely). Fix it or press Reset.' }]);
          return;
        }
        if (got.m === st.m && got.s.join(',') === st.s.join(',') && got.baked === 0) return;
        if (got.baked > 0) flashNote('Baked in ' + got.baked + (got.baked === 1 ? ' edit' : ' edits') + ' - Ctrl/\u2318+Z to undo');
        commit('input', { m: got.m, s: got.s, c: got.c, e: st.e, r: st.r, o: null });
      };
      if (typeof window !== "undefined" && window.requestAnimationFrame) window.requestAnimationFrame(run);
      else setTimeout(run, 16);
    }

    /* ---- raw-markup edit engine: visible position maps to markup edit ----
       The surface is a projection of st.m. Edits never read the DOM for
       content; the DOM only supplies the caret as a visible offset. Every
       keystroke becomes a string edit on st.m, then a re-parse and re-render.
       Literals edit in place, touching an editable group bakes just that group
       to plain text. Partial underlines are display only and never affect this. */
    let lastPasteAt = 0;
    function isGhostEl(el) {
      return !!(el && el.classList && (el.classList.contains('cp-pr-ghost') || el.classList.contains('cp-pr-old') || el.classList.contains('cp-pr-chev')));
    }
    function subtreeLen(node) {
      if (!node) return 0;
      if (node.nodeType === 3) return node.data.length;
      if (node.nodeName === 'BR') return 1;
      if (node.nodeType === 1) {
        if (isGhostEl(node)) return 0;
        let n = 0;
        for (const c of node.childNodes) n += subtreeLen(c);
        return n;
      }
      return 0;
    }
    function firstNLen(el, n) {
      let total = 0;
      const kids = el.childNodes;
      const lim = Math.max(0, Math.min(n, kids.length));
      for (let i = 0; i < lim; i++) total += subtreeLen(kids[i]);
      return total;
    }
    function visibleOffsetForPoint(node, off) {
      if (!node) return null;
      try {
        if (node === surface) return firstNLen(surface, off);
        if (!surface.contains(node)) return null;
        let anc = node.nodeType === 3 ? node.parentNode : node;
        while (anc && anc !== surface) {
          if (isGhostEl(anc)) return null;
          anc = anc.parentNode;
        }
        let pos = 0, found = null;
        function visit(cur) {
          for (const child of cur.childNodes) {
            if (found !== null) return true;
            if (child.nodeType === 1 && isGhostEl(child)) continue;
            if (child === node) {
              if (child.nodeType === 3) { found = pos + Math.max(0, Math.min(off, child.data.length)); return true; }
              if (child.nodeName === 'BR') { found = pos; return true; }
              found = pos + firstNLen(child, off);
              return true;
            }
            if (child.nodeType === 1 && child.contains && child.contains(node)) {
              if (visit(child)) return true;
            } else {
              pos += subtreeLen(child);
            }
          }
          return found !== null;
        }
        visit(surface);
        return found;
      } catch (e) { return null; }
    }
    function getVisibleSelection() {
      const sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0);
      const a = visibleOffsetForPoint(r.startContainer, r.startOffset);
      const b = visibleOffsetForPoint(r.endContainer, r.endOffset);
      if (a == null || b == null) return null;
      return a <= b ? { start: a, end: b } : { start: b, end: a };
    }
    function escVisible(text, style) {
      if (style === 'curly') return escapeCurlyText(text);
      return stripMarkers(text, style);
    }
    function buildSegs() {
      const p = curParse;
      if (!p || !p.ok) return null;
      const style = p.delimiterStyle || 'curly';
      const segs = [];
      let v = 0;
      for (const part of p.parts) {
        if (part.lit != null) {
          const txt = part.lit;
          segs.push({ kind: 'lit', text: txt, markup: st.m.slice(part.start, part.end), s0: v, s1: v + txt.length });
          v += txt.length;
        } else {
          const idx = part.index;
          const gd = p.groups[idx];
          if (!gd) continue;
          const k = st.s[idx] == null ? gd.rec : st.s[idx];
          const chosen = st.c ? !!st.c[idx] : false;
          const view = describeEdit(gd, k, chosen);
          const markup = st.m.slice(gd.start, gd.end);
          if (view.kind === 'deletion') {
            const t = view.original || '';
            segs.push({ kind: 'fixed-del', groupIdx: idx, text: t, markup: markup, s0: v, s1: v + t.length, k: k, chosen: chosen });
            v += t.length;
          } else if (view.kind === 'insertion-point') {
            segs.push({ kind: 'fixed-ins', groupIdx: idx, text: '', markup: markup, s0: v, s1: v, k: k, chosen: chosen });
          } else {
            const t = view.current == null ? '' : view.current;
            segs.push({ kind: 'edit', groupIdx: idx, text: t, markup: markup, s0: v, s1: v + t.length, k: k, chosen: chosen });
            v += t.length;
          }
        }
      }
      return { segs: segs, total: v, style: style, parse: p };
    }
    function applyVisibleEdit(a, b, ins) {
      const built = buildSegs();
      if (!built) return null;
      const segs = built.segs, style = built.style, p = built.parse;
      const total = built.total;
      a = Math.max(0, Math.min(a == null ? 0 : a, total));
      b = Math.max(0, Math.min(b == null ? a : b, total));
      if (a > b) { const t = a; a = b; b = t; }
      ins = ins == null ? '' : String(ins);
      const visibleIns = style === 'curly' ? ins : stripMarkers(ins, style);
      const esc = function (t) { return escVisible(t, style); };
      let out = '', newSel = [], newChosen = [], baked = 0;
      let changed = false;
      if (a === b && ins === '') {
        return { m: st.m, s: st.s.slice(), c: (st.c || []).slice(), baked: 0, newCaret: a, changed: false };
      }
      if (a === b) {
        let target = null, off = 0;
        for (const sg of segs) {
          if (sg.kind === 'lit' && sg.s0 <= a && a <= sg.s1) { target = sg; off = a - sg.s0; break; }
        }
        if (!target) {
          for (const sg of segs) {
            if (sg.kind === 'edit' && sg.s0 < a && a < sg.s1) { target = sg; off = a - sg.s0; break; }
          }
        }
        if (!target) {
          if (ins === '') return { m: st.m, s: st.s.slice(), c: (st.c || []).slice(), baked: 0, newCaret: a, changed: false };
          let inserted = false;
          for (const sg of segs) {
            if (!inserted && sg.s0 >= a) { out += esc(ins); inserted = true; }
            out += sg.markup;
            if (sg.kind !== 'lit') { newSel.push(sg.k); newChosen.push(!!sg.chosen); }
          }
          if (!inserted) out += esc(ins);
          changed = (out !== st.m);
          const rep = parse(out, style);
          if (!rep.ok) {
            if (!(isOnlyNoGroups(rep) && newSel.length === 0)) return null;
            return { m: out, s: [], c: [], baked: 0, newCaret: a + visibleIns.length, changed: changed };
          }
          if (rep.groups.length !== newSel.length) return null;
          return { m: out, s: newSel, c: newChosen, baked: 0, newCaret: a + visibleIns.length, changed: changed };
        }
        if (target.kind === 'lit') {
          const nt = target.text.slice(0, off) + ins + target.text.slice(off);
          for (const sg of segs) {
            if (sg === target) {
              if (nt !== '') out += esc(nt);
              changed = (nt !== target.text);
            } else {
              out += sg.markup;
              if (sg.kind !== 'lit') { newSel.push(sg.k); newChosen.push(!!sg.chosen); }
            }
          }
          const rep = parse(out, style);
          if (!rep.ok) return null;
          if (rep.groups.length !== newSel.length) return null;
          return { m: out, s: newSel, c: newChosen, baked: 0, newCaret: a + visibleIns.length, changed: changed };
        }
        const nt = target.text.slice(0, off) + ins + target.text.slice(off);
        if (nt === target.text) return { m: st.m, s: st.s.slice(), c: (st.c || []).slice(), baked: 0, newCaret: a, changed: false };
        for (const sg of segs) {
          if (sg === target) { out += esc(nt); baked++; changed = true; }
          else { out += sg.markup; if (sg.kind !== 'lit') { newSel.push(sg.k); newChosen.push(!!sg.chosen); } }
        }
        const rep2 = parse(out, style);
        if (!rep2.ok) {
          if (isOnlyNoGroups(rep2) && newSel.length === 0) {
            return { m: out, s: [], c: [], baked: baked, newCaret: a + visibleIns.length, changed: true };
          }
          return null;
        }
        if (rep2.groups.length !== newSel.length) return null;
        return { m: out, s: newSel, c: newChosen, baked: baked, newCaret: a + visibleIns.length, changed: true };
      }
      let first = true;
      for (const sg of segs) {
        const overlap = sg.kind === 'fixed-ins' ? (sg.s0 >= a && sg.s0 < b) : (sg.s1 > a && sg.s0 < b);
        if (!overlap) {
          out += sg.markup;
          if (sg.kind !== 'lit') { newSel.push(sg.k); newChosen.push(!!sg.chosen); }
          continue;
        }
        const ov0 = Math.max(0, a - sg.s0);
        const ov1 = Math.min(sg.text.length, b - sg.s0);
        const prefix = sg.text.slice(0, ov0);
        const suffix = sg.text.slice(Math.max(ov0, ov1));
        if (sg.kind === 'lit') {
          const nt = first ? prefix + ins + suffix : prefix + suffix;
          if (nt !== '') out += esc(nt);
          if (nt !== sg.text) changed = true;
        } else if (sg.kind === 'edit') {
          const gd = p.groups[sg.groupIdx];
          const orig = gd.g[sg.k] == null ? '' : gd.g[sg.k];
          const nt = first ? prefix + ins + suffix : suffix;
          if (nt === orig) {
            out += sg.markup;
            newSel.push(sg.k); newChosen.push(!!sg.chosen);
          } else if (nt === '' && (!first || ins === '')) {
            baked++; changed = true;
          } else {
            out += esc(nt); baked++; changed = true;
          }
        } else if (sg.kind === 'fixed-del') {
          const nt = first ? prefix + ins + suffix : suffix;
          if (nt === '') { baked++; changed = true; }
          else if (nt === sg.text && !first && ins === '') {
            out += sg.markup; newSel.push(sg.k); newChosen.push(!!sg.chosen);
          } else { out += esc(nt); baked++; changed = true; }
        } else {
          if (first && ins !== '') out += esc(ins);
          baked++; changed = true;
        }
        first = false;
      }
      if (first && ins !== '') { out += esc(ins); changed = true; }
      if (!changed && out === st.m) {
        return { m: st.m, s: st.s.slice(), c: (st.c || []).slice(), baked: 0, newCaret: a + visibleIns.length, changed: false };
      }
      const rep = parse(out, style);
      if (!rep.ok) {
        if (isOnlyNoGroups(rep) && newSel.length === 0) {
          return { m: out, s: [], c: [], baked: baked, newCaret: a + visibleIns.length, changed: true };
        }
        return null;
      }
      if (rep.groups.length !== newSel.length) return null;
      return { m: out, s: newSel, c: newChosen, baked: baked, newCaret: a + visibleIns.length, changed: true };
    }
    function commitMapped(res) {
      if (!res) return false;
      if (!res.changed) {
        setCaretAt(res.newCaret);
        return true;
      }
      if (res.baked > 0) flashNote('Baked in ' + res.baked + (res.baked === 1 ? ' edit' : ' edits') + ' - Ctrl/\u2318+Z to undo');
      commit('input', { m: res.m, s: res.s, c: res.c, e: st.e, r: st.r, o: null });
      setCaretAt(res.newCaret);
      try { surface.focus({ preventScroll: true }); } catch (e) {}
      return true;
    }

    /* ---- surface events ---- */
    surface.addEventListener('click', function (ev) {
      const span = ev.target.closest ? ev.target.closest('.cp-pr-edit') : null;
      if (!span || !surface.contains(span)) {
        if (menu) closeMenu('outside');
        return;
      }
      const gi = +span.dataset.g;
      if (span.classList.contains('cp-pr-ghost') || span.classList.contains('cp-pr-old')) return;
      if (menu && menu.gi === gi) {
        closeMenu('toggle');
        return;
      }
      // Tapping/clicking a word opens the dropdown AND lands cursor where clicked.
      // Do not prevent default or steal focus.
      openMenuForGroup(gi, { anchor: span, preserveCaret: true });
    });

    surface.addEventListener('beforeinput', function (ev) {
      if (menu) closeMenu('typing');
      const t = ev.inputType || '';
      if (ev.isComposing || t.indexOf('insertComposition') === 0) return;
      if (t === 'historyUndo') { ev.preventDefault(); undo(); return; }
      if (t === 'historyRedo') { ev.preventDefault(); redo(); return; }
      if (t.indexOf('format') === 0 || t.indexOf('insertOrderedList') === 0 || t.indexOf('insertUnorderedList') === 0 || t.indexOf('insertHorizontalRule') === 0) { ev.preventDefault(); return; }
      if (t === 'insertText' && ev.data === '\t') { ev.preventDefault(); return; }
      if ((t === 'insertFromPaste' || t === 'insertFromDrop') && Date.now() - lastPasteAt < 1000) { ev.preventDefault(); return; }
      let a = null, b = null, ins = '';
      let haveTarget = false;
      try {
        if (ev.getTargetRanges && curParse && curParse.ok) {
          const trs = ev.getTargetRanges();
          if (trs && trs.length) {
            const tr = trs[0];
            const s0 = visibleOffsetForPoint(tr.startContainer, tr.startOffset);
            const s1 = visibleOffsetForPoint(tr.endContainer, tr.endOffset);
            if (s0 != null && s1 != null) { a = Math.min(s0, s1); b = Math.max(s0, s1); haveTarget = true; }
          }
        }
      } catch (e) { haveTarget = false; }
      if (t.indexOf('insert') === 0) {
        if (t === 'insertParagraph' || t === 'insertLineBreak') ins = '\n';
        else if (typeof ev.data === 'string') ins = ev.data;
        else if (ev.dataTransfer) { try { ins = ev.dataTransfer.getData('text/plain') || ''; } catch (e) { ins = ''; } }
        else ins = '';
        if (!haveTarget) {
          const selR = getVisibleSelection();
          if (!selR) return;
          a = selR.start; b = selR.end;
        }
      } else if (t.indexOf('delete') === 0) {
        ins = '';
        if (!haveTarget) {
          // Without a target range the browser owns word/line boundaries.
          // Let it edit, then read back with the fixed DOM path.
          return;
        }
      } else {
        return;
      }
      const res = applyVisibleEdit(a, b, ins);
      if (!res) return;
      ev.preventDefault();
      commitMapped(res);
    });

    surface.addEventListener('input', function (ev) {
      if (menu) closeMenu('typing');
      if (ev && ev.isComposing) return;
      queueCommitFromDom();
    });

    surface.addEventListener('paste', function (ev) {
      if (menu) closeMenu('typing');
      const txt = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || '';
      if (!txt) { ev.preventDefault(); return; }
      // Preventing paste cancels the following insertFromPaste beforeinput, so
      // this is the single handling for clipboard pastes. Drops use beforeinput.
      ev.preventDefault();
      lastPasteAt = Date.now();
      const selR = getVisibleSelection();
      if (!selR) { queueCommitFromDom(); return; }
      const res = applyVisibleEdit(selR.start, selR.end, txt);
      if (!res) { queueCommitFromDom(); return; }
      commitMapped(res);
    });

    surface.addEventListener('cut', function () {
      if (menu) closeMenu('typing');
    });

    surface.addEventListener('compositionstart', function () {
      if (menu) closeMenu('typing');
    });

    surface.addEventListener('compositionend', function () {
      if (menu) closeMenu('typing');
      queueCommitFromDom();
    });

    surface.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (menu) {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenu('esc');
          return;
        }
        surface.blur();
        return;
      }

      // If dropdown is open and user presses Tab, transfer focus to dropdown menu
      if (ev.key === 'Tab' && menu && !ev.shiftKey) {
        ev.preventDefault();
        if (menu.focusFirst) menu.focusFirst();
        return;
      }

      // Any typing / editing key dismisses dropdown
      const isEditKey = !ev.metaKey && !ev.ctrlKey && !ev.altKey && (
        ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Enter'
      );
      if (isEditKey && menu) {
        closeMenu('typing');
      }

      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.shiftKey) redo(); else undo();
      } else if (mod && (ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault(); ev.stopPropagation();
        redo();
      }
    });

    function undo() {
      if (!past.length) return;
      future.push({ m: st.m, s: st.s.slice(), c: (st.c || []).slice() });
      if (future.length > 200) future.pop();
      const prev = past.pop();
      st = { m: prev.m, s: prev.s.slice(), c: (prev.c || []).slice(), e: st.e, r: st.r, o: null };
      lastSig = '';
      persist();
      render();
    }

    function redo() {
      if (!future.length) return;
      const nx = future.shift();
      past.push({ m: st.m, s: st.s.slice(), c: (st.c || []).slice() });
      st = { m: nx.m, s: nx.s.slice(), c: (nx.c || []).slice(), e: st.e, r: st.r, o: null };
      lastSig = '';
      persist();
      render();
    }

    btnUndo.addEventListener('click', undo);
    btnRedo.addEventListener('click', redo);

    btnReset.addEventListener('click', function () {
      const p = parse(st.m);
      if (p.ok) {
        commit('act', {
          m: st.m,
          s: defaultSel(p),
          c: p.groups.map(function () { return false; }),
          e: st.e,
          r: st.r,
          o: null
        });
      } else if (isOnlyNoGroups(p)) {
        hideErr();
        return;
      } else {
        commit('act', normalizeState(null, data));
      }
      hideErr();
    });

    btnCopy.addEventListener('click', function () {
      const p = parse(st.m);
      let txt;
      if (p.ok) txt = resolve(p, st.s);
      else if (isOnlyNoGroups(p)) txt = (p.delimiterStyle === 'curly') ? unescapeCurlyText(st.m) : st.m;
      else txt = st.m;
      let done = false;
      try {
        host.copy(txt, function () {
          if (done) return; done = true;
          setCopyState('copied');
        });
      } catch (e) { setCopyState('failed'); return; }
      setTimeout(function () { if (!done) { done = true; setCopyState('failed'); } }, 1500);
      function setCopyState(state) {
        btnCopy.textContent = state === 'copied' ? 'Copied \u2713' : state === 'failed' ? 'Copy failed' : 'Copy text';
        copyLive.textContent = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : '';
        if (state !== 'idle') setTimeout(function () { btnCopy.textContent = 'Copy text'; copyLive.textContent = ''; }, 2000);
      }
    });

    /* ---- the choice menu ---- */
    function closeMenu(reason) {
      if (menu && menu.overlay) menu.overlay.close(reason);
    }

    function openMenuForGroup(gi, opts) {
      opts = opts || {};
      if (menu) closeMenu('replaced');
      const p = curParse;
      if (!p || !p.ok || !p.groups[gi]) return;
      const span = opts.anchor || surface.querySelector('.cp-pr-edit[data-g="' + gi + '"]');
      if (!span) return;
      const caret0 = caretOffset();
      const overlay = host.overlay(span, {
        id: 'menu',
        onClose: function (reason) {
          menu = null;
          st.o = null;
          persist();
          span.classList.remove('cp-pr-open');
          if (reason === 'esc' && caret0 != null) {
            try { surface.focus({ preventScroll: true }); } catch (e) {}
            setCaretAt(caret0);
          }
        }
      });
      menu = { gi: gi, overlay: overlay, span: span };
      st.o = gi;
      persist();
      span.classList.add('cp-pr-open');

      const box = document.createElement('div');
      box.className = 'cp-pr-menu';
      box.setAttribute('data-widget-ui', '1');
      box.setAttribute('role', 'menu');
      const gd = p.groups[gi];
      const cur = st.s[gi] == null ? gd.rec : st.s[gi];
      const isChosen = st.c ? !!st.c[gi] : false;
      const view = describeEdit(gd, cur, isChosen);
      box.setAttribute('aria-label', 'Edit ' + (gi + 1) + ' of ' + p.groups.length + ': ' + kindLabel(view));

      const head = document.createElement('div');
      head.className = 'cp-pr-mhead';
      head.appendChild(Object.assign(document.createElement('span'), {
        textContent: 'Edit ' + (gi + 1) + ' of ' + p.groups.length
      }));
      const badge = document.createElement('span');
      badge.className = 'cp-pr-mbadge';
      badge.textContent = kindLabel(view);
      badge.setAttribute('style', ({
        replacement: 'background:' + t.replBadgeBg + ';color:' + t.replBadgeFg,
        insertion: 'background:' + t.insBadgeBg + ';color:' + t.insBadgeFg,
        deletion: 'background:' + t.delBadgeBg + ';color:' + t.delBadgeFg,
        unchanged: 'background:' + t.unchangedBadgeBg + ';color:' + t.unchangedBadgeFg,
        'insertion-point': 'background:' + t.insertionPointBadgeBg + ';color:' + t.insertionPointBadgeFg
      })[view.kind] || 'background:' + t.unchangedBadgeBg + ';color:' + t.unchangedBadgeFg);
      head.appendChild(badge);
      box.appendChild(head);

      const empty = emptyLabel(gd);
      const entries = menuEntries(gd);
      const items = [];
      entries.forEach(function (entry, ei) {
        const isCurrent = entry.indices.indexOf(cur) >= 0;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'menuitemradio');
        btn.setAttribute('aria-checked', isCurrent ? 'true' : 'false');
        btn.className = 'cp-pr-mi' + (isCurrent ? ' cur' : '');
        
        const ck = document.createElement('span');
        ck.className = 'cp-pr-mck';
        if (isCurrent) {
          ck.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        }
        btn.appendChild(ck);
        
        const tspan = document.createElement('span');
        tspan.className = 'cp-pr-mtext';
        if (entry.text === '') {
          const em = document.createElement('span');
          em.className = 'empt';
          em.textContent = empty;
          tspan.appendChild(em);
        } else {
          for (const seg of visibleWhitespace(entry.text)) {
            if (!seg.ws) { tspan.appendChild(document.createTextNode(seg.t)); continue; }
            tspan.appendChild(Object.assign(document.createElement('span'), {
              className: 'cp-pr-ws', title: 'whitespace', textContent: seg.t
            }));
          }
        }
        btn.appendChild(tspan);
        
        const tag = document.createElement('span');
        tag.className = 'cp-pr-mt';
        tag.textContent = entry.rec ? 'recommended' : entry.orig ? 'original' : 'suggestion';
        btn.appendChild(tag);
        
        btn.addEventListener('click', function () {
          const s = st.s.slice();
          s[gi] = entryChoice(gd, entry);
          const c = (st.c || []).slice();
          c[gi] = true; // Mark as chosen by user -> turns "your choice" blue!
          closeMenu('pick');
          commit('act', { m: st.m, s: s, c: c, e: st.e, r: st.r, o: null });
          const sp = surface.querySelector('.cp-pr-edit[data-g="' + gi + '"]');
          if (sp) setCaretAfter(sp);
        });
        items.push(btn);
        box.appendChild(btn);
      });

      const foot = document.createElement('div');
      foot.className = 'cp-pr-mfoot';
      foot.textContent = '\u2191\u2193 move \u00b7 Enter choose \u00b7 Esc close';
      box.appendChild(foot);

      box.addEventListener('keydown', function (ev) {
        const at = items.indexOf(document.activeElement);
        const focusAt = function (i) { if (items.length) items[(i + items.length) % items.length].focus(); };
        if (ev.key === 'ArrowDown') { ev.preventDefault(); focusAt(at + 1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusAt(at < 0 ? items.length - 1 : at - 1); }
        else if (ev.key === 'Home') { ev.preventDefault(); focusAt(0); }
        else if (ev.key === 'End') { ev.preventDefault(); focusAt(items.length - 1); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeMenu('esc'); }
        else if (ev.key === 'Tab') {
          ev.preventDefault();
          focusAt(ev.shiftKey ? at - 1 : at + 1);
        }
      });

      overlay.el.appendChild(box);
      overlay.reposition();

      menu.focusFirst = function () {
        if (items.length) {
          const start = Math.max(0, entries.findIndex(function (e) { return e.indices.indexOf(cur) >= 0; }));
          try { items[start].focus({ preventScroll: true }); } catch (e) {}
        }
      };

      // Only auto-focus menu items if NOT opened via surface click (preserves editor caret)
      if (!opts.preserveCaret && !opts.fromState && items.length) {
        menu.focusFirst();
      }
    }

    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && menu) { ev.stopPropagation(); closeMenu('esc'); }
    });

    lastSig = '';
    render();
  }

  return {
    parse: parse,
    serializeGroup: serializeGroup,
    defaultSel: defaultSel,
    originalSel: originalSel,
    resolve: resolve,
    carrySelections: carrySelections,
    carryChosen: carryChosen,
    describeEdit: describeEdit,
    kindLabel: kindLabel,
    editTooltip: editTooltip,
    editAriaLabel: editAriaLabel,
    menuEntries: menuEntries,
    entryChoice: entryChoice,
    emptyLabel: emptyLabel,
    visibleWhitespace: visibleWhitespace,
    stats: stats,
    stripMarkers: stripMarkers,
    escapeCurlyText: escapeCurlyText,
    unescapeCurlyText: unescapeCurlyText,
    isOnlyNoGroups: isOnlyNoGroups,
    detectDelimiterStyle: detectDelimiterStyle,
    renderCard: renderCard,
    buildThemeCSS: buildThemeCSS,
    getTheme: getTheme,
    OPEN: OPEN,
    SEP: SEP,
    CLOSE: CLOSE
  };
})();

/* Usage text returned ONLY by the unlock verb. This is the single home of the
   markup grammar and the working rules for the model; the file header keeps
   the same grammar for human readers. It never mentions the Unicode dialect.
   No common-mistakes section on purpose: add one only if failures persist
   after the examples and the minimal-span guidance have had a chance to work.
   String.raw keeps the backslashes literal. */
const PROOF_USAGE = String.raw`PROOFREADER USAGE

CONCEPT
Resend the user's FULL passage, with each edit marked inline as {recommended|original}. The first alternative is your recommendation and is shown by default. The last alternative is the original text exactly as the user wrote it. Middle alternatives are optional extra suggestions.

VERBS
unlock: returns this text.
check: validates your markup. If it is clean, it returns the passage your
 recommendations resolve to, so you can catch your own mistakes while you can
  still fix them. If it is not clean, it lists the problems. It shows no card
  and does not end the turn.
present: shows the card to the user. If the markup is not clean, it shows
  nothing and returns the same report as check. If it is clean, it ends the
  turn, so it must be your LAST action, with at most one short closing sentence
  afterward.

WORKFLOW
Mark up the whole passage, then check it and READ THE TEXT IT RETURNS. That
echo is your last chance to see the finished wording: after present you get a
count and nothing more, because the user owns the wording from then on. If check
reports problems, fix every one of them and check the whole passage again. Once
check is clean, call present with the same text.
If nothing needs changing, do not call this tool at all. Say so in prose.

MINIMAL SPANS
One group per independent wording choice. A sentence with two changes gets two groups. Never include a word in a group unless it changes: words that are the same in the recommended and original alternatives belong outside the group, before or after it. Marking a whole sentence or paragraph as one replacement gives the user a single all-or-nothing choice, which defeats the purpose of the card. A single-character change is fine, and is better when edits sit right next to each other.

GRAMMAR
A group opens with {, alternatives are separated by |, and a group closes with }.
Escape a literal {, |, } or \ in the text as \{, \|, \} or \\.
An empty first alternative is a recommended deletion. An empty last alternative is a pure insertion.
To delete text the user already wrote, that text goes LAST, as in {|really }. Never put existing text in a middle slot or leave the last slot empty: that deletes nothing.
Spaces are literal. At least two alternatives per group, never all empty. No nesting.
Words outside the marks must stay the same. You may fix whitespace without putting it into markup. Other punctuation should be opt-in using markup. Every other change must be marked as a group.

RARE EXCEPTION: SUGGESTION WITHOUT A RECOMMENDATION
Only when something seems missing and you cannot know what, leave BOTH the first and last alternatives empty and put the candidates between them: Call me at 3{| pm| am|}. Nothing is recommended and nothing is removed; the text stays as written unless the user picks one. If there's even a hint of the likely option, recommend instead: { pm|}.

PARAMETERS
text: the marked-up passage (required for check and present).

EXAMPLES
Each example shows the marked-up text, then the original text it came from.
Replacement: {They're|Their} going to the store.
  Original: Their going to the store.
Deletion: It was {|really }good.
  Original: It was really good.
Insertion: We left{ early|} on Friday.
  Original: We left on Friday.
Middle suggestion: The results were {good|decent|fine}.
  Recommended "good", optional extra "decent", original "fine".
Escaped braces: Set the value to \{id\}, and {then|than} save.
  Literal braces outside groups must be escaped.
Punctuation: I saw{ him|, him} {there|their}{.|!}
  Original: I saw, him their!
Whitespace fix (no markup): hello, world
  Original: hello  ,world
  (double space collapsed, space-before-comma moved after — no { } needed)
BAD (one all-or-nothing choice): {I saw him yesterday and he doesn't know anything.|I seen him yesterday and he don't know nothing.}
GOOD (three independent choices): I {saw|seen} him yesterday and he {doesn't|don't} know {anything|nothing}.
BAD (unchanged words inside the group): The {results were good and useful.|results was good and useful.}
GOOD (only the changed word): The results {were|was} good and useful.`;

/* Message for an unknown verb, or check/present without text. Returned as a
   plain result (never thrown) so the round continues and the model can
   self-correct. */
const PROOF_VERB_HELP =
  'proofreader: unknown verb, or text missing. Valid verbs: unlock (no text), ' +
  'check (needs text), present (needs text). Call with verb "unlock" to get the usage text.';

/* Pointer placed first in every present rejection. It costs tokens only on
   failure and is the main teaching path for a model that skipped unlock. */
const PROOF_UNLOCK_POINTER =
  'Tip: call proofreader with verb "unlock" for the markup rules and examples, or verb "check" to validate markup without showing a card.';

function proofErrorList(errors) {
  const n = errors.length;
  return errors.slice(0, 20).map(function (e) {
    return '- at line ' + e.line + ' col ' + e.col + (e.type ? ' [' + e.type + ']' : '') + ': ' + e.message + (e.excerpt ? '  [' + e.excerpt + ']' : '');
  }).join('\n') + (n > 20 ? '\n- \u2026and ' + (n - 20) + ' more.' : '');
}

/* The markup report. check and present share it verbatim so a bad parse reads
   the same either way; only the success paths differ, because only present
   hands the passage to the user. */
function proofFailureText(cp) {
  const cn = cp.errors.length;
  return 'Check found ' + cn + ' markup problem' + (cn === 1 ? '' : 's') + '. No card was shown:\n' +
    proofErrorList(cp.errors) + '\nFix every problem, then check again or present.';
}

/* check's success path. The resolved passage is echoed HERE, while the model
   can still change its markup, instead of after present, when it cannot. */
function proofCheckOkText(cp) {
  const kinds = cp.groups.map(function (g) { return (g.index + 1) + ': ' + proofGroupKind(g); }).join(', ');
  const resolved = PROOF.resolve(cp, PROOF.defaultSel(cp));
  return 'Check passed: ' + cp.groups.length + ' edit group' + (cp.groups.length === 1 ? '' : 's') + ' (' + kinds + '). ' +
    'No card was shown. Your recommendations resolve to the text below - read it back for mistakes NOW, while a fix is still cheap:\n"""\n' +
    resolved + '\n"""\nThis is a proofreading echo, not an answer: the card is what the user sees and every choice in it is theirs. ' +
    'Do not paste this back to them. Call present with the same text to show it.';
}

/* One word per group for the check result: choices (more than two
   alternatives), delete (empty recommendation), insert (empty original),
   otherwise replace. */
function proofGroupKind(g) {
  if (g.g.length > 2) return 'choices';
  if (g.g[g.rec] === '') return 'delete';
  if (g.g[g.orig] === '') return 'insert';
  return 'replace';
}

/* SEAM: the description below is rebuilt into EVERY request of every session
   while this plugin is enabled, so it must stay thin. It says why the tool
   exists and how to unlock it, and nothing else. The real usage text lives in
   PROOF_USAGE and is returned only by the unlock verb, the same shape as the
   stub of the extra tool. Merging usage text back into this description
   silently defeats the deferral. The more the stub explains, the more an
   agent is tempted to skip the unlock, so do not add grammar, ordering or
   turn-ending rules here. Parameters are likewise declared by name and type
   only, and only verb is required, because the unlock call carries no text.
   The gate is convention, not enforcement: a call with text and no verb is
   treated as present. */
define({
  apiVersion: 1,
  name: 'proofreader',
  description:
    '#CHAT Create a UI to show user multiple edits simultaneously for approval when they\'ve asked you to improve prose. ' +
    'Before first use, you must call proofreader({ verb: "unlock" }), which returns a detailed usage guide.',
  params: [
    { name: 'verb', type: 'string', required: true },
    { name: 'text', type: 'string', required: false }
  ],
  access: { op: 'chat' },

  async handler(args) {
    const src = args.text;
    const hasText = typeof src === 'string' && src.length > 0;
    let verb = (args.verb === undefined || args.verb === null) ? '' : String(args.verb).trim().toLowerCase();
    // Lenient gate: text with no verb is a present call (a stub-only caller
    // that never unlocked sends exactly this shape).
    if (verb === '' && hasText) verb = 'present';

    if (verb === 'unlock') return PROOF_USAGE;

    if (verb === 'check') {
      if (!hasText) return PROOF_VERB_HELP;
      const cp = PROOF.parse(src);
      if (!cp.ok) return proofFailureText(cp);
      return proofCheckOkText(cp);
    }

    if (verb !== 'present') return PROOF_VERB_HELP;
    if (!hasText) return PROOF_VERB_HELP;

    /* A malformed present behaves exactly like a check: report, show nothing,
       keep the round going so the markup can be fixed and resent whole. The
       unlock pointer is the only extra line, and it is the teaching path for a
       caller that never ran unlock. */
    const p = PROOF.parse(src);
    if (!p.ok) return PROOF_UNLOCK_POINTER + '\n' + proofFailureText(p);
    if (!p.groups.length) return PROOF_UNLOCK_POINTER + '\n' +
      'Proofreader rejected the passage: no edit groups. If there is genuinely nothing to change, reply in prose instead.';

    return {
      text: 'Proofreading card shown with ' + p.groups.length + ' edit group' + (p.groups.length === 1 ? '' : 's') + '. ' +
        'Do NOT repeat the passage back to the user: it is in the card, and the wording is theirs to change from here on. ' +
        'If something had to be judged rather than fixed, list it as brief bullets. ' +
        'End the turn now. Never call proofreader twice for the same passage in one turn.',
      widget: { text: src }
    };
  },

  summary(data, state) {
    const cur = state && typeof state.m === 'string' ? state : null;
    const m = cur ? cur.m : ((data && data.text) || '');
    const p = PROOF.parse(m);
    if (!p.ok) {
      if (PROOF.isOnlyNoGroups(p)) return { text: 'plain text, every edit baked in', open: true };
      return { text: 'proofreader card needs a look (markup invalid)', open: true };
    }
    const sel = cur && Array.isArray(cur.s) ? cur.s : PROOF.defaultSel(p);
    const chosen = cur && Array.isArray(cur.c) ? cur.c : [];
    const st = PROOF.stats(p, sel, chosen);
    let text;
    if (st.changes === 0) text = p.groups.length + ' suggestion' + (p.groups.length === 1 ? '' : 's') + ', nothing kept yet';
    else text = st.changes + ' of ' + st.edits + ' edit' + (st.edits === 1 ? '' : 's') + ' kept' + (st.differ ? ' \u00b7 ' + st.differ + ' your choice' : '');
    return { text: text, open: true };
  },

  render(body, data, host) {
    PROOF.renderCard(body, data, host);
  },

  _seams: { PROOF }
});
