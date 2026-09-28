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
docker build -f infra/github-runner-autoscaler/worker.Dockerfile -t n150/github-pi-runner-ephemeral:0.87.1 .
docker build -f infra/github-runner-autoscaler/worker-general.Dockerfile -t n150/github-general-runner-ephemeral:0.87.1 .
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
no model check to race).
The manager counts both `queued` and `pending` GitHub workflow runs. When GitHub
or Docker state cannot be read, it skips that poll instead of treating the failed
request as an empty queue or an empty runner pool.

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
