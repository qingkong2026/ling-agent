import { MemoryStore } from "./memory.js";

const memoryStore = new MemoryStore(process.cwd());

export { SessionStore } from "./store.js";
export { memoryStore };
export type {
  Session,
  SessionSummary,
  SessionMetadata,
  MemoryEntry,
  MemoryIndexEntry,
  MemoryType,
} from "./types.js";
