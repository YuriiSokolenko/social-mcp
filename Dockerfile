FROM python:3.12-slim AS builder

WORKDIR /install

# Install runtime dependencies in a source-independent layer. Hatchling needs
# the README and package sources only when building the project wheel below.
COPY pyproject.toml README.md ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python -c 'import pathlib, tomllib; deps = tomllib.loads(pathlib.Path("pyproject.toml").read_text())["project"]["dependencies"]; pathlib.Path("/tmp/requirements.txt").write_text("\n".join(deps) + "\n")' \
    && pip install --prefix=/install -r /tmp/requirements.txt

COPY src ./src
RUN pip install --no-deps --no-cache-dir --prefix=/install .

# Runtime stage: minimal image with only the installed package.
FROM python:3.12-slim AS runtime

# Create an unprivileged user and the writable data directory before switching.
# The data directory is where the SQLite account store and encrypted tokens live;
# it is mounted from a persistent volume in Compose so account data and token
# blobs survive container replacement.
RUN groupadd --system social-mcp \
    && useradd --system --gid social-mcp --create-home social-mcp \
    && mkdir -p /data \
    && chown social-mcp:social-mcp /data

COPY --from=builder /install /usr/local

USER social-mcp

WORKDIR /app

ENV DATABASE_URL=sqlite:////data/social-mcp.db
EXPOSE 8000

CMD ["uvicorn", "social_mcp.app:app", "--host", "0.0.0.0", "--port", "8000"]
