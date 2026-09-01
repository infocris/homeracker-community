import type { GridPosition, Axis, PartCategory, Rotation3 } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { getPartDefinition } from "../data/catalog";
import { rotateAxis } from "./grid-utils";

/**
 * Detect collision cells: grid positions occupied by 2+ parts,
 * excluding valid pull-through overlaps (a PT connector sitting
 * on a support whose orientation matches the connector's effective
 * pull-through axis).
 *
 * Returns the set of "x,y,z" grid keys where collisions exist.
 */
export function detectCollisionCells(assembly: AssemblyState): Set<string> {
  const collisions = new Set<string>();

  for (const [key, ids] of assembly.gridOccupancy) {
    if (ids.length < 2) continue;

    // Check if every pair in this cell is a valid pull-through overlap
    if (isValidPullThroughCell(ids, assembly)) continue;

    collisions.add(key);
  }

  return collisions;
}

/**
 * Returns collision cells grouped by part instance ID.
 * Each entry maps a part ID to the list of absolute grid positions
 * where that part collides with another.
 */
export function detectCollisionCellsPerPart(assembly: AssemblyState): Map<string, GridPosition[]> {
  const result = new Map<string, GridPosition[]>();

  for (const [key, ids] of assembly.gridOccupancy) {
    if (ids.length < 2) continue;
    if (isValidPullThroughCell(ids, assembly)) continue;

    const [x, y, z] = key.split(",").map(Number);
    const cell: GridPosition = [x, y, z];

    for (const id of ids) {
      let cells = result.get(id);
      if (!cells) {
        cells = [];
        result.set(id, cells);
      }
      cells.push(cell);
    }
  }

  return result;
}

/**
 * Returns the set of part instance IDs that have at least one collision (grid-only).
 */
export function detectCollidingPartIds(assembly: AssemblyState): Set<string> {
  const perPart = detectCollisionCellsPerPart(assembly);
  return new Set(perPart.keys());
}

export { detectCollidingPartIds as detectCollidingPartIdsMesh } from "./mesh-collision";

/** What one part contributes to a shared cell, for the pull-through exemption. */
export interface CellParticipant {
  category: PartCategory;
  /** Pull-through axis after rotation — pull-through connectors only */
  ptAxis?: Axis;
  /** Beam axis — supports only */
  orientation?: Axis;
}

/** Describe a part (placed or merely proposed) as a cell participant. */
export function cellParticipant(
  def: { category: PartCategory; pullThroughAxis?: Axis },
  rotation: Rotation3 = [0, 0, 0],
  orientation?: Axis,
): CellParticipant {
  return {
    category: def.category,
    ptAxis: def.pullThroughAxis ? rotateAxis(def.pullThroughAxis, rotation) : undefined,
    orientation: orientation ?? "y",
  };
}

/**
 * A cell shared by several parts is legal only as a pull-through overlap: exactly
 * one pull-through connector, at least one support, nothing else, and every
 * support running along the connector's effective PT axis.
 */
export function isValidPullThroughOverlap(participants: CellParticipant[]): boolean {
  const ptConnectors = participants.filter((p) => p.category === "connector" && p.ptAxis);
  const supports = participants.filter((p) => p.category === "support");
  if (ptConnectors.length !== 1 || supports.length === 0) return false;
  // Anything that is neither the PT connector nor a support makes the overlap illegal
  if (ptConnectors.length + supports.length !== participants.length) return false;
  const ptAxis = ptConnectors[0].ptAxis;
  return supports.every((s) => (s.orientation ?? "y") === ptAxis);
}

function isValidPullThroughCell(ids: string[], assembly: AssemblyState): boolean {
  const participants: CellParticipant[] = [];
  for (const id of ids) {
    const part = assembly.getPartById(id);
    const def = part ? getPartDefinition(part.definitionId) : undefined;
    // An occupant we cannot identify is never a legal overlap
    if (!part || !def) return false;
    participants.push(cellParticipant(def, part.rotation, part.orientation));
  }
  return isValidPullThroughOverlap(participants);
}
