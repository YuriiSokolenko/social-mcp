"""Deterministic core game model: state, movement, gravity, digging, entities.

This module has no terminal or timing dependencies: every rules change happens
inside :meth:`Game.step`, which takes an explicit player action and advances the
simulation by exactly one tick.  The terminal layer only translates keys into
actions and renders the resulting state.

Rules implemented here
----------------------
* The player walks left/right, climbs ladders, hangs from and walks along
  ropes, and falls when nothing supports them.
* All gold must be resolved (collected by the player, or back on the board after
  a guard dropped it) before the exit opens; stepping onto an open exit
  completes the level.
* While supported, the player can dig diagonally down-left or down-right into
  brick.  A dug hole stays open for ``HOLE_LIFETIME`` ticks and then regenerates.
* Guards chase the player with a bounded breadth-first search using documented
  deterministic tie-breaks, fall into holes, get trapped, climb out, and die if
  a regenerating brick encloses them.
* Guards may pick gold up and always drop it back on its home cell, so a guard
  can never permanently hide required gold.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .levels import BRICK, Level

#: Ticks a dug hole stays open before the brick regenerates.
HOLE_LIFETIME = 60
#: Ticks a trapped guard stays stuck before climbing out.
TRAP_DURATION = 20
#: Ticks a dead guard stays away before respawning at its start cell.
RESPAWN_DELAY = 20
#: Ticks a guard carries gold before dropping it back on the board.
CARRY_TIME = 30
#: Upper bound on the number of nodes the guard path search expands.
SEARCH_LIMIT = 6000

# Player actions.
ACTION_NONE = 0
ACTION_LEFT = 1
ACTION_RIGHT = 2
ACTION_UP = 3
ACTION_DOWN = 4
ACTION_DIG_LEFT = 5
ACTION_DIG_RIGHT = 6

#: Deterministic movement tie-break order for the guard search.
MOVE_ORDER = (ACTION_UP, ACTION_LEFT, ACTION_RIGHT, ACTION_DOWN)

GOLD_POINTS = 25
TRAP_POINTS = 50
LEVEL_POINTS = 500


@dataclass
class Entity:
    """A player or guard: position plus per-entity state."""

    x: int
    y: int
    start: tuple[int, int] = (0, 0)
    falling: bool = False
    on_ladder: bool = False
    on_rope: bool = False
    trapped: int = 0
    dead: bool = False
    dead_until: int = -1
    carrying: tuple[int, int] | None = None
    carry_ticks: int = 0

    @property
    def pos(self) -> tuple[int, int]:
        return (self.x, self.y)


@dataclass
class DigRecord:
    """A dug hole and the tick at which its brick comes back."""

    x: int
    y: int
    regenerate_at: int


@dataclass
class GameEvent:
    """A notable thing that happened during the most recent tick."""

    kind: str
    payload: dict[str, object] = field(default_factory=dict)


class Game:
    """The simulation state of a single level."""

    def __init__(self, level: Level) -> None:
        self.level = level
        self.reset()

    # ------------------------------------------------------------------ setup
    def reset(self) -> None:
        """Restore the level to its deterministic initial state."""
        level = self.level
        px, py = level.player_start
        self.player = Entity(x=px, y=py, start=(px, py))
        self.guards = [Entity(x=gx, y=gy, start=(gx, gy)) for gx, gy in level.guard_starts]
        self.gold: set[tuple[int, int]] = set(level.gold)
        self.holes: dict[tuple[int, int], DigRecord] = {}
        self.tick = 0
        self.collected = 0
        self.score = 0
        self.digs = 0
        self.level_complete = False
        self.player_dead = False
        self.message = ""
        self.events: list[GameEvent] = []
        self._refresh(self.player)
        for guard in self.guards:
            self._refresh(guard)

    # --------------------------------------------------------------- plumbing
    @property
    def remaining_gold(self) -> int:
        """Gold still unresolved (sitting on the board)."""
        return len(self.gold)

    @property
    def exit_open(self) -> bool:
        return not self.gold and not self._gold_in_hand()

    def _gold_in_hand(self) -> bool:
        return any(g.carrying is not None and not g.dead for g in self.guards)

    def entity_at(self, x: int, y: int) -> Entity | None:
        if not self.player.dead and self.player.pos == (x, y):
            return self.player
        for guard in self.guards:
            if not guard.dead and guard.pos == (x, y):
                return guard
        return None

    # ------------------------------------------------------ terrain predicates
    def is_free(self, x: int, y: int) -> bool:
        """Whether an entity may occupy (x, y) given terrain and dug holes."""
        if not self.level.inside(x, y):
            return False
        if (x, y) in self.holes:
            return True
        return self.level.is_free(x, y)

    def is_support(self, x: int, y: int) -> bool:
        """Whether (x, y) holds up the entity standing above it."""
        if (x, y) in self.holes:
            return False
        return self.level.is_support(x, y)

    def is_ladder(self, x: int, y: int) -> bool:
        return self.level.is_ladder(x, y)

    def is_rope(self, x: int, y: int) -> bool:
        return self.level.is_rope(x, y)

    def is_hold(self, x: int, y: int) -> bool:
        """Ladders and ropes hold an entity in place against gravity."""
        return self.is_ladder(x, y) or self.is_rope(x, y)

    def cell_at(self, x: int, y: int) -> str:
        if (x, y) in self.holes:
            return " "
        return self.level.at(x, y)

    def terrain_rows(self) -> list[str]:
        rows = [list(row) for row in self.level.terrain]
        for x, y in self.holes:
            rows[y][x] = " "
        return ["".join(row) for row in rows]

    # -------------------------------------------------------- entity plumbing
    def _refresh(self, entity: Entity) -> None:
        entity.on_ladder = self.is_ladder(*entity.pos)
        entity.on_rope = self.is_rope(*entity.pos)
        entity.falling = not self._held(entity)

    def _held(self, entity: Entity) -> bool:
        if entity.on_ladder or entity.on_rope:
            return True
        return self.is_support(entity.x, entity.y + 1)

    # ---------------------------------------------------------------- digging
    def can_dig(self, x: int, y: int) -> bool:
        """Whether (x, y) is a legal dig target right now."""
        if not self.level.inside(x, y):
            return False
        if self.level.at(x, y) != BRICK:
            return False
        if (x, y) in self.holes:
            return False
        return self.entity_at(x, y) is None

    def dig(self, entity: Entity, dx: int) -> bool:
        """Dig the brick diagonally below ``entity`` in direction ``dx``."""
        if not self._held(entity):
            self.message = "Cannot dig while falling"
            return False
        tx, ty = entity.x + dx, entity.y + 1
        if not self.can_dig(tx, ty):
            self.message = "Nothing to dig there"
            return False
        self.holes[(tx, ty)] = DigRecord(x=tx, y=ty, regenerate_at=self.tick + HOLE_LIFETIME)
        self.digs += 1
        self.events.append(GameEvent("dig", {"x": tx, "y": ty}))
        return True

    # ----------------------------------------------------------- gold / entry
    def _enter(self, entity: Entity) -> None:
        x, y = entity.pos
        entity.on_ladder = self.is_ladder(x, y)
        entity.on_rope = self.is_rope(x, y)
        if (x, y) in self.gold and not entity.dead:
            self.gold.discard((x, y))
            if entity is self.player:
                self.collected += 1
                self.score += GOLD_POINTS
                self.events.append(GameEvent("gold", {"points": GOLD_POINTS}))
                if self.exit_open:
                    self.message = "Exit unlocked!"
            else:
                entity.carrying = (x, y)
                entity.carry_ticks = CARRY_TIME
                self.message = "A guard took gold!"
        if (
            entity is self.player
            and not entity.dead
            and (x, y) == self.level.exit
            and self.exit_open
        ):
            self.level_complete = True
            self.score += LEVEL_POINTS
            self.message = "Level complete!"
            self.events.append(GameEvent("exit", {"points": LEVEL_POINTS}))

    # ------------------------------------------------------------------ ticks
    def step(self, action: int) -> None:
        """Advance the simulation by one deterministic tick."""
        self.events = []
        self.tick += 1
        player = self.player

        if player.dead:
            self._player_turn(player, ACTION_NONE)
        else:
            self._player_turn(player, action)

        for guard in self.guards:
            self._guard_turn(guard)

        self._regenerate()

        if not player.dead:
            for guard in self.guards:
                if not guard.dead and self._touches(player, guard):
                    self._kill_player("caught")
                    break

    @staticmethod
    def _touches(a: Entity, b: Entity) -> bool:
        return abs(a.x - b.x) + abs(a.y - b.y) <= 1

    def _kill_player(self, reason: str) -> None:
        self.player.dead = True
        self.player_dead = True
        self.message = "Caught by a guard!" if reason == "caught" else "You were crushed!"
        self.events.append(GameEvent("death", {"reason": reason}))

    # --------------------------------------------------------- player actions
    def _player_turn(self, player: Entity, action: int) -> None:
        if player.dead:
            return
        if action == ACTION_LEFT:
            self._move(player, player.x - 1, player.y)
        elif action == ACTION_RIGHT:
            self._move(player, player.x + 1, player.y)
        elif action == ACTION_UP:
            if self.is_ladder(player.x, player.y - 1) or self.is_ladder(player.x, player.y):
                self._move(player, player.x, player.y - 1)
            else:
                self.message = "Nothing to climb here"
        elif action == ACTION_DOWN:
            if self.is_ladder(player.x, player.y + 1) or self.is_rope(player.x, player.y + 1):
                self._move(player, player.x, player.y + 1)
        elif action == ACTION_DIG_LEFT:
            self.dig(player, -1)
        elif action == ACTION_DIG_RIGHT:
            self.dig(player, +1)
        self._gravity(player)
        self._enter(player)

    def _move(self, entity: Entity, nx: int, ny: int) -> bool:
        if not self.is_free(nx, ny) or self.entity_at(nx, ny) is not None:
            return False
        entity.x, entity.y = nx, ny
        self._refresh(entity)
        return True

    def _gravity(self, entity: Entity) -> None:
        if self._held(entity):
            entity.falling = False
            return
        entity.falling = True
        if self.is_free(entity.x, entity.y + 1) and self.entity_at(entity.x, entity.y + 1) is None:
            entity.y += 1
            self._refresh(entity)

    # -------------------------------------------------------------- guard turn
    def _guard_turn(self, guard: Entity) -> None:
        if guard.dead:
            if guard.dead_until <= self.tick:
                guard.dead = False
                guard.x, guard.y = guard.start
                guard.trapped = 0
                guard.carrying = None
                self._refresh(guard)
            return

        if guard.trapped:
            guard.trapped -= 1
            if guard.trapped == 0:
                guard.y -= 1  # climb out of the dug hole
                self._refresh(guard)
            return

        if guard.carrying is not None:
            guard.carry_ticks -= 1
            if guard.carry_ticks <= 0:
                self.gold.add(guard.carrying)
                guard.carrying = None
                self.message = "A guard dropped the gold it carried."

        self._gravity(guard)
        if guard.falling:
            if guard.pos in self.holes:
                guard.trapped = TRAP_DURATION
                self.message = "A guard fell into a hole!"
            return
        if guard.pos in self.holes:
            guard.trapped = TRAP_DURATION
            self.message = "A guard fell into a hole!"
            return

        action = choose_guard_action(self, guard)
        if action == ACTION_LEFT:
            self._move(guard, guard.x - 1, guard.y)
        elif action == ACTION_RIGHT:
            self._move(guard, guard.x + 1, guard.y)
        elif action == ACTION_UP:
            self._move(guard, guard.x, guard.y - 1)
        elif action == ACTION_DOWN:
            self._move(guard, guard.x, guard.y + 1)
        self._enter(guard)

    # ------------------------------------------------------------ regeneration
    def _regenerate(self) -> None:
        for key in [key for key, rec in self.holes.items() if rec.regenerate_at <= self.tick]:
            del self.holes[key]
            for entity in (self.player, *self.guards):
                if not entity.dead and entity.pos == key:
                    self._entomb(entity)

    def _entomb(self, entity: Entity) -> None:
        """A brick regenerated on top of ``entity``."""
        if entity is self.player:
            if entity.on_ladder or self.is_free(entity.x, entity.y - 1):
                self._move(entity, entity.x, entity.y - 1)  # climb out of the hole
            else:
                self._kill_player("entombed")
            return
        if entity.carrying is not None:
            self.gold.add(entity.carrying)
            entity.carrying = None
        entity.dead = True
        entity.dead_until = self.tick + RESPAWN_DELAY
        entity.x, entity.y = entity.start
        entity.trapped = 0
        self.score += TRAP_POINTS
        self.message = "Guard trapped!"
        self.events.append(GameEvent("trap", {"points": TRAP_POINTS}))


# ---------------------------------------------------------------------------
# Guard AI
# ---------------------------------------------------------------------------
def choose_guard_action(game: Game, guard: Entity) -> int:
    """Choose the guard's next action deterministically.

    The AI breadth-first searches the 1-tick transition graph (walk / climb /
    hang / fall) from the guard to the player, then replays the first move of
    the shortest route.  Neighbours are expanded in ``MOVE_ORDER`` order and
    nodes are visited in insertion order, so identical state always produces an
    identical decision.  At most ``SEARCH_LIMIT`` nodes are expanded; when no
    route exists the guard falls back to a deterministic horizontal shuffle
    toward the player.
    """
    start = guard.pos
    target = game.player.pos
    if start == target:
        return ACTION_NONE

    came: dict[tuple[int, int], tuple[tuple[int, int], int]] = {start: (start, ACTION_NONE)}
    queue: deque[tuple[int, int]] = deque([start])
    expanded = 0
    found = False
    while queue:
        node = queue.popleft()
        expanded += 1
        if expanded > SEARCH_LIMIT:
            break
        if node == target:
            found = True
            break
        for action, nxt in _transitions(game, node):
            if nxt not in came:
                came[nxt] = (node, action)
                queue.append(nxt)

    if found or target in came:
        node = target
        for _ in range(SEARCH_LIMIT):
            prev, action = came[node]
            if prev == start:
                return action
            node = prev
    return _fallback_action(game, guard)


def _transitions(game: Game, node: tuple[int, int]) -> list[tuple[int, tuple[int, int]]]:
    """Legal 1-tick moves out of ``node``, in deterministic order."""
    x, y = node
    out: list[tuple[int, tuple[int, int]]] = []
    for action, nx, ny in (
        (ACTION_LEFT, x - 1, y),
        (ACTION_RIGHT, x + 1, y),
        (ACTION_UP, x, y - 1),
        (ACTION_DOWN, x, y + 1),
    ):
        if action == ACTION_UP and not (game.is_ladder(x, y) or game.is_ladder(x, y - 1)):
            continue
        if action == ACTION_DOWN and not (game.is_ladder(x, y + 1) or game.is_rope(x, y + 1)):
            continue
        if not game.is_free(nx, ny):
            continue
        landing = _landing(game, nx, ny)
        if landing is None or landing == node:
            continue
        out.append((action, landing))
    return out


def _landing(game: Game, x: int, y: int) -> tuple[int, int] | None:
    """Where an entity settles after entering (x, y); ``None`` if it falls out."""
    if not game.is_free(x, y):
        return None
    depth = 0
    while not game.is_hold(x, y) and game.is_free(x, y + 1) and not game.is_support(x, y + 1):
        depth += 1
        if depth > game.level.height + 1:
            return None
        y += 1
        if not game.is_free(x, y):
            return None
    return (x, y)


def _fallback_action(game: Game, guard: Entity) -> int:
    dx = game.player.x - guard.x
    order = (ACTION_LEFT, ACTION_RIGHT) if dx < 0 else (ACTION_RIGHT, ACTION_LEFT)
    for action in order:
        sx = -1 if action == ACTION_LEFT else +1
        if game.is_free(guard.x + sx, guard.y):
            return action
    return ACTION_NONE


def run_steps(game: Game, actions: list[int]) -> None:
    """Apply ``actions`` in order (used by tools and tests)."""
    for action in actions:
        game.step(action)
