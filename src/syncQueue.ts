type SyncStatus = "idle" | "saving" | "saved" | "offline" | "error";

export type SyncQueueSnapshot = {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: string | null;
  message: string;
};

type SyncTask = {
  id: string;
  type: "PUT_JSON";
  url: string;
  body: unknown;
  retries: number;
  nextAttemptAt?: number;
  updatedAt: number;
};

const STORAGE_KEY = "nube-sync-queue";
const STATUS_KEY = "nube-sync-status";
const MAX_RETRIES = 6;
const MAX_CONCURRENT = 2;

const nowIso = () => new Date().toISOString();

const defaultSnapshot: SyncQueueSnapshot = {
  status: "idle",
  pending: 0,
  lastSyncedAt: null,
  message: "All local changes are saved.",
};

class NubeSyncQueue {
  private queue: SyncTask[] = [];
  private active = 0;
  private listeners = new Set<(snapshot: SyncQueueSnapshot) => void>();
  private snapshot: SyncQueueSnapshot = defaultSnapshot;

  constructor() {
    this.queue = this.readQueue();
    this.snapshot = this.readSnapshot();
    this.publish(this.queue.length ? { ...this.snapshot, status: "saving", pending: this.queue.length, message: `${this.queue.length} change${this.queue.length === 1 ? "" : "s"} waiting to sync.` } : this.snapshot);
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.publish({ ...this.snapshot, status: "saving", message: "Back online. Syncing queued changes..." });
        this.process();
      });
      window.addEventListener("offline", () => {
        this.publish({ ...this.snapshot, status: "offline", message: "Offline. Changes will sync when the connection returns." });
      });
      window.setTimeout(() => this.process(), 250);
    }
  }

  subscribe(listener: (snapshot: SyncQueueSnapshot) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  enqueuePutJson(id: string, url: string, body: unknown) {
    const task: SyncTask = { id, type: "PUT_JSON", url, body, retries: 0, updatedAt: Date.now() };
    const existing = this.queue.findIndex((item) => item.id === id && item.type === task.type);
    if (existing >= 0) this.queue[existing] = task;
    else this.queue.push(task);
    this.persistQueue();
    this.publish({ ...this.snapshot, status: navigator.onLine ? "saving" : "offline", pending: this.queue.length, message: navigator.onLine ? "Syncing changes..." : "Offline. Changes are queued safely." });
    this.process();
  }

  getSnapshot() {
    return this.snapshot;
  }

  private process() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.publish({ ...this.snapshot, status: "offline", pending: this.queue.length, message: "Offline. Changes will sync when the connection returns." });
      return;
    }
    while (this.active < MAX_CONCURRENT) {
      const index = this.nextTaskIndex();
      if (index < 0) break;
      const task = this.queue[index];
      void this.run(task);
    }
  }

  private nextTaskIndex() {
    const now = Date.now();
    return this.queue.findIndex((task) => !task.nextAttemptAt || task.nextAttemptAt <= now);
  }

  private async run(task: SyncTask) {
    this.active += 1;
    try {
      const response = await fetch(task.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(task.body),
      });
      if (!response.ok) throw new Error(`Sync failed with ${response.status}`);
      this.queue = this.queue.filter((item) => item !== task);
      const lastSyncedAt = nowIso();
      this.persistQueue();
      this.publish({
        status: this.queue.length ? "saving" : "saved",
        pending: this.queue.length,
        lastSyncedAt,
        message: this.queue.length ? `${this.queue.length} change${this.queue.length === 1 ? "" : "s"} still syncing.` : "Synced to local server.",
      });
    } catch (error) {
      task.retries += 1;
      if (task.retries >= MAX_RETRIES) {
        this.queue = this.queue.filter((item) => item !== task);
        this.publish({ ...this.snapshot, status: "error", pending: this.queue.length, message: error instanceof Error ? error.message : "Sync failed." });
      } else {
        task.nextAttemptAt = Date.now() + 1000 * 2 ** (task.retries - 1);
        this.publish({ ...this.snapshot, status: "saving", pending: this.queue.length, message: `Retrying sync in ${Math.round((task.nextAttemptAt - Date.now()) / 1000)}s.` });
        window.setTimeout(() => this.process(), Math.max(250, task.nextAttemptAt - Date.now()));
      }
      this.persistQueue();
    } finally {
      this.active -= 1;
      this.process();
    }
  }

  private publish(snapshot: SyncQueueSnapshot) {
    this.snapshot = snapshot;
    try {
      localStorage.setItem(STATUS_KEY, JSON.stringify(snapshot));
    } catch {
      // Non-critical: the in-memory snapshot still drives the UI.
    }
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private readQueue() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) as SyncTask[] : [];
    } catch {
      return [];
    }
  }

  private readSnapshot() {
    try {
      const raw = localStorage.getItem(STATUS_KEY);
      return raw ? { ...defaultSnapshot, ...JSON.parse(raw) as Partial<SyncQueueSnapshot>, pending: this.queue.length } : { ...defaultSnapshot, pending: this.queue.length };
    } catch {
      return { ...defaultSnapshot, pending: this.queue.length };
    }
  }

  private persistQueue() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
    } catch {
      this.publish({ ...this.snapshot, status: "error", message: "Browser storage is full. Sync queue could not be saved." });
    }
  }
}

export const syncQueue = new NubeSyncQueue();
