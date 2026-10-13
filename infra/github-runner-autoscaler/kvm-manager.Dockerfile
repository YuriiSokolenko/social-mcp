FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl jq netcat-openbsd qemu-system-x86 \
      qemu-utils util-linux xorriso \
    && rm -rf /var/lib/apt/lists/*

COPY infra/github-runner-autoscaler/manager.sh /usr/local/bin/pi-runner-manager
COPY infra/github-runner-autoscaler/kvm-backend.py /usr/local/bin/kvm-backend.py
COPY infra/github-runner-autoscaler/kvm-egress-proxy.py /usr/local/bin/kvm-egress-proxy.py
COPY infra/github-runner-autoscaler/kvm-proxy-bridge /usr/local/bin/kvm-proxy-bridge
RUN chmod 0755 /usr/local/bin/pi-runner-manager /usr/local/bin/kvm-backend.py \
      /usr/local/bin/kvm-proxy-bridge

ENTRYPOINT ["/usr/local/bin/pi-runner-manager"]
