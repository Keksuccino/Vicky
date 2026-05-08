import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";

import type {
  PerformanceCpuStats,
  PerformanceDriveStats,
  PerformanceMemoryStats,
  PerformanceStatsSnapshot,
} from "@/lib/types";

const CPU_SAMPLE_MS = 180;

type CpuTimesSnapshot = {
  idle: number;
  logicalCores: number;
  total: number;
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const usagePercent = (used: number, total: number): number => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }

  return clampPercent((used / total) * 100);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readCpuTimesSnapshot = (): CpuTimesSnapshot => {
  const cpuInfos = cpus();

  return cpuInfos.reduce<CpuTimesSnapshot>(
    (snapshot, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);

      return {
        idle: snapshot.idle + cpu.times.idle,
        logicalCores: snapshot.logicalCores + 1,
        total: snapshot.total + total,
      };
    },
    { idle: 0, logicalCores: 0, total: 0 },
  );
};

const loadCpuStats = async (): Promise<PerformanceCpuStats> => {
  const start = readCpuTimesSnapshot();
  await wait(CPU_SAMPLE_MS);
  const end = readCpuTimesSnapshot();
  const totalDelta = end.total - start.total;
  const idleDelta = end.idle - start.idle;
  const percent = totalDelta > 0 ? clampPercent((1 - idleDelta / totalDelta) * 100) : 0;

  return {
    usagePercent: percent,
    logicalCores: end.logicalCores,
    sampleMs: CPU_SAMPLE_MS,
  };
};

const loadMemoryStats = (): PerformanceMemoryStats => {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: usagePercent(usedBytes, totalBytes),
  };
};

const loadDriveStats = async (): Promise<PerformanceDriveStats> => {
  const path = process.cwd();
  const stats = await statfs(path);
  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bfree * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  return {
    path,
    totalBytes,
    usedBytes,
    freeBytes,
    availableBytes,
    usagePercent: usagePercent(usedBytes, totalBytes),
  };
};

export const createPerformanceStatsSnapshot = async (): Promise<PerformanceStatsSnapshot> => {
  const [cpu, drive] = await Promise.all([loadCpuStats(), loadDriveStats()]);

  return {
    updatedAt: new Date().toISOString(),
    memory: loadMemoryStats(),
    cpu,
    drive,
  };
};
