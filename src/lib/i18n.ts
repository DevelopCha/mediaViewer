export type Locale = "en" | "ko";

export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
];

export const LOCALE_STORAGE_KEY = "mviewer-locale";

let currentLocale: Locale = "en";

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "ko";
}

export function getInitialLocale() {
  if (typeof window === "undefined") {
    return currentLocale;
  }

  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored && isLocale(stored)) {
    return stored;
  }

  const browserLocale = window.navigator.language.toLowerCase();
  return browserLocale.startsWith("ko") ? "ko" : "en";
}

export function setCurrentLocale(locale: Locale) {
  currentLocale = locale;
}

export function getCurrentLocale() {
  return currentLocale;
}

export function bi(en: string, ko: string) {
  return currentLocale === "ko" ? ko : en;
}

export function biCount(en: string, ko: string, count: number) {
  return currentLocale === "ko" ? `${ko} (${count})` : `${en} (${count})`;
}
