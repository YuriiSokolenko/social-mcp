FROM node:24-bookworm-slim

ARG ACTIONS_RUNNER_VERSION=2.337.0
ARG ACTIONS_RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git gosu jq tar gzip \
      libcurl4 libicu72 libkrb5-3 liblttng-ust1 libssl3 libunwind8 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash runner \
    && install -d -o runner -g runner /home/runner/actions-runner

WORKDIR /home/runner/actions-runner

RUN curl -fsSL \
      "https://github.com/actions/runner/releases/download/v${ACTIONS_RUNNER_VERSION}/actions-runner-linux-x64-${ACTIONS_RUNNER_VERSION}.tar.gz" \
      -o /tmp/actions-runner.tar.gz \
    && echo "${ACTIONS_RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/actions-runner.tar.gz -C /home/runner/actions-runner \
    && rm /tmp/actions-runner.tar.gz \
    && chown -R runner:runner /home/runner/actions-runner

COPY infra/github-runner-autoscaler/control-runner-entrypoint.sh /usr/local/bin/control-runner-entrypoint
RUN chmod 0755 /usr/local/bin/control-runner-entrypoint

ENTRYPOINT ["/usr/local/bin/control-runner-entrypoint"]
