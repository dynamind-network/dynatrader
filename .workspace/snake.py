#!/usr/bin/env python3
"""
Terminal Snake — pure standard library, no dependencies.

Controls:
  Arrow keys / WASD  : move
  P                  : pause / resume
  Q or Esc           : quit
  Enter              : restart after game over

Run:
  python3 snake.py            # default 20x14 board, medium speed
  python3 snake.py --speed 5  # 1 (slow) .. 10 (fast)
  python3 snake.py --wrap     # walls wrap around instead of killing you
"""

import argparse
import os
import random
import sys
import time

# ---------------------------------------------------------------- platform I/O

if os.name == "nt":
    import msvcrt

    def init_terminal():
        os.system("")

    def restore_terminal():
        pass

    def get_key():
        """Return a normalized key name, or None if nothing is pending."""
        if not msvcrt.kbhit():
            return None
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):  # prefix for arrow / function keys
            ch2 = msvcrt.getwch()
            return {
                "H": "UP", "P": "DOWN", "K": "LEFT", "M": "RIGHT",
            }.get(ch2)
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
        if ch == "\x1b":  # escape sequence -> arrow key
            seq = ""
            while select.select([sys.stdin], [], [], 0.01)[0] and len(seq) < 2:
                seq += sys.stdin.read(1)
            return {"[A": "UP", "[B": "DOWN", "[C": "RIGHT", "[D": "LEFT"}.get(seq, "ESC")
        return _normalize(ch)


def _normalize(ch):
    """Map a raw character to a game action."""
    ch = ch.lower()
    if ch in ("w",):
        return "UP"
    if ch in ("s",):
        return "DOWN"
    if ch in ("a",):
        return "LEFT"
    if ch in ("d",):
        return "RIGHT"
    if ch in ("p",):
        return "PAUSE"
    if ch in ("q",):
        return "QUIT"
    if ch in ("\x1b",):
        return "ESC"
    if ch in ("\r", "\n"):
        return "ENTER"
    return None


# --------------------------------------------------------------------- render

HIDE_CURSOR = "\x1b[?25l"
SHOW_CURSOR = "\x1b[?25h"
CLEAR = "\x1b[2J\x1b[H"

RESET = "\x1b[0m"
DIM = "\x1b[2m"
BOLD = "\x1b[1m"
GREEN = "\x1b[32m"
BRIGHT_GREEN = "\x1b[92m"
RED = "\x1b[91m"
YELLOW = "\x1b[93m"
CYAN = "\x1b[96m"


def draw(board_w, board_h, snake, food, score, best, speed, wrap, paused, msg=""):
    body = set(snake[1:])
    head = snake[0]
    lines = [CLEAR]
    title = f"{BOLD}SNAKE{RESET}  score {CYAN}{score}{RESET}  best {DIM}{best}{RESET}  " \
            f"speed {DIM}{speed}{RESET}" + (f"  {YELLOW}WRAP{RESET}" if wrap else "")
    lines.append(title)
    lines.append("+" + "-" * board_w + "+")
    for y in range(board_h):
        row = []
        for x in range(board_w):
            p = (x, y)
            if p == head:
                row.append(f"{BRIGHT_GREEN}@{RESET}")
            elif p in body:
                row.append(f"{GREEN}o{RESET}")
            elif p == food:
                row.append(f"{RED}*{RESET}")
            else:
                row.append(" ")
        lines.append("|" + "".join(row) + "|")
    lines.append("+" + "-" * board_w + "+")
    if paused:
        lines.append(f"{YELLOW}{BOLD}-- PAUSED -- press P to resume{RESET}")
    elif msg:
        lines.append(f"{BOLD}{msg}{RESET}")
    else:
        lines.append(f"{DIM}arrows/WASD move  P pause  Q quit{RESET}")
    sys.stdout.write("\n".join(lines) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------- logic

DIRS = {"UP": (0, -1), "DOWN": (0, 1), "LEFT": (-1, 0), "RIGHT": (1, 0)}
OPPOSITE = {"UP": "DOWN", "DOWN": "UP", "LEFT": "RIGHT", "RIGHT": "LEFT"}


def spawn_food(board_w, board_h, snake):
    free = [(x, y) for y in range(board_h) for x in range(board_w) if (x, y) not in set(snake)]
    return random.choice(free) if free else None


def new_game(board_w, board_h):
    cx, cy = board_w // 2, board_h // 2
    snake = [(cx, cy), (cx - 1, cy), (cx - 2, cy)]
    return snake, spawn_food(board_w, board_h, snake), "RIGHT"


def run(args):
    board_w, board_h = args.width, args.height
    speed = max(1, min(10, args.speed))
    tick = 0.22 - (speed - 1) * 0.019  # ~0.22s .. ~0.05s per step
    best = 0

    snake, food, direction = new_game(board_w, board_h)
    pending = direction
    score = 0
    paused = False
    msg = ""

    init_terminal()
    sys.stdout.write(HIDE_CURSOR)

    def at_exit():
        sys.stdout.write(SHOW_CURSOR + RESET + "\n")
        sys.stdout.flush()
        restore_terminal()

    try:
        dead = False
        while True:
            loop_start = time.monotonic()

            # ---- input: drain all pending keys, keep the last valid turn
            while True:
                k = get_key()
                if k is None:
                    break
                if k in ("QUIT", "ESC"):
                    draw(board_w, board_h, snake, food, score, best, speed,
                         args.wrap, paused, msg)
                    at_exit()
                    print(f"Quit. Final score {score}.")
                    return
                if k == "ENTER" and dead:
                    snake, food, direction = new_game(board_w, board_h)
                    pending = direction
                    score, paused, dead, msg = 0, False, False, ""
                elif k == "PAUSE" and not dead:
                    paused = not paused
                elif k in DIRS and not paused and not dead:
                    if k != OPPOSITE[direction] or len(snake) == 1:
                        pending = k

            if not paused and not dead:
                direction = pending
                dx, dy = DIRS[direction]
                hx, hy = snake[0]
                nx, ny = hx + dx, hy + dy

                if args.wrap:
                    nx %= board_w
                    ny %= board_h
                elif not (0 <= nx < board_w and 0 <= ny < board_h):
                    dead = True
                    msg = f"GAME OVER - hit the wall. Press Enter to restart (Q to quit)."

                if not dead:
                    new_head = (nx, ny)
                    grow = new_head == food
                    tail = snake[:-1] if grow else snake[:-1] or []
                    # collision: body, excluding the square the tail is vacating
                    hits = snake if grow else tail
                    if new_head in hits:
                        dead = True
                        msg = f"GAME OVER - ate yourself. Press Enter to restart (Q to quit)."
                    else:
                        snake = [new_head] + (snake if grow else snake[:-1])
                        if grow:
                            score += 1
                            best = max(best, score)
                            food = spawn_food(board_w, board_h, snake)
                            if food is None:
                                dead = True
                                msg = "YOU WIN! Board cleared. Press Enter to play again."
                        else:
                            del snake[-1:]

            draw(board_w, board_h, snake, food, score, best, speed,
                 args.wrap, paused, msg)

            elapsed = time.monotonic() - loop_start
            time.sleep(max(0.0, tick - elapsed))

    except KeyboardInterrupt:
        pass
    finally:
        at_exit()


def main():
    p = argparse.ArgumentParser(description="Terminal Snake (no dependencies).")
    p.add_argument("--width", type=int, default=20)
    p.add_argument("--height", type=int, default=14)
    p.add_argument("--speed", type=int, default=6, help="1 (slow) .. 10 (fast)")
    p.add_argument("--wrap", action="store_true", help="walls wrap around")
    run(p.parse_args())


if __name__ == "__main__":
    main()
