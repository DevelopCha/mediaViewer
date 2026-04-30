export function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export function classNames(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const MENU_VIEWPORT_MARGIN = 12;

export function clampMenuPosition(x: number, y: number, width: number, height: number) {
  if (typeof window === "undefined") {
    return { x, y };
  }

  const maxX = Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - width - MENU_VIEWPORT_MARGIN);
  const maxY = Math.max(MENU_VIEWPORT_MARGIN, window.innerHeight - height - MENU_VIEWPORT_MARGIN);

  return {
    x: clamp(x, MENU_VIEWPORT_MARGIN, maxX),
    y: clamp(y, MENU_VIEWPORT_MARGIN, maxY),
  };
}
