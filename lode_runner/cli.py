"""Command line entry point for ``lode_runner``.

``python -m lode_runner`` starts the game.  ``--check`` (also used by the test
suite) validates the ten level maps and exits non-zero if any of them is
malformed, which is the documented solvability-validation hook.
"""

from __future__ import annotations

import argparse
import sys

from .levels import LEGEND, load_levels


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lode_runner", description="A Lode Runner-style terminal game")
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate all ten levels and print their summaries, then exit",
    )
    parser.add_argument("--legend", action="store_true", help="print the level symbol legend and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.legend:
        for symbol, name, description in LEGEND:
            print(f"{symbol!r:>4}  {name:14} {description}")
        return 0
    if args.check:
        for level in load_levels():
            print(
                f"level {level.number:2d}: {level.name:15} {level.width}x{level.height}"
                f"  gold={len(level.gold)} guards={len(level.guard_starts)}"
                f"  dig={'required' if level.require_dig else 'optional'}"
            )
        return 0
    from .app import main as game_main

    return game_main()

if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
