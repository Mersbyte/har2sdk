/** Tiny terminal styling helpers (no dependencies, honours NO_COLOR). */

const enabled = !process.env.NO_COLOR && (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : !!process.stdout.isTTY);

const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function methodColor(method: string): string {
  const m = method.padEnd(6);
  switch (method) {
    case "GET":
      return c.green(m);
    case "POST":
      return c.yellow(m);
    case "PUT":
    case "PATCH":
      return c.blue(m);
    case "DELETE":
      return c.red(m);
    default:
      return c.magenta(m);
  }
}

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Text with its C0/C1 control characters removed (tab and newline stay): text from a capture must not drive the terminal. */
export function stripControl(s: string): string {
  return s.replace(CONTROL, "");
}

/** Like {@link stripControl}, but the colour sequences of {@link c} stay. */
export function terminalSafe(s: string): string {
  return s.replace(/(\x1b\[(?:1|2|22|3[1-6]|39|90)m)|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (m, own?: string) => own ?? "");
}

/**
 * Filter everything this process writes to stdout and stderr through
 * {@link terminalSafe}: endpoint ids, warnings and prompts carry text from the
 * capture (a GraphQL operation name can hold an OSC 52 "write to clipboard").
 */
export function guardTerminal(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => write(typeof chunk === "string" ? terminalSafe(chunk) : chunk, ...rest)) as typeof stream.write;
  }
}

export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}
