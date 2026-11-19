/* ChatPlus plugin: http_request.
 *
 * One tool: send a single HTTP request and return the status line and the
 * body as text. The model chooses per call whether it wants the response
 * headers (include_headers) and how many body bytes to read (max_bytes).
 * The user owns two settings, shown in Settings > Plugins:
 *   user_agent        - sent on every request, replaces any the model sends
 *   require_approval  - each | once | never (default each)
 * "once" means once per host per chat, kept in memory only, so a reload or
 * a new chat asks again. An unreadable or unknown value falls back to each.
 *
 * No response at all (DNS, refused, TLS, timeout) is reported as one generic
 * error: the browser deliberately does not say which. Any HTTP response,
 * including 4xx and 5xx, is a normal result with its status and body.
 *
 * Install: copy this file to <DATA_ROOT>\plugins\ and approve it in
 * Settings > Plugins. */

const DEFAULT_MAX_BYTES = 100000;
const MAX_EXTRACT_MATCHES = 100;
const MAX_EXTRACT_CHARS = 20000;

// Settings the user owns (Settings > Plugins). Strict JSON between the
// markers, by rule: the settings page parses this as text, and the host
// refuses to load the plugin if define() below does not use it unchanged.
//{{PLUGIN_OPTIONS
const PLUGIN_OPTIONS = [
  {"key":"user_agent","label":"User agent","default":"","description":"Sent as the User-Agent header on every request, replacing any the model supplies. Blank = the webview default."},
  {"key":"require_approval","label":"Require approval","default":"each","choices":["never","once","each"],"description":"each = you approve every request before it is sent. once = you approve a host once per chat. never = requests are sent without asking."}
];
//}}PLUGIN_OPTIONS

// Fallbacks come from the declaration, so there is one place to change them.
const OPTION_DEFAULTS = {};
PLUGIN_OPTIONS.forEach(function (o) { OPTION_DEFAULTS[o.key] = o.default; });
const APPROVAL_MODES = PLUGIN_OPTIONS.filter(function (o) { return o.key === 'require_approval'; })[0].choices;
// chat id -> Set of host keys the user approved in that chat (once mode).
const grants = new Map();

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}

define({
  apiVersion: 1,
  // Neutral translucent surfaces over the host card, same shortcut as
  // ask-user.js; see the theming note there.
  style:
    '.cp-http{display:flex;flex-direction:column;gap:8px;min-width:min(100%,360px);max-width:560px}' +
    '.cp-http-line{font-family:monospace;font-size:12.5px;overflow-wrap:anywhere}' +
    '.cp-http-pre{margin:0;padding:6px 8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.1);border-radius:6px;font-family:monospace;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}' +
    '.cp-http-btns{display:flex;gap:8px;flex-wrap:wrap}' +
    '.cp-http-btn{border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.14);color:inherit;border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit}' +
    '.cp-http-btn:hover{border-color:#4f7cff}' +
    '.cp-http-btn.allow{border-color:#4f7cff;background:#4f7cff22}' +
    '.cp-http-hint{font-size:11px;opacity:.65}',
  name: 'http_request',
  description:
    '#CHAT Send one HTTP request to an absolute http or https URL and return the status line ' +
    'and the response body as text. Redirects are followed. Any HTTP response, including an ' +
    'error status, comes back as a normal result; if there is no response at all you get one ' +
    'generic error and cannot tell DNS from refused from TLS, so do not retry with URL variants. ' +
    'The user may have to approve the request first; if they decline, do not retry or send ' +
    'variants, say what you wanted and ask how to proceed. Set include_headers only when you ' +
    'need the response headers. Set max_bytes to read less of a large body (0 = no limit, ' +
    'still capped at 256 KB for you). If the result says it was truncated, say so. Set extract ' +
    'to return only substrings matching a JS regex (e.g. "<title>(.*?)</title>" with flags "is" ' +
    'to pluck just titles) instead of the full body. Use extract_mode line to keep whole ' +
    'matching lines.',
  params: [
    { name: 'url', type: 'string', required: true, description: 'Absolute http or https URL.' },
    { name: 'method', type: 'string', required: false, description: 'HTTP method. Default GET.' },
    { name: 'headers', type: 'string', required: false, description: 'Request headers as a JSON object string, e.g. {"Accept":"application/json"}.' },
    { name: 'body', type: 'string', required: false, description: 'Request body text. Ignored for GET and HEAD.' },
    { name: 'include_headers', type: 'boolean', required: false, description: 'Return the response headers ahead of the body. Default false.' },
    { name: 'max_bytes', type: 'number', required: false, description: 'Stop reading the body after this many bytes. Default 100000. 0 = no limit.' },
    { name: 'extract', type: 'string', required: false, description: 'Optional JS regex source. If set, return only matches instead of the full body. If it has a capture group, return group 1, else the full match.' },
    { name: 'extract_flags', type: 'string', required: false, description: 'Flags for extract: any of gimsuy. Default g. Global is forced on.' },
    { name: 'extract_mode', type: 'string', required: false, description: 'match = return matched substrings (default). line = return whole lines containing the regex.' }
  ],
  access: { op: 'chat' },
  options: PLUGIN_OPTIONS,

  async handler(args, t) {
    const opts = t.options || {};
    const mode = APPROVAL_MODES.indexOf(opts.require_approval) >= 0 ? opts.require_approval : OPTION_DEFAULTS.require_approval;
    const userAgent = String(opts.user_agent || '').trim();
    const includeHeaders = args.include_headers === true ||
      /^(1|true|yes)$/i.test(String(args.include_headers == null ? '' : args.include_headers));
    let maxBytes = DEFAULT_MAX_BYTES;
    if (args.max_bytes !== undefined && args.max_bytes !== null && args.max_bytes !== '') {
      const n = Number(args.max_bytes);
      if (Number.isFinite(n) && n >= 0) maxBytes = Math.floor(n);
    }

    let url;
    try { url = new URL(String(args.url || '')); }
    catch (_) { return { text: 'Error: url is not an absolute URL: ' + String(args.url || ''), isError: true }; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { text: 'Error: only http and https URLs are supported (got ' + url.protocol + ')', isError: true };
    }

    const method = String(args.method || 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) return { text: 'Error: bad method: ' + method, isError: true };

    // Extract filter: validate before the approval gate so a bad regex
    // fails fast with no user prompt and no fetch wasted.
    const extractSrc = args.extract !== undefined && args.extract !== null ? String(args.extract) : '';
    let extractRe = null;
    let extractFlags = 'g';
    let extractMode = 'match';
    if (extractSrc) {
      const rawFlags = args.extract_flags !== undefined && args.extract_flags !== null && args.extract_flags !== ''
        ? String(args.extract_flags) : 'g';
      if (!/^[gimsuy]*$/.test(rawFlags)) {
        return { text: 'Error: extract_flags must use only gimsuy (got ' + rawFlags + ')', isError: true };
      }
      extractFlags = rawFlags.indexOf('g') >= 0 ? rawFlags : rawFlags + 'g';
      const rawMode = args.extract_mode !== undefined && args.extract_mode !== null && args.extract_mode !== ''
        ? String(args.extract_mode).toLowerCase() : 'match';
      if (rawMode !== 'match' && rawMode !== 'line') {
        return { text: 'Error: extract_mode must be match or line (got ' + String(args.extract_mode) + ')', isError: true };
      }
      extractMode = rawMode;
      try { extractRe = new RegExp(extractSrc, extractFlags); }
      catch (e) { return { text: 'Error: extract is not a valid regex: ' + (e && e.message || e), isError: true }; }
    }

    let raw = {};
    if (args.headers !== undefined && args.headers !== null && args.headers !== '') {
      try { raw = typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers; }
      catch (e) { return { text: 'Error: headers is not valid JSON: ' + (e && e.message || e), isError: true }; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { text: 'Error: headers must be a JSON object of name/value pairs', isError: true };
      }
    }
    const merged = {};
    for (const k of Object.keys(raw)) merged[k] = String(raw[k]);
    if (userAgent) {
      for (const k of Object.keys(merged)) if (k.toLowerCase() === 'user-agent') delete merged[k];
      merged['User-Agent'] = userAgent;
    }
    let hdrs;
    try { hdrs = new Headers(merged); }
    catch (e) { return { text: 'Error: invalid request header: ' + (e && e.message || e), isError: true }; }

    const hasBody = args.body !== undefined && args.body !== null && method !== 'GET' && method !== 'HEAD';
    const bodyText = hasBody ? String(args.body) : '';
    const hostKey = url.host.toLowerCase();
    const base = { method, url: url.href };

    // Approval gate. never: straight through. once: ask unless this chat
    // already approved this host. each: always ask.
    let decision = 'auto';
    if (mode !== 'never') {
      const approved = grants.get(t.chat);
      if (mode === 'once' && approved && approved.has(hostKey)) {
        decision = 'remembered';
      } else {
        const shown = [];
        hdrs.forEach((v, k) => { shown.push(k + ': ' + v); });
        const payload = {
          pending: true, mode, method, url: url.href, host: hostKey, headers: shown,
          bodyPreview: hasBody ? clip(bodyText, 400) : '', bodyLength: bodyText.length
        };
        let ans;
        try { ans = await t.awaitAnswer(payload); }
        catch (e) {
          if (e && e.stopped) {
            return { text: 'The user did not answer (the turn was stopped). The request was NOT sent. Await further instructions.' };
          }
          throw e;
        }
        if (ans !== 'allow') {
          return {
            text: 'The user declined this request. It was not sent. Do not retry it or send variants; say what you wanted and ask how to proceed.',
            widget: Object.assign({}, base, { decision: 'denied' })
          };
        }
        decision = 'allowed';
        if (mode === 'once') {
          if (!grants.has(t.chat)) grants.set(t.chat, new Set());
          grants.get(t.chat).add(hostKey);
        }
      }
    }

    let res;
    try {
      res = await fetch(url.href, { method, headers: hdrs, body: hasBody ? bodyText : undefined, signal: t.signal });
    } catch (e) {
      if (t.signal && t.signal.aborted) return { text: 'The request was cancelled because the turn was stopped.' };
      return {
        text: 'Error: could not reach host ' + url.host + ' (DNS failure, connection refused, TLS error or timeout; the browser does not say which). No HTTP response was received.',
        isError: true,
        widget: Object.assign({}, base, { decision, noResponse: true })
      };
    }

    // Bounded read: stop pulling bytes at maxBytes and cancel the stream.
    let body = '';
    let truncated = false;
    let total = 0;
    if (method !== 'HEAD' && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let chunk = value;
          if (maxBytes > 0 && total + chunk.length > maxBytes) {
            chunk = chunk.subarray(0, maxBytes - total);
            truncated = true;
          }
          total += chunk.length;
          body += dec.decode(chunk, { stream: true });
          if (truncated) { try { await reader.cancel(); } catch (_) {} break; }
        }
        body += dec.decode();
      } catch (e) {
        if (t.signal && t.signal.aborted) return { text: 'The request was cancelled because the turn was stopped.' };
        return {
          text: 'Error: the connection broke while reading the response after ' + total + ' bytes (status was ' + res.status + ').',
          isError: true,
          widget: Object.assign({}, base, { decision, status: res.status, statusText: res.statusText || '', brokeAt: total })
        };
      }
    }

    const lines = [res.status + ' ' + (res.statusText || '') + (res.url && res.url !== url.href ? '  (final url: ' + res.url + ')' : '')];
    if (includeHeaders) res.headers.forEach((v, k) => { lines.push(k + ': ' + v); });
    lines.push('');
    let extractInfo = null;
    if (extractRe) {
      const found = [];
      if (extractMode === 'line') {
        const probe = new RegExp(extractRe.source, extractFlags);
        const bodyLines = body.split('\n');
        for (const ln of bodyLines) {
          probe.lastIndex = 0;
          if (probe.test(ln)) found.push(ln);
          if (found.length >= MAX_EXTRACT_MATCHES) break;
        }
      } else {
        extractRe.lastIndex = 0;
        for (const m of body.matchAll(extractRe)) {
          found.push(m[1] !== undefined ? m[1] : m[0]);
          if (found.length >= MAX_EXTRACT_MATCHES) break;
        }
      }
      extractRe.lastIndex = 0;
      let shown = found;
      let extractCut = null;
      if (found.length >= MAX_EXTRACT_MATCHES) {
        extractCut = 'stopped at ' + MAX_EXTRACT_MATCHES + ' matches';
      } else {
        // Keep the model-facing text small: trim whole matches off the end.
        let chars = 0;
        let keep = found.length;
        for (let i = 0; i < found.length; i++) {
          chars += found[i].length + (i ? 5 : 0); // '\n---\n' separator
          if (chars > MAX_EXTRACT_CHARS) { keep = i; break; }
        }
        if (keep < found.length) {
          shown = found.slice(0, keep);
          extractCut = 'stopped at ' + MAX_EXTRACT_CHARS + ' chars';
        }
      }
      extractInfo = {
        pattern: extractSrc, flags: extractFlags, mode: extractMode,
        matches: found.length, showing: shown.length,
        cut: extractCut, totalChars: body.length
      };
      lines.push('[extract /' + extractSrc + '/' + extractFlags + ' mode=' + extractMode +
        ': ' + found.length + ' matches, showing ' + shown.length + ']');
      if (shown.length) {
        lines.push(shown.join('\n---\n'));
      } else {
        lines.push('(no matches)');
      }
      if (extractCut) lines.push('', '[extract truncated: ' + extractCut + ']');
    } else {
      lines.push(body);
    }
    if (truncated) lines.push('', '[truncated: read stopped at ' + maxBytes + ' bytes]');
    return {
      text: lines.join('\n'),
      widget: Object.assign({}, base, {
        decision, status: res.status, statusText: res.statusText || '', truncated, bytes: total,
        finalUrl: res.url && res.url !== url.href ? res.url : '',
        extract: extractInfo || undefined,
        extractMode: extractInfo ? extractInfo.mode : undefined,
        matches: extractInfo ? extractInfo.matches : undefined,
        showing: extractInfo ? extractInfo.showing : undefined
      })
    };
  },

  summary(data) {
    const d = data || {};
    const host = (function () { try { return new URL(d.url).host; } catch (_) { return d.url || ''; } })();
    const head = (d.method || 'GET') + ' ' + host;
    if (d.pending) return { text: 'waiting for your approval: ' + head, open: true };
    if (d.decision === 'denied') return { text: 'declined: ' + head, open: false };
    if (d.noResponse) return { text: 'no response: ' + head, open: false };
    if (d.status) return { text: head + ' -> ' + d.status + (d.truncated ? ' (truncated)' : '') + (d.extract ? ' (extract ' + d.extract.showing + '/' + d.extract.matches + ')' : ''), open: false };
    return { text: head, open: false };
  },

  render(body, data, host) {
    const d = data || {};
    const wrap = document.createElement('div');
    wrap.className = 'cp-http';
    const line = document.createElement('div');
    line.className = 'cp-http-line';
    line.textContent = (d.method || 'GET') + ' ' + (d.url || '');
    wrap.appendChild(line);

    if (d.pending) {
      const detail = [];
      (d.headers || []).forEach(function (h) { detail.push(h); });
      if (d.bodyPreview) detail.push('', 'body (' + d.bodyLength + ' chars):', d.bodyPreview);
      if (detail.length) {
        const pre = document.createElement('pre');
        pre.className = 'cp-http-pre';
        pre.textContent = detail.join('\n');
        wrap.appendChild(pre);
      }
      const btns = document.createElement('div');
      btns.className = 'cp-http-btns';
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.className = 'cp-http-btn allow';
      allow.textContent = d.mode === 'once' ? 'Allow (' + d.host + ', this chat)' : 'Allow';
      allow.addEventListener('click', function () { host.answer('allow'); });
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'cp-http-btn';
      deny.textContent = 'Deny';
      deny.addEventListener('click', function () { host.answer('deny'); });
      btns.append(allow, deny);
      wrap.appendChild(btns);
      const hint = document.createElement('div');
      hint.className = 'cp-http-hint';
      hint.textContent = 'The request is not sent until you choose. Change this in Settings > Plugins.';
      wrap.appendChild(hint);
    } else {
      const how = {
        denied: 'You declined this request. It was not sent.',
        allowed: 'You allowed this request.',
        remembered: 'Sent without asking: this host was already approved in this chat.',
        auto: 'Sent without asking (approval setting is never).'
      }[d.decision] || '';
      let outcome = '';
      if (d.noResponse) outcome = 'No response from the host (DNS failure, connection refused, TLS error or timeout).';
      else if (d.brokeAt !== undefined) outcome = 'Status ' + d.status + '; the connection broke after ' + d.brokeAt + ' bytes.';
      else if (d.status) outcome = 'Status ' + d.status + ' ' + (d.statusText || '') + ' - ' + d.bytes + ' bytes read' + (d.truncated ? ', truncated' : '') + '.' + (d.finalUrl ? ' Final url: ' + d.finalUrl : '') + (d.extract ? ' Extract /' + d.extract.pattern + '/' + d.extract.flags + ' mode=' + d.extract.mode + ': ' + d.extract.matches + ' matches, showing ' + d.extract.showing + (d.extract.cut ? ' (' + d.extract.cut + ')' : '') + ' of ' + d.extract.totalChars + ' chars.' : '');
      [how, outcome].forEach(function (s) {
        if (!s) return;
        const p = document.createElement('div');
        p.className = 'cp-http-hint';
        p.textContent = s;
        wrap.appendChild(p);
      });
    }
    body.appendChild(wrap);
  }
});
