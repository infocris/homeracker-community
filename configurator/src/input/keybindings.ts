import type { ActionId } from "./actions";

/**
 * The keystrokes the app answers to, and the record of what the user has changed.
 *
 * A binding is a combo string: modifiers, then the key, lowercased and joined with
 * "+" — "mod+shift+z", "arrowup", "x". `mod` is Ctrl or Cmd, matched either way,
 * because that is the one chord whose key differs between platforms and every app
 * on both of them means the same thing by it.
 *
 * Kept out of React: two keydown handlers and the panel all need the same answer, and
 * the panel is the only thing that ever writes. A snapshot object is rebuilt on each
 * change so `useSyncExternalStore` can hand it out by reference.
 */

export interface ActionSpec {
  id: ActionId;
  label: string;
  /** What it does, for the list */
  detail: string;
  group: "Edit" | "Selection" | "Placing" | "Help";
  /** Default bindings. More than one where two keys have always meant the same thing. */
  keys: string[];
  /**
   * Shift makes it a variant of itself — a finer nudge, a turn the other way — so a
   * held shift never keeps the action from firing, and the panel says so.
   */
  shiftVariant?: string;
  /** Not rebindable: pressing it is how a capture is called off. */
  fixed?: boolean;
}

export const ACTIONS: ActionSpec[] = [
  {
    id: "undo",
    label: "Undo",
    detail: "Step back through the history",
    group: "Edit",
    keys: ["mod+z"],
  },
  {
    id: "redo",
    label: "Redo",
    detail: "Step forward again",
    group: "Edit",
    keys: ["mod+shift+z", "mod+y"],
  },
  {
    id: "copy",
    label: "Copy",
    detail: "Copy the selection",
    group: "Edit",
    keys: ["mod+c"],
  },
  {
    id: "paste",
    label: "Paste",
    detail: "Arm the cursor with the copied parts",
    group: "Edit",
    keys: ["mod+v"],
  },
  {
    id: "group",
    label: "Group",
    detail: "Tie the selection together as one body",
    group: "Edit",
    keys: ["mod+g"],
  },
  {
    id: "ungroup",
    label: "Ungroup",
    detail: "Untie the groups the selection is in",
    group: "Edit",
    keys: ["mod+shift+g"],
  },
  {
    id: "delete",
    label: "Delete",
    detail: "Remove the selected parts",
    group: "Edit",
    keys: ["delete", "backspace"],
  },
  {
    id: "cancel",
    label: "Cancel or deselect",
    detail: "Drop the selection, or call off what is in hand",
    group: "Edit",
    keys: ["escape"],
    fixed: true,
  },
  {
    id: "nudge-left",
    label: "Nudge left",
    detail: "One cell to the left of the view",
    group: "Selection",
    keys: ["arrowleft"],
    shiftVariant: "a twentieth of a cell",
  },
  {
    id: "nudge-right",
    label: "Nudge right",
    detail: "One cell to the right of the view",
    group: "Selection",
    keys: ["arrowright"],
    shiftVariant: "a twentieth of a cell",
  },
  {
    id: "nudge-forward",
    label: "Nudge away",
    detail: "One cell away from the camera",
    group: "Selection",
    keys: ["arrowup"],
    shiftVariant: "a twentieth of a cell",
  },
  {
    id: "nudge-back",
    label: "Nudge nearer",
    detail: "One cell towards the camera",
    group: "Selection",
    keys: ["arrowdown"],
    shiftVariant: "a twentieth of a cell",
  },
  {
    id: "raise",
    label: "Raise",
    detail: "Up one cell — the height of a part being placed, or of the selection",
    group: "Selection",
    keys: ["w"],
    shiftVariant: "a twentieth of a cell",
  },
  {
    id: "lower",
    label: "Lower",
    detail: "Down one cell",
    group: "Selection",
    keys: ["s"],
    shiftVariant: "a twentieth of a cell",
  },
  {
    id: "turn-x",
    label: "Turn in the xz plane",
    detail: "A quarter turn about the axis that stands up on screen",
    group: "Placing",
    keys: ["x"],
    shiftVariant: "the other way",
  },
  {
    id: "turn-y",
    label: "Turn in the xy plane",
    detail: "A quarter turn about the axis pointing at you",
    group: "Placing",
    keys: ["y"],
    shiftVariant: "the other way",
  },
  {
    id: "turn-z",
    label: "Turn in the yz plane",
    detail: "A quarter turn about the axis running across the screen",
    group: "Placing",
    keys: ["z"],
    shiftVariant: "the other way",
  },
  {
    id: "orient",
    label: "Re-aim a support",
    detail: "Send the bar along the next axis",
    group: "Placing",
    keys: ["o"],
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    detail: "This list",
    group: "Help",
    keys: ["?"],
  },
];

const BY_ID = new Map<ActionId, ActionSpec>(ACTIONS.map((a) => [a.id, a]));

export function specOf(id: ActionId): ActionSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`Unknown action ${id}`);
  return spec;
}

const STORAGE_KEY = "homeracker-keybindings";

type Overrides = Partial<Record<ActionId, string[]>>;

function loadOverrides(): Overrides {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved);
    const out: Overrides = {};
    for (const spec of ACTIONS) {
      const keys = parsed?.[spec.id];
      if (Array.isArray(keys) && keys.every((k: unknown) => typeof k === "string" && k.length > 0)) {
        out[spec.id] = keys;
      }
    }
    return out;
  } catch {
    return {};
  }
}

let overrides: Overrides = loadOverrides();

function buildSnapshot(): Record<ActionId, string[]> {
  const out = {} as Record<ActionId, string[]>;
  for (const spec of ACTIONS) out[spec.id] = overrides[spec.id] ?? spec.keys;
  return out;
}

let snapshot = buildSnapshot();
const listeners = new Set<() => void>();

function changed() {
  snapshot = buildSnapshot();
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore quota errors — the bindings still hold for this session */
  }
  for (const listener of listeners) listener();
}

export function subscribeBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every action's current keys, by reference: the same object until something changes. */
export function bindings(): Record<ActionId, string[]> {
  return snapshot;
}

export function keysOf(id: ActionId): string[] {
  return snapshot[id];
}

export function isCustomised(id: ActionId): boolean {
  return overrides[id] !== undefined;
}

export function setKeys(id: ActionId, keys: string[]): void {
  overrides = { ...overrides, [id]: keys };
  changed();
}

/** Puts one action, or all of them, back to the keys it was shipped with. */
export function resetKeys(id?: ActionId): void {
  if (id === undefined) overrides = {};
  else {
    const next = { ...overrides };
    delete next[id];
    overrides = next;
  }
  changed();
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock", "Dead"]);

/**
 * The combo a keystroke stands for, or null for a keystroke that names none —
 * a modifier pressed on its own.
 *
 * A printable character carries its own shift: on a French keyboard "?" *is* shift and
 * a comma, so recording the shift beside it would describe a chord nobody can type.
 * Shift is written down only where it changes nothing about the character — a chord
 * with Ctrl or Cmd, or a named key like an arrow.
 */
export function comboOf(e: KeyboardEvent): string | null {
  if (!e.key || MODIFIER_KEYS.has(e.key)) return null;
  const printable = e.key.length === 1;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && (!printable || parts.length > 0)) parts.push("shift");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

function withoutShift(combo: string): string {
  return combo
    .split("+")
    .filter((part) => part !== "shift")
    .join("+");
}

/**
 * The action a keystroke calls for, or null.
 *
 * An exact match is looked for across every action first, so a binding that names
 * shift on purpose still wins over an action that merely tolerates it.
 */
export function actionOf(e: KeyboardEvent): ActionId | null {
  const combo = comboOf(e);
  if (!combo) return null;
  for (const spec of ACTIONS) {
    if (snapshot[spec.id].includes(combo)) return spec.id;
  }
  const bare = withoutShift(combo);
  if (bare !== combo) {
    for (const spec of ACTIONS) {
      if (spec.shiftVariant && snapshot[spec.id].includes(bare)) return spec.id;
    }
  }
  return null;
}

/**
 * Chords the browser keeps for itself. Bound to an action they would never arrive —
 * the tab would close or a new one open instead — so the panel turns them down rather
 * than recording a key that does nothing here.
 */
const RESERVED = new Set(["mod+w", "mod+shift+w", "mod+t", "mod+shift+t", "mod+n", "mod+shift+n", "mod+q", "mod+m"]);

export function isReserved(combo: string): boolean {
  return RESERVED.has(combo);
}

/** The action already holding this combo, so the panel can refuse to double-book it. */
export function conflictOf(combo: string, except: ActionId): ActionId | null {
  for (const spec of ACTIONS) {
    if (spec.id === except) continue;
    if (snapshot[spec.id].includes(combo)) return spec.id;
  }
  return null;
}

const IS_APPLE = /mac|iphone|ipad|ipod/i.test(
  (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent,
);

const KEY_LABELS: Record<string, string> = {
  mod: IS_APPLE ? "⌘" : "Ctrl",
  alt: IS_APPLE ? "⌥" : "Alt",
  shift: IS_APPLE ? "⇧" : "Shift",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  delete: "Del",
  backspace: "⌫",
  enter: "↵",
  " ": "Space",
  tab: "Tab",
};

/** How a combo is written for the eye: "⌘Z" on a Mac, "Ctrl+Z" elsewhere. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+").map((part) => KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part));
  return IS_APPLE ? parts.join("") : parts.join("+");
}

/** All of an action's keys, written out: "⌘⇧Z or ⌘Y". */
export function keysLabel(id: ActionId): string {
  return snapshot[id].map(comboLabel).join(" or ");
}

/** The first key of an action, which is what a one-line hint has room for. */
export function keyLabel(id: ActionId): string {
  const keys = snapshot[id];
  return keys.length > 0 ? comboLabel(keys[0]) : "—";
}
