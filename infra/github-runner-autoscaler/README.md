# GitHub Pi runner autoscaler

This directory runs a small Docker-based autoscaler for the N150 host.

It watches queued runs of `.github/workflows/pi-issue-agent.yml`,
`.github/workflows/pi-pr-review.yml`, `.github/workflows/pi-dispatcher.yml`,
and `.github/workflows/pi-architect.yml`,
and keeps up to `MAX_RUNNERS` ephemeral self-hosted runner containers alive. Each worker registers
with GitHub using `--ephemeral`, accepts one job, and is removed after the job.

## Security model

The manager needs access to the Docker socket and a GitHub token capable of creating
and deleting repository self-hosted runners. Keep that token only in the local
`.env` file on the N150 host and never commit it.

For a fine-grained personal access token, grant this repository:

- Administration: Read and write
- Actions: Read

The N150 Pi configuration is mounted read-only at `/pi-config-ro` and copied into each ephemeral worker's private writable `/home/runner/.pi/agent` directory at startup. This avoids Pi lock-file errors and prevents parallel workers from sharing mutable Pi state. Because the manager controls the host Docker daemon through `/var/run/docker.sock`, the source configured by `PI_HOME_HOST` must be a real host path.

## N150 setup

Build the ephemeral worker image first:

```bash
docker build   -f infra/github-runner-autoscaler/worker.Dockerfile   -t n150/github-pi-runner-ephemeral:0.87.1 .
```

Create the local manager environment:

```bash
cd infra/github-runner-autoscaler
cp .env.example .env
chmod 600 .env
```

Put the GitHub token into `.env`, then start the manager:

```bash
docker compose --env-file .env up -d --build
docker compose logs -f pi-runner-manager
```

Before enabling the manager, stop the old persistent `github-pi-runner` container so
it cannot consume jobs in parallel with the ephemeral pool.

Set `MAX_RUNNERS` in the N150 host's local `.env` to the desired pool capacity.
If `.env` defines `WORKFLOW_FILES`, add `pi-architect.yml` there too; updating
the tracked defaults does not override an existing host `.env`. Restart the
autoscaler manager after changing its local environment.
The example defaults to two; a local value such as three takes precedence.
Additional jobs remain queued in GitHub Actions until a worker slot becomes free.
Set `MODEL_STATUS_URL` in the N150 host's local `.env` to the active model
server, reachable from the manager container. For the Laguna GGUF server on
the Nano, use `http://192.168.8.210:3009/slots`. The llama.cpp endpoint
returns the total slots and whether each is processing a request. The manager
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
When no Pi workflows are queued, the manager stops surplus online idle runners
after checking that GitHub still marks each one as not busy. This prevents an
already registered spare runner from taking a later job before the model check.
The manager counts both `queued` and `pending` GitHub workflow runs. When GitHub
or Docker state cannot be read, it skips that poll instead of treating the failed
request as an empty queue or an empty runner pool.

Run the focused manager checks without contacting GitHub or Docker:

```bash
bash tests/test_runner_autoscaler.sh
```
