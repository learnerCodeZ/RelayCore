# RelayCore

RelayCore is an experimental Windows-first bridge for coordinating a DeepSeek Harness (DSH) execution route with independent Codex review. Codex clients connect through MCP; the local daemon stores task state, approvals, review snapshots, and handoff records.

The implementation includes isolated candidate copies, task revisions, pause/resume, reviewed integration and rollback, a local control interface, usage records, and versioned memory. External execution is disabled by default and requires explicit account configuration and task authorization. Model calls may consume account quota or incur charges; model-turn limits are not monetary limits.

Individual real account diagnostics have succeeded, but the in-flight pause diagnostic stopped before integration and rollback. File copies are not an OS sandbox, and complete isolation, crash recovery, and long-term reliability have not been established. See [Phase 0 feasibility](docs/phase-0-feasibility.md), [Phase 3 status](docs/phase-3-status.md), and the [Chinese README](README.md) for details and current limitations.

## Local setup

Use Windows and Node.js 24.15.0 or a newer Node.js 24.x release. Install locked dependencies in the project directory:

```powershell
npm ci --include=optional --ignore-scripts
npm start
```

The default daemon listens on loopback and does not enable external execution. See the [Chinese README](README.md) for the account configuration, MCP connection, local control, and cleanup instructions. Keep API keys and account credentials out of chat, repository files, diagnostics, and public reports.

Run the model-free test suite with:

```powershell
node --test --test-reporter=tap --test-timeout=12000
```

`local/`, `.RelayCore/`, and `node_modules/` are excluded from Git. Local notes, diagnostic sites, and runtime state require a separate, carefully redacted backup. See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
