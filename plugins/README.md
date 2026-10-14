# ChatPlus plugins

A plugin is one plain `.js` file that registers a tool the model can call and,
optionally, a card that renders in the chat thread where that tool's result
row would be. There is no build step, no framework, and no import syntax: a
plugin calls `define({...})` exactly once.

The loader scans exactly one directory: `<DATA_ROOT>\plugins\`, beside
`config\` and `sessions\`. In dev, `DATA_ROOT` is the repo root, so this
folder - `plugins\` - IS the scan directory: the shipped samples are found
automatically in a dev checkout and only need approval in Settings > Plugins.
Packaged builds keep their data folder beside the exe; a `www\` path is never
a plugin location (the resource bundle is not user-writable and gets replaced
on update - plugins live where the user does). Open **Settings > Plugins**,
flip a plugin on, return to the chat: approval takes effect on the next
chat-page load, and the load itself never blocks startup (see Registration
timing).

Approval pins the exact bytes: the settings page records the file's SHA-256
(full record `{ hash, bytes, mtimeMs, approved }`; hand-editing
`config\plugins.json` may also use the shorthand `"file.js": "<hex>"`, which
reads as approved-at-that-hash), and any edit after approval drops the file
back to "changed - needs re-approval" and stops it from loading. This is a
know-what-you-run gate - aimed first at your own agents, who can edit anything
- not a sandbox: plugin code runs with the app's full privileges, exactly like
every other script on the page.

## The descriptor

```js
define({
  apiVersion: 1,                   // spec version; missing reads as 1, anything else is refused
  name: 'my_tool',                 // required, snake_case, 2-32 chars, unique (built-ins win)
  description: '...',              // required; the model reads this to decide when to call it
  params: [                        // optional; same shape as built-in registry params
    { name: 'thing', type: 'string', required: true, description: '...' }
  ],
  access: { op: 'chat' },          // required: 'chat' | 'read' | 'write' (see below); read/write also need pathParams
  style: '.card{...} button{...}', // optional CSS for your cards/overlays, scoped by the host
  async handler(args, t) { ... },  // required; return { text }, { text, widget } or { text, isError: true }
  summary(data, state, call) { ... },    // optional; head line for the row: { text, open }. call = { name, args }
  render(body, data, host) { ... } // optional; the card. Its presence makes the row a widget row.
});
```

## handler contract

- `handler(args, t)` may be async. It must return `{ text }` (a bare string is
  accepted) or `{ text, widget }`, where `widget` is any JSON-serializable
  value handed verbatim to `render()` as `data`. Anything else is a contract
  violation and surfaces as an error tool result.
- The returned `text` is the model-facing tool result. Make it do real work:
  state what the card showed, what the user can still do locally, and what
  the model should do now (almost always: end the turn). A widget tool that
  expects follow-up usually causes the model to restate the card in prose.
  The full underlying text belongs in `widget`; the row keeps `text` for
  recovery, so a plugin removed later still leaves a readable transcript.
  The host's ONE size guard lives here: text over 256 KB is truncated with a
  visible marker, because tool results re-ride every later provider request
  and a runaway result can break the chat loop with no in-app recovery. That
  is a shared-resource limit, not distrust of you: `widget` and persisted
  state are local-only and deliberately uncapped (rendering a base64 PNG over
  the wire is a use case, not an exploit).
- `access` is required and `access.op` must be exactly one of three levels;
  a plugin with a missing declaration, or any other value (including the old
  `'none'`), is rejected at load. There is no default.
  - `'chat'` -- touches no filesystem. Callable in every mode (Chat, Plan, Act).
    Use this for cards that only present something and return text.
  - `'read'` -- reads files. Callable in Plan and Act. Needs `pathParams`.
  - `'write'` -- writes files (implies read). Callable in Act only. Needs
    `pathParams`.
  The level is compared against the turn's mode: a tool runs only when its
  level is at or below the mode's. "chat" here is a permission level, not a
  session (`t.chat` below is a session id).
- `t.files` exists only when `access.op` is `read`/`write` — and then it is
  exactly the same permission-gated capability the built-in tools use: every
  path still runs through the app's allow/deny gates, and permission cards
  still work. Paths must be absolute; the built-in path validation applies.
- `t.apiVersion` is the spec version the host implements (1).
- `t.chat` is the session id; `t.callId` is this call's id (the same id
  `host.state` is keyed by).
- `t.signal` is an `AbortSignal` that fires when the user stops the turn.
  Pass it to `fetch` or check it in long loops. The host already stops
  *waiting* for you on Stop (a handler that never settles cannot pin the
  chat); the signal is how you also stop *working*.
- `await t.callTool(name, args)` runs a **built-in** tool (read_file,
  edit_file, ...) through exactly the gates the model's own calls pass:
  Tools settings, the turn's mode, absolute-path validation, permission
  cards, the per-file write guard and automatic backups. Resolves
  `{ text, isError, result }`; throws what the tool throws (catch it, or let
  it become your error result). Use this - not `t.files.writeFile` - when
  a plugin edits user files, so undo/backup keeps working. Plugin tools
  cannot call other plugin tools.
- Reporting a failure: `throw new Error('why')` or return
  `{ text: 'Error: why', isError: true }`. Both become a normal red tool row
  the model reads; the turn continues either way.
- `await t.awaitAnswer(payload)` parks the turn and shows the card with
  `payload` as its data. It resolves with the user's answer string, or
  rejects (`.stopped === true`) if the user stops the turn or leaves the
  chat. Decide explicitly what the model hears on rejection - returning a
  calm `{ text: 'The user did not answer...' }` keeps the transcript clean.

## card contract (render / summary)

- `render(body, data, host)` draws into `body`, a plain `div` inside the
  row (ordinary DOM: selection, focus and caret APIs behave as in app code).
  **It must be idempotent**: the host tears the card down and rebuilds it on
  every thread repaint (chat switch, settings round-trip), passing the same
  `data` plus whatever you persisted. Keep everything that must survive in
  `host.state`; keep DOM node identity across a rebuild in, not out.
- `host.signal` is an `AbortSignal` that fires when *this drawing* of the
  card is torn down (repaint, chat switch, a parked card being answered).
  Anything a card starts that outlives `render()` - a timer, a listener on
  `window`/`document`, a fetch - should hang off it, or it piles up once per
  repaint:
  `window.addEventListener('resize', fit, { signal: host.signal })`,
  `host.signal.addEventListener('abort', () => clearInterval(timer))`.
  Listeners on your own card elements need nothing; they go with the DOM.
- `host.copy(text, done)` copies via the app's clipboard path (includes the
  webview fallback).
- `host.state.get()` / `host.state.set(blob)` remember one plain JSON object
  per call, persisted per chat in `sessions/<id>/widgets.json` - debounced,
  flushed on answer, chat switch, settings nav, reload, and window close,
  copied on fork, dropped with the chat. Never sent to the model, never in
  the transcript. No size cap - `set(null)` clears; the cost of a fat blob is
  a slower widgets.json load, which you own. Store decisions and small UI
  positions if you like the file to stay lean, but nothing is refused.
- `host.answer(value)` settles a parked `awaitAnswer` (only while the turn
  is parked on this card).
- `host.overlay(anchor, opts)` opens a floating surface (menu, popover) in
  the app-level overlay host: never clipped by the thread's overflow, closed
  on outside pointerdown, `Esc`, thread repaint, or turn settle.
  `opts = { id, dismiss, focus, onClose(reason) }`; returns
  `{ el, signal, alive, close(), reposition() }` (`signal` fires on close). Repaint-closes are silent (no `onClose`)
  by design: a repaint is not a user gesture. Persist "which menu was open"
  in `host.state` if it should re-arm after a rebuild (see the ask-user and
  proofreader samples).
- `summary(data, state, call)` returns `{ text, open }` for the row head. `text`
  replaces the generic "ran" line; `open` controls the first paint only
  (after that the user's click-to-collapse is persisted like any tool row).
  `call` is `{ name, args }`, the model's request that produced the row, so
  the head can depend on what was asked. Pending cards (turn parked on
  `awaitAnswer`) always render open with a "waiting for your answer" head.
- `host.call` is the same `{ name, args }`, available in `render` whether the
  card is parked on `awaitAnswer` or already settled.
- The active theme is the app's business, not the model's and not a stored
  fact. Call `window.isDarkMode()` (true = dark) once per `render` and pick
  your own color table from the answer. Do not add a theme parameter, do not
  read `data-theme` or `localStorage` yourself, and do not write the theme
  into `data` or `host.state` - theming is settled at load, so a later draw
  answers it again. Ship your own colors rather than mirroring the app's
  stylesheet; the theme variables below are a convenience, not a contract.
- Put `data-widget-ui` on your card's root element if it has an editor. While
  focus is inside it (or inside an overlay), Esc no longer stops the turn,
  digits 1-8 no longer answer a pending permission card, and Ctrl+Home/End
  keep their caret meaning. Other app chords (Ctrl+W, Ctrl+N, Ctrl+, ...)
  still apply, exactly as they do in the composer.

## Style

Put your CSS in the descriptor's `style` string. The host installs it once
and nests every rule under `[data-plugin="<your file id>"]`, the attribute on
each of your cards and overlays, so `button { ... }` styles your buttons and
no one else's. It is parsed before nesting, so a stray `}` cannot break out
of the scope. The app's own CSS still reaches your cards (they sit in the
thread like any row), and the theme variables (`--fg`, `--accent`,
`--border`, `--bg-input`, ...) are available.

Two exceptions: `@keyframes` and `@font-face` cannot be scoped, so they stay
global; prefix their names. And do not write `<style>` into `document.head`
yourself - nothing stops you, but that CSS is global and outlives your plugin.

## Failure rules (enforced by the host)

No plugin mistake stops a turn, raises the app's INTERNAL FAILURE banner, or
writes into the transcript. Specifically:

- Throwing from `handler` (sync or async, any error type) → normal `Error:`
  tool result; the model sees it and the turn continues. Validate input and
  report every problem at once with positions if you can (see proofreader's
  markup validator). JS programming errors (`TypeError`, `ReferenceError`,
  ...) are reported as "plugin crashed (a bug in the plugin, not your
  arguments)" with a do-not-retry hint, and the stack goes to diagnostics.
- Returning something that is not `{ text }` / `{ text, widget }` / a
  string → same: a normal error result.
- A handler that never settles → Stop still ends the turn normally.
- A genuine stop (`e.stopped`, e.g. from `awaitAnswer` or a denied
  permission card) passes through and is reported as a stop.
- Throwing from `render` on a settled row → the card shows a short note plus
  the model-facing text. Nothing else happens.
- Throwing from `summary` → the head shows a neutral fallback line.
- Throwing from `render` while the turn is parked → the card degrades to a
  text row; the parked answer stays alive so the turn can still be answered
  or stopped.
<!-- TODO(pending-approval): freeze-marker - on removal: delete this bullet. -->
- Plugin code that never returns (an endless loop in load, `render` or
  `summary`) freezes the app; one JS thread, nothing can interrupt it. The
  host does make it recoverable: right before running that code it writes
  `config/plugin-inflight.json` naming your file, and deletes it right after.
  If the file is still there at the next start, your plugin is switched off
  (`approved: false` plus a `suspended` note in `config/plugins.json`), a
  toast says why, and Settings > Plugins shows "switched off automatically".
  Toggling it on clears that. Limits, stated plainly: code in your own
  timers and event handlers is not covered; a card expanded by a click is
  covered best-effort; and killing the app in the few milliseconds the
  marker exists (e.g. closing it mid-startup) reads as a freeze - one toggle
  undoes it. With several plugin rows in one repaint the marker names all
  of them, and all are switched off.
- Unknown/missing plugin (revoked after use) → the row renders the persisted
  `text` verbatim with a note. Write that `text` so a chat still reads
  correctly years later without your plugin.

## Registration timing

Startup fires the plugin scan and does not wait for it. Each approved file
registers the moment it is read and hashed (milliseconds), and the registry
freezes when the scan settles: mid-chat tool-set changes stay impossible by
construction, and a plugin you edit only takes effect on the next chat-page
load. Two small things close the startup window without delaying startup:
the first model request waits for the scan (bounded at 3 s; in practice it
finished long before anyone typed), and if a plugin row was painted before
its plugin registered, the open chat is repainted once when the scan ends.

## One file, one plugin

Every top-level `*.js` in the plugins folder is exactly one plugin. The
loader lists top-level files only, so **subfolders are reserved** for a
future shared-helpers mechanism (a plugin pulling code from, say,
`plugins/lib/`). Nothing is loaded from subfolders today; putting files
there now is safe and will not change what loads.

## Grammar belongs to the plugin

The proofreader sample's inline markup - `⟪recommended‖suggestion…‖original⟫`,
first alternative = recommendation (shown by default), last = the original
text exactly, empty-first = deletion, empty-last = insertion, spaces
literal, no nesting, no escapes - is the owner's `proofreader-widget-prototype`
grammar, ported verbatim (parser, error taxonomy, merged menu entries, kind
labels, selection carry-over). None of it is the host's business: the card's
shape lives entirely inside one plugin's `widget` payload and its `render`.
The host never parses plugin data and promises nothing about its shape. Swap
the convention for a rival one and the contract does not move an inch -
that is the point of the layer boundary, and why no host-side "edit markup"
spec ever shipped.


