FROM docker:29.9.0-cli@sha256:1a4c7cb63513f349bdad01fcc6e0f3f2f67d37b9da86f14dc0d4a0942eecda00

ARG NODE_VERSION=26.11.1
ARG NODE_SHA256=8d31c2180212503799c3c93924db216e236de769b4ca1fdfe85a33ebacae510c
ARG NPM_VERSION=12.2.0
RUN apk add --no-cache bash curl jq coreutils xz libatomic libgcc libstdc++ \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64-musl.tar.xz" -o /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
    && rm /tmp/node.tar.xz \
    && npm install --global "npm@${NPM_VERSION}" \
    && node --version && npm --version

COPY infra/github-runner-autoscaler/manager.sh /usr/local/bin/pi-runner-manager
COPY infra/github-runner-autoscaler/run-check-executor.mjs /usr/local/lib/run-check-executor.mjs
COPY .agent-harness.json /opt/social-mcp/.agent-harness.json
COPY scripts/pi-common/run-check.mjs /opt/social-mcp/scripts/pi-common/run-check.mjs
COPY scripts/pi-common/diagnostics-artifact.mjs /opt/social-mcp/scripts/pi-common/diagnostics-artifact.mjs
COPY scripts/pi-common/package-root-check.mjs /opt/social-mcp/scripts/pi-common/package-root-check.mjs
COPY scripts/pi-common/run-check-docker-backend.mjs /opt/social-mcp/scripts/pi-common/run-check-docker-backend.mjs
COPY scripts/pi-common/project-config.mjs /opt/social-mcp/scripts/pi-common/project-config.mjs
COPY scripts/pi-common/ruff-spec.mjs /opt/social-mcp/scripts/pi-common/ruff-spec.mjs
RUN mkdir -p /opt/social-mcp/src
RUN chmod +x /usr/local/bin/pi-runner-manager /usr/local/lib/run-check-executor.mjs

ENTRYPOINT ["/usr/local/bin/pi-runner-manager"]
