# BearHomeBot Ubuntu Implementation Plan

## 1. Purpose

BearHomeBot is an always-on home automation service that receives requests from
approved Telegram users, asks Codex CLI to interpret and execute those requests,
and uses a reviewed version of `k-skill` for Korean services such as KTX.

The first supported operating environment is Ubuntu. Windows and WSL support are
deferred until the Ubuntu service is stable.

The initial operating constraints are:

- Ubuntu is the only supported runtime.
- Up to five Telegram users may be registered.
- Requests from the same user are processed sequentially.
- Requests from different users may run concurrently within a global worker limit.
- `k-skill` is not included in the BearHomeBot Git repository.
- A candidate `k-skill` release is never activated when any required check fails.
- User credentials are never committed to Git, placed in a Codex prompt, or sent
  through Telegram.
- Payment, e-signature, and other irreversible actions are out of scope unless a
  separate policy explicitly adds them.

## 2. Current State

At the time this document was written:

- The BearHomeBot repository uses `main` and points `origin` to
  `https://github.com/bshsqa/BearHomeBot.git`.
- The local `k-skill` checkout is excluded from BearHomeBot Git and is not a
  submodule or embedded repository.
- The nested `k-skill` checkout is at commit
  `42473dad91ca919fd21d6d8b7fc6dbae3fa48b2c`.
- The Ubuntu bootstrap includes a read-only doctor, TypeScript app skeleton,
  external runtime paths, tests, and install/start/stop scripts.
- The current machine does not yet have rootless Podman installed.
- Codex CLI is installed and supports `codex exec`, JSONL output, structured
  output schemas, and resuming a session by ID.

The existing checkout is only a local reference. Managed releases will always be
materialized from a verified upstream commit without copying local changes or
untracked files.

## 3. Target Architecture

```text
Telegram Bot API
       |
       v
Telegram Gateway
       |
       +---- authenticated principal: Telegram numeric user_id
       |
       v
Per-user Queue and Session Manager
       |
       +---- Codex Runner: exec, resume, JSONL parsing
       |
       v
Capability Broker
       |
       +---- public skill runner
       |
       +---- credentialed skill runner
                  |
                  v
             Secret Broker
                  |
                  v
        encrypted per-user secret vault

Nightly Updater
       |
       v
k-skill candidate -> deterministic checks -> isolated tests -> Codex review
       |
       v
atomic active-release promotion or no change
```

The Telegram identity attached by the gateway is the authority for user
selection. A user ID written by Codex in natural language or generated command
arguments is never treated as authorization.

## 4. Recommended Technology

- Control plane: TypeScript on the current Node.js LTS release
- Persistent state: SQLite
- Service supervision: systemd
- Logs: journald with application-level secret redaction
- Candidate isolation: rootless Podman or an equivalent rootless OCI runtime
- Skill executors: the Node.js and Python helpers shipped by the active
  `k-skill` release
- Telegram transport: long polling, so no inbound public port is required

The application runs natively under systemd. Containers are used to evaluate
untrusted candidate code and, later, to add stronger isolation around
credential-bearing skill execution.

## 5. Filesystem Layout

Production state is kept outside the Git checkout.

```text
/opt/bearhomebot/                         installed application
/etc/bearhomebot/config.toml              non-secret configuration
/etc/bearhomebot/master.key               initial root-owned vault key
/var/lib/bearhomebot/state.sqlite          users, sessions, jobs, releases
/var/lib/bearhomebot/k-skill/mirror.git    upstream Git mirror
/var/lib/bearhomebot/k-skill/releases/     immutable releases by commit SHA
/var/lib/bearhomebot-vault/vault.sqlite    encrypted user credentials
/run/bearhomebot/secret-broker.sock        local broker socket
```

Development-only state belongs under a Git-ignored `.runtime/` directory. No
real credentials are stored there.

## 6. Sequential Implementation Plan

### Phase 0: Record Decisions and Threat Model

Tasks:

- Confirm Ubuntu version, CPU architecture, timezone, and whether the target mini
  PC has TPM 2.0.
- Fix the initial upstream to `https://github.com/NomaDamas/k-skill.git` and the
  allowed branch to `main`.
- Define actions that require explicit user confirmation.
- Define the first supported vertical slice as Telegram plus Codex plus KTX
  search and reservation.
- Define what happens when the machine is asleep or offline at midnight.

Completion criteria:

- The decisions are represented in version-controlled configuration or
  architecture decision records.
- The application timezone is explicitly `Asia/Seoul`.
- A missed nightly run executes once after the next startup.

### Phase 1: Create the BearHomeBot Foundation

Tasks:

- Initialize the BearHomeBot Git repository.
- Add a root `README.md`, `.gitignore`, license decision, and project metadata.
- Exclude the nested `k-skill` checkout and all runtime data from Git.
- Never copy local changes or untracked files from an unmanaged checkout into a
  managed `k-skill` release.
- Add `scripts/install.sh`, `scripts/start.sh`, `scripts/stop.sh`, and
  `scripts/doctor.sh`.
- Make `doctor.sh` check Git, Node.js, npm, Python, Codex CLI, Podman, systemd,
  free disk space, and the configured timezone.
- Add unit-test, lint, type-check, and formatting commands.

Completion criteria:

- A fresh Ubuntu clone can run the doctor command and receive actionable setup
  results.
- No secret, runtime database, Codex session, or `k-skill` checkout can be added
  by a normal `git add .`.

### Phase 2: Implement the Safe k-skill Supply Chain

Tasks:

- Create and maintain a bare upstream mirror outside the project checkout.
- Fetch `origin/main` and resolve the candidate to an exact commit SHA.
- Refuse a changed remote URL, unexpected branch, submodule, path escape,
  oversized file, or non-fast-forward history by default.
- Materialize candidates into immutable release directories.
- Compare the candidate with the active commit and create a machine-readable
  change manifest.
- Check dependency lockfiles and reject unapproved Git or arbitrary URL
  dependencies.
- Install dependencies without lifecycle scripts in an isolated build stage.
- Run dependency advisory scans.
- Run `npm run ci` and BearHomeBot contract tests in a secret-free container.
- Disable network during candidate test execution unless a specific test has a
  documented read-only exception.
- Ask Codex to review only the candidate diff and manifest in a read-only
  sandbox, with no secrets and a required JSON output schema.
- Treat a high-risk Codex finding as a failed gate. A Codex pass never overrides
  a deterministic failure.
- Promote by updating the active commit in one SQLite transaction.
- Keep at least three previous releases and support explicit rollback.

Completion criteria:

- Killing the updater at any point cannot corrupt the active release.
- A failed or uncertain check leaves the active release unchanged.
- Update results include the candidate SHA, each gate result, and a redacted log.
- Running jobs keep their pinned release while new jobs use the newly active
  release.

### Phase 3: Implement Core State and Principals

Tasks:

- Create SQLite migrations for users, Telegram identities, Codex sessions,
  jobs, account locks, releases, and audit events.
- Identify users by Telegram numeric `user_id`, never by username.
- Support `admin`, `member`, and `disabled` roles.
- Add local admin commands for pairing, disabling, and listing users.
- Reject group chats initially and accept only private chats from the allowlist.
- Store user preferences separately from credentials.

Completion criteria:

- An unknown Telegram user cannot create a session or job.
- Disabling a user immediately blocks new work.
- Every request and privileged action has a principal and audit event.

### Phase 4: Implement the Secret Broker

Tasks:

- Create a separate secret vault database owned by a dedicated service account.
- Encrypt every secret value with an authenticated encryption algorithm such as
  AES-256-GCM or XChaCha20-Poly1305.
- Generate a random master key outside the application repository and state
  database.
- Initially load the master key as a root-managed systemd credential or from a
  root-owned file with strict permissions.
- Add master-key versioning so secrets can be rotated without changing their
  external names.
- Expose only allowlisted operations over a Unix domain socket.
- Authenticate local callers and derive the user principal from the trusted
  request context, not from model-generated text.
- Add an import command for `~/.config/k-skill/secrets.env`.
- Import values into one selected BearHomeBot user without deleting or modifying
  the original file.
- Add redaction tests for logs, errors, child-process output, and Telegram
  messages.

Completion criteria:

- The Codex worker account cannot read the vault database, master key, or
  decrypted credentials.
- The application can list which credential names exist without revealing
  values.
- A secret is decrypted only inside the broker for one authorized operation.
- Backup of only the normal state database does not expose credentials.

### Phase 5: Implement the Codex Runner

Tasks:

- Start a new conversation with `codex exec --json`.
- Capture `thread.started.thread_id` and associate it with the authenticated
  BearHomeBot user.
- Continue the conversation with `codex exec resume <session-id>`.
- Make `세션 종료해` close the logical association. The next message creates a
  new session.
- Parse JSONL events and return only approved progress and final-message events
  to Telegram.
- Set a working directory, timeout, output limit, sandbox policy, and cancellation
  behavior for every run.
- Do not include raw secrets in the prompt, stdin, command line, environment, or
  Codex-readable files.
- Store a fixed system context containing BearHomeBot policy, the active
  k-skill release, the authenticated principal's non-secret preferences, and
  supported capability descriptions.

Completion criteria:

- Two users never share a Codex session ID.
- A restarted BearHomeBot can resume stored sessions.
- A timed-out or cancelled Codex process is terminated and recorded cleanly.
- Logs and returned messages contain no secrets.

### Phase 6: Implement the Telegram Gateway

Tasks:

- Store the Telegram bot token in the secret vault.
- Use long polling with idempotent update handling.
- Add commands for health, new session, end session, jobs, job cancellation, and
  user identity display.
- Acknowledge long requests quickly and send progress as edited messages with a
  reasonable rate limit.
- Add duplicate-update protection and per-user request size limits.
- Route administrative messages only to admin principals.

Completion criteria:

- The bot opens no inbound network port.
- Replayed Telegram updates cannot execute the same state-changing action twice.
- Unknown users receive no system details.

### Phase 7: Add the First k-skill Capability

The first capability is KTX because it exercises user credentials, search,
reservation, long-running monitoring, notifications, and account locking.

Tasks:

- Read KTX skill instructions only from the pinned active release.
- Implement typed operations for login check, search, seat check, reservation
  list, reservation creation, and cancellation.
- Keep reservation and cancellation behind an explicit policy and confirmation
  step.
- Allow only Seoul-origin KTX and general-seat filters when those constraints are
  present in the user's request.
- Let the secret broker inject only `KSKILL_KTX_ID` and
  `KSKILL_KTX_PASSWORD` into the KTX helper process.
- Spawn the helper directly without a shell and with a minimal environment.
- Redact the environment and known secret values from all output.
- Write successful outcomes to structured job state and notify the requesting
  Telegram user.

Completion criteria:

- Codex never receives the KTX ID or password.
- User A cannot use or inspect User B's Korail credentials.
- Concurrent operations using the same Korail account are serialized.
- A reservation result includes a stable operation ID for duplicate prevention
  and auditing.

### Phase 8: Add Durable Jobs and Concurrency

Tasks:

- Give each user a FIFO queue.
- Set a configurable global Codex worker limit, initially two.
- Add per-provider and per-account locks.
- Persist long-running monitoring jobs and their stop conditions.
- Pin a k-skill release to each job.
- Recover interrupted jobs conservatively after restart.
- Add backoff, jitter, maximum duration, and external-service rate policies.

Completion criteria:

- Up to five users can submit work without mixing sessions or credentials.
- The same user's conversational requests remain ordered.
- Long-running jobs do not block ordinary status and cancellation commands.
- Restart recovery cannot repeat a completed reservation.

### Phase 9: Add Scheduling and Operations

Tasks:

- Create systemd services for the gateway, worker, secret broker, and updater.
- Create a systemd timer for 00:00 `Asia/Seoul`.
- Add a startup catch-up check for a missed daily update.
- Add health checks for Telegram, Codex authentication, active k-skill release,
  database migrations, disk space, and broker availability.
- Send an admin notification when an update, migration, credential operation, or
  health check fails.
- Document backup and restore procedures.

Completion criteria:

- The service starts after reboot without an interactive terminal.
- A failed nightly update leaves the previous release active.
- Operators can identify the active commit and roll back with one command.

### Phase 10: Security Hardening and Release

Tasks:

- Run the gateway, Codex worker, updater, and secret broker as separate Unix
  service accounts.
- Add restrictive systemd options such as private temporary directories,
  protected system paths, no-new-privileges, and narrowly writable paths.
- Apply full-disk encryption to the production mini PC when practical.
- Move the vault master key to TPM-backed systemd credentials when the target
  hardware supports it.
- Add outbound network restrictions for credentialed skill runners, beginning
  with Korail-only destinations for KTX.
- Add secret rotation, encrypted recovery export, and restore drills.
- Add a release checklist and a clean-Ubuntu installation test.

Completion criteria:

- A Codex or Telegram worker compromise does not directly reveal the vault.
- A copied state database, Git repository, or ordinary backup contains no
  plaintext credentials.
- The documented restore path works on a second Ubuntu machine.

## 7. Secret Storage Decision

### 7.1 Current secrets.env

The existing `~/.config/k-skill/secrets.env` is outside the repository and is a
documented k-skill fallback. With mode `0600`, it is a reasonable baseline for
one user manually invoking trusted local scripts.

It is not the preferred production store for BearHomeBot because:

- BearHomeBot serves multiple users.
- Codex executes tools and can read files available to its Unix account.
- The service runs unattended.
- Candidate and active `k-skill` code executes on behalf of the service.
- Plain dotenv files are easy to include accidentally in support bundles,
  backups, shell output, or debugging sessions.
- A shared file makes account separation and credential rotation harder.

### 7.2 What encryption does and does not protect

Application-level encryption is useful when the ciphertext database and the
master key are separated. It protects against accidental database disclosure,
ordinary backup leakage, and some cross-service file access.

Encryption does not protect a secret from an attacker who controls the running
secret broker, root account, kernel, or an already-unlocked host. If the
decryption key is stored next to the encrypted database with the same owner and
permissions, the added protection is limited.

Full-disk encryption and application-level encryption address different risks:

- Full-disk encryption protects data on a powered-off lost or stolen disk.
- Application encryption protects a copied vault database or backup.
- Process and account isolation prevents Codex and ordinary workers from reading
  the vault directly.
- Just-in-time injection reduces how long plaintext exists and where it appears.

All four layers are useful; encryption alone is not the security boundary.

### 7.3 Recommended BearHomeBot flow

```text
encrypted vault
      |
      | authorized operation with trusted user principal
      v
Secret Broker decrypts in memory
      |
      | minimal child environment, direct exec, no shell
      v
pinned k-skill helper
      |
      v
redacted structured result returned to Codex and Telegram
```

Codex must not perform the decryption and must not receive the plaintext value.
Codex decides that an operation is needed; BearHomeBot validates the operation
and principal; the Secret Broker performs the credentialed execution.

Environment variables are retained only because current k-skill credentialed
helpers expect them. They are injected into the helper child process, never the
Codex process. Longer term, file descriptors or a narrow local API may replace
environment variables where helpers support it.

### 7.4 Initial key-management level

For the first production-capable version:

- Encrypt vault entries with authenticated encryption.
- Keep the vault database under a dedicated service account.
- Keep the master key out of the repository and out of the vault database.
- Supply the key to the broker through a root-managed systemd credential or a
  root-owned key file inaccessible to the Codex worker.
- Recommend LUKS full-disk encryption on the target mini PC.

After the target hardware is known:

- Prefer TPM-backed systemd credentials for unattended startup.
- Maintain a separately stored recovery method.
- Treat recovery-key loss as potential credential loss and make re-entry of
  external service credentials an acceptable fallback.

### 7.5 Migration from secrets.env

The migration command should:

1. Verify that the source file is owned by the invoking user and has mode `0600`.
2. Parse dotenv values without printing them.
3. Ask which BearHomeBot user owns the credentials.
4. Encrypt and write each supported value to the vault.
5. Verify credential presence by name and optionally run a read-only login test.
6. Leave the original file untouched.
7. Tell the administrator how to archive or remove the original after manual
   verification.

Automatic deletion is intentionally excluded from the importer.

## 8. Current Bootstrap Batch

The initial implementation batch contains:

- A real BearHomeBot Git repository.
- A root `.gitignore` that excludes `k-skill`, `.runtime`, databases, secrets,
  Codex state, and logs.
- A minimal TypeScript application with tests.
- `install.sh` and `doctor.sh` for Ubuntu.
- A runtime path module that never stores production state in the checkout.

The next Phase 2 batch adds a `k-skill` release model containing upstream URL,
commit SHA, status, and active flag, plus a read-only command that reports the
latest upstream SHA without installing or promoting it.

After the read-only upstream check, the next implementation batch builds the
isolated candidate validation and atomic promotion path. The Secret Broker must
be implemented before the first real KTX credential is imported.

## 9. First Milestone

Milestone 1 is complete when a clean Ubuntu machine can:

1. Clone BearHomeBot.
2. Run the installer and doctor.
3. Fetch a candidate `k-skill` commit.
4. Validate it without access to secrets.
5. Promote or reject it atomically.
6. Report the active commit and roll back to the previous commit.

Telegram, Codex conversations, and KTX credentials begin only after this
milestone is reliable.

## 10. References

- k-skill security policy:
  `k-skill/docs/security-and-secrets.md`
- Codex non-interactive mode:
  `https://learn.chatgpt.com/docs/non-interactive-mode`
- Ubuntu full-disk encryption:
  `https://documentation.ubuntu.com/security/security-features/storage/encryption-full-disk/`
- Linux process environment visibility:
  `https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html`
