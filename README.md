# csv-reader-speed-01

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/iwan0494/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/iwan0494/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in replacement for csv-reader 1.0.0: it reads broken CSV files exactly as the reference does — same columns, rows and errors on every case, including BOM, stray CRs, unterminated quotes, quote junk, short and long rows — in a single pass, without building fields character by character.

## How it is fast

Most records are plain (no quote, no stray CR). Each such record is found with one native `indexOf('\n')`, sliced once, and split by the engine — sliced strings, no copying, no per-character loop. Records that hold a quote or a CR take a slower path that still jumps with `indexOf` instead of walking character by character, and a quoted field is taken as one slice up to its next quote. Nothing is cached from one case to the next; every `run(input)` is answered alone.

## Run it

```sh
node main.ts
```

The harness runs `node /bot/main.ts` (Node 22). It reads every case from `/input/cases.json`, answers each one with `run()` from `solve.js`, and writes `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
