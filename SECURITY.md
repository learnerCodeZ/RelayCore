# Security

RelayCore is experimental. It is designed for a local single-user Windows environment, not as a security boundary against other processes running under the same account. Phase 0's isolation acceptance is not complete; do not assume that a candidate copy, Git worktree, prompt instruction, or file hash is an OS sandbox.

## Boundaries

- The daemon listens on loopback. Its control token is protected with Windows DPAPI under the current user when no explicit token is supplied. DPAPI does not protect that token from other processes running as the same user.
- The local `/ui`, `/usage`, and console action endpoint do not require a Bearer token or authenticate a Windows user. HTTP Host must be `127.0.0.1` or `localhost` with the actual listening port; browser actions also check origin and fetch metadata. These checks do not prevent other processes or users with loopback access from reading or operating the console, and are not equivalent to DPAPI-protected CLI authentication. Do not expose the daemon beyond the intended local host.
- External execution is disabled by default. Enabling an execution route does not authorize a task: local authorization binds the task contract and limits. Unknown-cost execution requires explicit consent, and E2 tasks require L3 approval.
- DSH ACP uses a console shim and strict JSON-RPC validation. The DSH process may access its own account login; RelayCore should not copy or disclose account credential contents. Do not weaken validation or modify the DSH installation to work around protocol errors.
- Candidate changes require independent review and explicit integration. Files can change between checks, and filesystem writes and SQLite records are not one cross-resource transaction. A cancelled or timed-out local task does not prove remote execution has stopped.
- Model-turn and duration limits are not a hard cap on money or tokens. Real model tests can consume account quota or incur costs.

## Credentials and diagnostics

Never place API keys, account credentials, control tokens, session exports, or private project contents in Git, issue reports, public logs, or screenshots. `.RelayCore/` and `local/` are ignored by Git, but they may still contain sensitive state; inspect and redact any material before sharing or backing it up.

## Reporting a vulnerability

Avoid posting exploitable details or credentials in a public issue. Use GitHub's private vulnerability reporting for this repository if it is available, or contact the maintainer privately to agree on a safe reporting channel. No security email address or response-time commitment is specified here.
