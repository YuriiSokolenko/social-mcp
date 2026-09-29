# Codex rollout: GitLab Orbit Local on N150 Pi runners

This document covers only host-side deployment that cannot be performed through the GitHub repository connector.

## Goal

Deploy the repository's updated `pi-agent` image so Architect and Implementer can use GitLab Orbit Local through Pi MCP. Keep Zoekt enabled; Orbit complements it.

## Non-negotiable secret-safety rules

- Never print or copy the contents of `.env`.
- Never run `env`, bare `printenv`, `set -x`, `bash -x`, or shell tracing.
- Never echo values of variables whose names contain `TOKEN`, `SECRET`, `PASSWORD`, `KEY`, `CREDENTIAL`, `COOKIE`, or `AUTHORIZATION`.
- Never use `docker inspect` in a way that prints container environment values.
- Never print GitHub PATs, runner registration tokens, model API keys, OAuth credentials, authorization headers, or cookies.
- For presence checks, print only `PRESENT` / `ABSENT`; never print the value.
- Do not add secrets to command arguments. Do not use verbose HTTP modes that may print headers.
- If any command unexpectedly outputs a secret, stop immediately, report only that a secret exposure occurred, and rotate the affected credential without repeating its value.

## Steps

1. Work in the existing N150 checkout for `YuriiSokolenko/social-mcp`. Fetch and fast-forward to the current `dev`. Do not discard unrelated local host configuration.

2. Confirm the tracked worker image now installs the pinned Orbit package:

   ```bash
   grep -n '@gitlab/orbit@0.130.0' infra/github-runner-autoscaler/worker.Dockerfile
   ```

3. Rebuild the Pi ephemeral worker image:

   ```bash
   docker build \
     -f infra/github-runner-autoscaler/worker.Dockerfile \
     -t n150/github-pi-runner-ephemeral:0.87.1 \
     .
   ```

4. Verify Orbit is present without starting the normal runner entrypoint:

   ```bash
   docker run --rm \
     --entrypoint orbit \
     n150/github-pi-runner-ephemeral:0.87.1 \
     version
   ```

   Expected: a version matching the pinned package. Do not print container environment variables.

5. Restart only the Pi runner manager so newly spawned ephemeral runners use the rebuilt image:

   ```bash
   cd infra/github-runner-autoscaler
   docker compose --env-file .env up -d --build pi-runner-manager
   ```

6. Verify manager health without printing its environment:

   ```bash
   docker compose ps pi-runner-manager
   docker compose logs --tail=80 pi-runner-manager
   ```

   Confirm normal polling resumes. Do not use `docker inspect` to dump env.

7. Run one controlled Architect or Implementer workflow. In the job steps verify:

   - `Prepare Orbit Local code graph` succeeds.
   - the log shows `orbit version`;
   - the log shows only the non-sensitive confirmation that MCP was configured and the checkout/worktree indexed;
   - no credentials or environment values appear;
   - the Pi session sees the Orbit MCP tools (`index`, `get_graph_schema`, `run_sql`) when structural context is needed.

8. For an Implementer run, confirm the indexed directory is the isolated `JOB_DIR`, not the control checkout. For Architect, confirm the trusted `dev` checkout is indexed.

9. Confirm Zoekt remains available and unchanged. Orbit is for structural code-graph questions; Zoekt remains the fast shared literal/path/symbol index.

10. Run the repository control-plane tests from the current `dev` checkout:

    ```bash
    node --test tests/*.test.mjs
    bash tests/test_runner_autoscaler.sh
    ```

11. Report only:
    - Orbit image build: PASS/FAIL
    - Orbit version check: PASS/FAIL and version number
    - Pi manager: RUNNING/FAILED
    - controlled Orbit workflow step: PASS/FAIL
    - Orbit MCP tools visible: YES/NO
    - Zoekt still available: YES/NO
    - Node tests: PASS/FAIL
    - autoscaler tests: PASS/FAIL
    - secrets printed: NO (or EXPOSURE DETECTED, without reproducing the value)
    - any exact non-secret error messages that still need fixing

Do not rotate, replace, print, or otherwise modify any credential unless a credential exposure is actually detected.
