# BearHomeBot repository guidance

## Runtime Model

BearHomeBot is a lightweight Telegram gateway for the local Codex CLI.
Authenticated Telegram text is passed to Codex unchanged. Codex runs from this
repository root with unrestricted host access and no interactive approvals.

Read `README.md` and `docs/implementation-plan.md` before substantial project
work.

## k-skill

The full upstream k-skill checkout lives at `k-skill/` inside this workspace and
is intentionally excluded from BearHomeBot Git.

For every user request that may match a Korean service or asks what k-skill can
do:

1. Search `k-skill/` for relevant `SKILL.md` files.
2. Read the selected `SKILL.md` completely before acting.
3. Treat paths such as `scripts/ktx_booking.py` as relative to the checkout root,
   never to the individual skill directory. Verify a helper with `rg --files
   k-skill` before reporting or executing it, then run the command from
   `k-skill/`.
4. Install missing runtime dependencies when needed. For Python on externally
   managed systems, create and reuse a virtual environment under an ignored
   local directory.
5. Follow the skill's workflow and stop conditions. If no skill applies, handle
   the request as ordinary Codex work.

Credential-bearing skills may use `~/.config/k-skill/secrets.env` according to
their documented credential resolution order. Load only the variables required
for the requested helper. Never print secret values in commands, logs, or the
Telegram-facing answer.

## Telegram Sessions

- Preserve `/newsession`, `/sessions`, `/renamesession`, `/endsession`, and
  `/cancel` behavior.
- Keep `/features` as a static Telegram browsing menu. It must not decide which
  skill Codex may execute or rewrite ordinary user requests.
- Keep session ownership bound to the Telegram numeric user ID.
- Do not store duplicate prompt or response transcripts in BearHomeBot SQLite.
- Let Codex own thread context and compaction.
- Do not add keyword routing, generated capability catalogs, or prompt wrappers
  around ordinary Telegram text.

## Host Operation

- Only one computer may long-poll the family Telegram bot token at a time.
- The Telegram allowlist is the primary trust boundary. Every allowed user has
  effective local Codex and shell authority on the host.
- Keep Telegram configuration, credentials, SQLite, `.runtime`, `k-skill/`, and
  Codex state out of BearHomeBot Git.
- Run `npm run ci` for code changes.
- Leave handoff work in a pushed commit rather than a host-local stash.
