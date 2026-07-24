export type Command =
  | "serve"
  | "init"
  | "doctor"
  | "scan"
  | "fix-context"
  | "inspect"
  | "compare"
  | "reanalyze"
  | "help";

export interface ParsedCommand {
  command: Command;
  rest: string[];
}

const COMMAND_WORDS = new Set<Command>([
  "serve",
  "init",
  "doctor",
  "scan",
  "fix-context",
  "inspect",
  "compare",
  "reanalyze",
  "help",
]);
const HELP_FLAGS = new Set(["--help", "-h"]);

/**
 * Routes argv into a subcommand. Back-compat: with no subcommand word, all args
 * are treated as `serve` flags, so `crumbtrail --port 3000` keeps working.
 */
export function parseCommand(args: string[]): ParsedCommand {
  if (args.length === 0) {
    return { command: "serve", rest: [] };
  }

  const [first, ...rest] = args;

  if (HELP_FLAGS.has(first)) {
    return { command: "help", rest };
  }

  if (COMMAND_WORDS.has(first as Command)) {
    return { command: first as Command, rest };
  }

  return { command: "serve", rest: args };
}
