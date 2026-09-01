import type { Axis, Direction, GridPosition, PartDefinition, PlacedPart, Rotation3, RotationStep } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { PART_CATALOG, getPartDefinition } from "../data/catalog";
import { getAdjacentPosition, getWorldCells, rotateAxis, rotateDirection, rotateGridCells } from "./grid-utils";
import { placementCollides } from "./gravity";
import { findConnectorSnapPoints, findSnapPoints } from "./snap";
import { IDENTITY_ROTATION } from "./part-sizing";

/**
 * A spot on a placed part where something can attach.
 *
 * `fit` says where the mating part actually goes: butted against the face
 * (`adjacent`, a socket or a bar end), or straight through this very cell
 * (`through`, the pull-through channel).
 */
export type AttachmentPoint = {
  cell: GridPosition;
  direction: Direction;
  fit: "adjacent" | "through";
};

/** The cell the mating part would occupy at this point. */
export function targetCellOf(point: AttachmentPoint): GridPosition {
  return point.fit === "through" ? point.cell : getAdjacentPosition(point.cell, point.direction);
}

const AXIS_OF: Record<string, Axis> = { x: "x", y: "y", z: "z" };
const STEPS: RotationStep[] = [0, 90, 180, 270];

/** Rotations that turn axis `from` into axis `to`. */
function rotationsAligning(from: Axis, to: Axis): Rotation3[] {
  const out: Rotation3[] = [];
  for (const x of STEPS) {
    for (const y of STEPS) {
      for (const z of STEPS) {
        const rotation: Rotation3 = [x, y, z];
        if (rotateAxis(from, rotation) === to) out.push(rotation);
      }
    }
  }
  return out;
}

/** Direction from one cell to the next, as a Direction. */
function directionBetween(from: GridPosition, to: GridPosition): Direction {
  const d: GridPosition = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
  if (d[0] >= 1) return "+x";
  if (d[0] <= -1) return "-x";
  if (d[1] >= 1) return "+y";
  if (d[1] <= -1) return "-y";
  if (d[2] >= 1) return "+z";
  return "-z";
}

/** Every spot on this part that another part could attach to. */
export function attachmentPointsOf(part: PlacedPart): AttachmentPoint[] {
  const def = getPartDefinition(part.definitionId);
  if (!def) return [];
  const orientation = part.orientation ?? "y";
  const worldCells = getWorldCells(rotateGridCells(def.gridCells, part.rotation), part.position, orientation);

  if (def.category === "support" && worldCells.length >= 2) {
    const first = worldCells[0];
    const last = worldCells[worldCells.length - 1];
    const points: AttachmentPoint[] = [
      { cell: first, direction: directionBetween(first, worldCells[1]), fit: "adjacent" },
      { cell: last, direction: directionBetween(last, worldCells[worldCells.length - 2]), fit: "adjacent" },
    ];
    // Mid-span cells take a pull-through connector threaded onto the bar. The two
    // extremities are left to the end points above, so clicking near a tip still
    // picks the end rather than the channel.
    const axis = AXIS_OF[directionBetween(worldCells[1], first)[1]];
    for (const cell of worldCells.slice(1, -1)) {
      points.push({ cell, direction: `+${axis}` as Direction, fit: "through" });
    }
    return points;
  }

  const points: AttachmentPoint[] = def.connectionPoints.map((cp) => {
    const offset = rotateGridCells([cp.offset as GridPosition], part.rotation)[0];
    return {
      cell: [part.position[0] + offset[0], part.position[1] + offset[1], part.position[2] + offset[2]] as GridPosition,
      direction: rotateDirection(cp.direction, part.rotation),
      fit: "adjacent" as const,
    };
  });

  // A pull-through connector also has its channel, which a bar passes straight through
  if (def.pullThroughAxis) {
    const axis = rotateAxis(def.pullThroughAxis, part.rotation);
    points.push({ cell: [...part.position], direction: `+${axis}` as Direction, fit: "through" });
  }
  return points;
}

/** The attachment point of `part` nearest to a clicked cell. */
export function nearestAttachmentPoint(part: PlacedPart, gridPoint: GridPosition): AttachmentPoint | null {
  const points = attachmentPointsOf(part);
  if (points.length === 0) return null;

  let best = points[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    // Measure to the cell the mating part would occupy — that is what the user aims at
    const target = targetCellOf(point);
    const dx = target[0] - gridPoint[0];
    const dy = target[1] - gridPoint[1];
    const dz = target[2] - gridPoint[2];
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

/** Flip a direction to its opposite. */
function oppositeDirection(dir: Direction): Direction {
  return `${dir[0] === "+" ? "-" : "+"}${dir[1]}` as Direction;
}

/** World directions a connector arm would have to reach in, from this cell. */
export function branchDirectionsAt(assembly: AssemblyState, cell: GridPosition): Direction[] {
  const dirs = new Set<Direction>();
  for (const part of assembly.getAllParts()) {
    if (getPartDefinition(part.definitionId)?.category !== "support") continue;
    for (const point of attachmentPointsOf(part)) {
      if (point.fit !== "adjacent") continue;
      const target = getAdjacentPosition(point.cell, point.direction);
      if (target[0] !== cell[0] || target[1] !== cell[1] || target[2] !== cell[2]) continue;
      // The bar end points at this cell, so the bar lies the other way round
      dirs.add(oppositeDirection(point.direction));
    }
  }
  return [...dirs];
}

/** Where a connector's arms end up once rotated. */
function armDirections(def: PartDefinition, rotation: Rotation3): Set<Direction> {
  return new Set(def.connectionPoints.map((cp) => rotateDirection(cp.direction, rotation)));
}

export type TopologySuggestion = { def: PartDefinition; rotation: Rotation3 };

/**
 * Connectors whose arm layout matches the branches meeting at this cell: three
 * branches ask for a 3-way, not a 2-way that cannot reach them nor a 4-way with a
 * spare arm. Each suggestion carries the rotation that lines its arms up.
 */
export function topologySuggestionsAt(
  assembly: AssemblyState,
  cell: GridPosition,
): { branches: Direction[]; suggestions: TopologySuggestion[] } {
  const branches = branchDirectionsAt(assembly, cell);
  if (branches.length === 0 || cell[1] < 0) return { branches, suggestions: [] };

  const suggestions: TopologySuggestion[] = [];
  for (const def of PART_CATALOG) {
    // Exact arm count — a connector with spare arms is not "the" fit for this spot
    if (def.category !== "connector" || def.connectionPoints.length !== branches.length) continue;
    for (const x of STEPS) {
      for (const y of STEPS) {
        for (const z of STEPS) {
          const rotation: Rotation3 = [x, y, z];
          const arms = armDirections(def, rotation);
          if (!branches.every((d) => arms.has(d))) continue;
          if (placementCollides(assembly, def.id, cell, rotation)) continue;
          suggestions.push({ def, rotation });
          break;
        }
        if (suggestions.at(-1)?.def === def) break;
      }
      if (suggestions.at(-1)?.def === def) break;
    }
  }
  return { branches, suggestions };
}

/** Bars that can be threaded through a cell along `axis` without an illegal overlap. */
function barsThrough(assembly: AssemblyState, cell: GridPosition, axis: Axis): PartDefinition[] {
  const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  return PART_CATALOG.filter((def) => {
    if (def.category !== "support") return false;
    const length = def.gridCells.length;
    // Any offset that still covers the cell counts — one clear placement is enough
    for (let back = 0; back < length; back++) {
      const origin: GridPosition = [...cell];
      origin[index] -= back;
      if (origin[1] < 0) continue;
      if (!placementCollides(assembly, def.id, origin, IDENTITY_ROTATION, axis)) return true;
    }
    return false;
  });
}

/** Pull-through connectors that can be threaded onto a bar at this cell. */
function connectorsThrough(assembly: AssemblyState, cell: GridPosition, axis: Axis): PartDefinition[] {
  return PART_CATALOG.filter((def) => {
    if (def.category !== "connector" || !def.pullThroughAxis) return false;
    return rotationsAligning(def.pullThroughAxis, axis).some(
      (rotation) => !placementCollides(assembly, def.id, cell, rotation),
    );
  });
}

/**
 * Catalog parts that can actually attach at this point, decided by the assembly's
 * own snap and collision rules rather than a separate notion of compatibility — so
 * the filtered list is exactly what the app would accept there.
 */
export function compatiblePartsAt(assembly: AssemblyState, part: PlacedPart, point: AttachmentPoint): PartDefinition[] {
  const def = getPartDefinition(part.definitionId);
  if (!def) return [];
  const target = targetCellOf(point);
  if (target[1] < 0) return [];

  if (point.fit === "through") {
    const axis = AXIS_OF[point.direction[1]];
    return def.category === "support" ? connectorsThrough(assembly, target, axis) : barsThrough(assembly, target, axis);
  }

  // A socket takes a bar; a bar end takes a connector
  const wanted = def.category === "support" ? "connector" : "support";
  return PART_CATALOG.filter((candidate) => {
    if (candidate.category !== wanted) return false;
    const snaps =
      wanted === "support"
        ? findSnapPoints(assembly, candidate.id, target, 1)
        : findConnectorSnapPoints(assembly, candidate.id, target, 1);
    return snaps.some((s) => s.connectorInstanceId === part.instanceId && s.socketDirection === point.direction);
  });
}
