# Sokoban Solver

[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built by an AI agent for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty ($100 in USDC).

## How it works

Every level the generator draws is a 1-wide hallway with 1–4 rooms hanging
off it, one door per room, and a box pushed out of its room can never come
back — so a level's push-optimal total is the sum of its rooms' optima.
The solver exploits that structure:

1. **Decompose.** Find the hallway (the player's row) and split the remaining
   floor into rooms, one connected component each, with its door cell.
2. **Solve each room push-optimally** with A* over push states (player cell +
   sorted box cells, cost = pushes), using:
   - an admissible heuristic: exact single-box push distances (other boxes
     ignored) combined by a minimum box-to-goal assignment;
   - deadlock pruning: dead cells (no relaxed route to any goal) and frozen
     boxes (computed to a fixpoint — a box only counts as frozen when every
     push is blocked by a wall or an already-frozen box).
   - each push is turned into full moves by BFS-walking the player between
     pushes, boxes treated as obstacles.
3. **Stitch.** Rooms are solved from their door entry; the move strings are
   joined with walks along the hallway. A room is normally solved with the
   extra condition that the player can still reach the hallway afterwards
   (otherwise the player would be trapped inside a finished room); the room
   that gains most from dropping that condition is solved last.

If a level ever falls outside the expected shape, the solver falls back to
running the same push-optimal A* on the whole level as one region.

The search is fully deterministic — no clock, no randomness, work bounded by
an expansion cap — so two runs produce byte-identical outputs.

## Practice results

Graded with the kit's local grader
(`node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process`):

| instance | P\* | pushes | points |
|----------|----|--------|--------|
| i001 | 13 | 13 | 1000 |
| i002 | 16 | 16 | 1000 |
| i003 | 29 | 29 | 1000 |
| i004 | 47 | 47 | 1000 |
| i005 | 60 | 60 | 1000 |

**Practice score: 1,000,000** (all five levels solved at the push optimum, in
about 0.3 s for the whole set). The house baseline (plain-astar 1.0.0) scores
200,000 on the same practice set.

## Running it

Requires Node 22. The program reads `/input/<id>/level.txt` for `i001`–`i005`
and writes `/output/<id>/solution.txt` (moves in `u`/`d`/`l`/`r`).

```sh
node main.ts
```

For a local run against the kit's practice set:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Only Node built-ins are used; there is nothing to install.

## License

MIT — see [LICENSE](LICENSE).
