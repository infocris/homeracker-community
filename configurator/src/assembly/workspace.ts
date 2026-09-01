import { WORKSPACE_EXTENT, WORKSPACE_HEIGHT } from "../constants";

export type WorkspaceSize = {
  /** Half-width of the buildable area, in cells from the origin on X and Z */
  extent: number;
  /** Ceiling of the buildable area, in cells above the ground */
  height: number;
  /**
   * A working floor part way up, in cells above the ground.
   *
   * Gravity does not pass through it: a part with nothing under it comes to rest here
   * rather than on the ground, which is what lets an upper storey be built before
   * anything holds it up. Zero puts it back on the ground.
   */
  level: number;
  /** How solid the working level looks, 0 for a bare grid and 1 for an opaque floor */
  levelOpacity: number;
};

export const DEFAULT_WORKSPACE: WorkspaceSize = {
  extent: WORKSPACE_EXTENT,
  height: WORKSPACE_HEIGHT,
  level: 0,
  levelOpacity: 0.1,
};

export const WORKSPACE_LIMITS = {
  extent: { min: 3, max: 60 },
  height: { min: 3, max: 120 },
  level: { min: 0, max: 120 },
  levelOpacity: { min: 0, max: 0.8 },
};

const STORAGE_KEY = "homeracker-workspace";

/**
 * The buildable area, as a store of its own rather than a pair of constants.
 *
 * The bounds are read deep in the placement rules, which no React component owns and
 * which must not import the assembly — hence a small store here, read directly by
 * grid-utils and subscribed to by the view. Kept whole numbers of cells: everything
 * downstream compares cell indices.
 */
let current: WorkspaceSize = load();
const listeners = new Set<() => void>();

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

function load(): WorkspaceSize {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_WORKSPACE;
    const parsed = JSON.parse(saved);
    return {
      extent: clamp(
        parsed.extent ?? DEFAULT_WORKSPACE.extent,
        WORKSPACE_LIMITS.extent.min,
        WORKSPACE_LIMITS.extent.max,
      ),
      height: clamp(
        parsed.height ?? DEFAULT_WORKSPACE.height,
        WORKSPACE_LIMITS.height.min,
        WORKSPACE_LIMITS.height.max,
      ),
      level: clamp(parsed.level ?? DEFAULT_WORKSPACE.level, WORKSPACE_LIMITS.level.min, WORKSPACE_LIMITS.level.max),
      // Not a cell count, so not rounded like the rest
      levelOpacity: Math.min(
        WORKSPACE_LIMITS.levelOpacity.max,
        Math.max(WORKSPACE_LIMITS.levelOpacity.min, parsed.levelOpacity ?? DEFAULT_WORKSPACE.levelOpacity),
      ),
    };
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

export function getWorkspace(): WorkspaceSize {
  return current;
}

export function setWorkspace(size: Partial<WorkspaceSize>) {
  const height = clamp(size.height ?? current.height, WORKSPACE_LIMITS.height.min, WORKSPACE_LIMITS.height.max);
  const next: WorkspaceSize = {
    extent: clamp(size.extent ?? current.extent, WORKSPACE_LIMITS.extent.min, WORKSPACE_LIMITS.extent.max),
    height,
    // The working floor cannot sit above the ceiling it works under
    level: clamp(size.level ?? current.level, WORKSPACE_LIMITS.level.min, height),
    levelOpacity: Math.min(
      WORKSPACE_LIMITS.levelOpacity.max,
      Math.max(WORKSPACE_LIMITS.levelOpacity.min, size.levelOpacity ?? current.levelOpacity),
    ),
  };
  if (
    next.extent === current.extent &&
    next.height === current.height &&
    next.level === current.level &&
    next.levelOpacity === current.levelOpacity
  )
    return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* ignore quota errors */
  }
  for (const listener of listeners) listener();
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
