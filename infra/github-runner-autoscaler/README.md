# GitHub runner autoscaler

This directory runs a small Docker-based autoscaler for the N150 host, as two
independent pools -- each its own manager instance (see `compose.yaml`) so one
pool's stuck loop can never block the other's:

- **`pi-runner-manager`** (pool label `pi-agent`) watches queued runs of
  `.github/workflows/pi-issue-agent.yml`, `.github/workflows/pi-pr-review.yml`,
  `.github/workflows/pi-pr-fix.yml`, `.github/workflows/pi-dispatcher.yml`,
  `.github/workflows/pi-architect.yml`, and `.github/workflows/pi-triage.yml` --
  jobs that call the Pi/LLM agent, gated by `MODEL_STATUS_URL` capacity.
- **`general-runner-manager`** (pool label `general`) watches queued runs of
  every workflow with a job on the `general` label: `.github/workflows/ci.yml`,
  `pi-auto-merge.yml`, `pi-automation-control.yml`, `pi-pr-review.yml`'s gate
  job (its review job stays on `pi-agent`), `pi-reconcile.yml`, `pi-set-model.yml`,
  and `pi-usage.yml` -- none of these call the Pi/LLM agent, so this pool has
  no model gate; `MAX_RUNNERS` is the only cap. **This list must stay in sync
  with `GENERAL_WORKFLOW_FILES`** (`compose.yaml`'s default / the host's
  `.env`): a workflow file moved onto the `general` label but left out of that
  list queues forever with nothing watching it -- check
  `grep -rl 'n150, *general' .github/workflows/` when adding one.

Each pool keeps up to its own `MAX_RUNNERS` ephemeral self-hosted runner
containers alive. Each worker registers with GitHub using `--ephemeral`,
accepts one job, and is removed after the job. Running each CI job on its own
disposable runner is also what lets several queued runs execute in parallel
instead of serializing behind a single persistent runner.

## Security model

The manager needs access to the Docker socket and a GitHub token capable of creating
and deleting repository self-hosted runners. Keep that token only in the local
`.env` file on the N150 host and never commit it.

For a fine-grained personal access token, grant this repository:

- Administration: Read and write
- Actions: Read

The N150 Pi configuration is mounted read-only at `/pi-config-ro` and copied into each ephemeral worker's private writable `/home/runner/.pi/agent` directory at startup, only for the `pi-agent` pool (`MOUNT_PI_CONFIG=true`). This avoids Pi lock-file errors and prevents parallel workers from sharing mutable Pi state. Because the manager controls the host Docker daemon through `/var/run/docker.sock`, the source configured by `PI_HOME_HOST` must be a real host path.

The `general` pool instead sets `MOUNT_DOCKER_SOCKET=true`: its worker image
(`worker-general.Dockerfile`) adds the Docker CLI and Compose plugin over the
same base runner image, and the host's `/var/run/docker.sock` is bind-mounted
into each ephemeral worker (sibling-container pattern) so `ci.yml`'s `docker`
job can run `docker compose up/down` itself. This means anything with access
to that pool's ephemeral runner also has Docker-socket-level access to the
host -- keep `ci.yml`'s `docker` job restricted to trusted, already-checked-out
repository code, same trust boundary as the `pi-agent` pool.

## N150 setup

Build both ephemeral worker images first:

```bash
docker build -f infra/github-runner-autoscaler/worker.Dockerfile -t n150/github-pi-runner-ephemeral:0.88.0-lsp .
docker build -f infra/github-runner-autoscaler/worker-general.Dockerfile -t n150/github-general-runner-ephemeral:0.87.1 .
```

The Pi worker tag `0.88.0-lsp` pins `pi-mcp-adapter@3.2.0`,
`lsp-mcp-server@1.1.25`, `git-context-mcp@1.0.0`, BasedPyright `1.40.1`, and the official JetBrains
Kotlin LSP `263.4702.0`. The general runner image and the base runner image
remain on their existing tags. To roll the Pi pool back, set
`RUNNER_IMAGE=n150/github-pi-runner-ephemeral:0.87.1` in the N150 host's
untracked `.env` and recreate only `pi-runner-manager`:

```bash
docker compose --env-file .env up -d --force-recreate --no-deps pi-runner-manager
```

Create the local manager environment:

```bash
cd infra/github-runner-autoscaler
cp .env.example .env
chmod 600 .env
```

Put the GitHub token into `.env`, then start both managers:

```bash
docker compose --env-file .env up -d --build
docker compose logs -f pi-runner-manager general-runner-manager
```

Before enabling `general-runner-manager`, stop and remove the old persistent
`github-general-runner` container/registration (and, for `pi-runner-manager`,
the old persistent `github-pi-runner` container) so neither consumes jobs in
parallel with its ephemeral pool.

Set `MAX_RUNNERS` (`pi-agent` pool) and `GENERAL_MAX_RUNNERS` (`general` pool)
in the N150 host's local `.env` to each pool's desired capacity. The two pools
share the same 4-core/14 GiB host and the same Docker daemon, so their totals
compete for the same real CPU/RAM -- raise either past its documented default
only after watching actual headroom under concurrent load, not by guessing.
If `.env` defines `WORKFLOW_FILES` (or, for the `general` pool, `GENERAL_WORKFLOW_FILES`),
add any newly introduced workflow file there too (e.g. `pi-triage.yml`);
updating the tracked defaults does not override an existing host `.env`.
Restart the autoscaler manager after changing its local environment.
The tracked example and manager fallback default to four. A host may override this in its untracked `.env`; the local value is authoritative for that host.
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
for the current worktree, including after edits.


## GitLab Orbit Local for Pi

The `pi-agent` ephemeral worker image pins `@gitlab/orbit@0.130.0`. Architect and Implementer workflows run `orbit setup pi --mcp --yes --no-index` before Pi starts, then index only the checkout authoritative for that job. No GitLab login, PAT, or Orbit Remote service is required: Orbit Local runs against the worker's local checkout and local DuckDB graph.

After changing the worker image, rebuild it on N150 with the existing image tag, restart the Pi runner manager, and verify a fresh Architect or Implementer job prints only the Orbit version plus the non-sensitive confirmation line. Do not run `env`, `printenv`, shell tracing, or commands that print values from the manager/runner environment while diagnosing Orbit.

Orbit complements the host Zoekt service: Zoekt stays the fast shared `dev` text index; Orbit supplies per-job structural code context for the current checkout/worktree.

## Local Git history context for Pi

The Pi worker image also pins `git-context-mcp@1.0.0` and exposes it through the project `.mcp.json` as a lazy local stdio server. It reads the job checkout and `.git` directly; no separate service or container is required. The exposed tools are `blame_context`, `commit_story`, `file_history`, `search_commits`, and `file_contributors`.

Use this layer only for historical intent/provenance questions that current source, RepoMap, Zoekt, LSP, and Orbit do not answer: why a bounded line range exists, what one commit changed, or how one known file evolved. Current source remains authoritative and must still be verified with `read` before mutation.

The upstream server can enrich local history with PR/issue metadata through the `gh` CLI. This integration intentionally does not add or forward a GitHub credential on its own; without authenticated `gh`, the local Git portion still works and PR/issue enrichment is skipped. This keeps the initial rollout read-only and avoids widening the Implementer credential surface.

## Pi RepoMap navigation context

Implementer and Architect additionally load the pinned `pi-repomap` extension from `scripts/pi-run-stage.mjs`. It is intentionally not installed through project `.pi/settings.json`, because that would install/load the package for every Pi stage. The selected stages load the pinned git revision only for their own run.

Project configuration lives in `.pi/repomap.json` with `refreshStrategy: "auto"` and a fixed **1536-token** map budget. RepoMap is a navigation hint, not authoritative source text: use it to choose a small reading order, then verify exact code with `read`/`repo_search`, use Zoekt for indexed literal discovery, and Orbit for precise graph questions. The repository skill `.agents/skills/repomap-navigation/SKILL.md` records the bounded routing policy.

RepoMap writes its incremental cache under `.pi/cache/`; that path is gitignored so ephemeral navigation state cannot be checkpointed or published with an implementation.
