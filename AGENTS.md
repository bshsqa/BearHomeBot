# BearHomeBot repository guidance

## Start Here

Before substantial work, read:

- `README.md`
- `docs/implementation-plan.md`
- `docs/security-model.md`
- `docs/host-transition.md`

Use the repository and those documents as the durable project context. Local
Codex threads, Telegram sessions, credentials, databases, and runtime releases
are host-local and are not project state.

## Host Safety

- Only one computer may run the family Telegram bot gateway at a time.
- Do not start `scripts/start-telegram.sh` unless the user has identified this
  computer as the active Telegram host.
- A host transition uses a fresh local Codex login, Telegram configuration,
  BearHomeBot database, and sessions unless the user explicitly requests a
  separately designed migration.
- Never commit or copy credentials, `.env` files, `~/.codex`, BearHomeBot
  SQLite files, `.runtime`, or downloaded `k-skill` content through Git.
- Follow `docs/host-transition.md` when moving development or Telegram service
  activity between computers.

## Verification

- Run `npm run ci` for code changes.
- Keep runtime and secret paths outside the Git checkout.
- Before a handoff, leave work in a pushed commit. Use a pushed topic branch
  for incomplete work instead of relying on a local stash.
