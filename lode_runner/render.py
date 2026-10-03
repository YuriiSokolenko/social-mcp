"""Terminal-independent rendering: the game state becomes plain text lines.

The terminal layer in :mod:`lode_runner.terminal` only moves those lines onto
the screen, so every visual rule here is testable without a TTY.
"""

from __future__ import annotations

from .engine import OUTCOME_GAME_OVER, OUTCOME_WON, Engine
from .levels import Level

#: Glyph sets.  ``ascii`` is the fallback required for terminals without
#: Unicode support; ``unicode`` is the default.
GLYPHS = {
    "ascii": {
        "player": "@",
        "guard": "%",
        "brick": "#",
        "solid": "=",
        "ladder": "\"",
        "rope": "-",
        "gold": "*",
        "exit": "+",
        "empty": " ",
        "hole": " ",
    },
    "unicode": {
        "player": "\u25cf",
        "guard": "\u00d7",
        "brick": "\u2593",
        "solid": "\u2588",
        "ladder": "\u2616",
        "rope": "\u2248",
        "gold": "\u25c6",
        "exit": "\u25a1",
        "empty": " ",
        "hole": "\u00b7",
    },
}

TERRAIN_TO_KEY = {
    "#": "solid",
    "B": "brick",
    "L": "ladder",
    "=": "rope",
    "o": "gold",
    "X": "exit",
    " ": "empty",
}


class Renderer:
    """Turns an :class:`~lode_runner.engine.Engine` into screen lines."""

    def __init__(self, charset: str = "ascii", help_overlay: bool = False) -> None:
        if charset not in GLYPHS:
            raise ValueError(f"unknown charset: {charset}")
        self.charset = charset
        self.glyphs = GLYPHS[charset]
        self.help_overlay = help_overlay

    # ---------------------------------------------------------------- helpers
    def _terrain_glyph(self, symbol: str) -> str:
        return self.glyphs[TERRAIN_TO_KEY.get(symbol, "empty")]

    def status_lines(self, engine: Engine) -> list[str]:
        game = engine.game
        state = "PAUSED" if engine.paused else "RUNNING"
        if engine.outcome == OUTCOME_WON:
            state = "COMPLETE"
        elif engine.outcome == OUTCOME_GAME_OVER:
            state = "GAME OVER"
        gold = game.remaining_gold
        return [
            "LODE RUNNER-STYLE            level {n}/10   {s}   score {p:6d}   lives {l}   gold left {g}".format(
                n=engine.level_index + 1,
                s=state,
                p=engine.score,
                l=engine.lives_left,
                g=gold,
            )
        ]

    def board_lines(self, engine: Engine) -> list[str]:
        game = engine.game
        rows = game.terrain_rows()
        width = game.level.width
        lines = [list(" " * width) for _ in rows]
        for y, row in enumerate(rows):
            for x, symbol in enumerate(row):
                if (x, y) in game.holes:
                    lines[y][x] = self.glyphs["hole"]
                else:
                    lines[y][x] = self._terrain_glyph(symbol)
        for guard in game.guards:
            if not guard.dead:
                lines[guard.y][guard.x] = self.glyphs["guard"]
        player = game.player
        if not player.dead:
            lines[player.y][player.x] = self.glyphs["player"]
        return ["".join(line) for line in lines]

    def help_lines(self) -> list[str]:
    def frame(self, engine: Engine, width: int, height: int) -> list[str]:
        """Compose one full screen (status, board, help/rules, message)."""
        status = self.status_lines(engine)
        board = self.board_lines(engine)
        notes: list[str] = []
        if self.help_overlay:
            notes.extend(self.help_lines())
        else:
            notes.append(
                "H help | arrows/WASD move | Z dig left | X dig right | P pause | R restart | Q quit"
            )
        if engine.game.message:
            notes.append(engine.game.message)
        if engine.outcome == OUTCOME_GAME_OVER:
            notes.append("GAME OVER - final score {p}. Q quits.".format(p=engine.score))
        if engine.outcome == OUTCOME_WON:
            notes.append("YOU BEAT ALL TEN LEVELS - final score {p}. Q quits.".format(p=engine.score))

        # Keep the whole board visible: trim notes before trimming the board.
        available = max(height, len(status) + len(board))
        while len(notes) > 1 and len(status) + len(board) + len(notes) > available:
            notes.pop(0)
        while board and len(status) + len(board) + len(notes) > available:
            board.pop()
        return _fit(status + board + notes, width, height)

    def screen(self, engine: Engine) -> str:
        """The current frame as one string (used by the terminal loop)."""
        return "\n".join(self.frame(engine, 80, 40))
            notes.append("YOU BEAT ALL TEN LEVELS - final score {p}. Q quits.".format(p=engine.score))
        spare = height - len(lines) - len(notes)
        if spare < 0:
            board = board[: max(0, len(board) + spare)]
            lines = self.status_lines(engine) + board
        lines.extend(notes)
        return _fit(lines, width, max(len(board) + len(notes) + 2, height))

    def legend_lines(self, level: Level) -> list[str]:
        return [
            f"{self.glyphs['player']} player                      {self.glyphs['guard']} guard",
            f"{self.glyphs['gold']} gold                        {self.glyphs['exit']} exit",
            f"{self.glyphs['brick']} brick (diggable)            {self.glyphs['solid']} solid block",
            f"{self.glyphs['ladder']} ladder                      {self.glyphs['rope']} rope",
        ]


def _fit(lines: list[str], width: int, height: int) -> list[str]:
    out = [line[:width].ljust(width) for line in lines]
    while len(out) < height:
        out.append(" " * width)
    return out[:height]


def render_screen(engine: Engine, width: int, height: int, charset: str = "ascii") -> list[str]:
    """One-shot text screen, used by tests and by the terminal painter."""
    return Renderer(charset).frame(engine, width, height)
