ARG RUNNER_PLATFORM=linux/amd64
FROM --platform=${RUNNER_PLATFORM} node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ARG ACTIONS_RUNNER_VERSION=2.337.0
ARG ACTIONS_RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
ARG PI_CODING_AGENT_VERSION=0.87.1
ARG PI_MCP_ADAPTER_VERSION=3.2.0
ARG LSP_MCP_SERVER_VERSION=1.1.25
ARG GIT_CONTEXT_MCP_VERSION=1.0.0
ARG AST_GREP_VERSION=0.45.3
ARG BASEDPYRIGHT_VERSION=1.40.1
ARG KOTLIN_LSP_VERSION=263.4702.0
ARG KOTLIN_LSP_SHA256=1e11d2e5fefbf9ea215ad8dd6be95f2222897cd086e8cb7a661a52084a590405
ARG MINI_SWE_AGENT_VERSION=2.4.6

USER root
COPY infra/github-runner-autoscaler/worker-entrypoint.sh /usr/local/bin/runner-entrypoint
COPY infra/github-runner-autoscaler/lsp-mcp-server-wrapper.mjs /tmp/lsp-mcp-server-wrapper.mjs
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git jq python3 python3-venv sudo tar gzip \
      libcurl4 libicu72 libkrb5-3 liblttng-ust1 libssl3 libunwind8 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 --shell /bin/bash runner \
    && printf 'runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner \
    && install -d -o runner -g runner /home/runner/actions-runner /opt/kotlin-lsp \
    && curl -fsSL \
      "https://github.com/actions/runner/releases/download/v${ACTIONS_RUNNER_VERSION}/actions-runner-linux-x64-${ACTIONS_RUNNER_VERSION}.tar.gz" \
      -o /tmp/actions-runner.tar.gz \
    && echo "${ACTIONS_RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/actions-runner.tar.gz -C /home/runner/actions-runner \
    && rm /tmp/actions-runner.tar.gz \
    && chown -R runner:runner /home/runner/actions-runner /opt/kotlin-lsp \
    && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}" \
      @gitlab/orbit@0.130.0 "lsp-mcp-server@${LSP_MCP_SERVER_VERSION}" "git-context-mcp@${GIT_CONTEXT_MCP_VERSION}" \
    && npm install --prefix /opt/ast-grep "@ast-grep/cli@${AST_GREP_VERSION}" \
    && ln -s /opt/ast-grep/node_modules/.bin/ast-grep /usr/local/bin/ast-grep \
    && python3 -m venv /opt/basedpyright \
    && /opt/basedpyright/bin/python -m pip install --no-cache-dir "basedpyright==${BASEDPYRIGHT_VERSION}" \
    && ln -s /opt/basedpyright/bin/basedpyright /usr/local/bin/basedpyright \
    && ln -s /opt/basedpyright/bin/basedpyright-langserver /usr/local/bin/basedpyright-langserver \
    && python3 -m venv /opt/mini-swe-agent \
    && /opt/mini-swe-agent/bin/python -m pip install --no-cache-dir "mini-swe-agent==${MINI_SWE_AGENT_VERSION}" \
    && ln -s /opt/mini-swe-agent/bin/mini /usr/local/bin/mini \
    && curl -fsSL "https://download.jetbrains.com/language-server/kotlin-server/${KOTLIN_LSP_VERSION}/kotlin-server-${KOTLIN_LSP_VERSION}.tar.gz" -o /tmp/kotlin-lsp.tar.gz \
    && echo "${KOTLIN_LSP_SHA256}  /tmp/kotlin-lsp.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/kotlin-lsp.tar.gz --strip-components=1 -C /opt/kotlin-lsp \
    && rm /tmp/kotlin-lsp.tar.gz \
    && ln -s /opt/kotlin-lsp/bin/intellij-server /usr/local/bin/kotlin-lsp \
    && install -d -o runner -g runner /opt/pi-adapter-seed \
    && chmod 0755 /usr/local/bin/runner-entrypoint \
    && rm -f /usr/local/bin/lsp-mcp-server \
    && install -m 0755 /tmp/lsp-mcp-server-wrapper.mjs /usr/local/bin/lsp-mcp-server \
    && rm /tmp/lsp-mcp-server-wrapper.mjs \
    && pi --version \
    && ast-grep --version \
    && orbit version \
    && mini --help >/dev/null

USER runner
ENV HOME=/home/runner \
    npm_config_cache=/tmp/pi-runner-npm-cache \
    PI_MCP_ADAPTER_VERSION=${PI_MCP_ADAPTER_VERSION}
RUN pi install --no-approve "npm:pi-mcp-adapter@${PI_MCP_ADAPTER_VERSION}" \
    && mkdir -p /opt/pi-adapter-seed \
    && cp -a /home/runner/.pi/agent/npm /opt/pi-adapter-seed/
USER root
RUN chmod -R a+rX /opt/pi-adapter-seed

USER runner
WORKDIR /home/runner/actions-runner
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
