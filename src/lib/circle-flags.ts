import { icons as circleFlags } from "@iconify-json/circle-flags";

type CircleFlagIconSource = {
  body: string;
  height?: number;
  width?: number;
};

type CircleFlagIconCollection = {
  height?: number;
  icons: Record<string, CircleFlagIconSource>;
  prefix: string;
  width?: number;
};

export type CircleFlagIconData = {
  body: string;
  height: number;
  id: string;
  width: number;
};

export type CircleFlagIconOption = {
  id: string;
  label: string;
  search: string;
};

const collection = circleFlags as CircleFlagIconCollection;

export const DEFAULT_CIRCLE_FLAG_ICON_ID = "xx";

const regionDisplayNames =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

const ICON_LABEL_OVERRIDES: Record<string, string> = {
  br: "Brazil",
  cn: "China",
  de: "Germany",
  en: "English",
  es: "Spain",
  "es-mx": "Spanish (Mexico)",
  fr: "France",
  gb: "United Kingdom",
  ja: "Japanese",
  jp: "Japan",
  ko: "Korean",
  kr: "South Korea",
  mx: "Mexico",
  pl: "Poland",
  "pt-br": "Portuguese (Brazil)",
  ru: "Russia",
  th: "Thailand",
  ua: "Ukraine",
  uk: "United Kingdom",
  us: "United States",
  xx: "Unknown",
  zh: "Chinese",
};

const ICON_SEARCH_ALIASES: Record<string, string[]> = {
  br: ["Portuguese", "Brazilian Portuguese", "Portuguese Brazil", "pt-BR"],
  cn: ["Chinese", "Simplified Chinese", "zh-CN", "Mandarin"],
  de: ["German", "Deutsch"],
  es: ["Spanish", "Spanish Spain", "es-ES", "Castilian"],
  fr: ["French", "Francais"],
  jp: ["Japanese", "Japan", "ja"],
  kr: ["Korean", "Korea", "ko"],
  mx: ["Spanish Mexico", "es-MX"],
  pl: ["Polish", "Polski"],
  ru: ["Russian"],
  th: ["Thai"],
  ua: ["Ukrainian", "Ukraine", "uk"],
  us: ["English", "English US", "English United States", "en-US", "American English"],
};

const COMMON_ICON_ORDER = [
  "us",
  "gb",
  "de",
  "fr",
  "es",
  "mx",
  "br",
  "pt",
  "pl",
  "ru",
  "ua",
  "jp",
  "kr",
  "cn",
  "th",
  "xx",
];

const commonIconRank = new Map(COMMON_ICON_ORDER.map((id, index) => [id, index]));

export const CIRCLE_FLAG_ICON_IDS = Object.keys(collection.icons).sort((left, right) => {
  const leftRank = commonIconRank.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = commonIconRank.get(right) ?? Number.MAX_SAFE_INTEGER;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.localeCompare(right);
});

const CIRCLE_FLAG_ICON_ID_SET = new Set(CIRCLE_FLAG_ICON_IDS);

const titleCase = (value: string): string =>
  value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export const normalizeCircleFlagIconId = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  const iconId = value.trim().toLowerCase().replace(/^circle-flags:/, "").replace(/_/g, "-");
  return CIRCLE_FLAG_ICON_ID_SET.has(iconId) ? iconId : "";
};

export const isCircleFlagIconId = (value: unknown): boolean => Boolean(normalizeCircleFlagIconId(value));

export const getCircleFlagIconLabel = (iconId: string): string => {
  const normalizedIconId = normalizeCircleFlagIconId(iconId);

  if (!normalizedIconId) {
    return ICON_LABEL_OVERRIDES[DEFAULT_CIRCLE_FLAG_ICON_ID];
  }

  const override = ICON_LABEL_OVERRIDES[normalizedIconId];
  if (override) {
    return override;
  }

  if (/^[a-z]{2}$/.test(normalizedIconId)) {
    return regionDisplayNames?.of(normalizedIconId.toUpperCase()) ?? normalizedIconId.toUpperCase();
  }

  return titleCase(normalizedIconId);
};

export const getCircleFlagIconSearchText = (iconId: string): string => {
  const normalizedIconId = normalizeCircleFlagIconId(iconId) || DEFAULT_CIRCLE_FLAG_ICON_ID;
  const label = getCircleFlagIconLabel(normalizedIconId);
  const aliases = ICON_SEARCH_ALIASES[normalizedIconId] ?? [];

  return [normalizedIconId, normalizedIconId.replace(/-/g, " "), label, ...aliases].join(" ").toLowerCase();
};

export const CIRCLE_FLAG_ICON_OPTIONS: CircleFlagIconOption[] = CIRCLE_FLAG_ICON_IDS.map((id) => ({
  id,
  label: getCircleFlagIconLabel(id),
  search: getCircleFlagIconSearchText(id),
}));

export const getCircleFlagIconOption = (iconId: string): CircleFlagIconOption | null => {
  const normalizedIconId = normalizeCircleFlagIconId(iconId);

  if (!normalizedIconId) {
    return null;
  }

  return {
    id: normalizedIconId,
    label: getCircleFlagIconLabel(normalizedIconId),
    search: getCircleFlagIconSearchText(normalizedIconId),
  };
};

export const getCircleFlagIcon = (iconId: string): CircleFlagIconData | null => {
  const normalizedIconId = normalizeCircleFlagIconId(iconId);

  if (!normalizedIconId) {
    return null;
  }

  const icon = collection.icons[normalizedIconId];
  if (!icon) {
    return null;
  }

  return {
    body: icon.body,
    height: icon.height ?? collection.height ?? 512,
    id: normalizedIconId,
    width: icon.width ?? collection.width ?? 512,
  };
};
