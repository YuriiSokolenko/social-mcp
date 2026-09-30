FROM n150/github-pi-runner:0.87.1

ARG PI_MCP_ADAPTER_VERSION=3.2.0
ARG LSP_MCP_SERVER_VERSION=1.1.25
ARG GIT_CONTEXT_MCP_VERSION=1.0.0
ARG AST_GREP_VERSION=0.45.3
ARG BASEDPYRIGHT_VERSION=1.40.1
ARG KOTLIN_LSP_VERSION=263.4702.0
ARG KOTLIN_LSP_SHA256=1e11d2e5fefbf9ea215ad8dd6be95f2222897cd086e8cb7a661a52084a590405
ARG MINI_SWE_AGENT_VERSION=2.4.6

USER root
COPY infra/github-runner-autoscaler/worker-entrypoint.sh /usr/local/bin/pi-runner-entrypoint
COPY infra/github-runner-autoscaler/lsp-mcp-server-wrapper.mjs /usr/local/bin/lsp-mcp-server
RUN chmod +x /usr/local/bin/pi-runner-entrypoint /usr/local/bin/lsp-mcp-server \
    && npm install -g @gitlab/orbit@0.130.0 "lsp-mcp-server@${LSP_MCP_SERVER_VERSION}" "git-context-mcp@${GIT_CONTEXT_MCP_VERSION}" \
    && npm install --prefix /opt/ast-grep "@ast-grep/cli@${AST_GREP_VERSION}" \
    && ln -s /opt/ast-grep/node_modules/.bin/ast-grep /usr/local/bin/ast-grep \
    && install -d -o runner -g runner /opt/kotlin-lsp \
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
    && ast-grep --version \
    && orbit version \
    && mini --help >/dev/null

USER runner
ENV npm_config_cache=/tmp/pi-runner-npm-cache \
    PI_MCP_ADAPTER_VERSION=${PI_MCP_ADAPTER_VERSION}
RUN pi install --no-approve "npm:pi-mcp-adapter@${PI_MCP_ADAPTER_VERSION}" \
    && mkdir -p /opt/pi-adapter-seed \
    && cp -a /home/runner/.pi/agent/npm /opt/pi-adapter-seed/
USER root
RUN chmod -R a+rX /opt/pi-adapter-seed

USER runner
ENTRYPOINT ["/usr/local/bin/pi-runner-entrypoint"]
