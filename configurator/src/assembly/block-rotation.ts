import type { Axis, GridPosition, PlacedPart, Rotation3, RotationStep } from "../types";
import { getPartDefinition } from "../data/catalog";
import { getWorldCells, rotateGridCells } from "./grid-utils";

/** The elementary quarter turn the app applies when it bumps rotation[axis] one step. */
const QUARTER_TURN: Rotation3[] = [
  [90, 0, 0],
  [0, 90, 0],
  [0, 0, 90],
];

const STEPS: RotationStep[] = [0, 90, 180, 270];

/** Every Euler triple the grid admits. */
const ALL_ROTATIONS: Rotation3[] = (() => {
  const out: Rotation3[] = [];
  for (const x of STEPS) for (const y of STEPS) for (const z of STEPS) out.push([x, y, z]);
  return out;
})();

const BASIS: GridPosition[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const ORIENTATIONS: Axis[] = ["x", "y", "z"];

const keyOf = (cells: GridPosition[]) => cells.map((c) => c.join(",")).join(" ");

/** Apply the quarter turn about `axis`, `turns` times. */
function turnCells(cells: GridPosition[], axis: 0 | 1 | 2, turns: number): GridPosition[] {
  let out = cells;
  for (let i = 0; i < turns; i++) out = rotateGridCells(out, QUARTER_TURN[axis]);
  return out;
}

const composedCache = new Map<string, Rotation3 | null>();

/**
 * The Euler triple standing for "the part's own rotation, then a quarter turn of the
 * whole body about `axis`".
 *
 * Searched rather than derived. Both sides go through the app's own rotateGridCells,
 * so the answer holds whatever order the triple is applied in and whatever sense each
 * step turns in — and there are only 64 candidates, cached on first use.
 */
export function composeBodyTurn(rotation: Rotation3, axis: 0 | 1 | 2, turns: 1 | 2 | 3): Rotation3 | null {
  const cacheKey = `${rotation.join(",")}|${axis}|${turns}`;
  const hit = composedCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const target = keyOf(turnCells(rotateGridCells(BASIS, rotation), axis, turns));
  const found = ALL_ROTATIONS.find((candidate) => keyOf(rotateGridCells(BASIS, candidate)) === target) ?? null;
  composedCache.set(cacheKey, found);
  return found;
}

export type TurnedPart = {
  id: string;
  definitionId: string;
  position: GridPosition;
  rotation: Rotation3;
  orientation?: Axis;
  color?: string;
  groupId?: string;
};

/**
 * Turns a set of parts as one rigid body: a quarter about `axis`, pivoting on the
 * middle of the cells they occupy.
 *
 * Returns null rather than a half-correct answer if any part cannot be expressed in
 * its new place — the caller refuses the whole turn, since a body that comes apart is
 * worse than one that does not move.
 *
 * Nothing is done about the ground. A quarter turn about a level axis can send part of
 * a body under the floor, and lifting it clear would carry it out of the very plane it
 * was turning in — the plane each ring draws. The caller refuses such a turn instead,
 * which also makes four quarter turns come back exactly wherever a turn is allowed at
 * all, rather than only when the body is clear of the ground.
 *
 * The pivot is rounded to a cell. A body of even extent has its true centre on a cell
 * boundary, and turning about that lands half its cells off the lattice; rounding
 * costs at most half a cell of drift and keeps every part on the grid.
 */
export function rotateBlock(
  parts: PlacedPart[],
  axis: 0 | 1 | 2,
  /** Quarter turns to make, in the direction asked for: 2 is the half turn between */
  turns: 1 | 2 | 3,
  /**
   * The cell to turn about, when the caller has one in mind. A lone part turns about
   * its own anchor, so its far end sweeps the ring through four distinct places like a
   * clock hand; about the middle instead, a symmetric bar would fall back onto its own
   * cells at half a turn and only ever show two.
   */
  pivotOverride?: GridPosition,
): TurnedPart[] | null {
  if (parts.length === 0) return null;

  const occupied = new Map<string, GridPosition[]>();
  const min: GridPosition = [Infinity, Infinity, Infinity];
  const max: GridPosition = [-Infinity, -Infinity, -Infinity];

  for (const part of parts) {
    const def = getPartDefinition(part.definitionId);
    if (!def) return null;
    const cells = getWorldCells(rotateGridCells(def.gridCells, part.rotation), part.position, part.orientation ?? "y");
    occupied.set(part.instanceId, cells);
    for (const cell of cells) {
      for (let i = 0; i < 3; i++) {
        if (cell[i] < min[i]) min[i] = cell[i];
        if (cell[i] > max[i]) max[i] = cell[i];
      }
    }
  }

  /*
   * The body turns about the cell nearest its centre, and is then put back so that
   * cell is nearest its centre again. That second step is what makes the operation
   * stable: rounding the pivot alone moved it, and because the extent changes with
   * every turn it moved somewhere different each time — four quarter turns left the
   * body two cells from where it started. Re-anchoring keeps "the rounded centre sits
   * at the pivot" true before and after, so the next turn finds the same pivot, and
   * four of them compose to nothing.
   *
   * No halves anywhere: the pivot is a cell, so the offsets are whole numbers and the
   * turn is a plain integer rotation.
   */
  const roundedCentre = (lo: GridPosition, hi: GridPosition): GridPosition =>
    [0, 1, 2].map((i) => Math.round((lo[i] + hi[i]) / 2)) as GridPosition;

  const pivot = pivotOverride ?? roundedCentre(min, max);
  const turnAbout = (cell: GridPosition): GridPosition => {
    const offset = turnCells([[cell[0] - pivot[0], cell[1] - pivot[1], cell[2] - pivot[2]]], axis, turns)[0];
    return [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]];
  };

  // Where the body lands before it is re-anchored
  const landedMin: GridPosition = [Infinity, Infinity, Infinity];
  const landedMax: GridPosition = [-Infinity, -Infinity, -Infinity];
  for (const cells of occupied.values()) {
    for (const cell of cells) {
      const t = turnAbout(cell);
      for (let i = 0; i < 3; i++) {
        if (t[i] < landedMin[i]) landedMin[i] = t[i];
        if (t[i] > landedMax[i]) landedMax[i] = t[i];
      }
    }
  }
  // A pivot the caller named is a cell already, and turning about a cell is exact and
  // reversible on its own — only the deduced pivot needs putting back where it was
  const landedPivot = pivotOverride ?? roundedCentre(landedMin, landedMax);
  const anchor: GridPosition = [pivot[0] - landedPivot[0], pivot[1] - landedPivot[1], pivot[2] - landedPivot[2]];
  const turnAboutSnapped = (cell: GridPosition): GridPosition => {
    const t = turnAbout(cell);
    return [t[0] + anchor[0], t[1] + anchor[1], t[2] + anchor[2]];
  };

  const out: TurnedPart[] = [];
  for (const part of parts) {
    const def = getPartDefinition(part.definitionId);
    const cells = occupied.get(part.instanceId);
    if (!def || !cells) return null;

    const composed = composeBodyTurn(part.rotation, axis, turns);
    if (!composed) return null;

    const wanted = cells.map(turnAboutSnapped);
    const wantedKey = keyOf([...wanted].sort());
    const wantedMin = wanted.reduce(
      (acc, c) => [Math.min(acc[0], c[0]), Math.min(acc[1], c[1]), Math.min(acc[2], c[2])] as GridPosition,
      [Infinity, Infinity, Infinity] as GridPosition,
    );

    /*
     * A part with sockets has to take the composed rotation exactly — its arms must
     * turn with the body, and no other rotation aims them the same way.
     *
     * A support carries an orientation instead of arms, and it is a square prism: any
     * rotation and orientation that lay its cells along the right line look the same.
     * The composed rotation is tried first all the same, then the rest — a bar lying
     * along X and turned about X keeps its line, which the composed rotation alone
     * cannot express, since it has already swung the cells off that axis.
     */
    const orientations: (Axis | undefined)[] = part.orientation ? ORIENTATIONS : [undefined];
    const rotations: Rotation3[] = part.orientation ? [composed, ...ALL_ROTATIONS] : [composed];

    let placed: TurnedPart | null = null;
    for (const rotation of rotations) {
      for (const orientation of orientations) {
        const shape = getWorldCells(rotateGridCells(def.gridCells, rotation), [0, 0, 0], orientation ?? "y");
        const shapeMin = shape.reduce(
          (acc, c) => [Math.min(acc[0], c[0]), Math.min(acc[1], c[1]), Math.min(acc[2], c[2])] as GridPosition,
          [Infinity, Infinity, Infinity] as GridPosition,
        );
        const position: GridPosition = [
          wantedMin[0] - shapeMin[0],
          wantedMin[1] - shapeMin[1],
          wantedMin[2] - shapeMin[2],
        ];
        const landed = shape.map((c) => [position[0] + c[0], position[1] + c[1], position[2] + c[2]] as GridPosition);
        if (keyOf([...landed].sort()) !== wantedKey) continue;
        placed = {
          id: part.instanceId,
          definitionId: part.definitionId,
          position,
          rotation,
          orientation,
          color: part.color,
          groupId: part.groupId,
        };
        break;
      }
      if (placed) break;
    }
    if (!placed) return null;
    out.push(placed);
  }

  return out;
}
