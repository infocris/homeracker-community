import type { Axis, GridPosition } from "../types";
import type { AssemblyState } from "./AssemblyState";
import { computeGroundLift } from "./grid-utils";
import { settleWithGravity } from "./gravity";
import { bestPartForSize, clampToSupportLength, orientationForSize, IDENTITY_ROTATION } from "./part-sizing";
import { hookupAxisAt } from "./compatibility";

export type ResolvedDraw = {
  definitionId: string;
  position: GridPosition;
  orientation?: Axis;
  size: [number, number, number];
};

/**
 * Turn a drawn span into the part that will actually be placed, and where.
 *
 * The ghost, the anchor cell and the committed part all go through this, so what
 * the preview shows is by construction what you get — including the drop under
 * gravity, which lands the span on top of whatever is already in the way.
 */
export function resolveDraw(
  assembly: AssemblyState,
  position: GridPosition,
  size: [number, number, number],
  gravityEnabled: boolean,
): ResolvedDraw | null {
  const capped = clampToSupportLength(size);
  const target = bestPartForSize(capped, "support");
  if (!target) return null;

  let orientation = orientationForSize(target, capped);

  /*
   * One cell says nothing about which way a bar lies, so it comes out upright by
   * default — which is the one thing it cannot be when it is being drawn into a
   * connector's arm reaching sideways. Where the cell has an arm asking for an axis,
   * that is the answer.
   */
  if (capped[0] === 1 && capped[1] === 1 && capped[2] === 1) {
    orientation = hookupAxisAt(assembly, position) ?? orientation;
  }
  if (!gravityEnabled) {
    return { definitionId: target.id, position, orientation, size: capped };
  }

  const groundY = computeGroundLift(target, IDENTITY_ROTATION, orientation ?? "y");
  const settled = settleWithGravity(assembly, target.id, position, IDENTITY_ROTATION, orientation, groundY);
  return { definitionId: target.id, position: settled, orientation, size: capped };
}
