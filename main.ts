// csv-reader-speed-01 R2 — driver (stage 2 fallback).
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json, answers each one with
// run() from solve.js, writes $MAKEFUN_OUTPUT_DIR/answers.json as a JSON array
// of answers in the cases' order. No network, no writes outside the output dir.
// V8 flags are set before solve.js is imported so all of its work runs under them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = await import(new URL('./solve.js', import.meta.url).href);

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
