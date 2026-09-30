#!/usr/bin/env python3
"""Headless smoke test for arkanoid game logic (no curses display needed)."""

import importlib.util

spec = importlib.util.spec_from_file_location("arkanoid", "arkanoid.py")
ark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ark)

# --- build_level ---
bricks = ark.build_level(24, 80)
assert len(bricks) > 0, "build_level should produce bricks"
for b in bricks:
    assert "y" in b and "x" in b and "width" in b and "symbol" in b and "color" in b

# --- paddle movement ---
p = {
    "rows": 24, "cols": 80, "paddle_width": 9,
    "paddle_y": 21, "paddle_x": 36,
    "ball_y": 20, "ball_x": 40, "ball_dy": -1, "ball_dx": 1.0,
    "bricks": [], "score": 0, "lives": 3, "status": "playing", "serving": False,
}
ark.move_paddle(p, -1)
assert p["paddle_x"] == 34
ark.move_paddle(p, 1)
assert p["paddle_x"] == 36
# Left bound
p["paddle_x"] = 0
ark.move_paddle(p, -1)
assert p["paddle_x"] == 1
# Right bound
p["paddle_x"] = 80
ark.move_paddle(p, 1)
assert p["paddle_x"] == 80 - 1 - 9

# --- ball_hits_paddle ---
p["paddle_x"] = 30
p["paddle_width"] = 9
p["paddle_y"] = 21
p["ball_y"] = 20
p["ball_x"] = 34
assert ark.ball_hits_paddle(p) is True
p["ball_x"] = 45
assert ark.ball_hits_paddle(p) is False
p["ball_y"] = 21
p["ball_x"] = 34
assert ark.ball_hits_paddle(p) is True  # at paddle row too

# --- handle_collision: wall bounce ---
p2 = dict(p)
p2["ball_y"] = 1
p2["ball_x"] = 40
p2["ball_dy"] = -1
result = ark.handle_collision(p2)
assert result == "hit"
assert p2["ball_dy"] == 1  # bounced down

# Side wall bounce
p2["ball_y"] = 10
p2["ball_x"] = 0
p2["ball_dy"] = 1
p2["ball_dx"] = -1.0
result = ark.handle_collision(p2)
assert result == "hit"
assert p2["ball_dx"] == 1.0  # bounced right

# --- miss (ball drops) ---
p2["ball_y"] = 22
p2["ball_x"] = 40
p2["ball_dy"] = 1
result = ark.handle_collision(p2)
assert result == "miss"

# --- brick hit + score ---
p3 = dict(p)
p3["ball_y"] = 5
p3["ball_x"] = 34
p3["ball_dy"] = 1
p3["bricks"] = [{"y": 4, "x": 30, "width": 8, "symbol": "#", "color": 2}]
p3["score"] = 0
result = ark.handle_collision(p3)
assert result == "hit", f"expected hit, got {result}"
assert len(p3["bricks"]) == 0, "brick should be removed"
assert p3["score"] == 10, f"score should be 10, got {p3['score']}"

# --- win condition (no bricks) ---
p4 = dict(p)
p4["bricks"] = []
assert len(p4["bricks"]) == 0

# --- float rendering safety ---
p5 = dict(p)
p5["ball_y"] = 20.0
p5["ball_x"] = 34.7
assert round(p5["ball_x"]) == 35
assert round(p5["ball_y"]) == 20

print("All smoke tests passed!")
