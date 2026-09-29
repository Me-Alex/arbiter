/**
 * csv.mjs — the one implementation of the CSV quoting rules.
 *
 * Both the scan export (scan-service.mjs) and the tracker import/export
 * (tracker-service.mjs) need to quote a value that could break the row
 * structure, and they each had their own copy. The copies had drifted on the
 * exact point that matters: the scan copy also escaped a carriage return, the
 * tracker copy only escaped a comma, a quote or a newline. A note containing a
 * bare `\r` therefore exported unquoted from the tracker and re-imported as two
 * lines, silently corrupting the file. There is one rule now, and it is the
 * stricter one.
 */

/**
 * Quote one value for a CSV field (RFC 4180).
 *
 * A field is quoted when it contains a comma, a double quote, a line feed or a
 * carriage return; embedded quotes are doubled. null and undefined are the
 * empty field, not the strings "null"/"undefined".
 *
 * @param {unknown} v
 * @returns {string}
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Join one row of values into a CSV line.
 *
 * @param {unknown[]} cells
 * @returns {string}
 */
export function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

/**
 * Split one CSV line into its fields, honouring quoted fields and doubled
 * quotes. This is the inverse of csvRow for a single line; it does not handle
 * newlines embedded inside a quoted field (a multi-line quoted cell must be
 * joined by the caller before splitting on line breaks).
 *
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}
