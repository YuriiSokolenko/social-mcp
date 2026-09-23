from fastapi import FastAPI

VERSION = "0.1.0"

app = FastAPI(
    title="Social MCP",
    version=VERSION,
)


@app.get("/health", tags=["system"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version", tags=["system"])
async def version() -> dict[str, str]:
    return {"version": VERSION}
