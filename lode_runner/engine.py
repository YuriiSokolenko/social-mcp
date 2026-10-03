"""Progression, lives, and scoring around the deterministic level model."""

from __future__ import annotations

from dataclasses import dataclass

from .game import Game
from .levels import Level, load_levels

#: Starting lives for a new game (the issue requires a minimum of three).
STARTING_LIVES = 3

OUTCOME_RUNNING = "running"
OUTCOME_LEVEL_COMPLETE = "level_complete"
OUTCOME_GAME_OVER = "game_over"
OUTCOME_WON = "won"


@dataclass
class EngineConfig:
    lives: int = STARTING_LIVES
    max_level: int | None = None


class Engine:
    """Runs the ten levels in order, tracking lives and score.

    Death semantics (documented and covered by tests):

    * A death restarts the current level from its initial deterministic state
      and restores the score the player had when the level started, so a
      restart can never be used to farm points.
    * Losing the last life ends the game.
    """

    def __init__(self, levels: list[Level] | None = None, lives: int = STARTING_LIVES) -> None:
        self.levels = list(levels if levels is not None else load_levels())
        if not self.levels:
            raise ValueError("no levels supplied")
        self.starting_lives = lives
        self.paused = False
        self.restart()

    def restart(self) -> None:
        """Start a new game from level one."""
        self.level_index = 0
        self.lives = self.starting_lives
        self.score = 0
        self.outcome = OUTCOME_RUNNING
        self.paused = False
        self._start_level()

    def _start_level(self) -> None:
        self.level_score = self.score
        self.game = Game(self.levels[self.level_index])
        self.level_restarts = 0

    # ---------------------------------------------------------------- control
    @property
    def level(self) -> Level:
        return self.levels[self.level_index]

    @property
    def lives_left(self) -> int:
        return self.lives

    @property
    def remaining_gold(self) -> int:
        return self.game.remaining_gold

    def toggle_pause(self) -> None:
        self.paused = not self.paused

    def restart_level(self) -> None:
        """R key: restore the current level's initial deterministic state."""
        self.score = self.level_score
        self.game.reset()

    def step(self, action: int) -> None:
        """One deterministic tick; freezes while paused."""
        if self.paused or self.outcome != OUTCOME_RUNNING:
            return
        self.game.step(action)
        if self.game.player_dead:
            self._lose_life()
        elif self.game.level_complete:
            self._complete_level()

    def _lose_life(self) -> None:
        self.lives -= 1
        if self.lives <= 0:
            self.lives = 0
            self.outcome = OUTCOME_GAME_OVER
            return
        # Death restores the level and the score the player started it with.
        self.score = self.level_score
        self.game.reset()
        self.level_restarts += 1

    def _complete_level(self) -> None:
        self.score = self.game.score
        self.level_score = self.score
        if self.level_index + 1 >= len(self.levels):
            self.outcome = OUTCOME_WON
            return
        self.level_index += 1
        self.game = Game(self.levels[self.level_index])
        self.level_restarts = 0
        self.level_score = self.score
        self.outcome = OUTCOME_RUNNING


def new_game(levels: list[Level] | None = None) -> Engine:
    return Engine(levels)
