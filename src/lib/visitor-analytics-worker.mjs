/**
 * Worker thread that owns the visitor analytics database (`visitor-storage.ts` starts it). All
 * SQLite work runs here, so writes, summaries, migration, and retention never block the thread
 * that serves requests. Requests are answered first; background maintenance runs one short step
 * per turn of the event loop in between, so new requests never wait long behind it.
 *
 * Messages from the client: `{ id, type: "salt" | "record" | "summary" | "close", ... }`.
 * Messages to the client: `{ type: "reply", id, value | error }`, `{ type: "progress", progress }`
 * while visits are being folded, `{ type: "busy", step }` before a step that holds the worker for
 * long, and `{ type: "fatal", error }` when the database cannot be opened, after which the worker
 * exits.
 */
import { parentPort, workerData } from "node:worker_threads";

import { createVisitorAnalyticsMaintenance } from "./visitor-analytics-maintenance.mjs";
import { openVisitorAnalyticsStore } from "./visitor-analytics-store.mjs";

const MAINTENANCE_CHECK_MS = 10 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 500;

const port = parentPort;
const { dbPath } = workerData;
const inbox = [];
let store = null;
let maintenance = null;
let scheduled = false;
let lastProgress = "null";
let lastProgressAt = 0;
let maintenanceTimer = null;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const post = (message) => port.postMessage(message);

const shutDown = () => {
  clearInterval(maintenanceTimer);
  store?.close();
  port.close();
};

const fail = (error) => {
  post({ type: "fatal", error: errorMessage(error) });
  shutDown();
};

const open = () => {
  store = openVisitorAnalyticsStore(dbPath);
  maintenance = createVisitorAnalyticsMaintenance(store, { onLongStep: (step) => post({ type: "busy", step }) });
};

const publishProgress = (force) => {
  const progress = maintenance.progress();
  const serialized = JSON.stringify(progress);
  if (serialized === lastProgress) {
    return;
  }
  const now = Date.now();
  // Throttle only updates within one catch-up; its start and end are always sent at once.
  if (!force && progress && lastProgress !== "null" && now - lastProgressAt < PROGRESS_INTERVAL_MS) {
    return;
  }
  lastProgress = serialized;
  lastProgressAt = now;
  post({ type: "progress", progress });
};

const handle = (message) => {
  try {
    switch (message.type) {
      case "salt":
        post({ type: "reply", id: message.id, value: store.salt });
        return;
      case "record":
        post({ type: "reply", id: message.id, value: store.recordVisits(message.events, Date.now()) });
        return;
      case "summary":
        post({ type: "reply", id: message.id, value: store.computeSummary(message.now ?? Date.now()) });
        return;
      default:
        throw new Error(`Unknown analytics request: ${message.type}`);
    }
  } catch (error) {
    post({ type: "reply", id: message.id, error: errorMessage(error) });
  }
};

const tick = () => {
  scheduled = false;
  while (inbox.length > 0) {
    const message = inbox.shift();
    if (message.type === "close") {
      shutDown();
      return;
    }
    handle(message);
  }

  const result = maintenance.step(Date.now());
  if (result.reopen) {
    try {
      open();
    } catch (error) {
      fail(error);
      return;
    }
  }
  publishProgress(!result.worked);
  if (result.worked || inbox.length > 0) {
    schedule();
  }
};

function schedule() {
  if (!scheduled) {
    scheduled = true;
    setImmediate(tick);
  }
}

port.on("message", (message) => {
  inbox.push(message);
  schedule();
});

try {
  open();
  const progress = maintenance.progress();
  lastProgress = JSON.stringify(progress);
  lastProgressAt = Date.now();
  post({ type: "ready", progress });
  maintenanceTimer = setInterval(schedule, MAINTENANCE_CHECK_MS);
  schedule();
} catch (error) {
  fail(error);
}
