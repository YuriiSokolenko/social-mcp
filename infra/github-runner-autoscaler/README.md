# GitHub runner autoscaler

This directory runs the N150 GitHub Actions runner stack: two independent
autoscaled pools plus one dedicated persistent control-plane runner. Each
autoscaled pool has its own manager instance (see `compose.yaml`) so one
pool's stuck loop can never block the other's:

- **`pi-runner-manager`** (pool label `pi-agent`) watches queued runs of
  `.github/workflows/pi-issue-agent.yml`, `.github/workflows/pi-pr-review.yml`,
  `.github/workflows/pi-pr-fix.yml`, `.github/workflows/pi-dispatcher.yml`,
  `.github/workflows/pi-architect.yml`, and `.github/workflows/pi-triage.yml` --
  jobs that call the Pi/LLM agent, gated by `MODEL_STATUS_URL` capacity.
- **`general-runner-manager`** (pool label `general`) watches queued runs of
  every workflow with a job on the `general` label: `.github/workflows/ci.yml`,
  `pi-auto-merge.yml`, `pi-automation-control.yml`, `pi-pr-review.yml`'s gate
  job (its review job stays on `pi-agent`), `pi-reconcile.yml`,
  and `pi-usage.yml` -- none of these call the Pi/LLM agent, so this pool has
  no model gate; `MAX_RUNNERS` is the only cap. **This list must stay in sync
  with `GENERAL_WORKFLOW_FILES`** (`compose.yaml`'s default / the host's
  `.env`): a workflow file moved onto the `general` label but left out of that
  list queues forever with nothing watching it -- check
  `grep -rl 'n150, *general' .github/workflows/` when adding one.
- **`control-runner`** (labels `n150,control`) is one persistent lightweight
  runner for short orchestration jobs such as `CI Terminal Wake`. It is not
  autoscaled, does not join either heavy pool, and therefore remains available
  while `n150/general` is saturated.


Each autoscaled pool keeps up to its own `MAX_RUNNERS` ephemeral self-hosted
runner containers alive. Each worker registers with GitHub using `--ephemeral`,
accepts one job, and is removed after the job. Running each CI job on its own
disposable runner is also what lets several queued runs execute in parallel.

The control lane is deliberately different: exactly one persistent runner
container executes at most one job at a time. `CI Terminal Wake` must request
exactly `[self-hosted, n150, control]`. Every other self-hosted N150 workflow
must require a pool-specific label such as `general` or `pi-agent`; a bare
`self-hosted`/`n150` selector would also match the control runner and is
blocked by the workflow contract test.

## Security model

The manager needs access to the Docker socket and a GitHub token capable of creating
and deleting repository self-hosted runners. Keep that token only in the local
`.env` file on the N150 host and never commit it.

For a fine-grained personal access token, grant this repository:

- Administration: Read and write
- Actions: Read

The N150 Pi configuration is mounted read-only at `/pi-config-ro` and copied into each ephemeral worker's private writable `/home/runner/.pi/agent` directory at startup, only for the `pi-agent` pool (`MOUNT_PI_CONFIG=true`). This avoids Pi lock-file errors and prevents parallel workers from sharing mutable Pi state. Because the manager controls the host Docker daemon through `/var/run/docker.sock`, the source configured by `PI_HOME_HOST` must be a real host path.

The persistent `control-runner` is intentionally constrained. Its image is
built from `node:24-bookworm-slim` (Debian/glibc), contains only the GitHub
Actions runner plus Git, Node.js, curl, jq, and runtime libraries, and has no
Docker CLI/socket, Pi configuration, model endpoint, Android SDK, or build
toolchain. Compose caps it at 1 CPU, 1 GiB RAM, and 512 PIDs, drops the
default Linux capability set, and adds back only `SETUID`, `SETGID`, and
`KILL`. `SETUID`/`SETGID` let PID 1 launch the unprivileged runner; `KILL`
is required so root PID 1 can signal and reap the uid 1001 runner process group
during graceful stop/recreate. The container also enables
`no-new-privileges`. The entrypoint uses the repository administration token
only for first-time registration and
bounded post-failure recovery; the long-lived Actions runner and all workflow
jobs run as the unprivileged `runner` user with `GH_ADMIN_TOKEN` removed from
their environment. Normal Docker/host stops do not deregister the runner.

The complete runner root at `/home/runner/actions-runner` is backed by the
named volume `CONTROL_RUNNER_STATE_VOLUME` (default
`social-mcp-control-runner-state`). Registration files, the repair-cooldown
marker, work/update state, and any self-updated runner binaries therefore
survive container restart, `--force-recreate`, and normal Compose down/up.
The image also keeps its verified bootstrap package at
`/opt/actions-runner-baseline` outside that volume. On startup, if the
persisted runtime is missing/corrupt or older than the image baseline, the
entrypoint restores only the runner package from that baseline while keeping
registration/cooldown state.

The entrypoint runs `bin/Runner.Listener run` directly instead of routing
through GitHub's `run.sh` / `run-helper.sh`. The upstream wrapper maps
listener exit codes such as terminated error (1) and session conflict (5) to
success; direct execution preserves those codes while the entrypoint explicitly
keeps the upstream retry/update/config-refresh behavior.

Credential/session recovery is deliberately conservative. The first exit 1 or
5 retries with the existing credentials, which lets a transient session
conflict after Docker restart expire naturally. Only a repeated 1/5 failure
can attempt `config.sh --replace`, and only when the repository runners API is
healthy and the persisted repair cooldown has expired. A failed cooldown write
or failed credential cleanup is non-destructive. Version-deprecated exit 7 and
unknown failures never re-register; exit 6 has a short retry delay rather than
a hot loop.

Startup requires both non-empty `.runner` and `.credentials`; a half-written
registration is cleared before `config.sh` runs. First-time `config.sh` and
`Runner.Listener` each run in their own process group. Docker TERM makes PID 1
signal and wait for the whole active process group, avoiding orphaned
registration/listener children. Failed or interrupted registration clears
partial local state. Retry/cooldown sleeps are interruptible.

GitHub self-update remains enabled. Upstream `update.sh` waits for
`Runner.Listener` to exit, switches the versioned `bin`/`externals`
symlinks, and writes `update.finished`. The entrypoint keeps the same 31-second
normal update wait as upstream, probes the updated listener after a confirmed
`update.finished`, and restores the image baseline only if that completed
runtime cannot answer `--version`. During Docker shutdown it waits up to
`CONTROL_UPDATE_SHUTDOWN_WAIT_SECONDS` (default 90s) for an in-flight update;
Compose gives the container a 120-second stop grace period.

The `general` pool instead sets `MOUNT_DOCKER_SOCKET=true`: its worker image
(`worker-general.Dockerfile`) starts directly from the public
`node:24-bookworm-slim` image, adds Python 3.12 from its digest-pinned official
image, and installs GitHub CLI for general CI jobs. It installs the
checksum-pinned GitHub Actions runner archive and Docker CLI, Buildx, and
Compose, and the host's
`/var/run/docker.sock` is bind-mounted
into each ephemeral worker (sibling-container pattern) so `ci.yml`'s `docker`
job can run `docker compose up/down` itself. This means anything with access
to that pool's ephemeral runner also has Docker-socket-level access to the
host -- keep `ci.yml`'s Docker job restricted to trusted, already-checked-out
repository code. The `pi-agent` pool does not receive the Docker socket.

The general pool can optionally mount a persistent host pip cache by setting
`PIP_CACHE_HOST_DIR` in the host `.env`. The source must already exist and be
owned by `runner` (UID:GID `1001:1001` in the current general worker image); the manager uses
Docker's `--mount` syntax so a missing source fails instead of creating a root
owned directory. Leave it unset to disable the mount. This variable is wired
only to `general-runner-manager`; the Pi pool does not receive it. For up to
three simultaneous CI runners, use a shared writable directory (for example
mode `0770`) and current pip (23.3.1 or newer); pip's cache supports normal
concurrent use, though duplicate downloads can still occur during races.

Until this mount is deployed, `ci.yml` also retains `actions/setup-python`'s
`cache: pip` as a transitional fallback.

Linux `run_check` uses a separate trusted executor process inside
`pi-runner-manager`. The manager already has Docker daemon access; the Pi worker
does not. The executor is published only on host loopback and authenticates each
Pi worker using a per-runner token. It accepts only the existing structured
`run_check` request, copies that worker's current worktree into a dedicated
temporary Docker volume, removes `.git` and local tool environments, then starts
the fixed sandbox image with that volume mounted read-only. The sandbox gets no
Docker socket, host bind mounts, runner tokens, GitHub token, model credentials,
or inherited runner environment. The executor never accepts Docker flags,
image names, commands, or mount paths from the caller.

## N150 setup

Build the manager, Pi worker, general worker, dedicated control runner, and separate check sandbox first:

```bash
docker build -f infra/github-runner-autoscaler/manager.Dockerfile -t n150/pi-runner-manager:run-check-docker-0.1.8 .
docker build -f infra/github-runner-autoscaler/worker.Dockerfile -t n150/github-pi-runner-ephemeral:0.89.2-mini-swe .
docker build -f infra/github-runner-autoscaler/worker-general.Dockerfile -t n150/github-general-runner-ephemeral:0.87.7 .
docker build -f infra/github-runner-autoscaler/control-runner.Dockerfile -t n150/github-control-runner:0.1.6 .
docker build -f infra/github-runner-autoscaler/run-check-sandbox.Dockerfile -t n150/run-check-sandbox:0.1.1 .
```

Both autoscaled worker Dockerfiles start from the public Node 24 Bookworm image
and download GitHub Actions Runner `2.337.0` with its pinned SHA-256. They do
not use locally built N150 images as build stages, so BuildKit can resolve
every base independently in a clean builder. The manager and general worker
retry a failed Docker daemon check once after five seconds before quarantining
the pool or refusing runner registration. The Pi worker tag `0.89.2-mini-swe`
pins Pi CLI `@earendil-works/pi-coding-agent@0.87.1` and Orbit
`@gitlab/orbit@0.130.0`, as well as `mini-swe-agent==2.4.6`, `pi-mcp-adapter@3.2.0`,
`lsp-mcp-server@1.1.25`, `git-context-mcp@1.0.0`, `@ast-grep/cli@0.45.3`, BasedPyright `1.40.1`, and the official JetBrains
Kotlin LSP `263.4702.0`. The experimental `mini-swe` Implementer backend uses the upstream mini-SWE-agent CLI with the same loaded local model endpoint; Pi remains the default backend. The Pi and general worker tags are `0.89.2-mini-swe` and `0.87.7`; the general image now retries a failed daemon health check once before registration. `run_check` tooling lives in the separate `0.1.1` sandbox image. System-package changes must use a new image tag rather than silently reusing an already-built local tag. The sandbox image independently contains Python 3.12, the repository's pinned Ruff and pytest tooling, Node for the configured `node_tests` profile, and Git for repository tests; it contains no runner registration, GitHub CLI, SSH client, or agent runtime. To roll the Pi pool back, set
`RUNNER_IMAGE=n150/github-pi-runner-ephemeral:0.89.1-mini-swe` in the N150 host's
untracked `.env` and recreate only `pi-runner-manager`:

```bash
docker compose --env-file .env up -d --force-recreate --no-deps pi-runner-manager
```

To deploy the general worker update, build the exact `0.87.7` tag, set
`GENERAL_RUNNER_IMAGE=n150/github-general-runner-ephemeral:0.87.7` in the host
`.env`, then recreate only the general manager:

```bash
docker build -f infra/github-runner-autoscaler/worker-general.Dockerfile -t n150/github-general-runner-ephemeral:0.87.7 .
docker compose --env-file .env up -d --force-recreate --no-deps general-runner-manager
```

To deploy or refresh the dedicated control lane, build the pinned image and
recreate only `control-runner`. Its named runner-root volume is retained, so
the same registration/cooldown/self-updated runtime survives restart and
recreate:

```bash
docker build -f infra/github-runner-autoscaler/control-runner.Dockerfile -t n150/github-control-runner:0.1.6 .
docker compose --env-file .env up -d --force-recreate --no-deps control-runner
docker compose --env-file .env logs --tail=100 control-runner
```

The control image uses GitHub Actions Runner `2.337.0` as its verified
bootstrap baseline and checks the official Linux x64 archive SHA-256 during
the build. The entrypoint intentionally does **not** pass `--disableupdate`:
the persistent runner keeps GitHub's supported self-update path enabled, so it
does not age out merely because the container stays online.

Treat the Dockerfile version as the rebuild baseline, not as a permanent
runtime ceiling. When updating that baseline, bump both
`ACTIONS_RUNNER_VERSION` and `ACTIONS_RUNNER_SHA256`, bump
`CONTROL_RUNNER_IMAGE`, rebuild the image, recreate only `control-runner`,
and verify that `n150-control` is online in the repository Actions runner
list before relying on it. The startup baseline check upgrades an older
persisted runtime without deleting its registration state. Do not remove
`CONTROL_RUNNER_STATE_VOLUME` during an ordinary deploy; deleting that volume
is an explicit reset that discards registration and cooldown state. Do not add
`general` or `pi-agent` to `CONTROL_RUNNER_LABELS`.

### `run_check` sandbox backend

`RUN_CHECK_SANDBOX_IMAGE` independently selects the versioned sandbox image; it
defaults to `n150/run-check-sandbox:0.1.1`. Set it in the host's untracked
`.env`, build that exact tag, and restart only `pi-runner-manager` when changing
the sandbox version. The manager refuses to start Pi workers unless the image
exists locally, a hardened no-network container can run the image probe, and
the trusted executor's health endpoint is reachable. It logs both the selected
tag and the image ID. Runtime `sandboxPreflight()` stages a real temporary
worktree marker, starts a sandbox with the same read-only worktree mount as a
real check, and verifies non-root UID, zero effective capabilities, disabled
network, no Docker socket, and the expected mount before logging
`PI_RUN_CHECK_PREFLIGHT {"ok":true,...}`. Docker startup and executor failures
remain structured `infra_error`; normal compiler and test failures remain
`fail`. There is no unrestricted-shell fallback.

The runtime and executor exchange a versioned environment contract on every
preflight (`RUN_CHECK_ENV_CONTRACT`). A version or key-set mismatch is logged as
`CHECK_ENV_CONTRACT`, recorded as `PI_RUN_CHECK_PREFLIGHT_FAILED`, and aborts the
Implementer from `session_start` before it starts a coding session or model
budget. If Pi schedules a request despite the abort, the request hook strips all
tools and sets `tool_choice` to `none`, so no tool-capable provider request is
sent. The sandbox wrapper must accept every key in the environment contract;
the v2 acceptance-target keys were added in sandbox image `0.1.1`. Build the
manager with the new `run-check-docker-0.1.8` tag and the sandbox with `0.1.1`,
set `PI_RUNNER_MANAGER_IMAGE` and `RUN_CHECK_SANDBOX_IMAGE` in the host `.env`
to those exact tags, then recreate
`pi-runner-manager` so new ephemeral workers load the rebuilt executor:

```bash
docker build -f infra/github-runner-autoscaler/manager.Dockerfile -t n150/pi-runner-manager:run-check-docker-0.1.8 .
docker build -f infra/github-runner-autoscaler/run-check-sandbox.Dockerfile -t n150/run-check-sandbox:0.1.1 .
docker compose --env-file .env up -d --force-recreate --no-deps pi-runner-manager
```

Confirm the manager is healthy and run a controlled Implementer workflow. Its
`PI_RUN_CHECK_PREFLIGHT` record must report `ok:true`; a stale executor must fail
with the contract diagnostic and no tool-capable provider request.

Terminal receipt schema v2 adds the semantic Implementer outcome to the existing
result digest binding. V2 readers reject v1 receipts, so deploy this manager and
runtime update while the Pi pool is idle; finish active runs before recreating
the manager. A run resumed with a v1 receipt must resubmit its result to create a
v2 receipt before the parent can accept it.

The manager also launches a local executor process with a Docker socket inside
its trusted container. The Pi runner itself remains non-root, unprivileged,
under the default Docker security profile, and has no socket mount. Sandbox
containers use `--network none`, `--cap-drop ALL`, `--security-opt
no-new-privileges`, a read-only root filesystem, UID 1001, a 128 MiB `/tmp`
tmpfs, a 2 GiB memory limit, a 2 CPU limit, and a read-only subpath of the
temporary staging volume. No host filesystem bind or secrets are passed through.

Upgrade procedure: choose a new immutable-by-convention tag, build
`run-check-sandbox.Dockerfile` under that tag, set `RUN_CHECK_SANDBOX_IMAGE` in
the N150 host `.env`, and recreate only `pi-runner-manager`. Check the manager
log for `run_check backend ready image=... image_id=...` before dispatching a
Pi job. The runtime preflight log includes the same image ID and sandbox
security evidence.

Create the local manager environment:

```bash
cd infra/github-runner-autoscaler
cp .env.example .env
chmod 600 .env
```

Put the GitHub token into `.env`, then start both managers and the persistent control runner:

```bash
docker compose --env-file .env up -d --build
docker compose logs -f pi-runner-manager general-runner-manager control-runner
```

Before enabling `general-runner-manager`, stop and remove the old persistent
`github-general-runner` container/registration (and, for `pi-runner-manager`,
the old persistent `github-pi-runner` container) so neither consumes jobs in
parallel with its ephemeral pool.

For the #465 live smoke, first confirm `n150-control` is online in the
repository runner list and note its reported runner version. Occupy all normal
`n150/general` slots with ordinary
heavy CI, then let a PR `CI` run reach a terminal state. Verify that its
`CI Terminal Wake` job is assigned to `n150-control` promptly, before a
general slot becomes free, and that it dispatches `Pi Auto Merge`. Repeat
across a failing/cancelled PR CI followed by a successful PR CI and record the
source CI run IDs plus wake start times. This is the live proof that the
control lane is independent; the static tests only protect the configuration.

The current Qwen model runtime supports eight concurrent model requests.
`MODEL_MAX_CONCURRENCY` is the centralized model-capacity setting and defaults
to `8`; set it to `4` when switching to Laguna. This controls model-facing
admission independently from the Pi runner pool's `MAX_RUNNERS` cap, even
though both currently default to eight. The manager also limits model slots
reported by llama.cpp to this configured capacity. Workflow concurrency groups
remain independent: per-issue/per-PR work stays keyed by its identity, while
Dispatcher, Architect, Triage, and Merge Gate remain serialized.

Set `MAX_RUNNERS` (`pi-agent` pool) and `GENERAL_MAX_RUNNERS` (`general` pool)
in the N150 host's local `.env` to each pool's desired capacity. The two pools
share the same 4-core/14 GiB host and the same Docker daemon, so their totals
compete for the same real CPU/RAM -- raise either past its documented default
only after watching actual headroom under concurrent load, not by guessing.
If `.env` defines `WORKFLOW_FILES` (or, for the `general` pool, `GENERAL_WORKFLOW_FILES`),
add any newly introduced workflow file there too (e.g. `pi-triage.yml`);
updating the tracked defaults does not override an existing host `.env`.
Restart the autoscaler manager after changing its local environment.
`manager.sh` owns Pi-pool fallback values (`MAX_RUNNERS=8`, `MODEL_MAX_CONCURRENCY=8`, and `POLL_SECONDS=6`). `compose.yaml` forwards Pi-pool overrides; `.env.example` shows recommended explicit host values. A host may override them in its untracked `.env`, and that local value is authoritative for that host. Raising model capacity does not raise the separate `GENERAL_MAX_RUNNERS` CI pool.
Additional jobs remain queued in GitHub Actions until a worker slot becomes free.
Set `MODEL_STATUS_URL` in the N150 host's local `.env` to the active model
server, reachable from the manager container. For a llama.cpp server, point it at that server's `/slots` endpoint. The endpoint returns the total slots and whether each is processing a request. Do not treat a historical host/port as part of the repository contract; `MODEL_STATUS_URL` must follow whichever model server is active on the N150 deployment. The manager
reserves one slot per active runner, including pauses between Pi's model calls.
It also counts any occupied slots beyond those reservations as other load.
The server does not identify which client owns a slot, so this is an estimate.
Each manager poll logs `model_slots_total`, `model_slots_busy`, and
`model_capacity` (new runner places after reserving active runners), including
when no GitHub work is queued. The vLLM `/metrics` endpoint does not expose a
fixed slot total, so those first two fields are `unknown` for vLLM.
The local `MAX_RUNNERS` still limits the number of workers. For vLLM, point
to `/metrics`; a waiting-request backlog defers new runners. An unavailable
endpoint or invalid status defers new runners and logs a warning. An unset URL
preserves the previous queue-only behavior. Recreate the manager after changing
the URL or switching model servers.
When none of a pool's watched workflows are queued, its manager stops surplus
online idle runners after checking that GitHub still marks each one as not
busy. This prevents an already registered spare runner from taking a later
job before the model check (the `pi-agent` pool's gate; the `general` pool has
no model check to race). A runner must show up idle on two consecutive polls
before it's stopped: GitHub can assign a job in the instant between one poll's
snapshot and the next, and killing a runner mid-assignment orphans that job
until it times out and gets re-queued -- requiring a second confirmation,
a full `POLL_SECONDS` apart, makes catching a runner in that window far less
likely without meaningfully delaying retirement of a genuinely idle one.
The manager counts both `queued` and `pending` GitHub workflow runs, in one
repo-wide request per status (filtered to the watched workflow files
client-side) rather than one request per watched file -- with 6-7 files per
pool that's the difference between roughly 30 GitHub API calls per poll and
2, which is what lets `POLL_SECONDS` sit as low as it does without
threatening the token's 5,000/hour budget. When GitHub or Docker state cannot
be read, the manager skips that poll instead of treating the failed request
as an empty queue or an empty runner pool.

The manager loop has no external supervisor for a hang: `restart: unless-stopped`
only restarts a crashed process, never one that is alive but stuck waiting on a
network call. Every GitHub API request and Docker command therefore runs under a
bounded deadline -- `CURL_CONNECT_TIMEOUT_SECONDS` (default 5) and
`CURL_MAX_TIME_SECONDS` (default 15) for `curl`, `DOCKER_TIMEOUT_SECONDS`
(default 30) for `docker ps`/`stop`/`run`. A call that exceeds its deadline is
killed and that poll logs a warning and retries on the next cycle, instead of
freezing runner scaling for the whole host.

Run the focused manager checks without contacting GitHub or Docker:

```bash
bash tests/test_runner_autoscaler.sh
```

## Local Zoekt index for Pi Implementer

The optional indexed search service runs on the N150 host from
`/home/yurasik/zoekt-social-mcp`. Its persistent index is in `index/`, and its
local Git mirror is in `mirror/`. It indexes only the public `dev` branch
of `YuriiSokolenko/social-mcp`. The Zoekt name is pinned by `repo.meta.json`.
The webserver uses upstream `sourcegraph/zoekt`, enables the JSON API with
`-rpc`, and publishes port 6070 on `127.0.0.1` only. Pi workers use host
networking, so their `http://127.0.0.1:6070` reaches the service without
publishing it to the LAN or internet.

From a fresh checkout on N150, copy `infra/zoekt/compose.yaml`,
`infra/zoekt/update-index.sh`, and `infra/zoekt/repo.meta.json` into
`/home/yurasik/zoekt-social-mcp/`, then run:

```bash
cd /home/yurasik/zoekt-social-mcp
chmod 750 update-index.sh
./update-index.sh
docker compose up -d
```

Add these two lines to the `yurasik` user's crontab (`crontab -e`) to schedule
updates at boot and every 15 minutes:

```cron
@reboot /home/yurasik/zoekt-social-mcp/update-index.sh >> /home/yurasik/zoekt-social-mcp/update.log 2>&1
*/15 * * * * /home/yurasik/zoekt-social-mcp/update-index.sh >> /home/yurasik/zoekt-social-mcp/update.log 2>&1
```

The updater fetches
only `refs/heads/dev` and runs Zoekt's incremental Git indexer with ctags
enabled. A failed or stopped Zoekt service does not block runner creation.
The Pi manager passes `PI_ZOEKT_URL`, `PI_ZOEKT_REPOSITORY`, and
`PI_ZOEKT_TIMEOUT_MS` to Pi workers; the general CI pool receives none of them.

Health and search checks on N150:

```bash
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"Q":"content:\"Threads\""}' http://127.0.0.1:6070/api/search
docker compose ps
docker stats social-mcp-zoekt --no-stream
```

To update manually, run `./update-index.sh`. To stop Zoekt fully, remove the
two scheduled lines from `crontab -e` and run `docker compose down`. To start
it again, run `./update-index.sh`, `docker compose up -d`, and restore those two
crontab lines. Docker's `restart: unless-stopped` starts the webserver after
host reboot. For index corruption, stop the service, remove the `.zoekt` shard
files from `index/`, run the updater, and start the service again. Normal
updates never delete the index. `indexed_repo_search`
is discovery against indexed `dev`; `repo_search` and `read` remain authoritative
for the current worktree, including after edits. For an already-known source-code
symbol, semantic LSP lookup is the first hop. Name-only workspace lookup needs
an active language server: when the task already makes the language explicit,
call `lsp_start_server` once with server id `python` or `kotlin` and the exact absolute Implementer workspace root supplied in the runtime-prepared state, then call `lsp_find_symbol`. Do not add a
`lsp_server_status` ritual first. Position-based LSP tools remain appropriate
when file + line/column are already known and auto-start the routed server.


## GitLab Orbit Local for Pi

The `pi-agent` ephemeral worker image pins `@gitlab/orbit@0.130.0`. Architect and Implementer workflows run `orbit setup pi --mcp --yes --no-index` before Pi starts, then index only the checkout authoritative for that job. No GitLab login, PAT, or Orbit Remote service is required: Orbit Local runs against the worker's local checkout and local DuckDB graph.

After changing a worker image, bump its tracked image tag, rebuild that tag on N150, update the host `.env` to the same tag, restart the affected runner manager, and verify a fresh Architect or Implementer job prints only the Orbit version plus the non-sensitive confirmation line. Do not run `env`, `printenv`, shell tracing, or commands that print values from the manager/runner environment while diagnosing Orbit.

Orbit complements the host Zoekt service: Zoekt stays the fast shared `dev` text index; Orbit supplies per-job structural code context for the current checkout/worktree.

## Local Git history context for Pi

The Pi worker image also pins `git-context-mcp@1.0.0` and exposes it through the project `.mcp.json` as a lazy local stdio server. It reads the job checkout and `.git` directly; no separate service or container is required. The exposed tools are `blame_context`, `commit_story`, `file_history`, `search_commits`, and `file_contributors`.

Use this layer only for historical intent/provenance questions that current source, Zoekt, LSP, and Orbit do not answer: why a bounded line range exists, what one commit changed, or how one known file evolved. Do not use Git Context to locate a current symbol or as a mutation anchor. Current source remains authoritative and must still be verified with `read` before mutation.

The upstream server can enrich local history with PR/issue metadata through the `gh` CLI. This integration intentionally does not add or forward a GitHub credential on its own; without authenticated `gh`, the local Git portion still works and PR/issue enrichment is skipped. This keeps the initial rollout read-only and avoids widening the Implementer credential surface.

## Deterministic Implementer edits

The Implementer runtime exposes `structural_edit` as the preferred source-code mutation when one exact syntax node can be described with an ast-grep pattern/rewrite. The worker image pins `@ast-grep/cli`; the tool lets ast-grep infer the language from the target file, performs a JSON dry-run, requires exactly one AST match, verifies that the returned byte range still matches the current worktree, and atomically applies only that proposed replacement. Metavariables should preserve untouched code instead of making the model reproduce neighboring statements.

`safe_edit` remains the bounded line/range fallback for text/config edits or source changes where structural matching is not a good fit. It re-reads the current worktree file immediately before mutation, validates the selected 1-based range and optional marker, preserves newline/final-newline state, writes atomically, and returns a bounded post-edit preview. `structural_edit`, `safe_edit`, `edit`, and `write` all participate in the same productive-progress snapshot/rollback path.

## Pi RepoMap navigation context

Architect additionally loads the pinned `pi-repomap` extension from `scripts/pi-run-stage.mjs`. Implementer no longer loads it. The extension is intentionally not installed through project `.pi/settings.json`, because that would install/load the package for every Pi stage.

Project configuration lives in `.pi/repomap.json` with `refreshStrategy: "auto"` and a fixed **1536-token** map budget. RepoMap is an Architect-only navigation hint for unclear repository areas, not authoritative source text. The repository skill `.agents/skills/repomap-navigation/SKILL.md` records that bounded Architect policy.

RepoMap writes its incremental cache under `.pi/cache/`; that path is gitignored so ephemeral Architect navigation state is never committed.

## General-pool daemon quarantine (#430, #474)

The general manager uses two bounded Docker health levels. Every scheduler poll
runs the cheap `docker info` liveness check so daemon loss still fails closed
without delaying queue observation. The expensive `docker system df` metadata
walk runs once at manager startup, then on
`GENERAL_DOCKER_DEEP_PROBE_INTERVAL_SECONDS` (default 300 seconds), after a
failed general-runner container start, and during quarantine recovery. A
container-start failure requests an early deep probe, but outside quarantine
those forced probes are limited to one per 60 seconds so a persistent unrelated
failure (for example, a missing image) cannot recreate the old per-poll CPU
hot loop. Quarantine recovery deliberately bypasses that throttle.

The manager is single-threaded and keeps the last successful deep-probe
timestamp, so ordinary calls from both the main loop and `spawn_runner` share
one cadence. This is intentional: `docker system df` traverses rw snapshots
and detects the #401 corruption, but on the N150 it can take about ten seconds
and must not sit on every queue-poll fast path.

General workers independently repeat both `docker info` and `docker system df`
before registering with GitHub, closing the manager's periodic-check window
before a worker can accept a job. Pi workers still have no Docker socket. A
successful deep probe is timestamped in manager logs, which makes the configured
cadence visible during idle validation.

A check that still fails after one five-second retry stops the spawn batch and quarantines the general pool. The manager
removes only idle registrations with the `general` label belonging to its own prefix; GitHub refuses deletion
of busy runners. It leaves busy jobs and other pools alone. While quarantined,
each recovery poll runs both liveness and deep metadata validation, and the pool
is released only after two consecutive healthy polls. A log containing
`infra_error code=DOCKER_METADATA_CORRUPTION` means the daemon reported the specific
`rw layer snapshot not found` error. Other health failures use
`DOCKER_DAEMON_UNHEALTHY`. No host-wide prune, storage deletion, or daemon restart is
automatic: a shared host may still be serving busy jobs.

Inspect the named container with `docker inspect <container-id>`, and collect
`journalctl -u docker -u containerd` around the failure before host repair. Check
exited ephemeral workers and Docker/containerd shutdown or cleanup events. Remove
an identified disposable stale container through the Docker API only after verifying
it is not busy; if that cannot succeed, drain the host and restart/recreate its daemon
under operator control. Never delete snapshot directories or metadata files manually.
The quarantine health checks must pass before the host resumes accepting CI work.

### Durable infra evidence (#437)

GitHub job logs can expire and general workers are `--rm`, so a `Set up job` failure like
PR #410's could not be diagnosed afterwards. The general pool now mounts a named volume
(`GENERAL_EVIDENCE_VOLUME`, default `social-mcp-general-runner-evidence`) at `/evidence`:

- `events.jsonl` (manager): one JSON line when the pool enters quarantine (code, failing
  check, daemon diagnostic and a bounded `docker ps -a` snapshot) and when it recovers.
  Only the transition is recorded, not every poll. Capped at 500 events.
- `worker-events.log` (workers): daemon health failures and the runner's exit status.
- `<runner-name>-worker-diag.log`: last 200 lines of the runner's newest `_diag/Worker_*.log`;
  the 50 newest are kept.

All writes are best-effort and never fail a job or block registration. Read them with
`docker run --rm -v social-mcp-general-runner-evidence:/evidence alpine tail -n 50 /evidence/events.jsonl`.
Evidence is disabled when `INFRA_EVIDENCE_DIR` is unset.

Deploy these changes by building the new manager tag
`n150/pi-runner-manager:run-check-docker-0.1.8`, sandbox tag
`n150/run-check-sandbox:0.1.1`, and general worker tag
`n150/github-general-runner-ephemeral:0.87.7` from this checkout, then updating the
host `.env` and recreating the managers. Existing cached tags do not acquire the
new gates. Do not restart busy worker containers during deployment.

The CI BuildKit step retains required Buildx initialization; `docker system df`
and `docker buildx du` inside the job are warning-only diagnostics. Merge Gate
still retries infrastructure once and never dispatches PR Fix for those failures.
