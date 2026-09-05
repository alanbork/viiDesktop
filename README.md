# Vii Desktop — Project Overview

## Mission

Vii is a desktop chat window that does real work on your files.

It feels like a regular chatbot window: one thread, minimal chrome, typed or spoken text. But underneath it has native read/write access to the folders you grant - as many or as few as you choose. You describe what you want; files change on disk; if the model got it wrong, you say so and it puts them back.

<img width="1920" height="1008" alt="image" src="https://github.com/user-attachments/assets/5421a6cd-8a2e-459f-8803-069484f5b07a" />


## Who It's For

People who already hold an LLM API key and are tired of terminals. Developers, researchers, writers who live in markdown, data people, power users — anyone who finds Claude Desktop too limited for file work, but opencode exhausting to supervise. Vii does not try to onboard users who have never seen an API key; it is a DIY project with no hosted tier, and the audience is chosen honestly to match.

## Guiding Goal

**Stay chat-first, with real edit power.**

Vii is not another CLI agent. The foil is opencode: capable, provider-agnostic, and maddening to operate — allow everything OR a permission prompt on every action, a shell command to evaluate every three seconds. Vii rejects that whole ceremony, not by being reckless, but by moving the safety somewhere else:

- **Permission is a scope decision, not a per-edit question.** You decide once what the model may touch and how far it may go; you are never asked again mid-task.
- **The agent has no shell.** It works through a fixed set of typed tools. You never have to judge whether a command is safe, because there is no command.
- **Every write is backed up first.** The worst thing the model can do is a bad edit.

## Positioning

| | Claude Desktop | opencode | Vii |
| :--- | :--- | :--- | :--- |
| Interaction | Chat, voice | Terminal, slash commands | Chat, voice |
| File access | None/MCP soup | Full, via shell | Full, when you want it |
| Safety model | n/a | Approve each action or trust everything | Scope grants + mode ceiling + backup |
| Undo | n/a | `/undo`, requires git repo | Automatic backup, no git, conversational restore |
| Provider | Anthropic only | Any | Any OpenAI-compatible endpoint, plus Gemini |
| Shell for the agent | No | Yes | Never |

## Core Pillars

### 1. Mode Ceiling — Chat / Plan / Act

| Mode | Indicator | Capabilities |
| :--- | :--- | :--- |
| **Chat** | 💬 Gray | Conversation only. File tools are omitted from the model loop entirely. |
| **Plan** | 🔵 Blue | Read-only. Inspect, search, and plan; no disk mutation. |
| **Act** | 🟠 Orange | Full read/write within granted directories. |

The mode is a hard ceiling, enforced before permissions. Switch via the composer dropdown, a project default, or three mode words (`/chat`, `/plan`, `/act`) — the only command vocabulary in the app, and even those have a dropdown.

### 2. Scoped Grants

Directory access is granted at one of four scopes: **Once** (single operation), **This Chat** (dies with the conversation), **Project** (inherited by every chat under it), **Global** (Settings). With decently clever agents, just give full read / write access scoped to project and other work folders and occasionally choose to undo things you didn't like. Or for less capable agents, scope exactly which files they can read and write.


### 3. No Shell for the Agent

The model's entire capability is the native toolset below. There is no `execute`, no `bash`, no escape hatch. A `!` prefix lets the *user* run a shell command from the composer; the agent is never given this ability, by design and permanently.

### 4. Automatic Backup and Conversational Restore

- Every write tool (`edit_file`, `write_file`) mirrors the pre-edit file into `.agentbackup\` under the workspace root (path configurable) before the write lands.
- The backup directory is readable by the agent so it can reason about how the code has changed when needed.
- Restore is conversational and needs no dedicated tool: "put that back" → the model reads the backup and writes it over the original. Because that write is itself backed up, restore is reversible — you can redo or any mixture in between.
- The store is bounded by a per-folder soft cap (default 50 MB) with LRU pruning. **Prune never touches a backup written in the current session.**
- On by default. No commit step, no git, no setup.

## Native Toolset

| Tool | Class | Summary |
| :--- | :--- | :--- |
| `read_file_safe` | read | Size-aware read with head/tail windowing and truncation. |
| `read_lines` | read | 1-indexed inclusive line-range read. |
| `list_files` | read | Non-recursive listing, optional wildcard, mtimes. |
| `fgrep` | read | Literal multi-needle search, bounded context. |
| `grep` | read | Regex search with `i`/`g`/`m`, bounded context. |
| `edit_file` | write | Single unique-string replacement; fails loudly on ambiguity. |
| `write_file` | write | Create or overwrite; preferred for new files and large rewrites. |

## Current State

- Native tool loop with backup-on-write, delivered and in daily use.
- Mode and skill engine: dynamic prompt composition, `/chat` `/plan` `/act` triggers, `{[mode=...]}` machine tokens, sticky mode across turns.
- Projects and sessions: hierarchical tree, per-project directory bindings and default mode, inline rename, inspectable details dialogs.
- Voice input via Web Speech API (`Ctrl+D`), live feedback.
- Multi-model routing: per-chat model switch, thinking toggle honoring mandatory flags, effort values from OpenRouter catalog.
- Stream-tolerant markdown (`md.js`); auto-scroll yields to the reader and reacquires via jump-to-latest.
- Single Windows binary (lightweight Neutralinojs, not a bloated electron app).

