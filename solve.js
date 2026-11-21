// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly csv-reader 1.0.0's answer for every input {text, header}:
// {columns, rows, errors}. Same broken-row policy, same error records, same
// order — only the work is different: one pass, no per-character building.
//
// How it stays fast:
// - Most records are plain (no quote, no stray CR). Each such record is found
//   with one native indexOf('\n'), sliced once, and split(',') by the engine
//   (sliced strings, no copying, no per-character loop).
// - Records that hold a quote or a CR take the slow path below, which still
//   jumps with indexOf instead of walking character by character.
// - A quoted field is taken as one slice up to its next quote; doubled quotes
//   ("" -> ") and CR/LF normalisation inside quotes are the only places a
//   value is rebuilt, and quoted fields are the minority.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Each run(input) is answered alone.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Field errors are stamped with these.
  let recordLine = 1;
  let recordRow = null;

  // The field just read, shared by readUnquoted/readQuoted so no result
  // object is allocated per field (there are ~800,000 fields in a set):
  // its value, how it ended (COMMA, LINE_BREAK or END), and, for a quoted
  // field's junk, how many characters the junk appended.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). The result lands
  // in fValue/fEnded/fAdded; `added` counts the characters kept.
  //
  // Only the next comma and the next LF are searched for in the whole text:
  // searching for a CR the same way would run past the field whenever the
  // field holds none (a CR is usually far away), so a CR is looked for only
  // inside the field's own slice, which is short. A CR in the slice is a
  // stray one, except a CR that ends the slice just before its LF, which is
  // half of a CRLF; every stray CR costs one stray_cr error, in order.
  function readUnquoted(value) {
    let added = 0;
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const cIdx = text.indexOf(',', pos);
    const nIdx = text.indexOf('\n', pos);
    let end = len;
    let kind = END;
    if (cIdx !== -1 && cIdx < end) {
      end = cIdx;
      kind = COMMA;
    }
    if (nIdx !== -1 && nIdx < end) {
      end = nIdx;
      kind = LINE_BREAK;
    }
    const seg = text.slice(pos, end);
    const r = seg.indexOf('\r');
    if (r === -1) {
      value += seg;
      added += seg.length;
    } else {
      let cr = 0;
      let clean = '';
      let from = 0;
      for (let i = r; i < seg.length; i += 1) {
        if (seg.charCodeAt(i) === 13) {
          cr += 1;
          clean += seg.slice(from, i);
          from = i + 1;
        }
      }
      clean += seg.slice(from);
      const isCrlf = kind === LINE_BREAK && seg.charCodeAt(seg.length - 1) === 13;
      const stray = cr - (isCrlf ? 1 : 0);
      for (let i = 0; i < stray; i += 1) error('stray_cr');
      value += clean;
      added += clean.length;
    }
    fValue = value;
    fAdded = added;
    if (kind === COMMA) {
      pos = end + 1;
      fEnded = COMMA;
      return;
    }
    if (kind === LINE_BREAK) {
      pos = end + 1;
      line += 1;
      fEnded = LINE_BREAK;
      return;
    }
    pos = len;
    fEnded = END;
  }

  // Normalises one slice from inside a quoted field: each CRLF or lone CR
  // becomes one LF. Returns [value, lineDelta]: how many lines the slice
  // spans (one per CR, plus one per LF not preceded by a CR).
  function normalizeQuoted(seg) {
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) return [seg, 0];
      let n = 0;
      let i = -1;
      while ((i = seg.indexOf('\n', i + 1)) !== -1) n += 1;
      return [seg, n];
    }
    let n = 0;
    for (let i = 0; i < seg.length; i += 1) {
      const c = seg.charCodeAt(i);
      if (c === 13) n += 1;
      else if (c === 10 && seg.charCodeAt(i - 1) !== 13) n += 1;
    }
    return [seg.replace(/\r\n?/g, '\n'), n];
  }

  // Reads a quoted field whose opening quote is at pos. The result lands
  // in fValue/fEnded/fAdded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let segStart = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, then keep looking.
        const seg = normalizeQuoted(text.slice(segStart, q));
        value += seg[0] + '"';
        line += seg[1];
        pos = q + 2;
        segStart = pos;
        continue;
      }
      const seg = normalizeQuoted(text.slice(segStart, q));
      value += seg[0];
      line += seg[1];
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) error('quote_junk');
  }

  // Reads one record the slow way, field by field. Used only for records
  // whose first line holds a quote or a CR.
  function readRecordSlow() {
    const fields = [];
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);
    return { fields, quoted };
  }

  // Takes a finished record's fields: drops a line left with no characters,
  // takes the header, or pads/cuts the row to the first record's width.
  function emitRecord(fields, quoted) {
    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: one whole record, no quote and no CR in it. A line break
    // inside a record can only sit inside a quoted field, and that field's
    // opening quote is on this first line — so a record with a quote in it
    // always shows one here, and falls through to the slow path instead.
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      let recEnd = nl;
      if (recEnd > pos && text.charCodeAt(recEnd - 1) === 13) recEnd -= 1;
      const rec = text.slice(pos, recEnd);
      if (rec.indexOf('"') === -1 && rec.indexOf('\r') === -1) {
        emitRecord(rec.split(','), false);
        pos = nl + 1;
        line += 1;
        continue;
      }
    } else {
      const rec = text.slice(pos);
      if (rec.indexOf('"') === -1 && rec.indexOf('\r') === -1) {
        emitRecord(rec.split(','), false);
        pos = len;
        continue;
      }
    }

    const slow = readRecordSlow();
    emitRecord(slow.fields, slow.quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
