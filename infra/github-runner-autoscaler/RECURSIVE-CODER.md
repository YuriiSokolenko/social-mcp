# Recursive-coder CI pool — issue #793

Status: **prepared, not deployed; sandbox and credential blockers remain**.
The owner alone performs privileged deployment. Do not enable the Compose profile
before addressing the blockers and reviewing this document.

## Isolation and lifecycle

`recursive-coder-runner-manager` is a third independent manager process, with its
own versioned image and separately scoped `RECURSIVE_CODER_GH_ADMIN_TOKEN`.
It points exclusively at `YuriiSokolenko/recursive-coder`, watches `ci.yml`, uses
prefix `n150-rc-eph` and labels `n150,recursive-coder-ci`, and starts at most one
worker. It does not use Pi configuration, inference capacity or the run-check
executor. Existing manager/control image tags, labels, networks and credentials
are preserved. Only the new service belongs to the opt-in `recursive-coder`
profile; the deployment uses its own Compose project and `--no-deps`.

Workers are amd64 Ubuntu 24.04 with pinned base digests and checksum-verified
Temurin 21.0.12.1+1, Node 22.23.3 and Actions runner 2.338.0. Python 3.12 is copied
from the existing digest-pinned Python image. Bubblewrap is installed at build
time. The worker has no sudo, Docker CLI/socket, host mounts, Pi secrets or host
network. It runs as UID 1001 with all capabilities dropped, no-new-privileges,
default seccomp/AppArmor, 2 CPUs, 4 GiB memory (no swap extension), and 512 PIDs.
Only the trusted manager has the Docker socket. The Actions runner gets a
short-lived registration token through environment inputs, never argv; jobs
never inherit the durable administration token. `--ephemeral --disableupdate`
retains the existing one-job lifecycle; maintain the pinned runner version.

The writable `/opt/hostedtoolcache` supports setup actions. Ubuntu 24.04 avoids
setup-python's unsupported Debian distribution selection. Checkout and artifact
upload use the runner's embedded Node runtime; setup-java can install Temurin 21;
setup-node requests 22; setup-python requests 3.12; setup-gradle downloads 9.8.1
as specified downstream. No Gradle installation or workflow changes are needed
in this infrastructure repository. Image/runtime smoke passed; actual execution
of these six actions is **not yet validated** and requires the deployed pool.

## Accounting and resource limits

All managers now count matching queued **jobs** in watched queued, pending and
in-progress workflow runs. They paginate runs, jobs and registrations, deduplicate
runs across status snapshots, exclude fork PRs, and require every evaluated job
label to match the pool's self-hosted Linux x64 labels. Completed/running jobs,
control jobs and other pools are excluded. A three-job workflow contributes
three units of demand; the new cap of one intentionally executes them serially.
API errors, invalid totals and truncation defer new starts. Lists are bounded
at ten pages per endpoint and fail closed beyond that bound. Poll cost now scales
with active watched runs; the third pool polls every 30 seconds. Monitor the
GitHub API quota before separately rolling this change into existing managers.

Busy/stale/idle/quarantine operations use the manager's repository API and exact
runner prefix. Docker counts for the new pool additionally require repo and pool
identity labels. Existing pools retain prefix-based legacy worker recovery;
reserve prefixes uniquely across repositories. Quarantine labels are derived
from configured pool labels, never hard-coded to `general`. Busy runner deletion
races are rejected by GitHub; failure does not block the remaining cleanup.

A named scheduler volume serializes admission through container creation. New
starts check total ephemeral count and host MemAvailable, reserving 3 GiB for the
host/control lane plus the candidate worker's reservation. The existing Compose
managers are wired to this lock on a **future separately reviewed rollout**, but
the targeted deploy never updates/restarts them. Until then the new manager
reserves their full live configured maximum (`LEGACY_RESERVED_RUNNERS`, normally
8 + 3 = 11), with `HOST_MAX_EPHEMERAL=12`. Preflight verifies this against the live
manager environments. This bounds the added worker count even while old managers
ignore the lock. Resource checks defer admission; they never evict running jobs.

Existing workers and their Docker-socket-created sibling workloads do not have
new CPU/RAM limits retroactively. Therefore this change cannot guarantee a hard
aggregate CPU/RAM ceiling for legacy workloads while preserving their runtime
configuration and uptime. New-worker quotas and admission headroom protect against
additional unbounded demand; a strict host-wide budget needs a separate owner
reviewed rollout of legacy workload reservations/quotas. Do not lower the legacy
reservation while those managers still run the old image.

## Actual evidence — 2026-10-13

Read-only SSH discovery on N150 found x86_64 Ubuntu kernel `7.0.0-38-generic`,
Docker `29.9.0`, 15,244 MiB RAM, approximately 13,533 MiB available and 193 GiB
free root disk. Existing Pi/general managers use
`n150/pi-runner-manager:run-check-docker-0.1.10`; control uses
`n150/github-control-runner:0.1.8`. No production service was restarted or deployed.

The existing durable credential, read only inside the running manager, returned
**HTTP 403** for recursive-coder's runners API. No token was printed. A separate
fine-grained PAT must grant recursive-coder Administration Read/write and Actions
Read. GET preflight verifies runners/Actions access; explicit owner deployment
also POSTs a registration token and discards it, proving Administration write.
GitHub's temporary UI registration token is not a durable manager credential.

Host policy is `kernel.unprivileged_userns_clone=1`,
`kernel.apparmor_restrict_unprivileged_userns=1`, and
`user.max_user_namespaces=60712`. The exact downstream Bubblewrap command passes
on the host. A plain host `unshare --user --map-root-user true` fails, and its
kernel audit record shows AppArmor's `unprivileged_userns` profile denying
`CAP_SYS_ADMIN`; that is a profile decision, not evidence that the kernel lacks
user-namespace support. `/dev/kvm` is accessible to the SSH user through the
existing `kvm` group, QEMU is installed, and N150 reports four CPUs, 13,533 MiB
available RAM and 193 GiB free disk.
I also started and cleanly quit a 64 MiB, one-vCPU QEMU/KVM `-machine none`
probe; this verifies device initialization only, not a guest boot.

Docker reports AppArmor `profile=default` and seccomp `profile=builtin`. The host's
`/etc/apparmor.d/bwrap-userns-restrict` defines a `bwrap` profile with userns and
mount permissions, plus `unpriv_bwrap`, which audits/denies capabilities. The
separate `unprivileged_userns` profile allows userns but audits/denies capability
use.
The worker startup probe now logs its active AppArmor label, seccomp mode and
`NoNewPrivs` value immediately before the exact bwrap invocation; it does not
change those settings.

I built the PR's pinned amd64 worker image on N150 as a disposable probe image and
ran the exact worker probe with UID 1001, all capabilities dropped,
`no-new-privileges`, a 4 GiB memory cap, 512 PIDs, and no network. The image was
not used to start an Actions runner or manager. Results:

- The exact probe fails with Docker's default AppArmor and builtin seccomp.
- Selecting `apparmor=bwrap` or `apparmor=unprivileged_userns` with builtin
  seccomp unchanged still fails.
- A temporary profile based on the published Moby default kept its default-deny
  rules but allowed the `clone`, `unshare`, and mount-related syscalls needed for
  this diagnostic container (`mount`, `umount2`, `pivot_root`, `mount_setattr`,
  `open_tree`, `move_mount`). With Docker's default AppArmor profile, the failure
  changed from namespace creation to `bwrap: Failed to make / slave: Permission
  denied`; this isolates a later AppArmor mount-propagation denial after
  namespace creation. With `apparmor=bwrap`, the active label was
  `bwrap//&unpriv_bwrap`, and N150 logged
  `apparmor="DENIED" operation="capable" profile="unpriv_bwrap"
  capability=21 capname="sys_admin"`; that profile selection still failed.
  Neither diagnostic profile had argument restrictions narrow enough for
  production, and neither was persisted.
- The earlier `getattr` denial for an empty/disconnected path under
  `unprivileged_userns` is not the namespace-creation denial. No seccomp audit
  event identified a specific syscall; Docker's documented builtin policy gates
  namespace `clone` flags and `unshare`, so seccomp remains a candidate blocker
  until a tight argument-filtered profile is tested.

Conclusion: global kernel settings permit the host Bubblewrap probe. The default
seccomp rules block the namespace setup path; temporarily allowing namespace and
mount syscalls moved the failure to an AppArmor-denied mount propagation. The
existing `bwrap` profile cannot simply be selected for the whole container because
it applies its `unpriv_bwrap` child profile to the worker and also denies a
`CAP_SYS_ADMIN` check. A worker-specific profile must combine a tight seccomp
allowlist with AppArmor rules suitable for the runner's container and Bubblewrap's
setup; that pair has not been validated. Loading it requires privileged host
policy installation; I did not run sudo, load a profile, change sysctls, or alter
persistent host state. Deployment remains fail-closed. The disposable diagnostic
image is removed after probes. No `unconfined` option or privileged container was
used.

## Disposable VM alternative — investigation only

If owner review does not approve and validate a worker-specific AppArmor/seccomp
pair, the concrete fallback is one ephemeral KVM guest per recursive-coder job,
not a silent change to this Docker design. N150 has QEMU, an accessible `/dev/kvm`,
four CPUs, and enough currently available memory/disk for one guest. Proposed
initial reservation: maximum one guest, 2 vCPU, 4 GiB RAM, a read-only golden
Ubuntu 24.04 image plus a disposable qcow2 overlay capped at 24 GiB, and the
existing 3 GiB host/control reserve. The current 11-runner legacy reservation
plus this one guest fits the configured 12-unit admission cap. Delete the overlay
after the ephemeral runner completes; never reuse a guest filesystem between
jobs.

The guest would contain the pinned Actions runner, Java 21, Node 22, Python 3.12,
and Bubblewrap, and run the exact downstream workflow as UID 1001. It would have
no Docker socket, Pi configuration, host filesystem share (including virtiofs/9p),
forwarded inbound port, or durable runner credential. A small host-side launcher
would create a one-time registration token, pass it through a read-only seed ISO
or vsock bootstrap, remove it before the job starts, and destroy the guest/overlay
after one job. Network access must use a dedicated per-guest egress boundary that
denies N150/LAN/control-plane destinations while allowing required GitHub Actions
endpoints; that needs an owner-reviewed per-VM firewall or egress-proxy rule and
is not implemented here.

The host does not currently have a validated guest image, VM autoscaler, or
per-guest egress policy. The resource probe establishes KVM availability only; it
does not claim guest boot, Bubblewrap isolation, or positive/negative sandbox E2E
success. Before any architecture switch, owner review must approve the VM boundary,
network policy, guest image lifecycle, runner-token bootstrap and rollback script.
This PR keeps the Docker pool opt-in and disabled until either the worker-specific
Docker profile or this VM plan is implemented and passes the same exact positive
and negative tests without skips. The downstream E2E test's positive separate
execution, read-only workspace, writable scratch directory, blocked network and
output-limit checks have not run inside a worker or guest. Its CI assertion still
requires exactly one passing sandbox case and treats a skip as failure.

## Owner deployment and rollback

After reviewing/merging, use a clean checkout of `social-mcp:dev` at
`/home/yurasik/github-runners/social-mcp-autoscaler`. Set the separately scoped
secret in its `infra/github-runner-autoscaler/.env` (regular file, mode 0600), plus
resource settings matching the live managers. Never paste credentials into argv,
issue comments or logs. The script defaults to read-only preflight:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder.sh --dry-run /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
```

**Do not deploy with the current sandbox blocker.** After a reviewed safe sandbox
solution and positive proof, the exact owner command is:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder.sh --deploy /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
```

Deployment checks architecture, Docker/Compose, API permissions, live legacy caps,
memory and disk. It builds only the two named new images, executes the hardened
worker probe, and refuses to start the manager if it fails. There is no daemon
restart/prune, host policy change, CI dispatch or existing service recreation.
It checks legacy IDs/start times before/after and records root-only last/previous
configuration, narrowly selected environment keys and immutable image IDs under
`/var/lib/recursive-coder-ci-deploy`. Repeated deployment is supported; changes
require workers to finish first. Images/volumes remain available for recovery.

```bash
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder.sh --rollback /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
```

Rollback first verifies that the running manager has the shared scheduler volume
and lock support. It then acquires the same nonblocking admission lock used around
worker creation, checks for active workers, stops only the new manager, and checks
again while still holding the lock. A busy-worker, lock-contention or old-manager
check fails before stop, leaving the manager running. This closes the start race
for the new manager; it refuses rollback against an older manager that cannot
coordinate. Once drained, it restores previous manager/worker images and
configuration when available, or removes just the new manager for an initial
deployment. It does not delete unrelated runners, images, networks or volumes.
The API preflight is not required during rollback.

## Post-deployment acceptance — pending owner action

After deployment, verify an actual trusted recursive-coder CI run. Record its
URL, all three job IDs and `runner_name`/`runner_id`/`runner_group_name`. Require
`runner_name` to begin `n150-rc-eph-`, matching pool labels and one job per worker.
Confirm architecture/kotlin/contracts all succeed, the sandbox test executes
exactly once with zero skips in the required suites, and existing negative checks
pass. Check no jobs use hosted runners and Pi/general/control identities and
uptime remain healthy. No actual CI run or passing sandbox E2E is claimed here.

## Reproduce validation

```bash
bash tests/test_runner_autoscaler.sh
python3 -m unittest discover -s tests -p test_recursive_coder_deploy.py -v
shellcheck infra/github-runner-autoscaler/{manager.sh,deploy-recursive-coder.sh,recursive-coder-entrypoint.sh,recursive-coder-probe.sh} tests/test_recursive_coder_pool.sh
docker compose --env-file infra/github-runner-autoscaler/.env.example -f infra/github-runner-autoscaler/compose.yaml --profile recursive-coder config --quiet
docker build --platform linux/amd64 -f infra/github-runner-autoscaler/worker-recursive-coder.Dockerfile -t n150/github-recursive-coder-runner-ephemeral:0.1.0 .
docker build --platform linux/amd64 -f infra/github-runner-autoscaler/manager.Dockerfile -t n150/recursive-coder-runner-manager:0.1.0 .
```

The complete shell suite passed in the locally built Linux amd64 worker image;
the ten deployment/entrypoint regression tests, workflow-integrity tests,
ShellCheck, Ruff and Compose validation also passed. Deployment tests use fake
Docker/GitHub commands and a temporary state directory: they are regression
coverage, not evidence of executing the owner deployment on N150. Published
version/checksum sources: [Node 22](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt),
[Temurin 21](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1),
[Actions runner environment inputs](https://github.com/actions/runner/blob/v2.338.0/src/Runner.Listener/CommandSettings.cs),
[setup-python self-hosted requirements](https://github.com/actions/setup-python/blob/v5/docs/advanced-usage.md),
[Docker seccomp defaults](https://docs.docker.com/engine/security/seccomp/),
and [Docker AppArmor profiles and diagnostics](https://docs.docker.com/engine/security/apparmor/).
