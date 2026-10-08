# Beelink N150 update and restart

Run this on the N150 from the deployment checkout after its host configuration
is present:

```bash
sudo bash scripts/beelink-update-restart.sh --dry-run
sudo bash scripts/beelink-update-restart.sh
```

Use `--yes` only when the update plan has already been reviewed. The script
checks GitHub Actions runs and self-hosted runner busy state and refuses to
interrupt work by default. `--force-busy` explicitly permits that interruption.
The script fetches `origin/dev` into a separate user-owned checkout, copies the
host autoscaler `.env` without printing its contents, builds all required images
before stopping services, and preserves the current checkout, configuration,
named volumes, Pi configuration, Zoekt index, and monitoring data. It does not
reboot the host or restart Docker Engine.

The managed services come from the tracked autoscaler and Zoekt Compose files:
Pi and general managers, the persistent control runner, the run-check sandbox
image/executor, ephemeral workers, and Zoekt. Orbit and DuckDB JSON support and
the SearXNG MCP executable are provisioned in the Pi worker image; the worker's
startup preflight performs the MCP initialize/search check before registration.
No Beszel Compose deployment is tracked in this repository, so the script does
not guess at or restart one.

Reports are written with mode 0600 to
`/var/log/beelink-update-restart/`. A copy of the host autoscaler `.env` is
backed up under `/var/backups/beelink-update-restart/` before service changes.
The report does not include environment values or command output that could
contain credentials.

If restart verification fails, read the report and the relevant Compose logs:

```bash
sudo docker compose --project-directory /path/to/social-mcp \
  --env-file /path/to/social-mcp/infra/github-runner-autoscaler/.env \
  -f /path/to/social-mcp/infra/github-runner-autoscaler/compose.yaml logs --tail=100
sudo docker compose -f /path/to/social-mcp/infra/zoekt/compose.yaml logs --tail=100
```

The previous image tags and named volumes remain available. Restore the prior
tracked checkout/configuration backup, then recreate only the affected Compose
services with `up -d --force-recreate`; never use `down -v` or prune volumes.
For a Pi worker registration check, wait for an approved queued workflow and
confirm its runner registers and completes the worker startup preflight.
