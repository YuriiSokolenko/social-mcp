FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir .

RUN mkdir -p /data

ENV DATABASE_URL=sqlite:////data/social-mcp.db
EXPOSE 8000

CMD ["uvicorn", "social_mcp.app:app", "--host", "0.0.0.0", "--port", "8000"]
