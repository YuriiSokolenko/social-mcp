# Recursive-coder CI pool — issue #793

Status: **KVM backend, manager integration, egress proxy, owner preparation and deployment tooling are implemented; current guest bootstrap awaits owner image staging and real-VM validation; not deployed**.
The guest bootstrap now uses unprivileged user namespaces plus a guest-only nftables
egress allow rule. That bootstrap revision still needs a fresh real-VM run before
deployment. The owner alone performs privileged deployment.

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
Bubblewrap unprivileged and enables user namespaces in the disposable guest. The
current bootstrap still needs a fresh VM validation.

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
user-namespace plus nftables bootstrap has unit coverage but has not yet been
rebooted in a real guest. The pinned golden image was no longer present on N150,
and direct HTTPS from both the SSH host and a disposable Docker container timed
out while trying to fetch it. No attempt was made to bypass that network boundary.

The current bootstrap has **not** been credited with the previous 524-test
result. It still requires a real boot after preparation, including the exact
workflow Bubblewrap probe, positive and negative sandbox tests with zero skips,
loopback/proxy checks, direct/private/DNS blocking, Gradle CI, and shutdown plus
overlay cleanup. The actual ephemeral Actions service and job also remain
untested; the separately scoped PAT is still an owner-only gate.

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
registration-token POST remain owner actions. The new guest bootstrap must be
validated against the pinned golden image before deploy. Re-run the full guest CI
and network boundary checklist after that validation; the earlier real-VM result
does not prove the changed bootstrap. Existing Pi, General, Control and
`n150-gen-eph-*` container IDs remained unchanged during Beelink validation; no
KVM guest or validation container remains running.

## Owner commands

Use a clean checkout of this Draft PR on Beelink. Keep the separately scoped
fine-grained PAT in the protected `.env` file as
`RECURSIVE_CODER_GH_ADMIN_TOKEN` (regular file, mode 0600). Grant only the
recursive-coder repository permissions required for Actions read and runner
Administration read/write. Never put the PAT or a registration token in shell
arguments, issue comments or logs.

N150's current direct route reaches GitHub and the Ubuntu package archive, but
times out fetching `cloud-images.ubuntu.com`. Download the official amd64 image
on a network-permitted Mac, verify the pinned checksum there, and stage it at
`/tmp/noble-server-cloudimg-amd64.img` on Beelink. The preparation script checks
the same checksum and image metadata before installation:

```bash
curl -fL --retry 3 https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img -o noble-server-cloudimg-amd64.img
echo '6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2  noble-server-cloudimg-amd64.img' | shasum -a 256 -c -
scp noble-server-cloudimg-amd64.img beelink:/tmp/noble-server-cloudimg-amd64.img
ssh beelink 'sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --dry-run'
ssh beelink 'sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --prepare'
ssh beelink 'sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --verify'
```

After a fresh real-VM bootstrap validation and owner review, run the read-only
preflight and inspect the output:

```bash
bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --dry-run /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
```

The preparation script creates
`/var/lib/recursive-coder-kvm/{golden,state}` with root ownership and modes 0755
and 0700, and installs the golden image as mode 0444. The separate deployment
script requires these prepared assets, checks their pinned SHA-256, builds only
the KVM manager image, verifies the exact device,
mount and resource settings, and starts only the new Compose service:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --deploy /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --verify /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
```

Rollback acquires the shared scheduler lock, refuses to interrupt an active VM,
and removes/restores only the KVM manager and its saved image/configuration:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh --rollback /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env
```

To undo host preparation before deployment, the separate rollback refuses to
run while a KVM manager or VM state exists. It removes only a golden image this
preparation transaction installed and preserves the staged source and
directories:

```bash
sudo bash /home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh --rollback
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
shellcheck infra/github-runner-autoscaler/manager.sh infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh tests/test_recursive_coder_kvm_pool.sh tests/test_recursive_coder_kvm_deploy.sh
shellcheck infra/github-runner-autoscaler/prepare-recursive-coder-kvm.sh tests/test_prepare_recursive_coder_kvm.sh
bash tests/test_prepare_recursive_coder_kvm.sh
docker compose --env-file infra/github-runner-autoscaler/.env.example -f infra/github-runner-autoscaler/compose.yaml --profile recursive-coder-kvm config --quiet
```

The guest-only change to AppArmor's unprivileged-userns restriction follows
Ubuntu's guest sysctl and Bubblewrap behavior; setuid Bubblewrap was removed from
the bootstrap. Review [Bubblewrap's security notes](https://github.com/containers/bubblewrap/blob/main/SECURITY.md)
and [Ubuntu CVE-2026-41163](https://ubuntu.com/security/CVE-2026-41163) when pinning
the guest package version. Endpoint requirements are listed in the [GitHub
self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).
