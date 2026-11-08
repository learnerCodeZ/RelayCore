# RelayCore

[English](README.en.md) · [中文](README.md)

RelayCore is a Windows local-first dual-agent collaboration tool: **Codex plans and reviews, DeepSeek Harness (DSH) executes, and a local bridge daemon persists tasks, dispatch, authorization, review, integration and rollback.** Codex connects through MCP; dispatch happens in the Codex chat, execution records appear natively in DSH's own UI, and the local web console is only for usage accounting and approvals.

**Status: the full chain (MCP → DSH account execution → independent Codex review → integrate/rollback) has been verified repeatedly with real dispatches, including in-flight pause/resume/replay. 164 automated regressions pass. It is a v1 for local, single-user, invited-beta use — full OS isolation, hard spending caps and long-term reliability are still open.** File copies are not an OS sandbox. See [SECURITY.md](SECURITY.md) for the trust model and [docs/使用手册.md](docs/使用手册.md) for the full manual (Chinese).

## Quick start

Prerequisites: Windows 10/11, [Node.js](https://nodejs.org) ≥24.15.0 <25, git, the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) desktop app installed **and signed in**, and a Codex desktop account.

```powershell
git clone https://github.com/learnerCodeZ/RelayCore.git
cd RelayCore
npm install
npm start
```

1. The terminal prints a one-time **console pairing link** (valid 10 minutes); set `RELAYCORE_OPEN=1` to open the browser automatically.
2. In the console's first-time setup form, save the **DSH executable path** and the **DSH account workspace** (a workspace folder you added in DSH). This writes `.RelayCore/bridge/config.json` — no secrets. Restart `npm start`.
3. Run `npm run login:review` once to initialize the independent Codex review login.
4. Register the MCP server in Codex (`~/.codex/config.toml`) — see [docs/codex-mcp-manual-setup.md](docs/codex-mcp-manual-setup.md).

Then: describe a task in the Codex chat → authorize in the console → Codex dispatches → watch the session appear in DSH's sidebar under its task title → integrate or roll back in the console. Details in the [manual](docs/使用手册.md).

## Testing

`npm test` runs the full no-model regression (currently 164 tests). Focused health checks: `npm run check:dispatch`, `npm run check:review`, `npm run check:dsh-account` (all zero-cost), plus `npm run smoke:tasks` and `npm run diagnose:crash`.

## Known limitations

- Model-turn and duration budgets do not cap spending; "unknown cost" consent is an explicit per-task acknowledgement, not a cap. Cancelling does not stop remote billing immediately.
- Candidate copies and git worktrees are isolation helpers, not OS-level sandboxes.
- DSH integration relies on package-internal paths; a DSH upgrade can require a small adapter update.

## License

[MIT](LICENSE)
