import { getDetailedAutoTranslateErrorMessage } from "@/lib/auto-translate-logging";
import {
  saveGitHubLocalizedDocsBatch,
  toRuntimeConfigCacheKey,
  type GitHubLocalizedDocSourcePage,
  type SaveGitHubLocalizedDocBatchItem,
} from "@/lib/github";
import type {
  AutoTranslateLanguage,
  GitHubDocPage,
  GitHubRuntimeConfig,
  SaveGitHubDocInput,
} from "@/lib/types";

export const GITHUB_LOCALIZATION_UPLOAD_INTERVAL_MS = 5 * 60 * 1_000;

export type GitHubLocalizationUploadEvent =
  | {
      type: "queued";
      flushAt: string;
      queueSize: number;
    }
  | {
      type: "upload-start";
      batchSize: number;
    }
  | {
      type: "upload-success";
      batchSize: number;
      commitSha: string;
    }
  | {
      type: "upload-retry";
      batchSize: number;
      error: string;
      retryAt: string;
    };

export type GitHubLocalizationUploadQueueInput = {
  config: GitHubRuntimeConfig;
  input: Omit<SaveGitHubDocInput, "path" | "slug">;
  language: AutoTranslateLanguage;
  localizationPath: string;
  onEvent?: (event: GitHubLocalizationUploadEvent) => void;
  sourcePage: GitHubDocPage;
};

export type GitHubLocalizationQueuedUpload = {
  flushAt: string;
  upload: Promise<void>;
};

type UploadQueueItem = Omit<GitHubLocalizationUploadQueueInput, "sourcePage"> & {
  sourcePage: GitHubLocalizedDocSourcePage;
  resolve: () => void;
};

type UploadQueueState = {
  flushing: boolean;
  lastFlushStartedAt: number;
  pending: UploadQueueItem[];
  scheduledFlushAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const GITHUB_LOCALIZATION_UPLOAD_QUEUE_KEY = Symbol.for("vicky.githubLocalization.uploadQueue");

const getUploadQueueState = (): UploadQueueState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, UploadQueueState | undefined>;
  let state = globalState[GITHUB_LOCALIZATION_UPLOAD_QUEUE_KEY];

  if (!state) {
    state = {
      flushing: false,
      lastFlushStartedAt: 0,
      pending: [],
      scheduledFlushAt: null,
      timer: null,
    };
    globalState[GITHUB_LOCALIZATION_UPLOAD_QUEUE_KEY] = state;
  }

  return state;
};

const getNextFlushAtMs = (state: UploadQueueState): number => {
  if (state.scheduledFlushAt) {
    return state.scheduledFlushAt;
  }

  const earliestFlushAt =
    state.lastFlushStartedAt > 0
      ? state.lastFlushStartedAt + GITHUB_LOCALIZATION_UPLOAD_INTERVAL_MS
      : Date.now() + GITHUB_LOCALIZATION_UPLOAD_INTERVAL_MS;

  return Math.max(Date.now(), earliestFlushAt);
};

const notifyQueued = (state: UploadQueueState, items = state.pending): string => {
  const flushAt = new Date(getNextFlushAtMs(state)).toISOString();

  for (const item of items) {
    item.onEvent?.({
      type: "queued",
      flushAt,
      queueSize: state.pending.length,
    });
  }

  return flushAt;
};

const groupQueueItems = (items: UploadQueueItem[]): UploadQueueItem[][] => {
  const groups = new Map<string, UploadQueueItem[]>();

  for (const item of items) {
    const key = toRuntimeConfigCacheKey(item.config);
    const group = groups.get(key);

    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return Array.from(groups.values());
};

const toBatchItem = (item: UploadQueueItem): SaveGitHubLocalizedDocBatchItem => ({
  input: item.input,
  language: item.language,
  localizationPath: item.localizationPath,
  sourcePage: item.sourcePage,
});

const compactSourcePage = (page: GitHubDocPage): GitHubLocalizedDocSourcePage => ({
  path: page.path,
  slug: page.slug,
  sha: page.sha,
  includeInPlaintextExport: page.includeInPlaintextExport,
  updatedAt: page.updatedAt,
  updatedBy: page.updatedBy,
});

const scheduleUploadFlush = (state: UploadQueueState): void => {
  if (state.timer || state.flushing || state.pending.length === 0) {
    return;
  }

  const flushAtMs = getNextFlushAtMs(state);
  state.scheduledFlushAt = flushAtMs;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.scheduledFlushAt = null;
    void flushGitHubLocalizationUploads();
  }, Math.max(0, flushAtMs - Date.now()));
};

const requeueUploadGroup = (state: UploadQueueState, group: UploadQueueItem[], error: unknown): void => {
  const retryAt = new Date(Date.now() + GITHUB_LOCALIZATION_UPLOAD_INTERVAL_MS).toISOString();
  const message = getDetailedAutoTranslateErrorMessage(error);

  state.pending.push(...group);

  for (const item of group) {
    item.onEvent?.({
      type: "upload-retry",
      batchSize: group.length,
      error: message,
      retryAt,
    });
  }
};

export const flushGitHubLocalizationUploads = async (): Promise<void> => {
  const state = getUploadQueueState();

  if (state.flushing || state.pending.length === 0) {
    return;
  }

  state.flushing = true;
  state.lastFlushStartedAt = Date.now();
  const batch = state.pending;
  state.pending = [];

  try {
    const groups = groupQueueItems(batch);

    for (const group of groups) {
      for (const item of group) {
        item.onEvent?.({
          type: "upload-start",
          batchSize: group.length,
        });
      }

      try {
        const result = await saveGitHubLocalizedDocsBatch({
          config: group[0].config,
          includePages: false,
          items: group.map(toBatchItem),
        });

        group.forEach((item) => {
          item.onEvent?.({
            type: "upload-success",
            batchSize: group.length,
            commitSha: result.commitSha,
          });
          item.resolve();
        });
      } catch (error: unknown) {
        requeueUploadGroup(state, group, error);
      }
    }
  } finally {
    state.flushing = false;
    notifyQueued(state);
    scheduleUploadFlush(state);
  }
};

export const enqueueGitHubLocalizationUpload = (
  input: GitHubLocalizationUploadQueueInput,
): GitHubLocalizationQueuedUpload => {
  const state = getUploadQueueState();
  let resolve!: () => void;
  const upload = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });

  const item = {
    ...input,
    sourcePage: compactSourcePage(input.sourcePage),
    resolve,
  };
  state.pending.push(item);
  const flushAt = notifyQueued(state, [item]);
  scheduleUploadFlush(state);

  return {
    flushAt,
    upload,
  };
};
