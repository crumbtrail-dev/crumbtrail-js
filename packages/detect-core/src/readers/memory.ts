import path from "node:path";
import type { FileReader } from "./types";

/**
 * In-memory reader for tests and prefetched remote repository trees. Keys may
 * be absolute; relative keys are resolved from the current working directory.
 */
export function memoryReader(
  files: Record<string, string>,
  rootOverride?: string,
): FileReader {
  const entries = new Map(
    Object.entries(files).map(([file, content]) => [
      path.resolve(file),
      content,
    ]),
  );
  const paths = [...entries.keys()];
  // Root is inferred from the common parent, which means adding one unrelated
  // file to a set silently widens the detection boundary. Pass rootOverride
  // when the boundary matters, as a prefetched repository tree does.
  //
  // An empty set resolves to the filesystem root, never process.cwd(): binding
  // a virtual filesystem to ambient process state would let an empty remote
  // tree root detection at whatever directory the server happens to be in.
  const root =
    rootOverride !== undefined
      ? path.resolve(rootOverride)
      : paths.length === 0
        ? path.parse(path.resolve(".")).root
        : commonDirectory(paths.map((file) => path.dirname(file)));

  return {
    root,
    readFile: (file) => entries.get(path.resolve(file)) ?? null,
    isFile: (file) => entries.has(path.resolve(file)),
    isDir: (dir) => {
      const normalized = path.resolve(dir);
      const prefix = normalized.endsWith(path.sep)
        ? normalized
        : `${normalized}${path.sep}`;
      return paths.some((file) => file.startsWith(prefix));
    },
    readDir: (dir) => {
      const normalized = path.resolve(dir);
      const prefix = normalized.endsWith(path.sep)
        ? normalized
        : `${normalized}${path.sep}`;
      const names = new Set<string>();
      for (const file of paths) {
        if (!file.startsWith(prefix)) continue;
        const relative = file.slice(prefix.length);
        const [entry] = relative.split(path.sep);
        if (entry) names.add(entry);
      }
      return [...names].sort();
    },
  };
}

function commonDirectory(files: string[]): string {
  const [first, ...rest] = files.map((file) => file.split(path.sep));
  let shared = first;
  for (const parts of rest) {
    let length = 0;
    while (length < shared.length && shared[length] === parts[length])
      length += 1;
    shared = shared.slice(0, length);
  }
  return shared.join(path.sep) || path.parse(files[0]).root;
}
