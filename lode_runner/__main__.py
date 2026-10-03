"""Run the game: ``python -m lode_runner``."""

from __future__ import annotations

import sys

from .cli import main

if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        print("\nInterrupted.")
        sys.exit(130)
