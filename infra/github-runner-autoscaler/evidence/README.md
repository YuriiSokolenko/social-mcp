# Recursive-coder KVM validation evidence

`recursive-coder-kvm-20261014.tar.gz` contains sanitized evidence exported from
the disposable Ubuntu 24.04.5 guest before shutdown and overlay deletion.

- Downstream source: `YuriiSokolenko/recursive-coder`
- Commit: `3028a05e602a9572ba41bc1f3daa28d0fdb762c0`
- Workflow SHA-256: `786b6fb857c10ac4ed60a94419f66068a0c91868f39021044decde3470bba491`
- Full command: `CI=true ./gradlew --no-daemon clean test integrationTest e2eTest installDist --stacktrace`
- Full command result: exit 0; 524 cases; zero skips, failures, or errors
- Tier counts: `test` 392, `integrationTest` 131, `e2eTest` 1
- Stability runs: two forced integration reruns, each 131 cases with zero skips/failures
- Sandbox: one passing case in `e2eTest`; the existing unfiltered `test` tier also
  executes that method once, while `integrationTest` excludes it
- Six original failures: individually and by class passed on the same source commit;
  no implementation change was justified because they did not recur

The archive includes the full Gradle output/stacktrace, every full-command JUnit
XML file, integration-only XML from each stability run, focused reports for all
six original failures, class reports, the one transient TaskManager diagnostic
failure, and selected guest network/bootstrap/shutdown evidence. The original
failed six-test run did not preserve JUnit XML, so the archive cannot recover
those missing assertion values.

SHA-256:

```text
aa6b2cb60e8a974a7b3f8ae019250a0805a35876499c1fab8a7829ffea2d98e4  recursive-coder-kvm-20261014.tar.gz
```

No PAT, registration token, VM overlay, seed image, or complete guest disk is
included.
