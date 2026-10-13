# Recursive-coder CI pool — issue #793

Status: **KVM sandbox prototype passes; autoscaler and credential integration remain unimplemented; not deployed**.
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

## Disposable KVM prototype — validated boundaries, runner integration pending

On 2026-10-13 I booted Canonical Ubuntu 24.04.5 amd64 on N150 using QEMU 10.2.1
with `-machine q35,accel=kvm -cpu host -smp 2 -m 4096`. The golden cloud image
was read-only, checksum verified (`6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`),
and each run used a separate qcow2 overlay with a 24 GiB virtual size. QEMU shut
down cleanly. The base boot used about 738 MiB RSS; the full CI test run peaked
around 4.22 GiB QEMU process RSS (guest RAM is capped at 4 GiB; the extra RSS is
emulator overhead). The completed Gradle overlay occupied 2.32 GB on disk with a
24 GiB virtual limit. The host still had about 9.6 GiB available during the test.
The overlays are temporary and must be deleted after each job; the golden image
remains read-only.

The exact Bubblewrap probe from `recursive-coder/.github/workflows/ci.yml` failed
as the unprivileged `runner` user with the stock Ubuntu package mode 0755:
Ubuntu's `unprivileged_userns` AppArmor profile audited/denied `CAP_SETPCAP` and
`CAP_NET_ADMIN`, ending with `bwrap: loopback: Failed RTM_NEWADDR: Operation not
permitted` (exit 1). In a disposable overlay only, setting `/usr/bin/bwrap` to
root-owned mode 4755 made the same exact command pass (exit 0) as UID 1001.
Neither host AppArmor, seccomp, kernel sysctl nor permanent guest state was changed.
This is a candidate image setting, not yet approved for a production golden image;
review whether the setuid helper is acceptable inside the KVM trust boundary.

The guest used `-netdev user,restrict=on,ipv4=on,ipv6=off` and one explicit
`guestfwd` connection to a loopback-only host proxy. There was no `hostfwd`, TAP,
bridge, shared folder, Docker socket, or other guest network path. The host proxy
allowlists required GitHub/Ubuntu/Gradle/Java/Python/Node endpoints, resolves names
on the host, rejects non-global resolved IPs, and connects to the pinned public
address. The test guest had working virtio networking and a default route. Results:

```text
n150-host-ssh=BLOCKED errno=111
lan-gateway=BLOCKED errno=111
docker-control-plane=BLOCKED errno=111
rfc1918-10=BLOCKED errno=111
public-direct=BLOCKED errno=111
proxy-github=HTTP_200 bytes=200
proxy-ubuntu=HTTP_200 bytes=200
proxy-disallowed=BLOCKED error=URLError
direct-dns-10.0.2.3=BLOCKED error=TimeoutError
direct-dns-10.0.2.254=BLOCKED error=TimeoutError
direct-dns-1.1.1.1=BLOCKED error=TimeoutError
NETWORK_POLICY_ASSERTIONS=PASS
```

The exact guest commands, host proxy implementation, and unit tests are in
`kvm-egress-proxy.py` and `tests/test_kvm_egress_proxy.py`. QEMU's `restrict=on`
and `guestfwd` behavior follows the [QEMU system manual](https://www.qemu.org/docs/master/system/qemu-manpage.html#user-netdev); this prototype has no
host port forwarding. An unauthenticated GitHub API probe returned HTTP 403 on
the host network, so registration-token API access is not claimed. The owner has
not supplied the scoped PAT, and I did not request or access any credential.

The downstream exact probe passed inside the VM. I installed the pinned Gradle
9.8.1 distribution using its published SHA-256, configured Java's HTTP(S) proxy
properties, and ran the workflow command from CI:

```text
./gradlew --no-daemon clean test integrationTest e2eTest installDist --stacktrace
BUILD SUCCESSFUL in 4m 11s
GRADLE_FULL_CI_EXIT=0
```

An XML scan in the same guest found 392 passing `test` cases, 131 passing
`integrationTest` cases and one passing `e2eTest` case; each tier had zero skips
and zero failures. The required
`realSeparatelyExecutedSandboxedTestPassesIfHostSupportsUserNamespaces` appeared
exactly once in `e2eTest`, passed, and was not skipped. That test exercises
separate execution, read-only workspace, writable scratch, blocked network and
output-limit behavior. No downstream test or workflow file was modified.

The first attempt failed because Gradle was not preinstalled by
`gradle/actions/setup-gradle`; the next attempt initially lacked Java proxy
properties. Both were corrected in the disposable guest, without changing the
downstream repository. The guest shut down after the result scan. These results
validate the KVM sandbox and prototype proxy, not a live Actions runner session.

The autoscaler regression scripts were run on Beelink (Linux), not on macOS:

```text
bash tests/test_runner_autoscaler.sh                    exit=0; 10 tests passed
bash tests/test_recursive_coder_pool.sh                 exit=0; pool checks passed
python3 -m unittest tests.test_kvm_egress_proxy -v       exit=0; 3 tests passed
```

Before and after these tests, the IDs and names of the existing Pi, General and
Control containers matched. No running QEMU guest remained after teardown. The
guest overlay, seed media, logs and temporary loopback proxy were removed from
the Beelink after evidence was recorded.

## KVM autoscaler integration plan and remaining blockers

Keep the existing scheduler and all Pi, General and Control managers untouched.
The opt-in recursive-coder manager should keep repository
`YuriiSokolenko/recursive-coder`, `MAX_RUNNERS=1`, and runner labels
`self-hosted,linux,x64,n150,recursive-coder-ci`. A dedicated KVM backend should
serialize admission with the existing scheduler lock, account for its 4 GiB
reservation and 2-vCPU allocation, and launch one QEMU process per ephemeral
runner. Its command line must use the read-only pinned golden image, a fresh 24 GiB
bounded overlay, `restrict=on`, and only the allowlisted guest-forwarded proxy.
The VM must have no disk/share mount from the host other than read-only bootstrap
media, no Docker socket or Pi configuration, and no inbound forwarding. The runner
must use `--ephemeral`, power off after one job, and have its overlay destroyed
before the manager can admit another VM. This backend is not yet integrated into
`manager.sh` or Compose; the current manager still starts Docker workers.

The host proxy prototype is rootless and binds only to loopback. A production
service still needs owner review of endpoint coverage, dynamic artifact hosts,
logging/timeout behavior, and the guest bootstrap. The repository-scoped PAT and
short-lived registration-token lifecycle also remain untested. The registration
token must be supplied only to trusted bootstrap, removed before any job starts,
and inaccessible to the job user; the runner's own runtime credential files need
a separate threat-model review inside the guest. No deployment or runner
registration has been performed. The existing deploy/rollback scripts cover the
Docker pool only; an idempotent KVM-specific `--dry-run`, verification, deploy and
rollback path still needs to be implemented and reviewed before deployment.
The KVM guest passed the exact Bubblewrap probe and downstream positive/negative
sandbox E2E with zero skips. The Docker pool remains opt-in and disabled. This
prototype does not register an Actions runner or test a one-job runner lifecycle:
the autoscaler still starts Docker workers, and KVM-specific owner `--dry-run`,
verification, deployment and rollback scripts have not been implemented. No
deployment or real recursive-coder Actions job is claimed. The CI assertion still
requires exactly one passing sandbox case and treats a skip as failure.

## Owner deployment and rollback

For the existing Docker pool only, after reviewing/merging, use a clean checkout of `social-mcp:dev` at
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
