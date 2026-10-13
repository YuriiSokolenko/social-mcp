ARG RUNNER_PLATFORM=linux/amd64
FROM --platform=${RUNNER_PLATFORM} python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS python-runtime
FROM --platform=${RUNNER_PLATFORM} ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG JAVA_VERSION=21.0.12.1_1
ARG JAVA_RELEASE=21.0.12.1%2B1
ARG JAVA_SHA256=ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94
ARG ACTIONS_RUNNER_VERSION=2.338.0
ARG ACTIONS_RUNNER_SHA256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32
COPY --from=python-runtime /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq bubblewrap tar gzip xz-utils unzip \
      libatomic1 libcurl4 libgcc-s1 libicu74 libkrb5-3 liblttng-ust1 libssl3t64 libstdc++6 libunwind8 zlib1g libbz2-1.0 libffi8 liblzma5 libreadline8t64 libsqlite3-0 libncursesw6 libgdbm6t64 libuuid1 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && mkdir -p /opt/java \
    && curl -fsSL "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JAVA_RELEASE}/OpenJDK21U-jdk_x64_linux_hotspot_${JAVA_VERSION}.tar.gz" -o /tmp/java.tar.gz \
    && echo "${JAVA_SHA256}  /tmp/java.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/java.tar.gz --strip-components=1 -C /opt/java \
    && useradd --create-home --uid 1001 --shell /bin/bash runner \
    && mkdir -p /home/runner/actions-runner /opt/hostedtoolcache \
    && curl -fsSL "https://github.com/actions/runner/releases/download/v${ACTIONS_RUNNER_VERSION}/actions-runner-linux-x64-${ACTIONS_RUNNER_VERSION}.tar.gz" -o /tmp/runner.tar.gz \
    && echo "${ACTIONS_RUNNER_SHA256}  /tmp/runner.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/runner.tar.gz -C /home/runner/actions-runner \
    && chown -R runner:runner /home/runner /opt/hostedtoolcache \
    && rm /tmp/node.tar.xz /tmp/java.tar.gz /tmp/runner.tar.gz
ENV HOME=/home/runner JAVA_HOME=/opt/java PATH=/opt/java/bin:/usr/local/bin:/usr/bin:/bin \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
COPY infra/github-runner-autoscaler/recursive-coder-entrypoint.sh /usr/local/bin/recursive-coder-entrypoint
COPY infra/github-runner-autoscaler/recursive-coder-probe.sh /usr/local/bin/recursive-coder-probe
RUN chmod 0755 /usr/local/bin/recursive-coder-* \
    && java -version && node --version && python3 --version
WORKDIR /home/runner/actions-runner
USER runner
ENTRYPOINT ["/usr/local/bin/recursive-coder-entrypoint"]
