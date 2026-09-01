import type { Axis, GridPosition, PartDefinition, PlacedPart, Rotation3 } from "../types";
import { PART_CATALOG, getPartDefinition } from "../data/catalog";
import { getWorldCells, rotateGridCells } from "./grid-utils";

/** Axis-aligned size in grid cells from a set of relative grid cells. */
export function getAabbSize(gridCells: GridPosition[]): [number, number, number] {
  if (gridCells.length === 0) return [0, 0, 0];
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const [x, y, z] of gridCells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
}

function sortedDims(size: [number, number, number]): [number, number, number] {
  return [...size].sort((a, b) => a - b) as [number, number, number];
}

/** True when two sizes match up to axis permutation. */
export function dimensionsMatch(a: [number, number, number], b: [number, number, number]): boolean {
  const sa = sortedDims(a);
  const sb = sortedDims(b);
  return sa[0] === sb[0] && sa[1] === sb[1] && sa[2] === sb[2];
}

/** Catalog parts whose grid AABB matches this size (permutation-aware). */
export function findPartsMatchingSize(sx: number, sy: number, sz: number): PartDefinition[] {
  const target: [number, number, number] = [sx, sy, sz];
  return PART_CATALOG.filter((p) => dimensionsMatch(getAabbSize(p.gridCells), target)).sort((a, b) => {
    const order = (c: string) => (c === "support" ? 0 : c === "connector" ? 1 : c === "lockpin" ? 2 : 3);
    return order(a.category) - order(b.category) || a.name.localeCompare(b.name);
  });
}

/**
 * Pick support orientation so the catalog Y-span aligns with the target's long axis
 * when it is a 1×1×N bar (or a cube).
 */
export function orientationForSize(def: PartDefinition, size: [number, number, number]): Axis | undefined {
  if (def.category !== "support") return undefined;
  const [, n] = getAabbSize(def.gridCells);
  const [sx, sy, sz] = size;
  const matches: Axis[] = [];
  if (sx === n && sy === 1 && sz === 1) matches.push("x");
  if (sx === 1 && sy === n && sz === 1) matches.push("y");
  if (sx === 1 && sy === 1 && sz === n) matches.push("z");
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return "y";
  return undefined;
}

/**
 * World-space grid box a placed part occupies, after its rotation and orientation.
 * A rotation can push cells to negative offsets, so the box does not start at the
 * part's own position — callers that draw on the box need this `min` corner.
 */
export function placedPartBounds(part: PlacedPart): { min: GridPosition; size: [number, number, number] } | null {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;
  const cells = getWorldCells(rotateGridCells(def.gridCells, part.rotation), part.position, part.orientation ?? "y");
  if (cells.length === 0) return null;

  const min: GridPosition = [Infinity, Infinity, Infinity];
  for (const cell of cells) {
    for (const i of [0, 1, 2] as const) {
      if (cell[i] < min[i]) min[i] = cell[i];
    }
  }
  return { min, size: getAabbSize(cells) };
}

/** World-space grid footprint of a placed part, after its rotation and orientation. */
export function placedPartSize(part: PlacedPart): [number, number, number] | null {
  return placedPartBounds(part)?.size ?? null;
}

/**
 * The box a part's length handles act on, anchored on the box's own min corner
 * rather than the part's origin so the handles stay put through rotations.
 * Only supports have a length to drag.
 */
export function resizeEnvelopeOf(part: PlacedPart): { origin: GridPosition; size: [number, number, number] } | null {
  if (getPartDefinition(part.definitionId)?.category !== "support") return null;
  const bounds = placedPartBounds(part);
  return bounds ? { origin: bounds.min, size: bounds.size } : null;
}

/**
 * The part that best fills a box of this size, preferring the category already in
 * place so resizing changes the length rather than the kind of part.
 */
export function bestPartForSize(
  size: [number, number, number],
  preferCategory?: PartDefinition["category"],
): PartDefinition | null {
  const matches = findPartsMatchingSize(size[0], size[1], size[2]);
  if (matches.length === 0) return null;
  return matches.find((p) => p.category === preferCategory) ?? matches[0];
}

/** Longest bar the catalog has a support for — the cap on drawing and resizing. */
export const MAX_SUPPORT_LENGTH = Math.max(
  1,
  ...PART_CATALOG.filter((p) => p.category === "support").map((p) => Math.max(...getAabbSize(p.gridCells))),
);

/** Shorten a 1×1×N box to a length a support actually covers. */
export function clampToSupportLength(size: [number, number, number]): [number, number, number] {
  const out: [number, number, number] = [...size];
  const longest = Math.max(out[0], out[1], out[2]);
  const i = out.indexOf(longest) as 0 | 1 | 2;
  out[i] = Math.min(Math.max(1, longest), MAX_SUPPORT_LENGTH);
  return out;
}

export const IDENTITY_ROTATION: Rotation3 = [0, 0, 0];
