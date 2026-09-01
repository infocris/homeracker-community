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

/**
 * Directions in which a support already occupying this cell carries on: both ways
 * from a cell in mid-span, inward only from the bar's own end cell.
 *
 * These count as branches of the junction even though nothing has to reach *out* to
 * them — the bar is already there, threaded through where the connector will sit, and
 * the arms that embrace it are doing work rather than going spare.
 */
export function throughDirectionsAt(assembly: AssemblyState, cell: GridPosition, ignoreIds?: Set<string>): Direction[] {
  const dirs = new Set<Direction>();
  for (const part of assembly.getAllParts()) {
    if (ignoreIds?.has(part.instanceId)) continue;
    const def = getPartDefinition(part.definitionId);
    if (def?.category !== "support") continue;
    const cells = getWorldCells(rotateGridCells(def.gridCells, part.rotation), part.position, part.orientation ?? "y");
    if (cells.length < 2) continue;
    const index = cells.findIndex((c) => c[0] === cell[0] && c[1] === cell[1] && c[2] === cell[2]);
    if (index === -1) continue;
    if (index > 0) dirs.add(directionBetween(cells[index - 1], cell));
    if (index < cells.length - 1) dirs.add(directionBetween(cells[index + 1], cell));
  }
  return [...dirs];
}

/** World directions a connector at this cell has to account for. */
export function branchDirectionsAt(assembly: AssemblyState, cell: GridPosition, ignoreIds?: Set<string>): Direction[] {
  const dirs = new Set<Direction>(throughDirectionsAt(assembly, cell, ignoreIds));
  for (const part of assembly.getAllParts()) {
    if (ignoreIds?.has(part.instanceId)) continue;
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
 * A rotation that aims every one of `branches` at an arm of `def` and leaves the
 * connector clear of what is already placed, or null when no rotation does.
 *
 * `preferred` is tried first, so a connector that is already aimed the right way
 * keeps its aim instead of being handed an equivalent rotation of the same shape.
 */
function rotationFittingBranches(
  assembly: AssemblyState,
  def: PartDefinition,
  cell: GridPosition,
  branches: Direction[],
  ignoreIds?: Set<string>,
  preferred?: Rotation3,
): Rotation3 | null {
  const candidates: Rotation3[] = preferred ? [preferred] : [];
  for (const x of STEPS) {
    for (const y of STEPS) {
      for (const z of STEPS) candidates.push([x, y, z]);
    }
  }

  for (const rotation of candidates) {
    const arms = armDirections(def, rotation);
    if (!branches.every((d) => arms.has(d))) continue;
    if (placementCollides(assembly, def.id, cell, rotation, undefined, ignoreIds)) continue;
    return rotation;
  }
  return null;
}

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
    const rotation = rotationFittingBranches(assembly, def, cell, branches);
    if (rotation) suggestions.push({ def, rotation });
  }
  return { branches, suggestions };
}

/**
 * Connectors that could stand in for a placed one, so it can be swapped without
 * moving anything else.
 *
 * Unlike the suggestions for an empty spot, spare arms are welcome here: trading a
 * 2-way for a 3-way is exactly how a junction grows a branch. The closest fits come
 * first, and the connector being replaced counts as absent — it is the one leaving.
 */
export function replacementSuggestionsAt(
  assembly: AssemblyState,
  part: PlacedPart,
): { branches: Direction[]; suggestions: TopologySuggestion[] } {
  const current = getPartDefinition(part.definitionId);
  if (!current || current.category !== "connector") return { branches: [], suggestions: [] };

  const cell: GridPosition = [...part.position];
  const ignoreIds = new Set([part.instanceId]);
  const branches = branchDirectionsAt(assembly, cell, ignoreIds);
  return { branches, suggestions: connectorsCovering(assembly, cell, branches, ignoreIds, part) };
}

/**
 * Connectors that reach every one of `branches` and stand clear at `cell`, tightest
 * fit first. Spare arms are allowed: a junction gains a branch by trading up.
 */
function connectorsCovering(
  assembly: AssemblyState,
  cell: GridPosition,
  branches: Direction[],
  ignoreIds: Set<string>,
  keepAimOf?: { definitionId: string; rotation: Rotation3 },
): TopologySuggestion[] {
  const out: TopologySuggestion[] = [];
  for (const def of PART_CATALOG) {
    if (def.category !== "connector" || def.connectionPoints.length < branches.length) continue;
    const preferred = keepAimOf && def.id === keepAimOf.definitionId ? keepAimOf.rotation : undefined;
    const rotation = rotationFittingBranches(assembly, def, cell, branches, ignoreIds, preferred);
    if (rotation) out.push({ def, rotation });
  }
  out.sort((a, b) => a.def.connectionPoints.length - b.def.connectionPoints.length);
  return out;
}

/** A connector that has to change to suit the bars that will meet it after a drop. */
export type ConnectorAdaptation = {
  /** The connector standing there now */
  instanceId: string;
  cell: GridPosition;
  from: string;
  definitionId: string;
  rotation: Rotation3;
  /** Why it changes: an arm gained for an arriving bar, or spare arms given up */
  reason: "grows" | "simplifies";
};

/** The ends of a support, with the direction each one faces away from the bar. */
function supportEnds(
  definitionId: string,
  position: GridPosition,
  rotation: Rotation3,
  orientation?: Axis,
): { cell: GridPosition; outward: Direction }[] {
  const def = getPartDefinition(definitionId);
  if (!def || def.category !== "support") return [];
  const cells = getWorldCells(rotateGridCells(def.gridCells, rotation), position, orientation ?? "y");
  if (cells.length < 2) return [];
  return [
    { cell: cells[0], outward: directionBetween(cells[0], cells[1]) },
    { cell: cells[cells.length - 1], outward: directionBetween(cells[cells.length - 1], cells[cells.length - 2]) },
  ];
}

/**
 * Connectors that would have to change for a support to land where it is being
 * dropped: one it arrives at end-on with no arm free, and one it is leaving with an arm
 * that will then serve nothing.
 *
 * The support is ignored while the junctions are read, since mid-drag it still sits at
 * its old place in the assembly and counting the branch it makes there — or fails to
 * make — would ask for the wrong connector. Its contribution at the *new* placement is
 * added back explicitly.
 *
 * Nothing is proposed for a connector the gesture did not touch. Growing needs the
 * arriving bar to have nowhere to land; simplifying needs the departing bar's own arm
 * to fall idle. Spare arms a user left deliberately elsewhere are left alone.
 */
export function adaptiveConnectorsFor(
  assembly: AssemblyState,
  support: {
    instanceId: string;
    definitionId: string;
    position: GridPosition;
    rotation: Rotation3;
    orientation?: Axis;
  },
): ConnectorAdaptation[] {
  const def = getPartDefinition(support.definitionId);
  if (!def || def.category !== "support") return [];

  const placed = assembly.getPartById(support.instanceId);
  const ignoreSupport = new Set([support.instanceId]);

  const arriving = supportEnds(support.definitionId, support.position, support.rotation, support.orientation);
  const leaving = placed ? supportEnds(placed.definitionId, placed.position, placed.rotation, placed.orientation) : [];

  /** Direction an end contributes to the junction it butts into */
  const contribution = (end: { cell: GridPosition; outward: Direction }) => ({
    cell: getAdjacentPosition(end.cell, end.outward),
    arm: oppositeDirection(end.outward),
  });

  const arrivingAt = arriving.map(contribution);
  const leavingFrom = leaving.map(contribution);

  const sameCell = (a: GridPosition, b: GridPosition) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

  const out: ConnectorAdaptation[] = [];
  const seen = new Set<string>();

  for (const spot of [...arrivingAt, ...leavingFrom]) {
    const { cell } = spot;
    if (cell[1] < 0) continue;

    const occupants = assembly.gridOccupancy.get(`${cell[0]},${cell[1]},${cell[2]}`) ?? [];
    const connector = occupants
      .filter((id) => id !== support.instanceId)
      .map((id) => assembly.getPartById(id))
      .find((p): p is PlacedPart => !!p && getPartDefinition(p.definitionId)?.category === "connector");
    if (!connector || seen.has(connector.instanceId)) continue;

    const connectorDef = getPartDefinition(connector.definitionId);
    if (!connectorDef) continue;

    // The junction as it will be: everything but the support, plus where the support
    // will actually reach once dropped
    const branches = branchDirectionsAt(assembly, cell, ignoreSupport);
    for (const a of arrivingAt) {
      if (sameCell(a.cell, cell) && !branches.includes(a.arm)) branches.push(a.arm);
    }

    const arms = armDirections(connectorDef, connector.rotation);
    const missing = branches.filter((d) => !arms.has(d));
    const wasServing = leavingFrom.find((l) => sameCell(l.cell, cell));
    const nowServing = arrivingAt.some((a) => sameCell(a.cell, cell) && a.arm === wasServing?.arm);
    const armFallsIdle = !!wasServing && !branches.includes(wasServing.arm) && !nowServing;

    let reason: ConnectorAdaptation["reason"] | null = null;
    if (missing.length > 0 && arrivingAt.some((a) => sameCell(a.cell, cell) && missing.includes(a.arm))) {
      reason = "grows";
    } else if (armFallsIdle && arms.size > branches.length) {
      reason = "simplifies";
    }
    if (!reason) continue;

    const fit = connectorsCovering(
      assembly,
      cell,
      branches,
      new Set([connector.instanceId, support.instanceId]),
      connector,
    )[0];
    if (!fit || (fit.def.id === connector.definitionId && fit.rotation.every((r, i) => r === connector.rotation[i]))) {
      continue;
    }

    seen.add(connector.instanceId);
    out.push({
      instanceId: connector.instanceId,
      cell,
      from: connector.definitionId,
      definitionId: fit.def.id,
      rotation: fit.rotation,
      reason,
    });
  }
  return out;
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

  // A bar end butting into the middle of another bar: nothing snaps onto a cell that
  // is already taken, so the sockets have nothing to say here. What belongs there is a
  // connector threaded onto the bar in the way, with an arm reaching back along this one.
  if (def.category === "support" && throughDirectionsAt(assembly, target).length > 0) {
    const reachBack = oppositeDirection(point.direction);
    return PART_CATALOG.filter(
      (candidate) =>
        candidate.category === "connector" &&
        rotationFittingBranches(assembly, candidate, target, [reachBack]) !== null,
    );
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
