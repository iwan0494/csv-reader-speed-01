// solve.js — fast drop-in for csv-reader 1.0.0 (R2, written fresh from SPEC.md).
//
// Semantics (from SPEC.md, must be identical to csv-reader 1.0.0):
// - U+FEFF only at position 0 is dropped. Records end at LF or CRLF.
// - A 0-char line is not a record (empty LF/CRLF lines skipped; a line that is
//   only a stray CR is not a record, but its stray_cr error is still recorded).
// - Outside quotes, a CR not followed by LF is dropped, 1 error `stray_cr` each.
// - A field opened by `"` runs to the next `"` that is not doubled; `""` is one
//   `"`. CRLF / lone CR inside quotes read as one LF in the value and add 1 to
//   the line number per LF/CRLF/lone CR. After the closing quote: `,` continues,
//   LF / CRLF / EOF ends the record; anything else is read as unquoted and
//   appended to the value — if >=1 char appended, 1 error `quote_junk` when the
//   field ends (a discarded stray CR does not count as appended, but its
//   stray_cr error still comes first). A quote that never closes is a literal
//   `"`, the text after it is re-read as unquoted, 1 error `unterminated_quote`
//   (line number restored to the line where the quote opened).
// - A `"` inside an unquoted field is a literal. Fields stay strings.
// - `columns` = first record if header true, else null; if header true and no
//   record at all, columns = []. `rows` = records after the header (all if
//   header false). Each row is cut/padded to the width of the FIRST record
//   (header counts): short -> error `short_row` {code,line,row,fields} + pad
//   with ""; long -> error `long_row` {code,line,row,extra} + cut.
// - Every error is {code,line,row} in encounter order; field errors when the
//   field is read, short/long_row when the record ends. `line` = 1-based line
//   where the record STARTED. `row` = index of the record in `rows` (0-based;
//   header = null).
//
// Speed design:
// - Fast path per record: if the record's first line has no `"` and no stray
//   CR, fields come from a single indexOf(',') scan with slice-assign (no
//   split, no per-field function call, no regex, no += concat).
// - Slow path per field with indexOf jumps (never a per-char loop in hot
//   code): quoted fields find the closing quote with indexOf('"'), `""`
//   escapes are single slices joined once, CR normalisation only happens for
//   segments that actually contain CR. Unquoted fields find the next `,`,
//   reusing the cached line end, and only scan for CR when the line has one.
// - Line numbers inside quotes are counted locally and committed only when
//   the quote closes, so an unterminated quote restores the opening line.
// - No allocation per character; field values are slices (or one join of a
//   few slices when a field has several segments).

export function run(input) {
  const text = input.text;
  const header = input.header === true;
  const len = text.length;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = 0;
  let first = true;
  let line = 1;
  let pos = 0;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // ---- per-record state (closure vars, set at each record start) ----
  let recordLine = 1;
  let recRow = 0;

  // ---- current-line cache (for the slow path) ----
  // curLineEnd: position of the '\n' ending the current line, or len; -1 = unknown.
  // curLineCR: position of the first '\r' at/after the current field start on
  //   the current line, or -1 = none; -2 = unknown.
  let curLineEnd = -1;
  let curLineCR = -2;
  function ensureLine(p) {
    if (curLineEnd !== -1) return;
    const nl = text.indexOf('\n', p);
    curLineEnd = nl === -1 ? len : nl;
    const cr = text.indexOf('\r', p);
    curLineCR = cr === -1 || cr >= curLineEnd ? -1 : cr;
  }

  // ---- field-value accumulator (slice-assign, one join at field end) ----
  let accSingle = null;
  let accParts = null;
  function accReset() { accSingle = null; accParts = null; }
  function accAdd(x) {
    if (accParts !== null) { accParts.push(x); return; }
    if (accSingle === null) { accSingle = x; return; }
    accParts = [accSingle, x];
    accSingle = null;
  }
  function accGet() { return accParts !== null ? accParts.join('') : accSingle; }

  // ---- quoted-segment processing ----
  // Processes text[s..e): adds the piece to the accumulator (normalising CR
  // to LF when the segment contains CR) and sets segBreaks to the number of
  // line breaks in the segment.
  let segBreaks = 0;
  function processSegment(s, e) {
    const r = text.indexOf('\r', s);
    if (r === -1 || r >= e) {
      // No CR. A '\n' is possible only if the segment reaches past the
      // current line end.
      if (e <= curLineEnd) {
        accAdd(text.slice(s, e));
        segBreaks = 0;
        return;
      }
      let cnt = 0;
      let from = s;
      for (;;) {
        const i = text.indexOf('\n', from);
        if (i === -1 || i >= e) break;
        cnt++;
        from = i + 1;
      }
      accAdd(text.slice(s, e));
      segBreaks = cnt;
      return;
    }
    // Contains CR: normalise CRLF / lone CR to LF, then count the LFs.
    const raw = text.slice(s, e);
    const norm = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    let cnt = 0;
    let from = 0;
    for (;;) {
      const i = norm.indexOf('\n', from);
      if (i === -1) break;
      cnt++;
      from = i + 1;
    }
    accAdd(norm);
    segBreaks = cnt;
  }

  // ---- unquoted field parsing ----
  // Parses an unquoted field starting at `start` (on the current line).
  // The accumulator already holds the initial value ('' for a plain field,
  // '"' for an unterminated re-read, the quoted value for junk).
  // Sets uqValue (string), uqKind ('comma' | 'eol' | 'eof'), uqJunk (chars
  // appended, meaningful when isJunk), uqEnd (position after the field).
  // Advances `line` when the record ends at a line break.
  let uqValue;
  let uqKind;
  let uqJunk;
  let uqEnd;
  function parseUnquoted(start, isJunk) {
    ensureLine(start);
    let junk = 0;
    let p = start;
    for (;;) {
      const cm = text.indexOf(',', p);
      if (cm !== -1 && cm < curLineEnd) {
        // Field ends at the comma, unless a stray CR comes first.
        if (curLineCR !== -1 && curLineCR < cm &&
            !(curLineCR === curLineEnd - 1 && curLineEnd < len)) {
          const seg = text.slice(p, curLineCR);
          accAdd(seg);
          if (isJunk) junk += seg.length;
          errors.push({ code: 'stray_cr', line: recordLine, row: recRow });
          p = curLineCR + 1;
          curLineCR = text.indexOf('\r', p);
          if (curLineCR >= curLineEnd) curLineCR = -1;
          continue;
        }
        const seg = text.slice(p, cm);
        accAdd(seg);
        if (isJunk) junk += seg.length;
        uqValue = accGet();
        uqKind = 'comma';
        uqJunk = junk;
        uqEnd = cm + 1;
        return;
      }
      // No comma before the line end: the field ends at the line end / EOF.
      let fieldEnd = curLineEnd;
      let kind;
      if (curLineEnd >= len) {
        kind = 'eof';
      } else {
        kind = 'eol';
        if (fieldEnd > p && text.charCodeAt(fieldEnd - 1) === 13) fieldEnd--;
      }
      if (curLineCR !== -1 && curLineCR < fieldEnd) {
        const seg = text.slice(p, curLineCR);
        accAdd(seg);
        if (isJunk) junk += seg.length;
        errors.push({ code: 'stray_cr', line: recordLine, row: recRow });
        p = curLineCR + 1;
        curLineCR = text.indexOf('\r', p);
        if (curLineCR >= curLineEnd) curLineCR = -1;
        continue;
      }
      const seg = text.slice(p, fieldEnd);
      accAdd(seg);
      if (isJunk) junk += seg.length;
      uqValue = accGet();
      uqKind = kind;
      uqJunk = junk;
      if (kind === 'eol') {
        line++;
        uqEnd = curLineEnd + 1;
      } else {
        uqEnd = len;
      }
      curLineEnd = -1;
      curLineCR = -2;
      return;
    }
  }

  // ---- record commit (shared by fast and slow paths) ----
  function commitRecord(fields, f0quoted) {
    if (fields.length === 1 && fields[0] === '' && !f0quoted) return; // not a record
    if (first) {
      first = false;
      if (header) {
        columns = fields;
        width = fields.length;
      } else {
        columns = null;
        width = fields.length;
        rows.push(fields);
      }
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
      rows.push(fields);
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recRow, extra: fields.slice(width) });
      fields.length = width;
      rows.push(fields);
    } else {
      rows.push(fields);
    }
  }

  // ================= main loop =================
  while (pos < len) {
    const c = text.charCodeAt(pos);
    if (c === 10) { line++; pos++; continue; } // empty LF line
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { line++; pos += 2; continue; } // empty CRLF line

    recordLine = line;
    recRow = header && first ? null : rows.length;
    // The previous record may have ended without invalidating the line
    // cache (quoted-branch record ends, fast path); force a recompute.
    curLineEnd = -1;
    curLineCR = -2;

    // ---- fast path? ----
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= lineEnd) {
      const cr = text.indexOf('\r', pos);
      if (cr === -1 || cr >= lineEnd || (cr === lineEnd - 1 && nl !== -1)) {
        // No quotes, no stray CR on this line: split by commas with indexOf.
        let end = lineEnd;
        if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end--;
        const fields = [];
        let f = pos;
        for (;;) {
          const cm = text.indexOf(',', f);
          if (cm === -1 || cm >= end) { fields.push(text.slice(f, end)); break; }
          fields.push(text.slice(f, cm));
          f = cm + 1;
        }
        if (nl === -1) {
          pos = len;
        } else {
          line++;
          pos = nl + 1;
        }
        commitRecord(fields, false);
        continue;
      }
    }

    // ---- slow path: parse the record field by field ----
    ensureLine(pos);
    const fields = [];
    let f0quoted = false;
    let fieldIdx = 0;
    let endRecord = false;
    while (!endRecord) {
      ensureLine(pos);
      if (text.charCodeAt(pos) === 34) {
        // ----- quoted field -----
        if (fieldIdx === 0) f0quoted = true;
        accReset();
        let segStart = pos + 1;
        let p = pos + 1;
        let qLines = 0;
        let closedAt = -1;
        let unterm = false;
        for (;;) {
          const qq = text.indexOf('"', p);
          if (qq === -1) { unterm = true; break; }
          if (text.charCodeAt(qq + 1) === 34) {
            processSegment(segStart, qq);
            qLines += segBreaks;
            accAdd('"');
            p = qq + 2;
            segStart = qq + 2;
            continue;
          }
          processSegment(segStart, qq);
          qLines += segBreaks;
          closedAt = qq;
          break;
        }
        if (unterm) {
          // Unterminated: the opening quote is literal, re-read as unquoted
          // from pos+1; the line number is restored (qLines discarded).
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recRow });
          accReset();
          accAdd('"');
          parseUnquoted(pos + 1, false);
          fields.push(uqValue);
          pos = uqEnd;
          if (uqKind !== 'comma') endRecord = true;
          fieldIdx++;
          continue;
        }
        // Closed: what follows the closing quote?
        const after = closedAt + 1;
        if (after >= len) {
          fields.push(accGet());
          pos = len;
          line += qLines;
          endRecord = true;
        } else {
          const nc = text.charCodeAt(after);
          if (nc === 44) { // ','
            fields.push(accGet());
            pos = after + 1;
            line += qLines;
            if (qLines > 0) { curLineEnd = -1; curLineCR = -2; }
          } else if (nc === 10) { // '\n'
            fields.push(accGet());
            pos = after + 1;
            line += qLines + 1;
            endRecord = true;
          } else if (nc === 13) { // '\r'
            if (text.charCodeAt(after + 1) === 10) { // CRLF
              fields.push(accGet());
              pos = after + 2;
              line += qLines + 1;
              endRecord = true;
            } else {
              // Stray CR, then junk (the CR itself is discarded). Invalidate
              // the line cache: the CR is consumed, so parseUnquoted must not
              // see it again as a stray CR on this line.
              errors.push({ code: 'stray_cr', line: recordLine, row: recRow });
              line += qLines;
              curLineEnd = -1;
              curLineCR = -2;
              parseUnquoted(after + 1, true);
              if (uqJunk > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recRow });
              }
              fields.push(uqValue);
              pos = uqEnd;
              if (uqKind !== 'comma') endRecord = true;
            }
          } else {
            // Junk: read unquoted from `after`, appending to the quoted value.
            line += qLines;
            if (qLines > 0) { curLineEnd = -1; curLineCR = -2; }
            parseUnquoted(after, true);
            if (uqJunk > 0) {
              errors.push({ code: 'quote_junk', line: recordLine, row: recRow });
            }
            fields.push(uqValue);
            pos = uqEnd;
            if (uqKind !== 'comma') endRecord = true;
          }
        }
        fieldIdx++;
        continue;
      }
      // ----- unquoted field -----
      accReset();
      parseUnquoted(pos, false);
      fields.push(uqValue);
      pos = uqEnd;
      if (uqKind !== 'comma') endRecord = true;
      fieldIdx++;
    }
    commitRecord(fields, f0quoted);
  }

  if (header && first) columns = [];
  return { columns, rows, errors };
}
