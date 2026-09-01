import type { Axis, GridPosition, Rotation3 } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { gridKeysForCell } from "./AssemblyState";
import { getPartDefinition } from "../data/catalog";
import { getWorldCells, rotateGridCells } from "./grid-utils";
import { cellParticipant, isValidPullThroughOverlap, type CellParticipant } from "./collision";
import { getWorkspace } from "./workspace";

/** How far a part may climb before gravity gives up and leaves it under the cursor. */
export const MAX_GRAVITY_RISE = 32;

/**
 * True when placing this part here would overlap an existing one in a way the
 * collision rules reject. Parts in `ignoreIds` count as absent — pass the parts
 * being moved so they never collide with the cells they are about to leave.
 */
export function placementCollides(
  assembly: AssemblyState,
  definitionId: string,
  position: GridPosition,
  rotation: Rotation3,
  orientation?: Axis,
  ignoreIds?: Set<string>,
): boolean {
  const def = getPartDefinition(definitionId);
  if (!def) return false;

  const candidate = cellParticipant(def, rotation, orientation);
  const cells = getWorldCells(rotateGridCells(def.gridCells, rotation), position, orientation ?? "y");

  for (const cell of cells) {
    for (const key of gridKeysForCell(cell)) {
      const occupants = assembly.gridOccupancy.get(key);
      if (!occupants || occupants.length === 0) continue;

      const participants: CellParticipant[] = [candidate];
      for (const id of occupants) {
        if (ignoreIds?.has(id)) continue;
        const other = assembly.getPartById(id);
        const otherDef = other ? getPartDefinition(other.definitionId) : undefined;
        if (!other || !otherDef) return true;
        participants.push(cellParticipant(otherDef, other.rotation, other.orientation));
      }

      if (participants.length > 1 && !isValidPullThroughOverlap(participants)) return true;
    }
  }
  return false;
}

/** Lowest world grid row a placement occupies, or null for an unknown part. */
export function placementFloor(
  definitionId: string,
  position: GridPosition,
  rotation: Rotation3,
  orientation?: Axis,
): number | null {
  const def = getPartDefinition(definitionId);
  if (!def) return null;
  const cells = getWorldCells(rotateGridCells(def.gridCells, rotation), position, orientation ?? "y");
  let floor = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    if (cell[1] < floor) floor = cell[1];
  }
  return Number.isFinite(floor) ? floor : null;
}

/**
 * Whether a placement is acceptable under gravity: its lowest cell stays at or
 * above level 0, and it overlaps no other part. Snap sockets can point into the
 * floor or into a neighbour, so snapped positions have to pass this too.
 */
export function placementIsGrounded(
  assembly: AssemblyState,
  definitionId: string,
  position: GridPosition,
  rotation: Rotation3,
  orientation?: Axis,
  ignoreIds?: Set<string>,
): boolean {
  const floor = placementFloor(definitionId, position, rotation, orientation);
  if (floor !== null && floor < 0) return false;
  return !placementCollides(assembly, definitionId, position, rotation, orientation, ignoreIds);
}

/**
 * Climb out of whatever the part is inside of: raise it one cell at a time until
 * nothing is in the way, so it comes to rest on top of what it ran into. Falls
 * back to the requested position when nothing is free within reach.
 */
export function restOnCollision(
  assembly: AssemblyState,
  definitionId: string,
  position: GridPosition,
  rotation: Rotation3,
  orientation?: Axis,
  ignoreIds?: Set<string>,
): GridPosition {
  for (let rise = 0; rise <= MAX_GRAVITY_RISE; rise++) {
    const candidate: GridPosition = [position[0], position[1] + rise, position[2]];
    if (!placementCollides(assembly, definitionId, candidate, rotation, orientation, ignoreIds)) {
      return candidate;
    }
  }
  return position;
}

/**
 * Settle a part under gravity: first climb out of anything it overlaps, then fall
 * until something is underneath it, never below `groundY`. With nothing below,
 * the part lands on the ground.
 */
export function settleWithGravity(
  assembly: AssemblyState,
  definitionId: string,
  position: GridPosition,
  rotation: Rotation3,
  orientation: Axis | undefined,
  groundY: number,
  ignoreIds?: Set<string>,
): GridPosition {
  const [x, , z] = position;

  /*
   * The part's own cells may hang below its origin, so the floor is whichever is
   * highest: the caller's ground lift, or the offset that keeps the lowest cell on the
   * floor it is falling to — the ground, or the working level when one is set. Gravity
   * does not pass through that level; a part with nothing under it comes to rest on it.
   */
  const cellFloor = placementFloor(definitionId, [0, 0, 0], rotation, orientation) ?? 0;
  /*
   * The working level catches what falls onto it from above; it does not lift what is
   * already below it. Gravity only ever pulls down, so a part under the level keeps
   * falling to the ground — the level is simply not in its way.
   */
  const level = getWorkspace().level;
  const floorY = position[1] + cellFloor >= level ? level : 0;
  const minY = Math.max(groundY, floorY - cellFloor);

  const risen = restOnCollision(assembly, definitionId, position, rotation, orientation, ignoreIds);
  let y = Math.max(risen[1], minY);

  while (y > minY) {
    const below: GridPosition = [x, y - 1, z];
    if (placementCollides(assembly, definitionId, below, rotation, orientation, ignoreIds)) break;
    y -= 1;
  }

  return [x, y, z];
}
