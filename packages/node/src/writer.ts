import type { BugEvent } from "crumbtrail-core";
import {
  DEFAULT_MAX_SESSION_EVENT_BYTES,
  defaultSessionStore,
  type AppendEventsOptions,
  type AppendEventsResult,
} from "./session-store";

export { DEFAULT_MAX_SESSION_EVENT_BYTES };
export type { AppendEventsOptions, AppendEventsResult };

export async function appendEvents(
  sessionDir: string,
  events: BugEvent[],
  options: AppendEventsOptions = {},
): Promise<AppendEventsResult> {
  return defaultSessionStore.appendEvents(sessionDir, events, options);
}

export async function writeBlob(
  sessionDir: string,
  name: string,
  data: Buffer,
): Promise<void> {
  await defaultSessionStore.writeBlob(sessionDir, name, data);
}
