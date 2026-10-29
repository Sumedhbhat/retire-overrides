// Surgical edits to string arrays in TOML files (pyproject.toml), preserving every comment, blank line
// and formatting choice around the change. Each edit re-parses the result and checks that exactly the
// intended change happened; anything unexpected throws instead of writing a surprising file.
import { parse } from "smol-toml";

export class TomlEditError extends Error {}

interface ArraySpan {
  /** Index of `[` that opens the array. */
  open: number;
  /** Index of the matching `]`. */
  close: number;
  elements: Array<{ start: number; end: number; value: string }>;
}

/** Finds `[table]` header lines, so keys are searched only inside the right table. */
function tableRange(text: string, table: string[]): { start: number; end: number } | null {
  const lines = text.split("\n");
  let offset = 0;
  let start: number | null = null;
  for (const line of lines) {
    const header = /^\s*\[(?!\[)\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line) ?? /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(#.*)?$/.exec(line);
    if (header) {
      const name = header[1]!.split(".").map((p) => p.trim().replace(/^["']|["']$/g, ""));
      if (start !== null) return { start, end: offset };
      if (name.join(".") === table.join(".")) start = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  if (start !== null) return { start, end: text.length };
  return table.length === 0 ? { start: 0, end: text.length } : null;
}

function skipString(text: string, i: number): number {
  const quote = text[i]!;
  const triple = text.startsWith(quote.repeat(3), i);
  if (triple) {
    const close = text.indexOf(quote.repeat(3), i + 3);
    if (close === -1) throw new TomlEditError("unterminated string");
    return close + 3;
  }
  for (let j = i + 1; j < text.length; j++) {
    if (quote === '"' && text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === quote) return j + 1;
    if (text[j] === "\n") break;
  }
  throw new TomlEditError("unterminated string");
}

function findArray(text: string, table: string[], key: string): ArraySpan | null {
  const range = tableRange(text, table);
  if (!range) return null;
  const segment = text.slice(range.start, range.end);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*(?:${escaped}|"${escaped}")[ \\t]*=[ \\t]*\\[`, "m").exec(segment);
  if (!m) return null;
  const open = range.start + m.index + m[0].length - 1;
  const elements: ArraySpan["elements"] = [];
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "]") return { open, close: i, elements };
    if (ch === "#") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
    } else if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      elements.push({ start: i, end, value: parse(`v = ${text.slice(i, end)}`).v as string });
      i = end;
    } else if (/[\s,]/.test(ch)) {
      i++;
    } else {
      throw new TomlEditError(`${key} contains a value that is not a string`);
    }
  }
  throw new TomlEditError(`${key} array is not closed`);
}

function readArray(text: string, table: string[], key: string): string[] | undefined {
  let node: unknown = parse(text);
  for (const part of table) node = (node as Record<string, unknown> | undefined)?.[part];
  const value = (node as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

function check(text: string, table: string[], key: string, expected: string[] | undefined): string {
  const actual = readArray(text, table, key);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TomlEditError(`editing ${[...table, key].join(".")} would produce ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  return text;
}

export function arrayValues(text: string, table: string[], key: string): string[] | undefined {
  return readArray(text, table, key);
}

/** Removes the element equal to `value`, with its comma and, when it sat alone on a line, that line. */
export function removeFromArray(text: string, table: string[], key: string, value: string): string {
  const before = readArray(text, table, key) ?? [];
  const span = findArray(text, table, key);
  const index = span?.elements.findIndex((e) => e.value === value) ?? -1;
  if (!span || index === -1) throw new TomlEditError(`${value} is not in ${[...table, key].join(".")}`);
  const el = span.elements[index]!;
  let start = el.start;
  let end = el.end;
  const after = /^[ \t]*,?/.exec(text.slice(end))![0];
  end += after.length;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = text.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const ownLine = text.slice(lineStart, start).trim() === "" && /^[ \t]*(#.*)?$/.test(text.slice(end, lineEnd));
  if (ownLine && !/#/.test(text.slice(end, lineEnd))) {
    start = lineStart;
    end = Math.min(lineEnd + 1, text.length);
  } else if (index === span.elements.length - 1 && index > 0) {
    // Last of several on one line: take the preceding comma instead.
    const prev = span.elements[index - 1]!;
    start = prev.end;
    end = el.end + (after.trim() === "," ? after.length : 0);
  }
  const expected = before.filter((_, i) => i !== before.indexOf(value));
  return check(text.slice(0, start) + text.slice(end), table, key, expected);
}

/** Replaces the element equal to `from` with `to`, in place. */
export function replaceInArray(text: string, table: string[], key: string, from: string, to: string): string {
  const before = readArray(text, table, key) ?? [];
  const span = findArray(text, table, key);
  const el = span?.elements.find((e) => e.value === from);
  if (!el) throw new TomlEditError(`${from} is not in ${[...table, key].join(".")}`);
  const expected = before.map((v) => (v === from ? to : v));
  return check(text.slice(0, el.start) + JSON.stringify(to) + text.slice(el.end), table, key, expected);
}

/** Appends `value`, matching the array's layout; creates the key (and table) when missing. */
export function appendToArray(text: string, table: string[], key: string, value: string): string {
  const before = readArray(text, table, key);
  const quoted = JSON.stringify(value);
  const span = findArray(text, table, key);
  let out: string;
  if (span) {
    const inner = text.slice(span.open + 1, span.close);
    const last = span.elements.at(-1);
    if (inner.includes("\n")) {
      const indent = last ? /([ \t]*)$/.exec(text.slice(text.lastIndexOf("\n", last.start - 1) + 1, last.start))![1]! : "    ";
      const insertAt = last ? last.end + (/^[ \t]*,/.exec(text.slice(last.end))?.[0].length ?? 0) : span.open + 1;
      const comma = last && !/^[ \t]*,/.test(text.slice(last.end)) ? "," : "";
      out = text.slice(0, last ? last.end : insertAt) + comma + text.slice(last ? last.end : insertAt, insertAt) + `\n${indent}${quoted},` + text.slice(insertAt);
    } else {
      out = last ? text.slice(0, last.end) + `, ${quoted}` + text.slice(last.end) : text.slice(0, span.open + 1) + quoted + text.slice(span.open + 1);
    }
  } else {
    const range = tableRange(text, table);
    const line = `${key} = [${quoted}]\n`;
    if (range && table.length > 0) {
      out = text.slice(0, range.start) + line + text.slice(range.start);
    } else {
      const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      out = `${text}${sep}[${table.join(".")}]\n${line}`;
    }
  }
  return check(out, table, key, [...(before ?? []), value]);
}

/** Removes `key = [...]` entirely when it is empty (keeps the table header). */
export function dropEmptyArray(text: string, table: string[], key: string): string {
  const span = findArray(text, table, key);
  if (!span || span.elements.length > 0) return text;
  const lineStart = text.lastIndexOf("\n", span.open) + 1;
  const lineEnd = text.indexOf("\n", span.close);
  const out = text.slice(0, lineStart) + text.slice(lineEnd === -1 ? text.length : lineEnd + 1);
  return check(out, table, key, undefined);
}

/** 1-based line of the element equal to `value`, for blame. */
export function lineOf(text: string, table: string[], key: string, value: string): number | undefined {
  const el = findArray(text, table, key)?.elements.find((e) => e.value === value);
  return el ? text.slice(0, el.start).split("\n").length : undefined;
}
