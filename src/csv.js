// Shared CSV writing for the seller exports. Cells that a spreadsheet could read as a formula are neutralised, because
// buyers and sellers choose their own text.
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const money = (minor) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

// The byte-order mark makes Excel read the file as UTF-8.
export const toCsv = (lines) => `﻿${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
