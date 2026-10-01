"""Probe the raw file on disk in the sandbox."""


def test_dump_raw():
    import social_mcp.exercises as pkg

    path = "src/social_mcp/exercises/text_buffer.py"
    try:
        raw = open(path, encoding="utf-8").read()
    except OSError as exc:
        raw = f"<no {path}: {exc}>"
    lines = raw.splitlines()
    seg = [ln for ln in lines if "invert" in ln or "removed" in ln]
    raise AssertionError(f"pkg={pkg.__file__!r} seg={seg!r} <<END")
