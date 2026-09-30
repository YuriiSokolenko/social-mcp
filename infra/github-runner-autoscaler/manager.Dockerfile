FROM docker:28-cli

RUN apk add --no-cache bash curl jq coreutils nodejs

COPY infra/github-runner-autoscaler/manager.sh /usr/local/bin/pi-runner-manager
COPY infra/github-runner-autoscaler/run-check-executor.mjs /usr/local/lib/run-check-executor.mjs
COPY .agent-harness.json /opt/social-mcp/.agent-harness.json
COPY scripts/pi-common/run-check.mjs /opt/social-mcp/scripts/pi-common/run-check.mjs
COPY scripts/pi-common/run-check-docker-backend.mjs /opt/social-mcp/scripts/pi-common/run-check-docker-backend.mjs
COPY scripts/pi-common/project-config.mjs /opt/social-mcp/scripts/pi-common/project-config.mjs
COPY scripts/pi-common/ruff-spec.mjs /opt/social-mcp/scripts/pi-common/ruff-spec.mjs
RUN chmod +x /usr/local/bin/pi-runner-manager /usr/local/lib/run-check-executor.mjs

ENTRYPOINT ["/usr/local/bin/pi-runner-manager"]
