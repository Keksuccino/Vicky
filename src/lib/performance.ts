import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, freemem, release, totalmem } from "node:os";
import { promisify } from "node:util";

import type {
  PerformanceCpuStats,
  PerformanceDriveStats,
  PerformanceMemoryStats,
  PerformanceStatsSource,
  PerformanceStatsSnapshot,
} from "@/lib/types";

const CPU_SAMPLE_MS = 180;
const WINDOWS_HOST_SOURCE_LABEL = "Windows host (via WSL)";
const SERVER_SOURCE_LABEL = "Server host";
const POWERSHELL_TIMEOUT_MS = 3_000;
const execFileAsync = promisify(execFile);

const WINDOWS_HOST_METRICS_SCRIPT = `
$ErrorActionPreference = "Stop"
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$processors = @(Get-CimInstance -ClassName Win32_Processor)
$cpuLoad = ($processors | Measure-Object -Property LoadPercentage -Average).Average
$logicalCores = ($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
if ($null -eq $cpuLoad) { $cpuLoad = 0 }
if ($null -eq $logicalCores) { $logicalCores = 0 }
[pscustomobject]@{
  totalMemoryBytes = [Int64]$os.TotalVisibleMemorySize * 1024
  freeMemoryBytes = [Int64]$os.FreePhysicalMemory * 1024
  cpuLoadPercent = [Double]$cpuLoad
  logicalCores = [Int32]$logicalCores
} | ConvertTo-Json -Compress
`;

type CpuTimesSnapshot = {
  idle: number;
  logicalCores: number;
  total: number;
};

type PerformanceHostStats = {
  source: PerformanceStatsSource;
  sourceLabel: string;
  memory: PerformanceMemoryStats;
  cpu: PerformanceCpuStats;
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const usagePercent = (used: number, total: number): number => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }

  return clampPercent((used / total) * 100);
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
};

const isWsl = (): boolean => {
  if (process.platform !== "linux") {
    return false;
  }

  return release().toLowerCase().includes("microsoft") || Boolean(process.env.WSL_DISTRO_NAME);
};

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

const loadWindowsHostStats = async (): Promise<PerformanceHostStats | null> => {
  if (!isWsl()) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_HOST_METRICS_SCRIPT],
      {
        maxBuffer: 64 * 1024,
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const payload = asRecord(JSON.parse(stdout.trim()));
    const totalBytes = Math.max(0, asFiniteNumber(payload.totalMemoryBytes));
    const freeBytes = Math.min(totalBytes, Math.max(0, asFiniteNumber(payload.freeMemoryBytes)));

    if (totalBytes <= 0) {
      return null;
    }

    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const logicalCores = Math.max(0, Math.round(asFiniteNumber(payload.logicalCores, cpus().length)));

    return {
      source: "windows-host",
      sourceLabel: WINDOWS_HOST_SOURCE_LABEL,
      memory: {
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: usagePercent(usedBytes, totalBytes),
      },
      cpu: {
        usagePercent: clampPercent(asFiniteNumber(payload.cpuLoadPercent)),
        logicalCores,
        sampleMs: 0,
      },
    };
  } catch {
    return null;
  }
};

const loadServerHostStats = async (): Promise<PerformanceHostStats> => ({
  source: "server",
  sourceLabel: SERVER_SOURCE_LABEL,
  memory: loadMemoryStats(),
  cpu: await loadCpuStats(),
});

const loadHostStats = async (): Promise<PerformanceHostStats> => {
  const windowsHostStats = await loadWindowsHostStats();
  return windowsHostStats ?? loadServerHostStats();
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
  const [host, drive] = await Promise.all([loadHostStats(), loadDriveStats()]);

  return {
    updatedAt: new Date().toISOString(),
    source: host.source,
    sourceLabel: host.sourceLabel,
    memory: host.memory,
    cpu: host.cpu,
    drive,
  };
};
