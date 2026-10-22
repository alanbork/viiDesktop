# Vii Desktop

**A chat window that does real work on your files.**

Vii feels like a regular chatbot: text first, minimal chrome. But underneath it has native read/write access to the folders you grant, as many or as few as you choose. You describe what you want, the model does the work, and if it got it wrong, you say so and it puts things back.

<img alt="image" src="https://github.com/user-attachments/assets/0816e573-f7a3-46a5-bab4-87db125eb4b6" />


[More screenshots and major milestones →](https://github.com/alanbork/viiDesktop/releases)

---

## Who It's For

Anybody who wants to get real work done with an LLM and not just have an entertaining chat, but doesn't want to get into the overwhelming world of installing a full development environment, and especially anyone who doesn't want to have to decipher every single command line request to decide if it's safe or not. Developers, researchers, writers in markdown, data people, power users. If **Claude Desktop** is too limited for file work but **opencode** is exhausting to supervise, Vii is aimed at you.

---

## The Idea: Chat-First, With Real Edit Power

Vii is not another CLI agent. The foil is opencode: capable, provider-agnostic, but maddening to operate, with the "choice" between allowing everything OR a permission prompt on every action. Vii drops that ceremony by moving safety elsewhere:

- **Permission is a project decision, not a per-edit question.** When the model reaches outside what you've granted, you get one card offering scopes (this turn, this chat, this project, forever) and a deny / approve option you only answer once; the rest of the task runs without asking again.
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

### Dictation support

There is no doubt that telling an agent what to do with your voice is the highest bandwidth approach, and there's also no doubt that LLMs do the best voice-to-text recognition out there. We provide easy access to send your speech to a Whisper-style endpoint and then send it to the agent immediately after transcription. 

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

---

## Under the Hood

Vii is built on Neutralinojs with a WebView2 host: plain HTML/JS, no bundler, no Node at runtime, shipped as a **portable Windows exe**. It's lightweight rather than a bloated Electron app.

---

## Get It

Download the latest exe from [Releases](https://github.com/alanbork/viiDesktop/releases), add your API key, and pick a folder to work in.
