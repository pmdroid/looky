/**
 * Worker thread entrypoint for one index build. Reading, hashing, chunking and
 * SQLite writes all happen here, on the worker's own database connection, so
 * the service's event loop stays free for requests.
 */
import { openDatabaseFile } from "../storage/database";
import { runIndexBuild, type IngestResult } from "./ingest";
import type { IndexLimits } from "./policy";

declare const self: Worker;

export type WorkerRequest =
  | {
      readonly type: "start";
      readonly databaseFile: string;
      readonly buildId: string;
      readonly directory: string;
      readonly limits: IndexLimits;
    }
  | { readonly type: "cancel" };

export type WorkerResponse = { readonly type: "done"; readonly result: IngestResult };

const controller = new AbortController();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    controller.abort();
    return;
  }
  const db = openDatabaseFile(message.databaseFile);
  void runIndexBuild({
    db,
    buildId: message.buildId,
    directory: message.directory,
    limits: message.limits,
    signal: controller.signal,
  })
    .then((result) => self.postMessage({ type: "done", result } satisfies WorkerResponse))
    .finally(() => db.close());
};
