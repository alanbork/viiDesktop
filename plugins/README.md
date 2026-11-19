# ChatPlus plugins

Out of the box, Vii Desktop's agent can talk to you and work on the files in
the folders you allow. That is what we needed when we wrote it for ourselves.
Plugins are how it learns to do things we never imagined, and how it shows
you things a paragraph of text can't.

A plugin is one plain `.js` file in a folder. It gives the agent a new
**tool** (a named action it can choose to take mid-conversation) and,
optionally, a **card**: a small interactive panel that appears right in the
chat thread, where the tool's result would otherwise show as a line of text.
You can write one by hand, or have the agent write one if it has access to
the plugins folder. Nothing runs until you approve it.

## What plugins are good for

1. **Showing instead of telling.** A sortable table, a checklist, a form, a
chart, a preview. The agent hands you something you can use, not a wall
of prose to re-read.
2. **Asking you mid-task.** The agent can stop, put a question in front of
you with buttons or a text box, and carry on once you answer.
3. **Working through choices together.** The agent proposes; you decide, in
   the card, on your own time. Your choices are remembered per chat, survive
switching chats and restarting the app, and stay on your machine. They are
never sent to the model.
4. **Doing real work on your files, safely.** A plugin that edits files
   through the built-in tools gets the same permission checks and automatic
backups as the agent itself, so "put that back" still works.

None of these ideas ship as plugins yet (the three samples below are the
real ones), but they are all within reach of what a card can do: a quiz or
flashcard deck, a palette picker, a diff reviewer, a sign-off checklist, a
progress panel for a long job.

## Three samples

This folder ships three working plugins, ordered simplest to deepest.

1. **Clickable lines** (`clickable-lines.js`, tool `clickable_lines`). The
   agent gives you a list - paths, commands, config blocks - as numbered
   rows; click a row and exactly that text lands on your clipboard. This is
   the smallest complete plugin: roughly 125 lines, and the whole skeleton
   (descriptor, handler, summary, render). Its result text tells the model
   the card is already in front of you, so the model stops instead of
   repeating the list in prose. (It also highlights the last row you copied,
   purely as a demonstration of remembered card state.)

2. **Ask user** (`ask-user.js`, tool `ask_user`). The agent pauses and asks
   you one question with up to 12 choices (the first is its recommendation)
   and, optionally, a box to type your own answer. The turn waits until you
   answer. If you press Stop instead, the agent is told calmly that you
   didn't answer. This is also the reference for any card with a text
   field: what you've typed, and where your cursor was, survive the card
   being redrawn, and IME composition is handled.

3. **Proofreader** (`proofreader.js`, tool `proofreader`). The agent returns
   your passage with its suggested edits marked. Each change becomes a
   choice in the card: take the recommendation, pick an alternative, keep
   the original, or retype it yourself. Then you copy the finished text. It
   is the full-depth reference, for when you are building something people
   will live in: its own dark and light colors, floating menus, undo,
   a usage guide the agent only loads on demand, and positioned error
   reports when the agent's edit marks are malformed.

If you are building a plugin, read them in that order; each is the reference
for one slice of the contract below. (The file name and the tool name are
independent: one file is one plugin, and the `name` in its descriptor is
what the model sees.)

In a dev checkout all three are already in the plugins folder. Flip them on
in **Settings > Plugins**, reload the chat page, and ask the agent to use
one ("ask me which of these I want"). Everything below is the technical
contract, written for whoever - or whichever agent - is building a plugin.

## Finding and approving plugins

The loader scans exactly one directory: `<DATA_ROOT>\plugins\`, beside
`config\` and `sessions\`. Packaged builds keep their data folder beside
the exe; a `www\` path is never a plugin location (the resource bundle is
not user-writable and gets replaced on update - plugins live where the user
does). Open **Settings > Plugins**,
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
  value handed verbatim to `render()` as `data`. The host never parses plugin
  data and promises nothing about its shape - the card's whole shape lives in
  your `widget` payload and your `render`. Anything else is a contract
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
- `t.options` is the user's settings for this plugin: a frozen `{ key: string }`
  map with every declared option present (see Options below). Read it per call;
  it never changes mid-chat.
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

## Options (user settings)

A plugin can expose a few settings the user, not the model, controls: a user
agent, an approval gate, a default folder. Declare them in a marked region
near the top of the file, then hand the same array to `define()`:

```js
//{{PLUGIN_OPTIONS
const PLUGIN_OPTIONS = [
  {"key":"user_agent","label":"User agent","default":"","description":"..."},
  {"key":"require_approval","label":"Require approval","default":"each",
   "choices":["never","once","each"],"description":"..."}
];
//}}PLUGIN_OPTIONS

define({ /* ... */ options: PLUGIN_OPTIONS, /* ... */ });
```

- **The region is strict JSON, by rule.** Between the markers goes exactly
  `const PLUGIN_OPTIONS = [ ... ];` where the array is JSON, not a JS
  literal: double quotes everywhere, no trailing commas, no comments. Both
  marker lines must start at the beginning of a line, and a file may have one
  region. This is what lets the settings page read the declaration as text
  with a regex and `JSON.parse`, without running anything in your file.
- **The two declarations must agree, and the host checks.** At load the host
  parses the region and compares it to `define()`'s `options`. A region with no
  `options:`, `options:` with no region, or any difference between them refuses
  the load, with the reason in `logs\console.log` and under Settings >
  Plugins. Pass `options: PLUGIN_OPTIONS` unchanged and they cannot differ.
  Read your own fallbacks from the same array rather than retyping them.
- Every value is a plain string. `key` is lowercase snake_case, at most 16
  options per plugin. `label`, `description`, `default` and `choices` are
  optional; with `choices` the settings page draws a dropdown instead of a
  text box, and a stored value outside the list falls back to the default.
  Avoid putting a line that starts with the marker text inside a description.
- The user edits them in **Settings > Plugins**, under the plugin's row.
  Saving a value is not an approval event: it never touches
  `config\plugins.json`, never changes the file hash, and asks for no
  confirmation. Values live in `config\plugin-options.json`, keyed by plugin
  file name then option key. Blank means the default.
- The values are read once when the chat page loads, so a change applies when
  the user returns to the chat. Read them through `t.options` in the handler
  or `host.options` in a card. A missing or unreadable values file means every
  option reads as its declared default, so pick defaults you are content to
  run with unattended (an approval gate should default to asking).
- Fields appear in Settings the moment the plugin is switched on, and vanish
  when it is switched off, with no reload. Nothing in your file is evaluated
  by the settings page, and a file that is not approved at its current hash is
  not even parsed there. Editing the declared options changes the file, so
  that edit needs re-approval like any other.
- Values are stored in plain text, like the rest of `config\`. Do not use
  options for secrets you would not keep in `.storage\`.
- The model never sees options, only whatever your handler chooses to put in
  its result. Use them for decisions that belong to the user, and use tool
  params for decisions that belong to the model.

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


