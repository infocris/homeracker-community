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
 * Grid cell k spans world [k*U, (k+1)*U) on Y but [k*U - U/2, k*U + U/2) on X and Z,
 * so the two get different rounding offsets when turning a hit back into an index.
 */
const AXIS_ROUNDING_OFFSET: Record<LengthAxis, number> = { x: 0.5, y: 0, z: 0.5 };

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

/**
 * Resolve a handle drag into a new box. The cap is applied here, where the anchored
 * end is still known: capping the length afterwards would leave the position derived
 * from the uncapped one, sliding the part away from the end the user is holding.
 */
function applyLengthDrag(
  face: LengthFace,
  position: GridPosition,
  size: [number, number, number],
  hit: THREE.Vector3,
): { position: GridPosition; size: [number, number, number] } {
  const axis = face[1] as LengthAxis;
  const i = AXIS_INDEX[axis];
  const pos: GridPosition = [...position];
  const next: [number, number, number] = [...size];

  // The envelope stays a 1×1×N bar: the two cross-section axes collapse to one cell
  for (const other of [0, 1, 2] as const) {
    if (other !== i) next[other] = 1;
  }

  const hitOnAxis = axis === "x" ? hit.x : axis === "y" ? hit.y : hit.z;
  const boundary = Math.round(hitOnAxis / BASE_UNIT + AXIS_ROUNDING_OFFSET[axis]);
  const max = position[i] + size[i];

  if (face[0] === "+") {
    // The low end is anchored: cap the length and the far end simply stops
    next[i] = Math.min(Math.max(1, boundary - pos[i]), MAX_SUPPORT_LENGTH);
  } else {
    // The high end is anchored. Cap the length first, then re-derive the low end
    // from it — and never take the bottom of the bar below level 0.
    const lowest = i === 1 ? 0 : Number.NEGATIVE_INFINITY;
    const clampedMin = Math.max(Math.min(boundary, max - 1), lowest);
    next[i] = Math.min(Math.max(1, max - clampedMin), MAX_SUPPORT_LENGTH);
    pos[i] = max - next[i];
  }

  return { position: pos, size: next };
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

  const plane = useMemo(() => new THREE.Plane(), []);
  const hit = useMemo(() => new THREE.Vector3(), []);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const projectHit = useCallback(
    (clientX: number, clientY: number, face: LengthFace, handleWorld: [number, number, number]) => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      plane.setFromNormalAndCoplanarPoint(camDir, new THREE.Vector3(...handleWorld));
      if (!raycaster.ray.intersectPlane(plane, hit)) return null;

      // Only the dragged axis may move; pin the other two to the handle
      const constrained = hit.clone();
      const axis = face[1] as LengthAxis;
      if (axis !== "x") constrained.x = handleWorld[0];
      if (axis !== "y") constrained.y = handleWorld[1];
      if (axis !== "z") constrained.z = handleWorld[2];
      return constrained;
    },
    [camera, gl, raycaster, plane, hit],
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
      dragRef.current = {
        face,
        originPos,
        originSize,
        latestPos: originPos,
        latestSize: originSize,
      };
      setActiveFace(face);

      const handleWorld = faceHandleWorldPos(originPos, originSize, face);
      const point = projectHit(e.clientX, e.clientY, face, handleWorld);
      if (point) {
        const next = applyLengthDrag(face, originPos, originSize, point);
        dragRef.current.latestPos = next.position;
        dragRef.current.latestSize = next.size;
        setDisplay(next);
        onPreview({ instanceId: part.instanceId, position: next.position, size: next.size });
      }
    },
    [basePos, baseSize, gl, setControlsEnabled, onPreview, part.instanceId, projectHit],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const handleWorld = faceHandleWorldPos(drag.originPos, drag.originSize, drag.face);
      const point = projectHit(e.clientX, e.clientY, drag.face, handleWorld);
      if (!point) return;
      const next = applyLengthDrag(drag.face, drag.originPos, drag.originSize, point);
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
  }, [gl, setControlsEnabled, onPreview, onResize, part.instanceId, projectHit]);

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
