import { FieldError } from './validation.js';

/* Product imports retain their historical permissive quote handling; inbound tracking opts into strict syntax. */
export function parseCsv(text, { maxRows = 2000, cellMax = 4000, strict = false } = {}) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  const push = () => {
    row.push(cell); cell = ''; closed = false;
    if (row.some((value) => value !== '') || row.length > 1) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) throw new FieldError('csv', `The file has more than ${maxRows} rows.`);
  };
  for (let index = text.charCodeAt(0) === 0xFEFF ? 1 : 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ',') { row.push(cell); cell = ''; closed = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      push();
    } else if (char === '"' && cell === '' && !closed) quoted = true;
    else {
      if (strict && (closed || char === '"')) throw new FieldError('csv', 'Malformed CSV quoting.');
      cell += char;
    }
    if (cell.length > cellMax) throw new FieldError('csv', 'A cell is longer than allowed.');
  }
  if (quoted) throw new FieldError('csv', 'The file has an unclosed quote.');
  push();
  return rows;
}

// Shared CSV writing for the seller exports. Cells that a spreadsheet could read as a formula are neutralised, because
// buyers and sellers choose their own text.
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const money = (minor) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

// The byte-order mark makes Excel read the file as UTF-8.
export const toCsv = (lines) => `﻿${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
