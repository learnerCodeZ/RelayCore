# Contributing

RelayCore is under active development. Read the [README](README.md), relevant files in [docs](docs/), and applicable `AGENTS.md` instructions before changing behavior. Keep changes focused and preserve existing local work.

## Setup and verification

Use Windows with Node.js 24.15.0 or a newer Node.js 24.x release. Install locked dependencies with `npm ci --include=optional --ignore-scripts`. Start with the narrowest relevant tests and then run the model-free suite:

```powershell
node --test --test-reporter=tap --test-timeout=12000
```

Report actual results, skipped cases, and failures; do not treat a historical test count as the current acceptance threshold. Tests using fake adapters do not establish real account behavior. A timed-out or interrupted run is not a pass.

Real DSH or Codex calls can consume quota or incur fees. Run them only within the user's explicit authorization, state the purpose, maximum prompt count, and duration beforehand, and do not automatically retry a failed paid diagnostic. Never paste or copy account credentials into tests or reports.

## Files and safety

Keep necessary shared documentation in `docs/`. `local/` contains local notes and diagnostic evidence and must not enter the repository; `.RelayCore/` contains private runtime state. Do not include either directory or `node_modules/` in commits. Preserve existing evidence and avoid changing the DSH installation, weakening ACP validation, or touching unrelated running daemons.

Changes to authorization, integration, recovery, or file boundaries need tests for the relevant failure paths. Follow [SECURITY.md](SECURITY.md) when handling potentially sensitive findings.
