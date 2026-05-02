export function bi(en: string, ko: string) {
  return `${en} / ${ko}`;
}

export function biCount(en: string, ko: string, count: number) {
  return `${en} (${count}) / ${ko} (${count})`;
}
