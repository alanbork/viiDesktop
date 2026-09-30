# Vii Desktop

**A chat window that does real work on your files.**

Vii feels like a regular chatbot: text first, minimal chrome. But underneath it has native read/write access to the folders you grant, as many or as few as you choose. You describe what you want, the model does the work, and if it got it wrong, you say so and it puts things back.

<img width="1920" height="1008" alt="Vii Desktop screenshot" src="https://github.com/user-attachments/assets/3f8f5733-04ff-4659-8982-cadc27173f10" />

[Visual changelog →](https://github.com/alanbork/viiDesktop/wiki/Visual-changelog)

---

## Who It's For

People who already hold an LLM API key and are tired of terminals: developers, researchers, writers in markdown, data people, power users. If **Claude Desktop** is too limited for file work but **opencode** is exhausting to supervise, Vii is aimed at you.

It's a DIY project with no hosted tier and no onboarding for people who've never seen an API key. The audience is chosen honestly to match.

---

## The Idea: Chat-First, With Real Edit Power

Vii is not another CLI agent. The foil is opencode: capable, provider-agnostic, and maddening to operate, with a choice between allowing everything and a permission prompt on every action. Vii drops that ceremony by moving safety elsewhere:

- **Permission is a scope decision, not a per-edit question.** When the model reaches outside what you've granted, you get one card offering scopes (this turn, this chat, this project, forever) with a matching deny at each. Answer once; the rest of the task runs without asking again.
- **The agent has no shell.** It works through a fixed set of typed tools, so you never have to judge whether a command is safe. There is no command.
- **Every write is backed up first.** The worst the model can do is a bad edit, and you can recover from it.

| | Claude Desktop | opencode | Vii |
| :--- | :--- | :--- | :--- |
| Interaction | Chat, voice | Terminal, slash commands | Chat |
| File access | None / MCP soup | Full, via shell | Full, when you want it |
| Safety model | n/a | Approve each action or trust everything | Scope grants + mode ceiling + backup |
| Undo | n/a | `/undo`, needs git | Automatic backup, no git needed |
| Provider | Anthropic only | Any | Any OpenAI-compatible endpoint, plus Gemini |
| Shell for the agent | No | Yes | Never |
| Install | Desktop installer | Node + CLI | One Windows exe, nothing to install |

---

## How It Keeps You in Control

### Three modes, one hard ceiling

| Mode | What it means |
| :--- | :--- |
| 💬 **Chat** | No filesystem at all. |
| 🔵 **Plan** | Read-only. Inspect, search, and plan, but no writes. |
| 🟠 **Act** | Full read/write within the folders you've granted. |

Switch from the composer, set a default per project, or type `/chat`, `/plan`, `/act`. The mode is a hard ceiling: nothing the model says or tries can exceed it.

### Grants you can see

Access is deny-by-default. Grant it for a single turn, a chat, a project, or globally, and every level has a matching deny. Each project's workspace folder is implicitly open to that project's chats. A permissions view in every chat and project dialog shows exactly what the model can reach and where each grant came from, so you can revoke it at the source.

A practical rule: with a capable model, give full read/write to your project and work folders and occasionally undo something you didn't like. With a weaker model, scope it to exactly the files it should touch.

### No shell, ever

The model's entire capability is a small set of typed tools: read, search, list, edit, write. If a model reaches for `bash` or `powershell`, it's told plainly that there's no shell here. The app can launch things (open a file, open Explorer, run a script), but only when *you* click it.

### Backups without git

Before any write, Vii saves a copy of the original file into a plain backup folder right beside it. There are no special tools, no commit step, and no setup. It's just files on disk that you can open yourself, and the agent can read them too, so it can reason about what changed.

- **Undo is conversational.** Say "put that back" and it does.
- **Or use the button.** Chat details lists every backed-up file, previews the diff, and restores (or un-restores) in a click.
- **Managed for you.** The backup folder is pruned automatically when it grows too large, and never touches backups from your current chat. Nothing to clean up. On by default, and you can turn it off.

---

## Extend It With Plugins

Plugins live in a folder, one `.js` file per plugin. Each one registers a tool for the model and can optionally draw a card in the chat. No build step, no framework.

Plugin tools sit behind the same mode ceiling, permissions, and backups as built-in ones. Each plugin must be approved by you, and if the file changes, it needs approval again. Plugins run with the app's full privileges, so treat them like any program you install.

Three samples ship with the app:

- **proofreader**: inline edit suggestions you accept or reject in the card
- **ask_user**: the model asks you a multiple-choice question and waits for your answer
- **clickable_lines**: lists with per-row copy and click-to-send

---

## What You Get Today

- **A Files tab that doubles as a featherweight IDE.** Browse the workspace, open files in your editor of choice, and run scripts in a visible terminal, all with a click.
- Projects and chats with a sidebar tree, a workspace folder per project, pinning, archiving, and bulk cleanup
- An optional `AGENTS.md` in a project is automatically included at the start of the first turn
- Any OpenAI-compatible endpoint plus Gemini, with per-chat model switching, a thinking toggle, and effort levels
- Token and cost tracking per turn and per chat, with a warning when uncached input runs hot
- Auto-continue when a response is cut off by the output limit (off by default)
- Readable diagnostics: per-chat wire log, tool-use audit trail, and an in-app info panel
- Dark, light, and system themes, and a full hotkey table in Settings

**Known limitation:** voice input (`Ctrl+D`) is wired up but inert in the current build, because WebView2 doesn't provide speech recognition. It will work in any runtime that does.

---

## Under the Hood

Vii is built on Neutralinojs with a WebView2 host: plain HTML/JS, no bundler, no Node at runtime, shipped as a **portable Windows exe**. It's lightweight rather than a bloated Electron app.

---

## Get It

Download the latest exe from [Releases](https://github.com/alanbork/viiDesktop/releases), add your API key, and pick a folder to work in.
