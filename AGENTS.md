# AGENTS.md

This file provides guidance to Codex when working with code in this repository. It mirrors CLAUDE.md; keep the two in sync.

## What this is

A local "AI collaboration bridge". One long-running Node daemon exposes an MCP server over Streamable HTTP, plus a web panel. AI agents in different desktop products (Claude desktop's Code tab, and Codex inside the ChatGPT Windows app; later Gemini, Antigravity and DeepSeek) use it to hand work to each other through a role pipeline that has human approval gates. Work travels as **mail**, and a **postman** wakes idle agents with product-specific **doorbells** instead of having them poll.

The design docs are in Chinese. `docs/ARCHITECTURE-v2.md` is the current architecture: the postman, the borrowed designs, and the S1/S2 spike results. `docs/DESIGN.md` covers the original goals and decisions. Read them before changing behaviour. The user communicates in Chinese, and the agent-facing tool text and the panel are in Chinese too. How to use the bridge: `docs/USAGE.md`.

Stage: M2b (postman) and M2b.1 are done, and the bridge ships as an installable package (0.3, `ai-bridge` CLI). Next is M2c: a meeting engine, a task DAG, file leases, and per-task commits. After that comes M2d: the panel from the roundtable/board prototype. Treat `src/m0/` and `spikes/` as records. Don't extend them.

## Commands

```
npm start -- --project <dir> [--port 7878]   # dev: run the daemon from src via tsx (MCP /mcp, panel /, JSON API /api/*)
npm run smoke       # end-to-end regression: own daemon on port 7891, temp git repo, fake Claude pipe, fake Codex transcripts
npm run typecheck
npm run build       # tsc -p tsconfig.build.json → dist/ (src/m0 excluded)
npm run reinstall   # npm pack into release/ → npm i -g → ai-bridge setup --refresh → ai-bridge doctor (local tree)
ai-bridge update    # install github:vwow521-dotcom/Interaction-ai#main globally → setup --refresh → doctor
npm run cli -- <cmd> [--dry-run]   # run the CLI from this tree (setup/uninstall/init/start/doctor)
```

**The user's Claude and Codex point at the globally installed copy** (`%APPDATA%\npm\node_modules\ai-bridge`), not at this tree. After changing `bin/` or `src/`, run `npm run reinstall` so the clients pick it up; once pushed, `ai-bridge update` installs from GitHub. `prepare` builds and writes `dist/build-info.json` (commit), which `doctor` compares with GitHub main. `setup --refresh` (used by both) only touches bridge entries that already exist: the user removed Codex's bridge entry on purpose, so never re-add a client they removed. `npm run cli -- setup` would point the clients at this dev tree instead. Testing `setup`/`uninstall` against copied config files is not isolated: they also clean `.codex/hooks.json` in the real project folders listed in the config. Use `--dry-run`.

Extend `scripts/smoke.ts` whenever you change engine, proxy or hook behaviour.

## Architecture

- **Mail is the only way work reaches an agent.** `Engine.sendMail` → `mail` table (one row per recipient, `id` primary key = dedupe) → `kick(agent)` wakes a `wait_for_mail` poller and/or rings an open doorbell. Status flow: `queued → rung → fetched → acked`, plus `stuck` (gave up after `mail.max_rings`; the human is told to wake the agent) and `void` (a task that was stopped or replaced). `sweep()` runs every 5 s, re-rings mail that is rung but not fetched, and flags overdue acks.
- **Tasks:** a run is one goal. Each stage handed to an agent is an **attempt** (`ready → in_progress → (awaiting_approval → approved|rejected) | done`) and gets a `task` mail. `fetch_inbox` turns a task mail into the turn payload and moves the attempt to `in_progress`. `submit_handoff` commits, acks the task mail and advances. A rejection creates a new attempt of `on_reject` with structured `feedback` (`Feedback` in store.ts: user_requirements / blocking / observations); when that rework attempt finishes, its feedback is carried (`kind: "carried"`) into the next stage. Reviews with no file changes still commit (`--allow-empty`, `git.commit_reviews`). `ask_human` doesn't block; the answer arrives as an `answer` mail. Only one open run exists at a time.
- **Doorbells** (`doorbellKind`: config `agents.<id>.doorbell`, `auto` = whatever registers, else `poll`). Both kinds long-poll `GET /api/doorbell/wait`:
  - `bin/bridge-mcp.mjs`: a stdio MCP proxy that Claude launches. It forwards every call to the daemon. It injects `_doorbell: "claude-socket"` into `join`. Then it writes `{"type":"auth"}` + `{"type":"user"}` NDJSON frames to the inherited `CLAUDE_CODE_MESSAGING_SOCKET` (a Windows named pipe) when rung. This is an undocumented Claude internal: a failure gets reported to `/api/doorbell/result` and the mail is requeued.
  - `bin/codex-stop-hook.mjs`: a Codex Stop hook. It parks only if the session transcript shows a completed `bridge.join` `McpToolCall`; otherwise it returns `{}` immediately. When rung it outputs `{"decision":"block","reason":…}`. When a park window passes with no mail it sends a heartbeat block. It rides out a bridge restart (retries for `BRIDGE_DOWN_GRACE_SECONDS`, default 90) before giving up. While it is parked, Codex queues the user's typing (the hook gets no signal), so pressing Stop releases it.
- **Durable vs in-memory:** runs, attempts, handoffs, mail, notes, questions, events and Codex threads are in `<project>/.bridge/bridge.db` (`store.ts`, `node:sqlite`). Presence, identity bindings, doorbell waiters and blocked waits are in memory. After a restart agents re-`join`, and `resendLiveTask` re-mails a live task.
- **Identity binding:** each agent_id is bound to one MCP session (`bindingError`). A second session can only take it with `join(takeover=true)`, or after the human presses 释放 on the panel (`release`) or the agent calls `leave`. The proxy replays join with `takeover` after the daemon restarts.
- `daemon.ts`: HTTP, MCP transports, the JSON API and SSE `/api/stream` (a "change" ping). The panel (`panel.ts`) re-fetches `/api/state` and rebuilds only when the JSON differs. `notify.ts` shows Windows toasts through PowerShell/WinRT; `BRIDGE_NOTIFY=0` disables them.
- `git.ts`: `submit_handoff` runs `git add -A` and commits. Before that, `changedFiles` is compared with `files_changed` and with other stages' `owns` globs; mismatches become `scope_notes` (shown on the approval card, not blocking). `.bridge/` writes its own `.gitignore`. Parallel tasks in M2c must switch to committing only leased/declared files.
- `cli.ts` → `ai-bridge` (`bin/ai-bridge.mjs` imports `dist/cli.js`): `setup` writes `~/.claude.json` `mcpServers.bridge` and `~/.codex/config.toml` `[mcp_servers.bridge]` (both: absolute node + installed `bin/bridge-mcp.mjs`), and a **user-level** `~/.codex/hooks.json` Stop hook. It also removes legacy project-level copies for every `[projects.'…']` in Codex's config. It only replaces entries it recognises as the bridge's and backs up every file first. `uninstall` reverses all of it. `doctor` checks paths, hook trust (`[hooks.state.'<hooks.json>:stop:…']`), legacy hooks, proxy and daemon.
- `config.ts`: `<project>/bridge.config.yaml`, validated with zod. `DEFAULT_CONFIG_YAML` must stay in sync with `bridge.config.example.yaml`.
- `AGENTS.md` mirrors this file for Codex; update both together.
