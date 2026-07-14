// Tiny terminal helpers — color + prompts over plain stdin/readline, no CLI
// framework dependency (keeps npx cold-start fast, per §1). All output goes
// through `Ui`, an injectable sink so the wizard is testable without a real TTY.

import readline from "node:readline";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR == null;

function paint(code: string, s: string): string {
  return useColor ? `[${code}m${s}[0m` : s;
}

export const color = {
  bold: (s: string) => paint("1", s),
  dim: (s: string) => paint("2", s),
  green: (s: string) => paint("32", s),
  cyan: (s: string) => paint("36", s),
  yellow: (s: string) => paint("33", s),
  red: (s: string) => paint("31", s),
};

/** Mask the middle of a secret: first 8 + last 4, dots between. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** Output sink — swappable in tests to capture lines instead of writing stdout. */
export interface Ui {
  out(line?: string): void;
  err(line?: string): void;
  /**
   * Rewrite a transient single-line status in place (a live "Waiting… 12s"
   * ticker). TTY-only; calling with no argument clears the line. Callers MUST
   * clear before the next out()/err() or the lines collide.
   */
  status?(line?: string): void;
}

export const consoleUi: Ui = {
  out: (line = "") => process.stdout.write(line + "\n"),
  err: (line = "") => process.stderr.write(line + "\n"),
  status: (line = "") => {
    if (process.stdout.isTTY !== true) return;
    // \r + erase-line, then the fresh status text (nothing for a clear).
    process.stdout.write(`\r[2K${line}`);
  },
};

/** One row of a `multiSelect` list. */
export interface MultiSelectItem {
  /** Primary text, e.g. "apps/web". */
  label: string;
  /** Trailing detail, e.g. "next" or "already wired — skipping". */
  hint?: string;
  /** Whether this row starts checked (drives the empty-input default). */
  checked: boolean;
  /**
   * False for rows we can list but cannot wire (no recipe matched). Rendered
   * greyed out and rejected if the user names them explicitly — listing them is
   * how we show the scan wasn't blind to the package.
   */
  selectable: boolean;
}

/** Prompts the wizard needs — injectable so tests answer without a TTY. */
export interface Prompter {
  /** Free-text with a default; empty input returns the default. */
  ask(question: string, def?: string): Promise<string>;
  /** Yes/no; empty input returns `def`. */
  confirm(question: string, def?: boolean): Promise<boolean>;
  /** 1-based numeric choice among labels; empty input returns `def` (0-based). */
  select(question: string, labels: string[], def?: number): Promise<number>;
  /**
   * Multi-choice; returns 0-based indices. On a real TTY this is an
   * interactive checkbox list (arrows move, space toggles, enter confirms);
   * everywhere else it falls back to the number-list prompt so piped stdin
   * and dumb terminals keep working.
   */
  multiSelect(question: string, items: MultiSelectItem[]): Promise<number[]>;
}

export type SelectionParse =
  | { ok: true; indices: number[] }
  | { ok: false; error: string };

/**
 * Parse a multi-select answer. Pure and separately exported so the grammar is
 * unit-testable without a TTY.
 *
 * Accepts: "" (the checked defaults), "all", "none", "1,3", "1-3,6", and any
 * mix separated by commas or whitespace. Rejects non-numeric tokens, indices
 * out of range, and indices naming an unselectable row.
 */
export function parseSelection(
  input: string,
  items: MultiSelectItem[],
): SelectionParse {
  const trimmed = input.trim().toLowerCase();
  const selectable = (i: number) => items[i].selectable;

  if (!trimmed) {
    return {
      ok: true,
      indices: items
        .map((it, i) => (it.checked && it.selectable ? i : -1))
        .filter((i) => i >= 0),
    };
  }
  if (trimmed === "none") return { ok: true, indices: [] };
  if (trimmed === "all") {
    return {
      ok: true,
      indices: items.map((_, i) => i).filter(selectable),
    };
  }

  const picked = new Set<number>();
  for (const token of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    const bounds = range
      ? [Number(range[1]), Number(range[2])]
      : /^\d+$/.test(token)
        ? [Number(token), Number(token)]
        : null;
    if (!bounds) {
      return {
        ok: false,
        error: `"${token}" isn't a number, a range like 1-3, "all", or "none".`,
      };
    }
    const [lo, hi] = bounds;
    if (lo < 1 || hi > items.length || lo > hi) {
      return {
        ok: false,
        error: `"${token}" is out of range — pick between 1 and ${items.length}.`,
      };
    }
    for (let n = lo; n <= hi; n += 1) {
      const i = n - 1;
      if (!selectable(i)) {
        return {
          ok: false,
          error: `${n} (${items[i].label}) has no supported framework — it can't be wired.`,
        };
      }
      picked.add(i);
    }
  }
  return { ok: true, indices: [...picked].sort((a, b) => a - b) };
}

/** Render one multiSelect row: "   1. [x] apps/web   next". */
function renderItem(item: MultiSelectItem, index: number): string {
  const hint = item.hint ? `  ${color.dim(item.hint)}` : "";
  if (!item.selectable) {
    return `   ${color.dim("-")}  ${color.dim("·")}  ${color.dim(item.label)}${hint}`;
  }
  const n = color.cyan(String(index + 1).padStart(2));
  return `  ${n}. ${item.checked ? "[x]" : "[ ]"} ${item.label}${hint}`;
}

/**
 * The subset of readline's Key the interactive list cares about — its own type
 * so the reducer below stays unit-testable without a TTY or keypress stream.
 */
export interface Keypress {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

/** Live state of the interactive checkbox list. */
export interface MultiSelectState {
  /** Index of the highlighted row; always a selectable one. */
  cursor: number;
  /** Per-row checked flags; unselectable rows stay false forever. */
  checked: boolean[];
}

export type MultiSelectKeyResult =
  | { kind: "continue"; state: MultiSelectState }
  | { kind: "submit"; indices: number[] }
  | { kind: "abort" };

export function initialMultiSelectState(
  items: MultiSelectItem[],
): MultiSelectState {
  return {
    cursor: Math.max(
      0,
      items.findIndex((it) => it.selectable),
    ),
    checked: items.map((it) => it.checked && it.selectable),
  };
}

/** Next selectable row in `dir` (+1/-1), wrapping past either end. */
function moveCursor(
  items: MultiSelectItem[],
  from: number,
  dir: 1 | -1,
): number {
  let i = from;
  for (let step = 0; step < items.length; step += 1) {
    i = (i + dir + items.length) % items.length;
    if (items[i].selectable) return i;
  }
  return from;
}

/**
 * One keypress → next state. Pure so the whole key grammar is testable:
 * arrows (or j/k) move, space toggles, `a` toggles everything, enter submits,
 * ctrl+c aborts. Anything else is ignored.
 */
export function reduceMultiSelectKey(
  state: MultiSelectState,
  key: Keypress,
  items: MultiSelectItem[],
): MultiSelectKeyResult {
  if (key.ctrl && key.name === "c") return { kind: "abort" };

  switch (key.name) {
    case "up":
    case "k":
      return {
        kind: "continue",
        state: { ...state, cursor: moveCursor(items, state.cursor, -1) },
      };
    case "down":
    case "j":
      return {
        kind: "continue",
        state: { ...state, cursor: moveCursor(items, state.cursor, 1) },
      };
    case "space": {
      if (!items[state.cursor]?.selectable) return { kind: "continue", state };
      const checked = [...state.checked];
      checked[state.cursor] = !checked[state.cursor];
      return { kind: "continue", state: { ...state, checked } };
    }
    case "a": {
      const allOn = items.every((it, i) => !it.selectable || state.checked[i]);
      return {
        kind: "continue",
        state: {
          ...state,
          checked: items.map((it) => it.selectable && !allOn),
        },
      };
    }
    case "return":
    case "enter":
      return {
        kind: "submit",
        indices: state.checked
          .map((on, i) => (on ? i : -1))
          .filter((i) => i >= 0),
      };
    default:
      return { kind: "continue", state };
  }
}

/** Render one interactive row: " ❯ [x] apps/web   next". */
export function renderInteractiveItem(
  item: MultiSelectItem,
  index: number,
  state: MultiSelectState,
): string {
  const hint = item.hint ? `  ${color.dim(item.hint)}` : "";
  if (!item.selectable) {
    return `    ${color.dim("·")}  ${color.dim(item.label)}${hint}`;
  }
  const pointer = index === state.cursor ? color.cyan("❯") : " ";
  const box = state.checked[index]
    ? color.green("[x]")
    : color.dim("[ ]");
  const label =
    index === state.cursor ? color.bold(item.label) : item.label;
  return `  ${pointer} ${box} ${label}${hint}`;
}

export const INTERACTIVE_KEYS_HINT =
  "↑/↓ move · space toggle · a all/none · enter confirm";

/**
 * Clip a rendered line to the terminal width without counting ANSI escapes,
 * so the redraw's cursor-up arithmetic never breaks on a wrapped line.
 */
export function fitToWidth(line: string, width: number): string {
  if (width <= 0) return line;
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "") {
      const end = line.indexOf("m", i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (visible === width - 1) {
      return `${line.slice(0, i)}…[0m`;
    }
    visible += 1;
    i += 1;
  }
  return line;
}

/** True when we can run the raw-mode checkbox list on this terminal. */
function canRunInteractive(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    process.env.TERM !== "dumb"
  );
}

/**
 * The raw-mode checkbox list. Repaints in place on every keypress; on submit
 * the final checked state stays in the transcript. Ctrl+C restores the
 * terminal and exits 130, matching what ctrl+c does at every other prompt.
 */
function interactiveMultiSelect(
  q: string,
  items: MultiSelectItem[],
): Promise<number[]> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("[?25l");

    let state = initialMultiSelectState(items);
    let painted = 0;

    const paint = (lines: string[]) => {
      const width = process.stdout.columns ?? 80;
      const clipped = lines.map((l) => fitToWidth(l, width));
      const up = painted > 0 ? `[${painted}A` : "";
      process.stdout.write(`${up}[0J${clipped.join("\n")}\n`);
      painted = clipped.length;
    };

    const frame = () => [
      q,
      ...items.map((it, i) => renderInteractiveItem(it, i, state)),
      color.dim(INTERACTIVE_KEYS_HINT),
    ];

    const restore = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("[?25h");
    };

    const onKeypress = (_str: string | undefined, key: Keypress | undefined) => {
      const result = reduceMultiSelectKey(state, key ?? {}, items);
      if (result.kind === "abort") {
        restore();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (result.kind === "submit") {
        const count = result.indices.length;
        const selectable = items.filter((it) => it.selectable).length;
        const final = { ...state, cursor: -1 };
        paint([
          q,
          ...items.map((it, i) => renderInteractiveItem(it, i, final)),
          `${color.green("✓")} ${count} of ${selectable} selected`,
        ]);
        restore();
        resolve(result.indices);
        return;
      }
      state = result.state;
      paint(frame());
    };

    paint(frame());
    stdin.on("keypress", onKeypress);
  });
}

function rl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function question(prompt: string): Promise<string> {
  const r = rl();
  return new Promise((resolve) => {
    r.question(prompt, (answer) => {
      r.close();
      resolve(answer);
    });
  });
}

/** The real stdin-backed prompter. */
export const stdinPrompter: Prompter = {
  async ask(q, def) {
    const suffix = def ? ` ${color.dim(`(${def})`)}` : "";
    const answer = (await question(`${q}${suffix} `)).trim();
    return answer || def || "";
  },
  async confirm(q, def = true) {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await question(`${q} ${color.dim(`[${hint}]`)} `))
      .trim()
      .toLowerCase();
    if (!answer) return def;
    return answer === "y" || answer === "yes";
  },
  async select(q, labels, def = 0) {
    const r = rl();
    try {
      while (true) {
        const lines = [
          q,
          ...labels.map((l, i) => `  ${color.cyan(String(i + 1))}. ${l}`),
        ];
        process.stdout.write(lines.join("\n") + "\n");
        const answer = await new Promise<string>((resolve) => {
          r.question(
            `Choose ${color.dim(`(1-${labels.length}, default ${def + 1})`)}: `,
            resolve,
          );
        });
        const trimmed = answer.trim();
        if (!trimmed) return def;
        const n = Number(trimmed);
        if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
        process.stdout.write(
          color.yellow(`Enter a number between 1 and ${labels.length}.\n`),
        );
      }
    } finally {
      r.close();
    }
  },
  async multiSelect(q, items) {
    if (canRunInteractive()) return interactiveMultiSelect(q, items);
    const r = rl();
    try {
      while (true) {
        const lines = [q, ...items.map(renderItem)];
        process.stdout.write(lines.join("\n") + "\n");
        const answer = await new Promise<string>((resolve) => {
          r.question(
            `Enter numbers ${color.dim('(e.g. 1,3 or 1-2), "all", "none", or Enter for the checked defaults')}: `,
            resolve,
          );
        });
        const parsed = parseSelection(answer, items);
        if (parsed.ok) return parsed.indices;
        process.stdout.write(color.yellow(`${parsed.error}\n`));
      }
    } finally {
      r.close();
    }
  },
};

/**
 * Read a single line from stdin, resolving undefined if stdin closes first.
 * Used by the browser-handoff flow to race a pasted code against the localhost
 * callback. The returned `cancel` detaches the listener so the winner of the
 * race doesn't leave stdin half-consumed.
 */
export function readStdinLine(): {
  promise: Promise<string | undefined>;
  cancel: () => void;
} {
  const stdin = process.stdin;
  let settled = false;
  let onData: ((chunk: Buffer) => void) | undefined;
  let onEnd: (() => void) | undefined;
  let buffer = "";

  const promise = new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      if (onData) stdin.off("data", onData);
      if (onEnd) stdin.off("end", onEnd);
      stdin.pause();
      resolve(value);
    };
    onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl >= 0) finish(buffer.slice(0, nl).trim());
    };
    onEnd = () => finish(buffer.trim() || undefined);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });

  const cancel = () => {
    if (settled) return;
    settled = true;
    if (onData) stdin.off("data", onData);
    if (onEnd) stdin.off("end", onEnd);
    stdin.pause();
  };

  return { promise, cancel };
}
