// bytepath.js — byte-path CSV reader for csv-reader 1.0.0 (R2 stage 3).
//
// Reads cases.json as a raw Buffer and answers it without JSON.parse or
// JSON.stringify: it scans the JSON structure for each case's "text" span
// (still JSON-escaped) and "header" flag, parses the CSV straight from the
// escaped bytes, and emits answers.json as a Buffer by copying spans from
// the input (field values are already valid JSON string content, apart from
// the CSV transforms below). Zero per-field string allocation.
//
// Byte alphabet (the text span is a JSON string, so every CSV character is
// either a raw byte or an escape):
//   ','  raw 0x2C            field delimiter
//   '\"' 2 bytes 0x5C 0x22    CSV quote
//   '\n' 2 bytes 0x5C 0x6E    LF (line break / record end)
//   '\r' 2 bytes 0x5C 0x72    CR (stray outside quotes, LF inside quotes)
//   other escapes (\uXXXX, \t, \b, \f, \/, \\) are plain characters: copied
//   verbatim (valid JSON in, valid JSON out) and never delimiters.
// A backslash is an escape introducer iff the run of '\' immediately before
// it is even; searches that jump with indexOf check that parity, sequential
// scans from a clean position need no check.
//
// CSV transforms applied while copying (same semantics as solve.js / SPEC):
//   '""' inside a quoted field (bytes '\"\"') -> one '"' (bytes '\"').
//   CR inside quotes ('\r' or '\r\n') -> one LF (bytes '\n'), +1 line.
//   Stray CR outside quotes -> dropped, 1 stray_cr error each.
//   Unterminated quote -> literal '"', text re-read as unquoted, 1 error;
//     content emitted while scanning for the close is rewound and discarded.
// Rows are emitted as they are parsed, with an output-buffer rewind for
// dropped records (single empty unquoted field) and long rows (cut to width).
// Errors are buffered as small strings (rare) and emitted at the case end.

const BS = 0x5C, DQ = 0x22, CM = 0x2C, N = 0x6E, R = 0x72, U = 0x75;
const TEXT_NEEDLE = Buffer.from('"text":"');
const HEADER_NEEDLE = Buffer.from('"header":');

export function byteRun(buf) {
  let out = Buffer.allocUnsafe(Math.max(65536, buf.length * 2 + 65536));
  let op = 0;
  function grow(n) {
    let nl = out.length * 2;
    while (op + n > nl) nl *= 2;
    const nb = Buffer.allocUnsafe(nl);
    out.copy(nb, 0, 0, op);
    out = nb;
  }
  function putStr(s) {
    const n = Buffer.byteLength(s, 'utf8');
    if (op + n > out.length) grow(n);
    op += out.write(s, op, 'utf8');
  }

  // Is the backslash at p a real escape introducer?
  function isIntroducer(p) {
    let r = 0, q = p - 1;
    while (q >= 0 && buf[q] === BS) { r++; q--; }
    return (r & 1) === 0;
  }
  // Next real \n / \r escape in [p, limit), or -1. Sequential BS scan from
  // a clean position, so every BS found is an introducer.
  function findLF(p, limit) {
    let q = p;
    for (;;) {
      const bs = buf.indexOf(BS, q);
      if (bs === -1 || bs >= limit) return -1;
      if (buf[bs + 1] === N) return bs;
      q = bs + (buf[bs + 1] === U ? 6 : 2);
    }
  }
  function findCR(p, limit) {
    let q = p;
    for (;;) {
      const bs = buf.indexOf(BS, q);
      if (bs === -1 || bs >= limit) return -1;
      if (buf[bs + 1] === R) return bs;
      q = bs + (buf[bs + 1] === U ? 6 : 2);
    }
  }
  const isLF = (p) => buf[p] === BS && buf[p + 1] === N;
  const isCR = (p) => buf[p] === BS && buf[p + 1] === R;
  const isQ = (p) => buf[p] === BS && buf[p + 1] === DQ;
  const rowStr = (r) => (r === null ? 'null' : '' + r);

  out[op++] = 0x5B; // [
  let searchFrom = 0;
  let caseIdx = 0;
  for (;;) {
    const tpos = buf.indexOf(TEXT_NEEDLE, searchFrom);
    if (tpos === -1) break;
    const spanStart = tpos + TEXT_NEEDLE.length;
    // Span end: first raw '"' (unescaped). Raw '"' never occurs inside a
    // JSON string value, so this is the closing quote of the text span.
    let spanEnd = -1;
    {
      let m = buf.indexOf(DQ, spanStart);
      while (m !== -1) {
        let r = 0, q = m - 1;
        while (q >= 0 && buf[q] === BS) { r++; q--; }
        if ((r & 1) === 0) { spanEnd = m; break; }
        m = buf.indexOf(DQ, m + 1);
      }
    }
    if (spanEnd === -1) break;
    const hpos = buf.indexOf(HEADER_NEEDLE, spanEnd);
    let header = false;
    if (hpos !== -1) {
      let v = hpos + HEADER_NEEDLE.length;
      while (buf[v] === 0x20 || buf[v] === 0x0A || buf[v] === 0x0D || buf[v] === 0x09) v++;
      header = buf[v] === 0x74; // 't'
    }
    if (caseIdx > 0) out[op++] = CM;
    caseIdx++;
    // Output for a case is at most ~4x its span (field content <= span, plus
    // at most 3 JSON-overhead bytes per field) + slack; use 5x so a
    // pathological input (many tiny fields / many errors) can never overflow
    // the direct writes below, which rely on this ensure.
    const need = (spanEnd - spanStart) * 5 + 8192;
    if (op + need > out.length) grow(need);
    parseCase(spanStart, spanEnd, header);
    searchFrom = spanEnd + 1;
  }
  out[op++] = 0x5D; // ]
  return out.subarray(0, op);

  function parseCase(spanStart, spanEnd, header) {
    const errs = [];
    let pos = spanStart;
    // BOM: UTF-8 EF BB BF at position 0.
    if (spanEnd - spanStart >= 3 && buf[spanStart] === 0xEF && buf[spanStart + 1] === 0xBB && buf[spanStart + 2] === 0xBF) pos = spanStart + 3;
    let line = 1;
    let first = true;
    let width = 0;
    let rowCount = 0;

    putStr('{"columns":');
    if (!header) putStr('null,"rows":[');

    let curLineEnd = -1;
    let curLineCR = -2;
    let curLineEndIsLF = false;
    function ensureLine(p) {
      if (curLineEnd !== -1) return;
      const nl = findLF(p, spanEnd);
      curLineEnd = nl === -1 ? spanEnd : nl;
      curLineEndIsLF = nl !== -1;
      curLineCR = findCR(p, curLineEnd);
    }

    let rewindPos = 0;
    let afterWidthPos = -1;
    let curIsColumns = false;
    let f0contentLen = 0;

    function commitRecord(fc, f0quoted, recordLine, recRow) {
      if (fc === 1 && !f0quoted && f0contentLen === 0) {
        op = rewindPos; // dropped record: single empty unquoted field
        return 'dropped';
      }
      if (first) {
        first = false;
        width = fc;
        out[op++] = 0x5D;
        if (header) return 'columns';
        rowCount++;
        return 'row';
      }
      if (fc < width) {
        errs.push('{"code":"short_row","line":' + recordLine + ',"row":' + rowStr(recRow) + ',"fields":' + fc + '}');
        for (let i = fc; i < width; i++) { out[op++] = CM; out[op++] = DQ; out[op++] = DQ; }
        out[op++] = 0x5D;
        rowCount++;
        return 'row';
      }
      if (fc > width) {
        // Extra fields are already emitted as ,"v",... after afterWidthPos;
        // reuse those bytes for the error's extra array.
        const extraJson = out.subarray(afterWidthPos + 1, op).toString('utf8');
        errs.push('{"code":"long_row","line":' + recordLine + ',"row":' + rowStr(recRow) + ',"extra":[' + extraJson + ']}');
        op = afterWidthPos;
        out[op++] = 0x5D;
        rowCount++;
        return 'row';
      }
      out[op++] = 0x5D;
      rowCount++;
      return 'row';
    }

    // Full unquoted-field parse (stray CR / EOL / EOF). Emits content into
    // out. Returns {kind, end, junk} (junk = bytes appended, for quote_junk).
    function parseUnquoted(start, isJunk, recordLine, recRow) {
      ensureLine(start);
      let junk = 0;
      let p = start;
      for (;;) {
        const cm = buf.indexOf(CM, p);
        if (cm !== -1 && cm < curLineEnd) {
          if (curLineCR !== -1 && curLineCR < cm &&
              !(curLineCR === curLineEnd - 2 && curLineEndIsLF && isCR(curLineEnd - 2) && isIntroducer(curLineEnd - 2))) {
            if (curLineCR > p) { buf.copy(out, op, p, curLineCR); op += (curLineCR - p); }
            if (isJunk) junk += (curLineCR - p);
            errs.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + rowStr(recRow) + '}');
            p = curLineCR + 2;
            curLineCR = findCR(p, curLineEnd);
            continue;
          }
          if (cm > p) { buf.copy(out, op, p, cm); op += (cm - p); }
          if (isJunk) junk += (cm - p);
          return { kind: 'comma', end: cm + 1, junk };
        }
        let fieldEnd = curLineEnd;
        let kind;
        if (!curLineEndIsLF) {
          kind = 'eof';
        } else {
          kind = 'eol';
          if (fieldEnd > p && isCR(fieldEnd - 2) && isIntroducer(fieldEnd - 2)) fieldEnd -= 2;
        }
        if (curLineCR !== -1 && curLineCR < fieldEnd) {
          if (curLineCR > p) { buf.copy(out, op, p, curLineCR); op += (curLineCR - p); }
          if (isJunk) junk += (curLineCR - p);
          errs.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + rowStr(recRow) + '}');
          p = curLineCR + 2;
          curLineCR = findCR(p, curLineEnd);
          continue;
        }
        if (fieldEnd > p) { buf.copy(out, op, p, fieldEnd); op += (fieldEnd - p); }
        if (isJunk) junk += (fieldEnd - p);
        if (kind === 'eol') {
          line++;
          const endPos = curLineEnd + 2;
          curLineEnd = -1;
          curLineCR = -2;
          return { kind, end: endPos, junk };
        }
        curLineEnd = -1;
        curLineCR = -2;
        return { kind, end: spanEnd, junk };
      }
    }

    while (pos < spanEnd) {
      // Skip empty lines (LF / CRLF). A lone CR falls through to record parse.
      for (;;) {
        if (pos >= spanEnd) break;
        if (isLF(pos)) { line++; pos += 2; continue; }
        if (isCR(pos) && isLF(pos + 2)) { line++; pos += 4; continue; }
        break;
      }
      if (pos >= spanEnd) break;
      const recordLine = line;
      const recRow = (header && first) ? null : rowCount;
      curLineEnd = -1;
      curLineCR = -2;

      curIsColumns = first && header;
      rewindPos = op;
      afterWidthPos = -1;
      f0contentLen = 0;
      if (!curIsColumns && rowCount > 0) out[op++] = CM;
      out[op++] = 0x5B; // [ row/columns open

      // Fast-path check: one BS scan finds the line end and reports whether
      // the line holds a quote or a stray CR.
      let lineEnd = -1;
      let lineEndIsLF = false;
      let nextPos = spanEnd;
      let fastOK = true;
      {
        let p = pos;
        for (;;) {
          const bs = buf.indexOf(BS, p);
          if (bs === -1 || bs >= spanEnd) { lineEnd = spanEnd; lineEndIsLF = false; nextPos = spanEnd; break; }
          const c2 = buf[bs + 1];
          if (c2 === N) { lineEnd = bs; lineEndIsLF = true; nextPos = bs + 2; break; }
          if (c2 === DQ) { fastOK = false; break; }
          if (c2 === R) {
            if (buf[bs + 2] === BS && buf[bs + 3] === N) { lineEnd = bs; lineEndIsLF = true; nextPos = bs + 4; break; }
            fastOK = false; break;
          }
          p = bs + (c2 === U ? 6 : 2);
        }
      }
      if (fastOK) {
        // No quotes, no stray CR on this line: split by commas, copy spans.
        let f = pos;
        let fc = 0;
        for (;;) {
          const cm = buf.indexOf(CM, f);
          if (cm === -1 || cm >= lineEnd) {
            if (fc > 0) out[op++] = CM;
            out[op++] = DQ;
            if (lineEnd > f) { buf.copy(out, op, f, lineEnd); op += (lineEnd - f); }
            out[op++] = DQ;
            fc++;
            if (fc === width) afterWidthPos = op;
            break;
          }
          if (fc > 0) out[op++] = CM;
          out[op++] = DQ;
          if (cm > f) { buf.copy(out, op, f, cm); op += (cm - f); }
          out[op++] = DQ;
          fc++;
          if (fc === width) afterWidthPos = op;
          f = cm + 1;
        }
        f0contentLen = lineEnd - pos;
        if (lineEndIsLF) line++;
        pos = nextPos;
        const res = commitRecord(fc, false, recordLine, recRow);
        if (res === 'columns') putStr(',"rows":[');
        continue;
      }

      // Slow path: field by field.
      ensureLine(pos);
      let fc = 0;
      let f0quoted = false;
      let endRecord = false;
      while (!endRecord) {
        ensureLine(pos);
        if (isQ(pos)) {
          // Quoted field: one sequential BS scan handles the closing quote,
          // '""' escapes, CR/LF normalisation and line counting.
          if (fc === 0) f0quoted = true;
          if (fc > 0) out[op++] = CM;
          out[op++] = DQ;
          const contentStart = op;
          const scanStartOp = op; // rewind if unterminated
          let p = pos + 2;
          let qLines = 0;
          let closedAt = -1;
          let unterm = false;
          let segStart = p;
          for (;;) {
            const bs = buf.indexOf(BS, p);
            if (bs === -1 || bs >= spanEnd) { unterm = true; break; }
            const c2 = buf[bs + 1];
            if (c2 === DQ) {
              if (buf[bs + 2] === BS && buf[bs + 3] === DQ) {
                if (bs > segStart) { buf.copy(out, op, segStart, bs); op += (bs - segStart); }
                out[op++] = BS; out[op++] = DQ;
                p = bs + 4;
                segStart = bs + 4;
                continue;
              }
              if (bs > segStart) { buf.copy(out, op, segStart, bs); op += (bs - segStart); }
              closedAt = bs;
              break;
            }
            if (c2 === N) {
              if (bs + 2 > segStart) { buf.copy(out, op, segStart, bs + 2); op += (bs + 2 - segStart); }
              qLines++;
              p = bs + 2;
              segStart = bs + 2;
              continue;
            }
            if (c2 === R) {
              if (bs > segStart) { buf.copy(out, op, segStart, bs); op += (bs - segStart); }
              out[op++] = BS; out[op++] = N;
              qLines++;
              let np = bs + 2;
              if (buf[np] === BS && buf[np + 1] === N) np += 2;
              p = np;
              segStart = np;
              continue;
            }
            const adv = c2 === U ? 6 : 2;
            if (bs + adv > segStart) { buf.copy(out, op, segStart, bs + adv); op += (bs + adv - segStart); }
            p = bs + adv;
            segStart = bs + adv;
          }
          if (unterm) {
            op = scanStartOp; // discard content the scan emitted
            errs.push('{"code":"unterminated_quote","line":' + recordLine + ',"row":' + rowStr(recRow) + '}');
            out[op++] = BS; out[op++] = DQ; // the opening quote is literal
            const uq = parseUnquoted(pos + 2, false, recordLine, recRow);
            out[op++] = DQ;
            if (fc === 0) f0contentLen = op - contentStart - 1;
            pos = uq.end;
            if (uq.kind !== 'comma') endRecord = true;
            fc++;
            if (fc === width) afterWidthPos = op;
            continue;
          }
          const after = closedAt + 2;
          if (after >= spanEnd) {
            out[op++] = DQ;
            if (fc === 0) f0contentLen = op - contentStart - 1;
            pos = spanEnd;
            line += qLines;
            endRecord = true;
          } else if (buf[after] === CM) {
            out[op++] = DQ;
            if (fc === 0) f0contentLen = op - contentStart - 1;
            pos = after + 1;
            line += qLines;
            if (qLines > 0) { curLineEnd = -1; curLineCR = -2; }
          } else if (isLF(after)) {
            out[op++] = DQ;
            if (fc === 0) f0contentLen = op - contentStart - 1;
            pos = after + 2;
            line += qLines + 1;
            endRecord = true;
          } else if (isCR(after)) {
            if (isLF(after + 2)) {
              out[op++] = DQ;
              if (fc === 0) f0contentLen = op - contentStart - 1;
              pos = after + 4;
              line += qLines + 1;
              endRecord = true;
            } else {
              errs.push('{"code":"stray_cr","line":' + recordLine + ',"row":' + rowStr(recRow) + '}');
              line += qLines;
              curLineEnd = -1;
              curLineCR = -2;
              const uq = parseUnquoted(after + 2, true, recordLine, recRow);
              if (uq.junk > 0) errs.push('{"code":"quote_junk","line":' + recordLine + ',"row":' + rowStr(recRow) + '}');
              out[op++] = DQ;
              if (fc === 0) f0contentLen = op - contentStart - 1;
              pos = uq.end;
              if (uq.kind !== 'comma') endRecord = true;
            }
          } else {
            line += qLines;
            if (qLines > 0) { curLineEnd = -1; curLineCR = -2; }
            const uq = parseUnquoted(after, true, recordLine, recRow);
            if (uq.junk > 0) errs.push('{"code":"quote_junk","line":' + recordLine + ',"row":' + rowStr(recRow) + '}');
            out[op++] = DQ;
            if (fc === 0) f0contentLen = op - contentStart - 1;
            pos = uq.end;
            if (uq.kind !== 'comma') endRecord = true;
          }
          fc++;
          if (fc === width) afterWidthPos = op;
          continue;
        }
        // Unquoted field: inline the common comma/no-CR case, else full parse.
        if (fc > 0) out[op++] = CM;
        out[op++] = DQ;
        const contentStart = op;
        const cm = buf.indexOf(CM, pos);
        if (cm !== -1 && cm < curLineEnd && curLineCR === -1) {
          if (cm > pos) { buf.copy(out, op, pos, cm); op += (cm - pos); }
          out[op++] = DQ;
          if (fc === 0) f0contentLen = op - contentStart - 1;
          pos = cm + 1;
          fc++;
          if (fc === width) afterWidthPos = op;
          continue;
        }
        const uq = parseUnquoted(pos, false, recordLine, recRow);
        out[op++] = DQ;
        if (fc === 0) f0contentLen = op - contentStart - 1;
        pos = uq.end;
        if (uq.kind !== 'comma') endRecord = true;
        fc++;
        if (fc === width) afterWidthPos = op;
      }
      const res = commitRecord(fc, f0quoted, recordLine, recRow);
      if (res === 'columns') putStr(',"rows":[');
    }

    if (header && first) {
      putStr('[],"rows":[]');
    } else {
      out[op++] = 0x5D; // ] rows close
    }
    putStr(',"errors":[');
    putStr(errs.join(','));
    putStr(']}');
  }
}
