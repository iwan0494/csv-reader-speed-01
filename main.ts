// csv-reader-speed-01 R2 — driver (stage 3 byte path).
// Reads $MAKEFUN_INPUT_DIR/cases.json as a raw Buffer and answers it with
// byteRun() from bytepath.js (no JSON.parse, no JSON.stringify, no per-field
// string building): the CSV is parsed straight from the JSON-escaped bytes
// and answers.json is emitted as a Buffer by copying spans. A small warmup
// primes the JIT (the hot parser runs cold once per process otherwise).
// If the byte path ever throws (unexpected input shape), it falls back to
// the plain driver (JSON.parse + solve.js run() + JSON.stringify) so the
// entry still answers correctly, just slower. No network, no writes outside
// the output dir. V8 flags are set before either module is imported.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { byteRun } = await import(new URL('./bytepath.js', import.meta.url).href);

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'));

// Prime the JIT on a tiny input that exercises the hot paths (header on/off,
// quoted/unquoted fields, '""' escapes, short/long rows, CR, multi-line
// quoted fields, unterminated quotes) so the real run executes optimized code.
const warm = Buffer.from(JSON.stringify([
  { id: 'w1', input: { text: 'a,b,c\n"x","y""z",w\np,q\n', header: true } },
  { id: 'w2', input: { text: '"a\nb",c\r\nd,e,f,g\n"unterminated\nx,y\n', header: false } },
  { id: 'w3', input: { text: 'h1,h2\n1,2,3\n4\n', header: true } },
  { id: 'w4', input: { text: 'plain,fields,here\nmore,fields,there\n', header: false } },
]), 'utf8');
for (let i = 0; i < 5; i++) byteRun(warm);

let answers;
try {
  answers = byteRun(raw);
} catch {
  const { run } = await import(new URL('./solve.js', import.meta.url).href);
  const cases = JSON.parse(raw.toString('utf8'));
  const out = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) out[i] = run(cases[i].input);
  answers = Buffer.from(JSON.stringify(out), 'utf8');
}
writeFileSync(join(outputDir, 'answers.json'), answers);
