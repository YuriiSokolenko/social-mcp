# GitHub Pi runner autoscaler

This directory runs a small Docker-based autoscaler for the N150 host.

It watches queued runs of `.github/workflows/pi-issue-agent.yml` and keeps up to
`MAX_RUNNERS` ephemeral self-hosted runner containers alive. Each worker registers
with GitHub using `--ephemeral`, accepts one job, and is removed after the job.

## Security model

The manager needs access to the Docker socket and a GitHub token capable of creating
and deleting repository self-hosted runners. Keep that token only in the local
`.env` file on the N150 host and never commit it.

For a fine-grained personal access token, grant this repository:

- Administration: Read and write
- Actions: Read

The Pi configuration is mounted read-only into workers directly from the N150 host path configured by `PI_HOME_HOST`. Because the manager controls the host Docker daemon through `/var/run/docker.sock`, worker bind-mount source paths must be host paths, not paths that exist only inside the manager container.

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

With `MAX_RUNNERS=2`, at most two Pi jobs run concurrently. Additional jobs remain
queued in GitHub Actions until a worker slot becomes free.
