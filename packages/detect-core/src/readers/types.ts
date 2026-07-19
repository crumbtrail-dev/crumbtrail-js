/** Synchronous filesystem boundary used by detection and monorepo discovery. */
export interface FileReader {
  /** File contents, or null when missing or unreadable. */
  readFile(path: string): string | null;
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  /** Immediate entry basenames, or an empty list when unreadable. */
  readDir(path: string): string[];
  /** Highest directory the package-manager upward walk may inspect. */
  root: string;
}
