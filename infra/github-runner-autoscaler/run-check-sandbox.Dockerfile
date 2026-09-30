FROM node:24-bookworm-slim AS node-runtime

ARG TYPEBOX_VERSION=1.1.38
RUN npm install --global --no-audit --no-fund "typebox@${TYPEBOX_VERSION}"

FROM python:3.12-slim-bookworm

ARG RUFF_VERSION=0.12.12
ARG PYTEST_VERSION=9.0.2
ARG PYTEST_ASYNCIO_VERSION=1.3.0
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

COPY infra/github-runner-autoscaler/run-check-sandbox-exec.py /usr/local/lib/run-check-sandbox-exec.py
COPY infra/github-runner-autoscaler/run-check-sandbox-probe.py /usr/local/lib/run-check-sandbox-probe.py

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir \
      "ruff==${RUFF_VERSION}" \
      "pytest==${PYTEST_VERSION}" \
      "pytest-asyncio==${PYTEST_ASYNCIO_VERSION}" \
      'mcp[cli]>=2,<3' \
      'fastapi>=0.116,<1' \
      'uvicorn[standard]>=0.35,<1' \
      'httpx>=0.28,<1' \
      'pydantic>=2.12,<3' \
      'pydantic-settings>=2.10,<3' \
      'cryptography>=45,<47' \
      'itsdangerous>=2.1,<3' \
      'python-multipart>=0.0.18,<1' \
    && mkdir -p /node_modules /workspace \
    && ln -s /usr/local/lib/node_modules/typebox /node_modules/typebox \
    && chown 1001:1001 /workspace \
    && chmod 0755 /workspace \
    && chmod 0555 /usr/local/lib/run-check-sandbox-exec.py /usr/local/lib/run-check-sandbox-probe.py

ENV PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/tmp \
    TMPDIR=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONIOENCODING=utf-8 \
    PYTHONPATH=/workspace/src \
    RUFF_CACHE_DIR=/tmp/ruff

WORKDIR /workspace
USER 1001:1001
