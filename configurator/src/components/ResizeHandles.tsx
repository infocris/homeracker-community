import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS } from "../constants";
import type { GridPosition, PlacedPart } from "../types";
import { MAX_SUPPORT_LENGTH } from "../assembly/part-sizing";

type LengthAxis = "x" | "y" | "z";
type LengthFace = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

const AXIS_INDEX: Record<LengthAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * How far the handle floats past the end of the bar. Strictly under half a cell, so
 * the boundary a click resolves to is still the bar's own end — a bigger gap would
 * make merely grabbing a handle resize the part by one cell.
 */
const HANDLE_GAP = BASE_UNIT * 0.4;

export type ResizePreview = {
  instanceId: string;
  position: GridPosition;
  size: [number, number, number];
};

interface ResizeHandlesProps {
  part: PlacedPart;
  /** Min corner of the box being resized — not the part origin, which rotation moves */
  origin: GridPosition;
  /** Extent of that box in grid cells */
  size: [number, number, number];
  onPreview: (preview: ResizePreview | null) => void;
  onResize: (instanceId: string, position: GridPosition, size: [number, number, number]) => void;
  onDraggingChange?: (dragging: boolean) => void;
}

function gridToWorld(pos: GridPosition): [number, number, number] {
  return [pos[0] * BASE_UNIT, pos[1] * BASE_UNIT + BASE_UNIT / 2, pos[2] * BASE_UNIT];
}

/** Handles sit on the two ends of the box's long axis. */
function lengthFacesForSize(size: [number, number, number]): LengthFace[] {
  const [sx, sy, sz] = size;
  const longest = Math.max(sx, sy, sz);
  if (longest > 1) {
    if (sy === longest) return ["+y", "-y"];
    if (sx === longest) return ["+x", "-x"];
    return ["+z", "-z"];
  }
  // 1×1×1: the length can start growing along any axis
  return ["+x", "-x", "+z", "-z", "+y", "-y"];
}

const AXES: LengthAxis[] = ["x", "y", "z"];

/** Unit world vector for an axis. */
function axisVector(axis: LengthAxis): THREE.Vector3 {
  return new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
}

/** Cursor travel below which the axis is left alone — a press should not re-aim the bar. */
const AXIS_PICK_THRESHOLD = 8;

/**
 * Cursor travel *across* the current axis, in screen pixels, before the bar may swing
 * onto another one. Measured perpendicular rather than in total: dragging along the
 * handle's own axis should never re-aim however far it goes, so re-aiming has to be
 * asked for deliberately.
 */
const AXIS_SWITCH_THRESHOLD = 40;

/** How much better a rival axis must score before the bar swings onto it. Without a
 *  margin the choice flickers whenever the cursor runs near a diagonal. */
const AXIS_SWITCH_MARGIN = 0.12;

/**
 * Pick the world axis whose direction on screen best matches where the cursor went.
 * Screen-space is what makes this feel right: the same world axis reads as a
 * different drag direction depending on where the camera stands, so the point of
 * view has to be part of the decision.
 */
function axisFromCursorTravel(
  current: LengthAxis,
  pivotWorld: THREE.Vector3,
  travel: { x: number; y: number },
  toScreen: (point: THREE.Vector3) => { x: number; y: number },
): LengthAxis {
  const distance = Math.hypot(travel.x, travel.y);
  if (distance < AXIS_PICK_THRESHOLD) return current;

  const origin = toScreen(pivotWorld);
  const screenOf = (axis: LengthAxis) => {
    const tip = toScreen(pivotWorld.clone().add(axisVector(axis).multiplyScalar(BASE_UNIT)));
    return { x: tip.x - origin.x, y: tip.y - origin.y };
  };

  // How far the cursor has strayed off the current axis decides whether re-aiming is
  // even on the table. An axis seen end-on has no screen direction to measure against,
  // so it cannot hold the drag and any travel may re-aim.
  const along = screenOf(current);
  const alongLength = Math.hypot(along.x, along.y);
  if (alongLength >= 2) {
    const ux = along.x / alongLength;
    const uy = along.y / alongLength;
    const projected = travel.x * ux + travel.y * uy;
    const across = Math.hypot(travel.x - projected * ux, travel.y - projected * uy);
    if (across < AXIS_SWITCH_THRESHOLD) return current;
  }

  let best = current;
  let bestScore = -Infinity;

  for (const axis of AXES) {
    const { x: sx, y: sy } = screenOf(axis);
    const length = Math.hypot(sx, sy);
    // An axis pointing nearly at the camera collapses to a point: no direction to read
    if (length < 2) continue;
    // Absolute value: which way along the axis comes from the cursor's own side later
    const score = Math.abs((sx * travel.x + sy * travel.y) / (length * distance));
    const biased = axis === current ? score + AXIS_SWITCH_MARGIN : score;
    if (biased > bestScore) {
      bestScore = biased;
      best = axis;
    }
  }
  return best;
}

/**
 * Signed distance, in world units, from the pivot to the point on its axis nearest
 * the cursor ray. Closest-approach between ray and line rather than a plane
 * intersection, so it behaves the same whichever way the axis faces the camera.
 */
function distanceAlongAxis(ray: THREE.Ray, pivotWorld: THREE.Vector3, axis: LengthAxis): number | null {
  const a = axisVector(axis);
  const d = ray.direction;
  const w0 = ray.origin.clone().sub(pivotWorld);
  const b = d.dot(a);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return null; // axis seen end-on
  return (a.dot(w0) - b * d.dot(w0)) / denom;
}

/**
 * Grow the bar from its fixed end along `axis` to reach the cursor. The pivot is the
 * cell at the far end of the box from the handle being held, so re-aiming swings the
 * bar about that cell rather than sliding the whole thing.
 */
function boxFromDrag(
  pivot: GridPosition,
  axis: LengthAxis,
  signedDistance: number,
): { position: GridPosition; size: [number, number, number] } {
  const index = AXIS_INDEX[axis];
  const cells = Math.min(MAX_SUPPORT_LENGTH, Math.max(1, Math.round(Math.abs(signedDistance) / BASE_UNIT) + 1));
  const forward = signedDistance >= 0;

  const position: GridPosition = [...pivot];
  const size: [number, number, number] = [1, 1, 1];
  size[index] = cells;
  if (!forward) position[index] = pivot[index] - (cells - 1);

  // Never below the ground: shorten instead of sinking
  if (position[1] < 0) {
    if (index === 1) {
      size[1] = Math.max(1, size[1] + position[1]);
      position[1] = 0;
    } else {
      position[1] = 0;
    }
  }
  return { position, size };
}

function faceHandleWorldPos(
  position: GridPosition,
  size: [number, number, number],
  face: LengthFace,
): [number, number, number] {
  const [px, py, pz] = position;
  const [sx, sy, sz] = size;
  const cx = (px + (px + sx - 1)) / 2;
  const cy = (py + (py + sy - 1)) / 2;
  const cz = (pz + (pz + sz - 1)) / 2;
  const [wx, wy, wz] = gridToWorld([cx, cy, cz]);

  switch (face) {
    case "+x":
      return [(px + sx) * BASE_UNIT - BASE_UNIT / 2 + HANDLE_GAP, wy, wz];
    case "-x":
      return [px * BASE_UNIT - BASE_UNIT / 2 - HANDLE_GAP, wy, wz];
    case "+z":
      return [wx, wy, (pz + sz) * BASE_UNIT - BASE_UNIT / 2 + HANDLE_GAP];
    case "-z":
      return [wx, wy, pz * BASE_UNIT - BASE_UNIT / 2 - HANDLE_GAP];
    case "+y":
      return [wx, (py + sy) * BASE_UNIT + HANDLE_GAP, wz];
    case "-y":
      // A bar resting on the ground would bury its lower handle under the grid
      return [wx, Math.max(0, py * BASE_UNIT - HANDLE_GAP), wz];
  }
}

function LengthHandle({
  face,
  position,
  size,
  active,
  onPointerDown,
}: {
  face: LengthFace;
  position: GridPosition;
  size: [number, number, number];
  active: boolean;
  onPointerDown: (face: LengthFace, e: PointerEvent) => void;
}) {
  const worldPos = faceHandleWorldPos(position, size, face);
  return (
    <mesh
      position={worldPos}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(face, e.nativeEvent);
      }}
    >
      <sphereGeometry args={[BASE_UNIT * 0.28, 16, 16]} />
      <meshStandardMaterial
        color={active ? "#ffffff" : PART_COLORS.selected}
        emissive={PART_COLORS.selected}
        emissiveIntensity={active ? 0.7 : 0.35}
      />
    </mesh>
  );
}

export function ResizeHandles({ part, origin, size, onPreview, onResize, onDraggingChange }: ResizeHandlesProps) {
  const { camera, gl, controls } = useThree();

  const basePos = origin;
  const baseSize = size;

  const dragRef = useRef<{
    face: LengthFace;
    /** Cell at the far end from the handle: the bar grows and swings about this */
    pivot: GridPosition;
    axis: LengthAxis;
    startX: number;
    startY: number;
    originPos: GridPosition;
    originSize: [number, number, number];
    latestPos: GridPosition;
    latestSize: [number, number, number];
  } | null>(null);

  const [display, setDisplay] = useState({ position: basePos, size: baseSize });
  const [activeFace, setActiveFace] = useState<LengthFace | null>(null);

  const setControlsEnabled = useCallback(
    (enabled: boolean) => {
      const orbit = controls as { enabled?: boolean } | null;
      if (orbit) orbit.enabled = enabled;
      onDraggingChange?.(!enabled);
    },
    [controls, onDraggingChange],
  );

  useEffect(() => {
    if (dragRef.current) return; // don't clobber mid-drag
    setDisplay({ position: basePos, size: baseSize });
  }, [part.instanceId, part.definitionId, basePos[0], basePos[1], basePos[2], baseSize[0], baseSize[1], baseSize[2]]);

  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const toScreen = useCallback(
    (point: THREE.Vector3) => {
      const projected = point.clone().project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return {
        x: (projected.x * 0.5 + 0.5) * rect.width + rect.left,
        y: (-projected.y * 0.5 + 0.5) * rect.height + rect.top,
      };
    },
    [camera, gl],
  );

  const cursorRay = useCallback(
    (clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray;
    },
    [camera, gl, raycaster],
  );

  /** Resolve the cursor into a new box: which axis it is heading along, and how far. */
  const resolveDrag = useCallback(
    (clientX: number, clientY: number) => {
      const drag = dragRef.current;
      if (!drag) return null;
      const pivotWorld = new THREE.Vector3(...gridToWorld(drag.pivot));
      const travel = { x: clientX - drag.startX, y: clientY - drag.startY };
      drag.axis = axisFromCursorTravel(drag.axis, pivotWorld, travel, toScreen);

      // Measured as travel, not as absolute position: the cursor starts on the handle,
      // which sits a whole bar-length away from the pivot, so an absolute reading
      // along a freshly chosen axis would be off by that offset.
      const from = distanceAlongAxis(cursorRay(drag.startX, drag.startY).clone(), pivotWorld, drag.axis);
      const to = distanceAlongAxis(cursorRay(clientX, clientY).clone(), pivotWorld, drag.axis);
      if (from === null || to === null) return null;
      const moved = to - from;

      const heldIndex = AXIS_INDEX[drag.face[1] as LengthAxis];
      const reach = (drag.originSize[heldIndex] - 1) * BASE_UNIT;
      let signed: number;
      if (drag.axis === (drag.face[1] as LengthAxis)) {
        // Same axis: continuous with where the bar already ends, so no jump on grab
        signed = (drag.face[0] === "+" ? reach : -reach) + moved;
      } else {
        // Re-aimed: the bar swings onto the new axis keeping its length, then grows
        signed = moved >= 0 ? Math.max(reach, moved) : Math.min(-reach, moved);
      }
      return boxFromDrag(drag.pivot, drag.axis, signed);
    },
    [toScreen, cursorRay],
  );

  const handlePointerDown = useCallback(
    (face: LengthFace, e: PointerEvent) => {
      // No preventDefault here: R3F registers its pointerdown listener as passive,
      // so the call is a no-op that only earns a console warning. stopPropagation
      // is the one that matters — it keeps the window listeners from also reading
      // this press as the start of a part drag.
      e.stopPropagation();
      // Disable orbit immediately (setState would be one frame too late)
      setControlsEnabled(false);
      gl.domElement.setPointerCapture(e.pointerId);

      const originPos: GridPosition = [basePos[0], basePos[1], basePos[2]];
      const originSize: [number, number, number] = [baseSize[0], baseSize[1], baseSize[2]];
      const axis = face[1] as LengthAxis;
      const index = AXIS_INDEX[axis];
      // The end being held moves; the other one stays put and becomes the pivot
      const pivot: GridPosition = [...originPos];
      if (face[0] === "+") {
        pivot[index] = originPos[index];
      } else {
        pivot[index] = originPos[index] + originSize[index] - 1;
      }

      dragRef.current = {
        face,
        pivot,
        axis,
        startX: e.clientX,
        startY: e.clientY,
        originPos,
        originSize,
        latestPos: originPos,
        latestSize: originSize,
      };
      setActiveFace(face);
    },
    [basePos, baseSize, gl, setControlsEnabled],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const next = resolveDrag(e.clientX, e.clientY);
      if (!next) return;
      drag.latestPos = next.position;
      drag.latestSize = next.size;
      setDisplay(next);
      onPreview({ instanceId: part.instanceId, position: next.position, size: next.size });
    };

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      setActiveFace(null);
      setControlsEnabled(true);
      onPreview(null);
      try {
        gl.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      const { latestPos, latestSize, originPos, originSize } = drag;
      const unchanged =
        latestPos[0] === originPos[0] &&
        latestPos[1] === originPos[1] &&
        latestPos[2] === originPos[2] &&
        latestSize[0] === originSize[0] &&
        latestSize[1] === originSize[1] &&
        latestSize[2] === originSize[2];
      if (!unchanged) {
        onResize(part.instanceId, latestPos, latestSize);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // Safety: never leave controls stuck disabled
      if (dragRef.current) {
        dragRef.current = null;
        setControlsEnabled(true);
      }
    };
  }, [gl, setControlsEnabled, onPreview, onResize, part.instanceId, resolveDrag]);

  const faces = lengthFacesForSize(display.size);

  return (
    <group>
      {faces.map((face) => (
        <LengthHandle
          key={face}
          face={face}
          position={display.position}
          size={display.size}
          active={activeFace === face}
          onPointerDown={handlePointerDown}
        />
      ))}
    </group>
  );
}
