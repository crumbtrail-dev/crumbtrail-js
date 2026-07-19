import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileReader } from "./types";

/** Local synchronous implementation, bounded by the filesystem root. */
export function localFsReader(root: string): FileReader {
  return {
    root: path.parse(path.resolve(root)).root,
    readFile(file) {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    isFile(file) {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    isDir(dir) {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    readDir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}
