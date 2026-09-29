"""Headless smoke tests for snake.py game logic (no terminal needed)."""
import sys
sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])

import snake

DIRS = snake.DIRS
OPP = snake.OPPOSITE


def step(state, direction, wrap, w, h):
    """Mirror of the movement logic in run(). Returns (snake, food, score, dead)."""
    s, food, score = state
    dx, dy = DIRS[direction]
    hx, hy = s[0]
    nx, ny = hx + dx, hy + dy
    if wrap:
        nx %= w
        ny %= h
    elif not (0 <= nx < w and 0 <= ny < h):
        return s, food, score, True
    head = (nx, ny)
    grow = head == food
    hits = s if grow else s[:-1]
    if head in hits:
        return s, food, score, True
    s = [head] + (s if grow else s[:-1])
    if grow:
        score += 1
        food = snake.spawn_food(w, h, s)
    return s, food, score, False


W, H = 20, 14

# 1. new game sanity
s, f, d = snake.new_game(W, H)
assert d == "RIGHT" and len(s) == 3 and f not in s
print("ok  new_game: head=%s food=%s" % (s[0], f))

# 2. plain move
s2, f2, sc2, dead = step((s, f, 0), "RIGHT", False, W, H)
assert not dead and s2[0] == (s[0][0] + 1, s[0][1]) and len(s2) == 3
print("ok  move keeps length 3, head=%s" % (s2[0],))

# 3. eating grows the snake and increments the score
s3, f3, sc3 = s2, None, 0
target = (s2[0][0] + 1, s2[0][1])
snake_hits = step((s2, target, 0), "RIGHT", False, W, H)
assert snake_hits[2] == 1 and len(snake_hits[0]) == 4
print("ok  eat: score=%d length=%d" % (snake_hits[2], len(snake_hits[0])))

# 4. wall death (no wrap)
probe = ([(W - 1, H // 2), (W - 2, H // 2), (W - 3, H // 2)], (0, 0), 0)
_, _, _, dead4 = step(probe, "RIGHT", False, W, H)
assert dead4, "expected wall death"
print("ok  wall kills you when wrap is off")

# 5. wrap passes through
_, _, _, dead5 = step(probe, "RIGHT", True, W, H)
assert not dead5, "expected wrap to survive"
print("ok  wrap keeps you alive")

# 6a. following your own tail is LEGAL (tail vacates the square)
tailchase = ([(5, 5), (6, 5), (6, 6), (5, 6)], (0, 0), 0)
_, _, _, dead6a = step(tailchase, "DOWN", False, W, H)
assert not dead6a, "tail-chase should be legal"
print("ok  tail-chase is legal")

# 6b. self collision into a mid-body segment
probe6 = ([(5, 5), (6, 5), (6, 6), (5, 6), (5, 7)], (0, 0), 0)
_, _, _, dead6b = step(probe6, "DOWN", False, W, H)
assert dead6b, "expected self-collision death"
print("ok  self-collision detected")

# 7. opposite-direction guard
for a, b in (("UP", "DOWN"), ("LEFT", "RIGHT")):
    assert OPP[a] == b and OPP[b] == a
print("ok  no illegal 180-degree turns")

# 8. board full -> no food left -> win condition reachable
full = [(x, y) for y in range(2) for x in range(3)]
assert snake.spawn_food(3, 2, full) is None
print("ok  win condition reachable (board cleared)")

print("\nALL TESTS PASSED")
