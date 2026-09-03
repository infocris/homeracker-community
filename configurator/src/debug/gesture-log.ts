/**
 * A running account of what the viewport made of the mouse: every press and release,
 * the gesture each one turned into, and every change of mode.
 *
 * Gestures are the one part of this app whose behaviour cannot be read off the screen
 * after the fact — a chord that never arrived and a chord that was ignored look
 * exactly alike. The log says which, in the app's own words.
 *
 * Off by default and free when off: `logGesture` returns before it builds anything.
 */

export interface GestureEntry {
  id: number;
  /** Milliseconds since the log was switched on, so gaps between events read easily */
  at: number;
  kind: string;
  detail?: string;
}

const MAX_ENTRIES = 200;
const STORAGE_KEY = "homeracker-gesture-log";

let entries: GestureEntry[] = [];
let seq = 0;
let startedAt = performance.now();
const listeners = new Set<() => void>();

let enabled = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
})();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeGestureLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The entries, newest last, by reference until something is added. */
export function gestureLog(): GestureEntry[] {
  return entries;
}

export function gestureLogIsOn(): boolean {
  return enabled;
}

export function setGestureLogOn(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  if (on) {
    startedAt = performance.now();
    entries = [];
  }
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  notify();
}

export function clearGestureLog(): void {
  entries = [];
  startedAt = performance.now();
  notify();
}

export function logGesture(kind: string, detail?: string): void {
  if (!enabled) return;
  const entry: GestureEntry = { id: ++seq, at: Math.round(performance.now() - startedAt), kind, detail };
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(1), entry] : [...entries, entry];
  notify();
}

/** "left+right", or "none" — how a `buttons` bitmask reads in the log. */
export function buttonsLabel(buttons: number): string {
  const held: string[] = [];
  if (buttons & 1) held.push("left");
  if (buttons & 2) held.push("right");
  if (buttons & 4) held.push("middle");
  return held.length > 0 ? held.join("+") : "none";
}
