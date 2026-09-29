#!/usr/bin/env python3
"""
Terminal Tetris — pure standard library, zero dependencies.

Controls:
  <left> / A          : move left
  <right> / D         : move right
  <down> / S          : soft drop (1 point per cell)
  <up> / X            : rotate clockwise
  Z                   : rotate counter-clockwise
  SPACE               : hard drop (2 points per cell)
  C                   : hold / swap piece
  P                   : pause / resume
  Q or Esc            : quit
  Enter               : restart after game over

Run:
  python3 tetris.py                 # 10x20 board, normal gravity
  python3 tetris.py --level 5       # start at a faster level
  python3 tetris.py --no-ghost      # hide the landing preview
  python3 tetris.py --seed 42       # reproducible piece sequence
"""

import argparse
import os
import random
import sys
import time

COLS = 10
ROWS = 20

# ------------------------------------------------------------------- pieces

# Spawn orientations. Rotation is done with plain matrix math, so no
# per-piece rotation tables are needed.
SHAPES = {
    "I": [[0, 0, 0, 0],
          [1, 1, 1, 1],
          [0, 0, 0, 0],
          [0, 0, 0, 0]],
    "J": [[1, 0, 0],
          [1, 1, 1],
          [0, 0, 0]],
    "L": [[0, 0, 1],
          [1, 1, 1],
          [0, 0, 0]],
    "O": [[1, 1],
          [1, 1]],
    "S": [[0, 1, 1],
          [1, 1, 0],
          [0, 0, 0]],
    "T": [[0, 1, 0],
          [1, 1, 1],
          [0, 0, 0]],
    "Z": [[1, 1, 0],
          [0, 1, 1],
          [0, 0, 0]],
}

PIECE_NAMES = list(SHAPES)
PIECE_COLORS = {          # xterm-256 colour index
    "I": 51, "J": 27, "L": 208, "O": 226,
    "S": 46, "T": 201, "Z": 196,
}

SCORE_TABLE = [0, 100, 300, 500, 800]   # base points per 1/2/3/4 lines


def rotate_cw(matrix):
    """Rotate a square matrix 90 degrees clockwise."""
    return [list(row) for row in zip(*matrix[::-1])]


def rotate_ccw(matrix):
    """Rotate a square matrix 90 degrees counter-clockwise."""
    return [list(row) for row in zip(*matrix)][::-1]


def drops(matrix):
    """Row indices that actually contain blocks (used for previews)."""
    return [i for i, row in enumerate(matrix) if any(row)]


# --------------------------------------------------------------------- board

def empty_board():
    return [[None] * COLS for _ in range(ROWS)]


def collides(board, matrix, x, y):
    """True if the piece would overlap a wall, the floor, or a locked block."""
    for r, row in enumerate(matrix):
        for c, val in enumerate(row):
            if not val:
                continue
            bx, by = x + c, y + r
            if bx < 0 or bx >= COLS or by >= ROWS:
                return True
            if by >= 0 and board[by][bx] is not None:
                return True
    return False


def lock_piece(board, matrix, x, y, color):
    """Write the piece into the board. Returns False if it locked out of sight."""
    wrote = False
    for r, row in enumerate(matrix):
        for c, val in enumerate(row):
            if not val:
                continue
            bx, by = x + c, y + r
            if 0 <= by < ROWS and 0 <= bx < COLS:
                board[by][bx] = color
                wrote = True
    return wrote


def clear_lines(board):
    """Remove full rows, shift everything down, and return (board, n_cleared)."""
    remaining = [row for row in board if not all(cell is not None for cell in row)]
    cleared = ROWS - len(remaining)
    if cleared:
        board = [[None] * COLS for _ in range(cleared)] + remaining
    return board, cleared


def score_for_lines(n, level):
    if n <= 0:
        return 0
    return SCORE_TABLE[min(n, 4)] * level


def drop_interval(level):
    """Seconds per gravity step — gets faster with level."""
    return max(0.06, 0.80 - (level - 1) * 0.065)


def ghost_y(board, matrix, x, y):
    """Lowest legal y for the current orientation."""
    while not collides(board, matrix, x, y + 1):
        y += 1
    return y


# ------------------------------------------------------------------ bag/queue

class SevenBag:
    """Standard 7-bag randomizer: every piece appears once per bag of seven."""

    def __init__(self, rng=None):
        self.rng = rng or random.Random()
        self._bag = []

    def next(self):
        if not self._bag:
            self._bag = PIECE_NAMES[:]
            self.rng.shuffle(self._bag)
        return self._bag.pop()


class Piece:
    __slots__ = ("name", "matrix", "x", "y")

    def __init__(self, name):
        self.name = name
        self.matrix = [row[:] for row in SHAPES[name]]
        self.x = (COLS - len(self.matrix[0])) // 2
        self.y = 0

    @property
    def color(self):
        return PIECE_COLORS[self.name]

    def cells(self, matrix=None, x=None, y=None):
        matrix = self.matrix if matrix is None else matrix
        x = self.x if x is None else x
        y = self.y if y is None else y
        out = []
        for r, row in enumerate(matrix):
            for c, val in enumerate(row):
                if val:
                    out.append((x + c, y + r))
        return out


def try_rotate(board, piece, clockwise=True):
    """Rotate with simple wall kicks. Returns True on success."""
    matrix = rotate_cw(piece.matrix) if clockwise else rotate_ccw(piece.matrix)
    for dx, dy in ((0, 0), (-1, 0), (1, 0), (-2, 0), (2, 0), (0, -1), (0, 1)):
        if not collides(board, matrix, piece.x + dx, piece.y + dy):
            piece.matrix = matrix
            piece.x += dx
            piece.y += dy
            return True
    return False


# ------------------------------------------------------------------ terminal

if os.name == "nt":
    import msvcrt

    def init_terminal():
        os.system("")

    def restore_terminal():
        pass

    def get_key():
        if not msvcrt.kbhit():
            return None
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            return {"H": "UP", "P": "DOWN", "K": "LEFT", "M": "RIGHT"}.get(
                msvcrt.getwch()
            )
        return _normalize(ch)

else:
    import select
    import termios
    import tty

    _saved_termios = None

    def init_terminal():
        global _saved_termios
        _saved_termios = termios.tcgetattr(sys.stdin.fileno())
        tty.setcbreak(sys.stdin.fileno())

    def restore_terminal():
        if _saved_termios is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _saved_termios)

    def get_key():
        if not select.select([sys.stdin], [], [], 0)[0]:
            return None
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            seq = ""
            while select.select([sys.stdin], [], [], 0.01)[0] and len(seq) < 2:
                seq += sys.stdin.read(1)
            return {"[A": "UP", "[B": "DOWN", "[C": "RIGHT", "[D": "LEFT"}.get(seq, "ESC")
        return _normalize(ch)


def _normalize(ch):
    ch = ch.lower()
    return {
        "w": "UP", "s": "DOWN", "a": "LEFT", "d": "RIGHT",
        "x": "X", "z": "Z", "c": "C", " ": "SPACE",
        "p": "PAUSE", "q": "QUIT", "\r": "ENTER", "\n": "ENTER", "\x1b": "ESC",
    }.get(ch)


RESET = "\x1b[0m"
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
CLEAR = "\x1b[2J\x1b[H"
HIDE_CURSOR = "\x1b[?25l"
SHOW_CURSOR = "\x1b[?25h"


def block(color, ghost=False):
    if ghost:
        return f"\x1b[2m\x1b[38;5;{color}m░░{RESET}"
    return f"\x1b[38;5;{color}m██{RESET}"


def preview(piece_name, rows=4):
    """Return `rows` rendered strings for a next/hold preview box."""
    if piece_name is None:
        return ["      "] * 2
    matrix = SHAPES[piece_name]
    color = PIECE_COLORS[piece_name]
    idx = drops(matrix)
    lines = []
    for r in idx:
        line = "".join(block(color) if v else "  " for v in matrix[r])
        lines.append(line + "  ")
    return lines


def render(board, piece, next_name, hold_name, score, best, level, lines,
           paused, ghost_on, msg=""):
    grid = [row[:] for row in board]
    ghost_cells = set()

    if not paused:
        gy = ghost_y(board, piece.matrix, piece.x, piece.y)
        if ghost_on and gy != piece.y:
            for cx, cy in piece.cells(piece.matrix, piece.x, gy):
                if 0 <= cy < ROWS:
                    ghost_cells.add((cx, cy))
                    grid[cy][cx] = ("ghost", piece.color)
        for cx, cy in piece.cells():
            if 0 <= cy < ROWS:
                grid[cy][cx] = ("solid", piece.color)

    out = [CLEAR + f"{BOLD}TETRIS{RESET}",
           "+" + "-" * (COLS * 2) + "+"]

    header = [
        "",
        f"  {BOLD}SCORE{RESET}  {score}",
        f"  {DIM}BEST {best}{RESET}",
        f"  {BOLD}LEVEL{RESET}  {level}",
        f"  {BOLD}LINES{RESET}  {lines}",
        "",
        f"  {DIM}NEXT{RESET}",
    ]
    header += ["  " + p for p in preview(next_name)]
    header += ["", f"  {DIM}HOLD{RESET}"]
    header += ["  " + p for p in preview(hold_name)]

    body = []
    for y in range(ROWS):
        cells = []
        for x in range(COLS):
            cell = grid[y][x]
            if cell is None:
                cells.append("  ")
            elif isinstance(cell, tuple):
                kind, color = cell
                cells.append(block(color, ghost=(kind == "ghost")))
            else:
                cells.append(block(PIECE_COLORS[cell]))
        body.append("|" + "".join(cells) + "|")

    lines_out = [out[0], out[1]]
    for i, row in enumerate(body):
        panel = header[i] if i < len(header) else ""
        lines_out.append(row + "   " + panel)
    lines_out.append("+" + "-" * (COLS * 2) + "+")

    if paused:
        lines_out.append(f"{BOLD}-- PAUSED -- press P to resume{RESET}")
    elif msg:
        lines_out.append(f"{BOLD}{msg}{RESET}")
    else:
        lines_out.append(f"{DIM}arrows/WASD move  Z/X rotate  SPACE drop  C hold  P pause  Q quit{RESET}")

    sys.stdout.write("\n".join(lines_out) + "\n")
    sys.stdout.flush()


# ----------------------------------------------------------------------- game

def new_piece(bag):
    return Piece(bag.next())


def spawn(board, name, hold_used):
    """Place a new piece; returns (piece, hold_used, game_over)."""
    piece = Piece(name)
    return piece, hold_used, collides(board, piece.matrix, piece.x, piece.y)


def run(args):
    rng = random.Random(args.seed) if args.seed is not None else random.Random()
    bag = SevenBag(rng)

    board = empty_board()
    level = max(1, args.level)
    score = 0
    best = 0
    lines_total = 0
    hold_name = None
    hold_used = False
    paused = False
    dead = False
    msg = ""

    piece = new_piece(bag)
    next_name = bag.next()
    soft_drop = False

    init_terminal()
    sys.stdout.write(HIDE_CURSOR)

    def shutdown():
        sys.stdout.write(SHOW_CURSOR + RESET + "\n")
        sys.stdout.flush()
        restore_terminal()

    try:
        while True:
            loop_start = time.monotonic()

            # ---- drain input, keeping the last lateral/rotation intent
            while True:
                k = get_key()
                if k is None:
                    break
                if k in ("QUIT", "ESC"):
                    render(board, piece, next_name, hold_name, score, best, level,
                           lines_total, paused, not args.no_ghost, msg)
                    shutdown()
                    print(f"Quit. Final score {score} ({lines_total} lines).")
                    return
                if k == "ENTER" and dead:
                    board = empty_board()
                    bag = SevenBag(rng)
                    piece = new_piece(bag)
                    next_name = bag.next()
                    hold_name, hold_used = None, False
                    score, lines_total, level = 0, 0, max(1, args.level)
                    dead, paused, msg, soft_drop = False, False, "", False
                    continue
                if dead:
                    continue
                if k == "PAUSE":
                    paused = not paused
                    continue
                if paused:
                    continue

                if k == "LEFT" and not collides(board, piece.matrix, piece.x - 1, piece.y):
                    piece.x -= 1
                elif k == "RIGHT" and not collides(board, piece.matrix, piece.x + 1, piece.y):
                    piece.x += 1
                elif k == "UP" or k == "X":
                    try_rotate(board, piece, clockwise=True)
                elif k == "Z":
                    try_rotate(board, piece, clockwise=False)
                elif k == "SPACE":
                    gy = ghost_y(board, piece.matrix, piece.x, piece.y)
                    score += 2 * (gy - piece.y)
                    piece.y = gy
                    soft_drop = True
                elif k == "C" and not hold_used:
                    swap = hold_name
                    hold_name = piece.name
                    new_name = swap if swap else next_name
                    if not swap:
                        next_name = bag.next()
                    piece, hold_used, over = spawn(board, new_name, True)
                    if over:
                        dead = True
                        msg = "GAME OVER (locked out). Press Enter to restart."
                elif k == "DOWN":
                    soft_drop = True

            # ---- gravity
            if not paused and not dead:
                msg = ""
                if not collides(board, piece.matrix, piece.x, piece.y + 1):
                    if soft_drop:
                        piece.y += 1
                        score += 1
                else:
                    wrote = lock_piece(board, piece.matrix, piece.x, piece.y,
                                       piece.name)
                    board, cleared = clear_lines(board)
                    if cleared:
                        score += score_for_lines(cleared, level)
                        lines_total += cleared
                        new_level = 1 + lines_total // 10
                        if new_level > level:
                            level = new_level
                            msg = f"LEVEL {level}!"
                    if not wrote:
                        dead = True
                        msg = "GAME OVER (blocked out). Press Enter to restart."
                    else:
                        piece, hold_used, over = spawn(board, next_name, False)
                        next_name = bag.next()
                        if over:
                            dead = True
                            msg = "GAME OVER. Press Enter to restart."
                    if not dead and not msg:
                        msg = ""
                best = max(best, score)
                soft_drop = False

            render(board, piece, next_name, hold_name, score, best, level,
                   lines_total, paused, not args.no_ghost, msg)

            elapsed = time.monotonic() - loop_start
            tick = 0.04 if soft_drop else drop_interval(level)
            time.sleep(max(0.0, tick - elapsed))

    except KeyboardInterrupt:
        pass
    finally:
        shutdown()


def main():
    p = argparse.ArgumentParser(description="Terminal Tetris (no dependencies).")
    p.add_argument("--level", type=int, default=1, help="starting level (1-15)")
    p.add_argument("--seed", type=int, default=None, help="fixed RNG seed")
    p.add_argument("--no-ghost", action="store_true", help="disable landing preview")
    run(p.parse_args())


if __name__ == "__main__":
    main()
