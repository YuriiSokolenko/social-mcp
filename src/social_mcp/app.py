from fastapi import FastAPI

app = FastAPI(
    title="Social MCP",
    version="0.1.0",
)


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ping", tags=["system"])
async def ping() -> dict[str, str]:
    return {"message": "pong"}
