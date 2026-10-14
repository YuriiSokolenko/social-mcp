# Recursive-coder CI pool — issue #793

Status (2026-10-14): **The unprivileged KVM guest passes the exact Bubblewrap probe, full downstream Gradle CI, and two repeated integration suites on a real disposable N150 VM. Resource review bounded KVM-manager swap and added fail-closed VM-state checks. The six failures from an earlier run did not recur; their original JUnit diagnostics were not preserved, so no downstream implementation fix is claimed. The runner pool is not deployed and PR #794 remains Draft.**
The guest uses unprivileged user namespaces and a guest-only nftables deny-by-default
egress policy. VM startup, bounded resources, restricted proxy egress, shutdown and
overlay cleanup have been exercised. Actions runner registration and a live job
remain untested because the owner has not supplied the separately scoped PAT.
The owner alone performs privileged deployment.

## Earlier Docker runner prototype (blocked)

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

## Disposable KVM feasibility run — previous bootstrap revision

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
That setuid workaround is historical evidence only; the current bootstrap keeps
Bubblewrap unprivileged and enables user namespaces in the disposable guest. This
historical run predates the current bootstrap validation recorded above.

The command executed verbatim from the workflow was:

```bash
/usr/bin/bwrap --die-with-parent --new-session --unshare-all \
  --tmpfs / --proc /proc --dev /dev \
  --ro-bind /usr /usr --ro-bind /bin /bin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  -- /usr/bin/true
```

The source is the downstream [CI workflow](https://github.com/YuriiSokolenko/recursive-coder/blob/dev/.github/workflows/ci.yml#L96-L102).

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

The host proxy implementation and its policy unit tests are in
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

## Current unprivileged bootstrap validation — 2026-10-13 UTC

The owner staged the read-only golden image on Beelink from preparation commit
`afd5b8f`. I validated the current PR head `9c0891cd8fec0562efcf2f89ddb1687eb920a2eb`
in a disposable manager container on N150. The golden qcow2 image was mounted
read-only and matched SHA-256
`6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`. QEMU ran
with KVM acceleration, 2 vCPUs and 4096 MiB; the overlay had a 24 GiB virtual
limit and reached 3,502,481,408 allocated bytes (about 3.26 GiB). Peak QEMU RSS
was 4,238,032 KiB (about 4.04 GiB). The disposable manager container was capped
at 5 GiB and 2.25 CPUs; its cgroup recorded no OOM or OOM kill. The host had
12,934 MiB available before the run and 190 GiB root disk free. QEMU's command
had no `hostfwd`, TAP, bridge, or shared filesystem device. It used
`user,restrict=on,ipv6=off` with only the loopback egress-proxy guest forward.
The overlay and seed were removed at shutdown; the golden image was unchanged.

The guest bootstrap started nftables before the probe. The captured ruleset had
an `inet runner_egress` output chain with `policy drop`, loopback and established
traffic, DHCP, and only `10.0.2.100:3128` as allowed guest egress. The exact
workflow Bubblewrap command was run as the unprivileged `runner` user (UID 1001)
and returned `BWRAP_PROBE_EXIT=0`. No setuid change or host policy change was
made in this run.

Network checks recorded `NETWORK_POLICY_ASSERTIONS=PASS`. The host-side loopback
proxy reached `github.com` (HTTP 200), `api.github.com` (200),
`raw.githubusercontent.com` (301), `downloads.gradle.org` (200), and the two
Actions upload endpoints (HTTP 404 responses, so DNS/TCP/TLS/HTTP reachability
was established). It denied `example.com`. Direct guest DNS and direct public
egress were blocked. TCP probes to Beelink SSH, Penpot, run-check, LAN gateway,
Docker engine ports, Docker bridge addresses and representative 10/172/192
private addresses all failed with `errno=101` (`ENETUNREACH`). A guest-local
loopback HTTP server worked. The proxy log contained only its expected denials
for the guestfwd loopback peer; no private target was accepted. The HP Nano SSH
alias resolves to `192.168.8.210`; that exact address was not individually dialed
from this guest. It is covered by the guest output chain's default-drop rule,
which admits only the proxy address/port, and the Beelink and gateway probes on
the same LAN were blocked.

Downstream source was cloned without modification from `dev` at commit
`3028a05e602a9572ba41bc1f3daa28d0fdb762c0`; the workflow hash was
`786b6fb857c10ac4ed60a94419f66068a0c91868f39021044decde3470bba491`. The exact
Bubblewrap probe and the exact `ci.yml` Gradle command were used. Gradle 9.8.1
was downloaded through the allowlist proxy and verified against its published
SHA-256. One full command
`./gradlew --no-daemon clean test integrationTest e2eTest installDist --stacktrace`
returned exit 1 after 15m 4s: Gradle reported 36 integration tests completed,
6 failed: `SessionRuntimeTest.cancellationEmitsOneTerminalResult`,
`SessionRuntimeTest.deadlineInterruptsBlockingFakeModel`, and four
`WorkspaceManagerTest` cases (`typedToolsReadOnlyCommittedPublicFilesWithBoundedResults`,
`pathTraversalSecretsAndUntrackedPathsAreDenied`,
`symlinkSwapRaceNeverExposesDataOutsideWorkspace`, and
`symlinkAndSubmoduleBoundariesFailClosed`). The full command's Gradle console
reported assertion failures for the first two and the typed-tools case; it did
not leave JUnit XML for the collector, so the full assertion messages were not
captured. A focused rerun of
`SessionRuntimeTest.cancellationEmitsOneTerminalResult` and
`SessionRuntimeTest.deadlineInterruptsBlockingFakeModel` returned exit 0. A
separate `./gradlew --no-daemon e2eTest --stacktrace` returned exit 0; the
required `realSeparatelyExecutedSandboxedTestPassesIfHostSupportsUserNamespaces`
ran exactly once with 0 skipped and 0 failures. The E2E includes separate
execution, read-only workspace, writable scratch, blocked network and output
limit checks. The complete downstream CI suite is therefore **not yet green**;
rerun it with corrected JUnit report collection before claiming full-suite
acceptance. The successful full suite documented above used the previous guest
bootstrap revision and does not replace this current-revision result.

Beelink Linux regression commands all passed at the same PR head: runner
autoscaler (10 tests), recursive-coder pool, KVM pool, KVM preparation, KVM
deployment, KVM backend/proxy Python tests (15 tests), and recursive-coder deploy
Python tests (10 tests). In particular, `flock` was `util-linux 2.41.3`; these
Linux-only harness scripts were run on Beelink, not macOS.

The before/after Docker snapshots contained the same 11 container IDs, names,
images and running/health states. No production service was restarted. The
validation manager was removed, no QEMU process remained, and the temporary VM
state directory was absent after teardown. No GitHub registration token was
requested or used: the test-only cloud-init hook skips runner registration, and
the owner has not provided the separately scoped PAT. The autoscaler and VM
cleanup code are implemented and unit-tested, but Actions runner registration,
one-job pickup, GitHub completion/de-registration and `ExecStopPost` cleanup
have not been exercised against GitHub. Deployment and merge remain owner-only;
the PR is still Draft.

## KVM autoscaler implementation

The opt-in `recursive-coder-kvm` Compose profile uses a separate manager container
for `YuriiSokolenko/recursive-coder`. It admits one VM, registers one ephemeral
runner with custom labels `n150,recursive-coder-ci` (GitHub adds
`self-hosted,linux,x64`), and watches only `ci.yml`. The manager shares the existing
admission lock, reserves legacy pool capacity, checks host RAM/CPU and free disk,
and never starts a GitHub-hosted fallback.

`kvm-backend.py` validates the pinned read-only Ubuntu 24.04 image, creates one
qcow2 overlay with a 24 GiB virtual limit, and starts `q35,accel=kvm` with two
vCPUs and 4 GiB RAM. The guest has no host disk/share, Docker socket, Pi config,
TAP device or inbound forwarding. QEMU user networking is `restrict=on`; the only
guest-forwarded service is the loopback egress proxy. The proxy permits the
GitHub Actions, checkout, package and artifact endpoints needed by CI, resolves
each destination itself, pins that public address for the connection, and denies
private/non-global DNS results. The guest bootstrap also installs a default-drop
nftables output policy allowing only DHCP and the proxy at `10.0.2.100:3128`.
Runner jobs cannot modify this host-network-namespace firewall as the unprivileged
`runner` user; Bubblewrap's own network namespace remains disconnected.

The guest uses Ubuntu's unprivileged Bubblewrap package (mode 0755) and enables
`kernel.apparmor_restrict_unprivileged_userns=0` only in that disposable guest.
No host AppArmor, seccomp or sysctl policy changes. The stock `ubuntu` cloud-image
account is locked and removed from sudo before the runner starts. Bootstrap places
the short-lived registration token only on a root-owned NoCloud seed, configures
the runner, shreds the token file, ejects the seed and removes cloud-init userdata
before enabling the Actions service. The PAT remains in the manager only; it is
not passed to QEMU or the VM. A QEMU supervisor enforces the lifetime limit and
deletes the overlay, seed, and logs after exit; manager shutdown also stops active
VMs.

The KVM manager image has no Docker socket and receives only `/dev/kvm`, the
read-only golden-image mount, its mode-0700 state directory and the shared
scheduler volume. The owner script `deploy-recursive-coder-kvm.sh` provides
read-only `--dry-run`, `--verify`, targeted `--deploy` and `--rollback`. It checks
legacy service IDs/start times, refuses to coexist with the old Docker
recursive-coder pool, checks the repository-scoped GitHub permissions, and only
starts/stops the KVM manager service. It never restarts or prunes existing pools.

## Current evidence and blockers — 2026-10-13

The latest review findings are addressed in source: cloud-init schedules the
Actions service through a transient delayed systemd unit after `cloud-final`
returns; nftables explicitly allows loopback; runner registration supplies the
short-lived token through the Actions runner's `ACTIONS_RUNNER_INPUT_TOKEN`
input variable instead of argv; the runner unit uses a privileged
`ExecStopPost` poweroff hook, while bootstrap failures power off from the root
bootstrap; and KVM admission checks host 1-minute load, online CPU count,
`MemAvailable`, and overlay filesystem headroom. The manager Compose CPU quota
bounds its QEMU and manager processes. Regression coverage checks generated
lifecycle rules and exercises high-load admission.

`prepare-recursive-coder-kvm.sh` is a separate owner-run script with
`--dry-run`, `--prepare`, `--verify`, and `--rollback`. It changes only
`/var/lib/recursive-coder-kvm`, never installs packages, changes host security
policy, or controls services. It verifies the pinned SHA-256 and QEMU image
format before an atomic install, refuses to replace an existing image, records
whether preparation created the image, and removes only that image on rollback
after checking that the manager and VM state are absent. Deployment now requires
the prepared root-owned read-only image and never downloads or modifies it.

The prior real Ubuntu 24.04.5 guest run above verified KVM boot/teardown, the
exact workflow Bubblewrap command, the positive and negative sandbox E2E tests
with zero skips, direct/private network blocking, and the full Gradle CI command.
That run used the guest-local setuid Bubblewrap workaround. The new unprivileged
user-namespace plus nftables bootstrap was not yet rebooted in a real guest at
the time this note was written. The pinned golden image was then absent on N150,
and direct HTTPS from both the SSH host and a disposable Docker container timed
out while trying to fetch it. The owner subsequently staged the image; current
bootstrap results are recorded in the validation section above.

The current bootstrap is not credited with the previous 524-test result because
that run used the setuid workaround. The actual ephemeral Actions service and
job remain untested; the separately scoped PAT is still an owner-only gate.

On Beelink, against the current branch snapshot:

```text
python3 -W error::ResourceWarning -m unittest -v tests/test_kvm_backend.py tests/test_kvm_egress_proxy.py
  15 tests passed; no resource warnings; generated systemd runner unit passed systemd-analyze verify
bash tests/test_runner_autoscaler.sh
  exit 0
bash tests/test_recursive_coder_pool.sh
  exit 0
bash tests/test_recursive_coder_kvm_pool.sh
  exit 0
bash tests/test_recursive_coder_kvm_deploy.sh
  exit 0; missing prepared assets fail closed before any Docker action
bash tests/test_prepare_recursive_coder_kvm.sh
  exit 0; bad digest rejected, dry-run left no state, install/repeat/verify/rollback passed in an isolated temporary root, mismatched existing image preserved
python3 -m unittest -v tests.test_recursive_coder_deploy
  10 tests passed
pytest --confcutdir=tests/ci -q tests/ci/test_workflow_integrity.py
  not rerun for this snapshot: pytest is not installed on Beelink
shellcheck manager.sh deploy-recursive-coder-kvm.sh prepare-recursive-coder-kvm.sh and shell tests
  not rerun for this snapshot: ShellCheck is not installed on Beelink; bash -n passed for all changed shell scripts
docker compose --env-file .env.example -f compose.yaml --profile recursive-coder-kvm config --quiet
  exit 0
docker build --pull=false -f infra/github-runner-autoscaler/kvm-manager.Dockerfile -t n150/recursive-coder-kvm-manager:codex-pr794-review .
  exit 0; the uniquely tagged validation image was removed immediately afterward; no container was started
qemu-img info --output=json -- /bin/true
  exit 0; Linux qemu-img accepts the image inspection arguments used by preparation
```

The backend lifecycle test uses fake QEMU and proves token absence from the QEMU
environment and cleanup after exit, timeout, stop and abandoned-state recovery.
The runner-manager test uses fake GitHub registration tokens and backend calls;
no PAT was read, no runner was registered, and no live GitHub Actions job was
started. Those are lifecycle regression tests, not evidence of a GitHub runner
session. No production KVM manager was deployed.

The scoped PAT has not been provided. A host-side live API permission check and
registration-token POST remain owner actions. The current unprivileged bootstrap
has now been validated against the pinned golden image; no real GitHub runner
registration or Actions job was attempted. Existing Pi, General, Control and
General ephemeral runner container IDs remained unchanged during Beelink tests;
no KVM guest or validation container remains running.

## Owner commands

Use the prepared checkout `/home/yurasik/github-runners/social-mcp-pr-794` on
Beelink. Keep the separately scoped
fine-grained PAT in the protected `.env` file as
`RECURSIVE_CODER_GH_ADMIN_TOKEN` (regular file, mode 0600). Grant only the
recursive-coder repository permissions required for Actions read and runner
Administration read/write. Never put the PAT or a registration token in shell
arguments, issue comments or logs.

Create the fine-grained PAT for **only** `YuriiSokolenko/recursive-coder`, with
repository `Administration: Read and write` and `Actions: Read`. Enter it only
at the hidden terminal prompt on Beelink; never paste it into Codex, chat, a PR,
or a command argument. The isolated checkout `.env` is not the live social-mcp
checkout. This writes the KVM PAT plus non-secret deployment settings and an
explicit inert placeholder for the unused legacy manager variable; it does not
read or copy any existing runner credential:

```bash
ssh -t beelink
```

Then run this in the interactive Beelink shell. Do not enable shell tracing.
Only the hidden prompt accepts the PAT; the shell writes it using a builtin,
not an argument to another process:

```bash
cd /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler
umask 077
read -r -s -p 'Fine-grained PAT for recursive-coder: ' token
printf '\n'
if [ -z "$token" ]; then
  unset token
  echo 'PAT must not be empty; .env was not written' >&2
else
  {
    printf 'RECURSIVE_CODER_GH_ADMIN_TOKEN=%s\n' "$token"
    printf '%s\n' \
      'GH_ADMIN_TOKEN=unused-by-kvm-profile' \
      'KVM_GOLDEN_HOST_DIR=/var/lib/recursive-coder-kvm/golden' \
      'KVM_STATE_HOST_DIR=/var/lib/recursive-coder-kvm/state' \
      'HOST_MAX_EPHEMERAL=12' \
      'HOST_MEMORY_RESERVE_MB=3072' \
      'LEGACY_RESERVED_RUNNERS=11'
  } > .env
  unset token
  chmod 0600 .env
fi
```

Verify later without printing the value:

```bash
ssh beelink 'cd /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler && stat -c "mode=%a owner=%U:%G file=%n" .env && python3 -c '\''import os,stat; s=os.lstat(".env"); t=open(".env").read(); assert stat.S_ISREG(s.st_mode) and (s.st_mode & 0o777)==0o600 and any(x.startswith("RECURSIVE_CODER_GH_ADMIN_TOKEN=") and len(x.split("=",1)[1])>0 for x in t.splitlines()); print("PAT setting is present and protected; value not displayed")'\'''
```

The owner staged and prepared the official Ubuntu 24.04 amd64 golden image from
preparation commit `afd5b8f`; it is read-only and matches the pinned SHA-256.
Verify it before any future deployment:

```bash
ssh beelink 'sudo bash /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --verify'
```

After the owner supplies the scoped PAT and reviews the saved validation
evidence, run the read-only preflight and inspect its output:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --dry-run /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/.env
```

Use `sudo` for this read-only check because the prepared golden image and its
parent path are root-only on Beelink and `/dev/kvm` is restricted to the KVM
group. The script's `--dry-run` validates but does not write files, query GitHub,
build images, or start/stop services.

The preparation script creates
`/var/lib/recursive-coder-kvm/{golden,state}` with root ownership and modes 0755
and 0700, and installs the golden image as mode 0444. The separate deployment
script requires these prepared assets, checks their pinned SHA-256, builds only
the KVM manager image, verifies the exact device,
mount and resource settings, and starts only the new Compose service:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --deploy /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/.env
sudo bash /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --verify /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/.env
docker inspect pi-runner-manager general-runner-manager n150-control --format '{{.Name}} {{.Id}} {{.State.Status}} {{.State.StartedAt}}'
```

Compare this post-verify snapshot with the one captured before deployment; IDs
and start times should match. The inspect format omits all container environment
values and secrets.

Rollback acquires the shared scheduler lock, refuses to interrupt an active VM,
and removes/restores only the KVM manager and its saved image/configuration:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --rollback /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/.env
```

To undo host preparation before deployment, the separate rollback refuses to
run while a KVM manager or VM state exists. It removes only a golden image this
preparation transaction installed and preserves the staged source and
directories:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-pr-794/infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --rollback
```

After owner deployment, require one trusted Actions job on an `n150-rc-eph-*`
runner. Record the job URL and runner metadata, verify all workflow jobs ran on
self-hosted labels, require the sandbox test exactly once with zero skips, and
confirm no hosted fallback was used. Check the Pi, General and Control service
IDs/start times and ensure the KVM overlay and runner registration are removed
when the job completes.

## Reproduce on Beelink Linux

```bash
bash tests/test_runner_autoscaler.sh
bash tests/test_recursive_coder_pool.sh
bash tests/test_recursive_coder_kvm_pool.sh
bash tests/test_recursive_coder_kvm_deploy.sh
python3 -W error::ResourceWarning -m unittest -v tests/test_kvm_backend.py tests/test_kvm_egress_proxy.py
python3 -m unittest -v tests.test_recursive_coder_deploy
pytest --confcutdir=tests/ci -q tests/ci/test_workflow_integrity.py
shellcheck infra/github-runner-autoscaler/manager.sh infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh
bash tests/test_prepare_recursive_coder_kvm.sh
TOKEN_ENCRYPTION_KEY=validation-only-placeholder-no-auth docker compose --env-file .env.example -f compose.yaml --profile recursive-coder-kvm config --quiet
```

## Final resource and deployment safety review — 2026-10-14

Beelink reports Docker cgroup v2 with the systemd cgroup driver, 4 CPUs, 14 GiB
RAM, 12 GiB `MemAvailable`, and a 4 GiB `/swap.img` with 208 KiB used at the
review snapshot. Load averages were `1.08, 0.60, 0.39` initially and
`1.12, 0.76, 0.55` after regression testing. The Pi and General
manager containers report no explicit Docker memory, swap, or CPU quota; these
existing pools were not changed. No KVM manager was deployed at the time of this
inspection. The golden parent `/var/lib/recursive-coder-kvm` is root-owned mode
0700, so the image and child directories cannot be inspected as the SSH user;
the owner must run the read-only preparation and deployment preflights with
`sudo`.

The earlier disposable KVM test manager had a 5 GiB cgroup RAM cap, reached that
cap in live samples, used approximately 2.38 GiB swap at its final sample, and
recorded no cgroup OOM events. Its swap cap was not captured in the saved full-CI
summary, so that run does not prove a bound for swap. Docker documents an unset
swap limit as allowing a total of twice the memory limit when host swap exists.
The KVM Compose service now sets `mem_limit: 5120m` and `memswap_limit: 8192m`:
the latter is total RAM plus swap, permitting at most 3 GiB swap. Deployment
verification asserts Docker's effective `HostConfig.MemorySwap` equals 8 GiB.
This keeps 0.62 GiB above the observed 2.38 GiB sample while preventing this
manager from consuming all 4 GiB of host swap by itself. This is a hard bound,
not a guarantee that other host workloads can never cause swapping. See the
[Docker resource constraints reference](https://docs.docker.com/engine/containers/resource_constraints).

On Beelink, Docker resolved this service to 5,368,709,120 bytes RAM,
8,589,934,592 bytes total RAM+swap, and 2.25 CPUs. A separate disposable,
network-disabled pressure probe with a 128 MiB RAM / 160 MiB total cap reported
`memory.max=134217728` and `memory.swap.max=33554432`; it allocated and touched
96 MiB while staying under its cgroup limit, then was removed. The actual KVM
manager is not deployed, so its cgroup values will be asserted again by
deployment `--verify`. No production container was used as the pressure target.

KVM admission fails closed unless `MemAvailable` covers the 5 GiB manager RAM
budget plus a 3 GiB host reserve, the 1-minute load plus two guest vCPUs and one
CPU headroom fits within four online CPUs, the existing 11 ephemeral slots plus
the candidate remain below the 12-runner ceiling, and the state filesystem has
at least 24 GiB plus 1 GiB headroom. The isolated shell regression now simulates
memory below the admission threshold and asserts refusal; no pressure was
applied to live services. The Beelink snapshot had enough available memory, but
its 1-minute load of 1.08 exceeded the current CPU admission threshold of 1.0,
so a live start at that instant would correctly defer. Existing Docker pools
retain their prior resource settings. The updated admission regression passed
on Linux for available memory below the 8 GiB threshold and malformed memory
input; no live host memory pressure was applied.

The 1800-second QEMU lifetime exceeds the downstream workflow's longest
20-minute job timeout by 10 minutes. The previous full guest validation, from
VM start through provisioning, test execution and teardown, took about 9
minutes, and the Gradle command itself took 3m54s. Thus the tested provisioning
plus current CI path fit inside the budget; a real Actions setup and artifact
upload remain part of the owner acceptance run. Timeout expiry kills QEMU and
removes the overlay; the lifetime is still a ceiling, not a promise to preserve
a job that exceeds it.

The deployment script defaults `.env` to the isolated checkout beside itself,
never the production checkout. Rollback now refuses when the KVM manager is
stopped or missing but a per-runner state directory remains, because it cannot
query active QEMU state without a live manager. If state inspection fails, it
also fails closed. When the manager is running, rollback holds the shared
scheduler lock and refuses while any VM is active. Deployment uses only the
dedicated Compose service with `--no-deps`, validates the read-only pinned image
and exact Docker device/mount/CPU/RAM/swap policy, and compares Pi/General/
Control IDs and start times before and after. It contains no Docker daemon
restart/prune or host-wide security-policy changes.

The downstream workflow at Draft PR #67 includes a same-repository-only guard
for each job on `pull_request`; fork PRs skip these jobs. All three jobs use only
`[self-hosted, linux, x64, n150, recursive-coder-ci]`, with no hosted fallback.
GitHub currently has run `38485469883` queued for PR-head commit
`c33410613999598ccb630e402cf73fd78c932067`; its three jobs are queued and await
the dedicated runner. This run is not evidence of live runner acceptance. The
separate job-filtered JUnit artifact change remains in PR #67 and is not merged.

Credential review found no PAT, registration token, AWS key, private key, or
bearer credential pattern in the committed diagnostics archive; the scan
reported zero matches. KVM manager code passes the short-lived registration
token to the backend over stdin, not argv; the seed is mode 0600, the guest
bootstrap token file is root-only and shredded before starting the runner, and
the PAT remains in the trusted manager environment only. The Actions runner's
own per-runner identity key is generated inside the guest as part of runner
configuration; it is destroyed with the disposable overlay and is distinct
from the PAT and registration token. As with any self-hosted runner, workflow
code on an accepted job can access its job-scoped GitHub token and runner
process credentials; therefore this pool is restricted to trusted
same-repository jobs, never fork PR jobs. GitHub warns that public-repository
fork workflows can execute dangerous code on self-hosted machines and documents
the runner's key/token lifecycle in its [security guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
and [runner authentication design](https://github.com/actions/runner/blob/main/docs/design/auth.md).

Read-only deployment checklist for the owner (never run by Codex):

```bash
cd /home/yurasik/github-runners/social-mcp-pr-794
sudo bash infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --verify
sudo bash infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --dry-run infra/github-runner-autoscaler/.env
docker inspect pi-runner-manager general-runner-manager n150-control --format '{{.Name}} {{.Id}} {{.State.Status}} {{.State.StartedAt}}'
```

The remaining workflow is owner-controlled and is not authorized by this
readiness review: install the PAT as above, inspect existing runner health,
review the dry-run and explicitly run deployment with `sudo`, then `--verify`.
If acceptance fails, cancel/wait for the active job and run `--rollback`; the
script refuses to stop an active VM. After the owner explicitly confirms
deployment, validate queued run
[`38485469883`](https://github.com/YuriiSokolenko/recursive-coder/actions/runs/38485469883)
if it remains available, or have the owner dispatch a trusted same-repository
CI run. Require all three jobs on the KVM labels, the sandbox E2E with zero
skips, uploaded JUnit, runner unregister, QEMU/overlay cleanup, and unchanged
Pi/General/Control health before calling live acceptance complete.

The guest-only change to AppArmor's unprivileged-userns restriction follows
Ubuntu's guest sysctl and Bubblewrap behavior; setuid Bubblewrap was removed from
the bootstrap. Review [Bubblewrap's security notes](https://github.com/containers/bubblewrap/blob/main/SECURITY.md)
and [Ubuntu CVE-2026-41163](https://ubuntu.com/security/CVE-2026-41163) when pinning
the guest package version. Endpoint requirements are listed in the [GitHub
self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

## Current full KVM validation and failure diagnosis — 2026-10-14

The Beelink run used the isolated worktree prepared from `afd5b8f` and the KVM
manager image built from the PR implementation. It booted the pinned Ubuntu
24.04.5 amd64 golden image (SHA-256
`6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`) as a
disposable qcow2 overlay. QEMU used `-machine q35,accel=kvm -cpu host -smp 2
-m 4096`, `-netdev user,restrict=on,ipv6=off`, and one `guestfwd` to the
loopback-only egress proxy. The command had no host forwarding, TAP/bridge, host
filesystem share, Docker socket, or Pi configuration. The manager container was
capped at 2.25 CPUs and 5 GiB; the guest overlay had a 24 GiB virtual cap and the
VM lifetime was bounded to 1800 seconds. The full CI command completed in 3m54s;
both integration repeats completed in 1m44s and 1m41s. The VM powered off and
the supervisor removed its overlay, seed, state directory, and temporary proxy.

The current run reached the manager's 5 GiB memory cap in live samples and used
about 2.38 GiB of swap at the last sample. The cgroup reported `oom=0`,
`oom_kill=0`, and `oom_group_kill=0`. An earlier run of this same current
unprivileged bootstrap measured QEMU peak RSS at 4,238,032 KiB and peak overlay
allocation at 3,502,481,408 bytes; those are separate-run peak measurements, not
claimed as the exact peak for this full-suite run. Host storage remained about
190 GiB free. The diagnostics bundle includes the exact QEMU command and the
serial policy/probe results. Its SHA-256 is
`aa6b2cb60e8a974a7b3f8ae019250a0805a35876499c1fab8a7829ffea2d98e4`.

The guest used Java 21.0.12.1, Git 2.43.0, Gradle 9.8.1, and downstream commit
`3028a05e602a9572ba41bc1f3daa28d0fdb762c0` (workflow SHA-256
`786b6fb857c10ac4ed60a94419f66068a0c91868f39021044decde3470bba491`). The exact
workflow command passed:

```text
CI=true ./gradlew --no-daemon clean test integrationTest e2eTest installDist --stacktrace
BUILD SUCCESSFUL in 3m 54s
exit=0
```

The preserved full-command JUnit XML has 524 cases: `test` 392, `integrationTest`
131, and `e2eTest` 1; each tier has zero skips, failures, and errors. The
required sandbox test appears once in the dedicated `e2eTest` tier and passed
with zero skips. The downstream legacy `test` task is deliberately unfiltered,
so its report also contains one pass of that method; `integrationTest` excludes
it. This is the existing downstream task design, not a retry. Two subsequent
`./gradlew --no-daemon integrationTest --rerun-tasks --stacktrace` runs each
passed all 131 integration cases with zero skips/failures. JUnit for both
repeats is included without stale `test` or `e2eTest` reports.

All six previously reported failures were run individually and then by their
full `SessionRuntimeTest` and `WorkspaceManagerTest` classes on the same
downstream commit. Each individual test passed (1/1, zero skips); the classes
passed (14/14 and 10/10, zero skips). They also passed in the exact clean CI
command and both repeated integration suites. The previous 15-minute failing
run did not export its XML. Its retained console only identifies the two
SessionRuntime assertions (expected terminal statuses at source lines 144 and
156), the typed-list assertion at `WorkspaceManagerTest.kt:122`, and `Refused`
exceptions from the `WorkspaceManager.open` helper at line 111 for the
path-traversal and symlink/submodule cases; it does not record the actual values
or refusal codes for those failures. The symlink-swap failure likewise has no
preserved assertion message. Git version, workspace behavior, and filesystem
security were therefore compared by rerunning on the same commit and current
bootstrap, not by altering the downstream implementation or tests. The six
failures did not reproduce, so no downstream runtime fix is justified by the
available evidence; the original root cause remains unproven because the first
run's JUnit was lost.

The report-enabled diagnostic run also caught one unrelated transient failure
in `TaskManagerTest.cancelledAttemptCannotBeOverwrittenByImmediateRetryWhileWorkerIsAlive`
at line 471 (`expected: <2> but was: <1>`). Its focused class passed in the exact
full CI run and both subsequent full integration reruns. The JUnit failure and
stacktrace are preserved in the evidence archive. No implementation change was
made without recurrence or a demonstrated scheduler defect.

The guest started nftables before running tests. Its `inet runner_egress`
output chain had `policy drop` and allowed only loopback, established traffic,
DHCP, and `10.0.2.100:3128`. The exact Bubblewrap workflow probe passed as
unprivileged UID 1001 (`BWRAP_PROBE_EXIT=0`). GitHub, GitHub API, raw GitHub, and
Gradle endpoints returned HTTP 200/200/301/200 through the proxy; an unlisted
host, direct DNS, and direct public egress were blocked. Beelink SSH, the LAN
gateway, Docker control-plane address, and representative 10/172/192 private
addresses all returned `ENETUNREACH`. HP Nano was not contacted as a live target:
**Direct connection attempts blocked; live-target verification unavailable
because HP Nano is powered off.**

The validation injected no runner registration token and never called the
GitHub registration API. The separate PAT remains an owner-only input. Backend
unit tests cover one-job admission, token isolation, timeout, guest exit, and
abandoned-state cleanup; a real Actions registration/job and cleanup-after-job
remain untested until the owner supplies the scoped PAT and separately
authorizes deployment. No host-wide policy or production service was changed.
PR #794 remains Draft.

The current-run evidence archive is
[`evidence/recursive-coder-kvm-20261014.tar.gz`](evidence/recursive-coder-kvm-20261014.tar.gz).
It contains the full Gradle console/stacktrace, 37 JUnit XML files from all
three tiers, two clean integration reruns, six focused test reports, the two
class reports, the single TaskManager failure report, and guest
network/lifecycle results. The downstream workflow artifact change is in Draft PR
[#67](https://github.com/YuriiSokolenko/recursive-coder/pull/67), which uploads
`test`, `integrationTest`, and `e2eTest` XML under `if: always()`.

The Beelink regression suite was rerun from the Linux checkout at
`ef1c34c8df30618e1e141f4f10d5d230f38529f3`. `tests/test_runner_autoscaler.sh`,
`tests/test_recursive_coder_pool.sh`, `tests/test_recursive_coder_kvm_pool.sh`,
`tests/test_recursive_coder_kvm_deploy.sh`, and
`tests/test_prepare_recursive_coder_kvm.sh` all exited 0. The Python unittest
set passed 25/25; Python AST parsing passed for all 38 Python files under the
autoscaler and tests directories. Workflow-integrity pytest passed 4/4 using
pytest 9.1.1, PyYAML 6.0.3, and pytest-asyncio 1.4.0. Both the KVM Compose
profile and repository Compose config rendered successfully with nonsecret-only
placeholders.

The pre/post regression container name/ID lists and Pi, General, and Control
manager IDs/start times matched. Rabbit logger remained unhealthy and Rabbit
viewer healthy, unchanged. Host memory/swap stayed at 12 GiB available and 208
KiB swap used; root storage had 190 GiB free. No KVM manager, QEMU process,
overlay, validation container, or diagnostics image remained. The unprivileged
deployment dry-run failed before Docker access because the prepared golden
directory's root-only parent is not traversable by the SSH user; the owner
should run this read-only preflight with `sudo`. No privileged command was run.

ShellCheck 0.10.0 ran in a disposable container with the source mounted
read-only. The three production KVM scripts passed `shellcheck
--severity=warning`. The broad default scan across those scripts and five
regression scripts exited 1 with 22 SC2034 warnings and 259 informational
findings: SC2317 215, SC2016 19, SC2015 17, SC1091 2, SC2012 2, SC2030 2, and
SC2031 2. Most are indirect test functions invoked through the sourced manager.
No suppressions were added.
