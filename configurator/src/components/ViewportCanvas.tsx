import { Canvas, useThree, useFrame } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  GizmoHelper,
  GizmoViewport,
  OrthographicCamera,
  PerspectiveCamera,
  Html,
  useGLTF,
} from "@react-three/drei";
import { useCallback, useRef, useState, useEffect, useMemo, Suspense, useLayoutEffect } from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS, GRID_EXTENT, WORKSPACE_EXTENT } from "../constants";
import type {
  PlacedPart,
  InteractionMode,
  GridPosition,
  Rotation3,
  RotationStep,
  Axis,
  DragState,
  ClipboardData,
  DrawAxis,
} from "../types";
import { getPartDefinition } from "../data/catalog";
import { isCustomPart, getCustomPartGeometry } from "../data/custom-parts";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AssemblyState } from "../assembly/AssemblyState";
import {
  nextOrientation,
  orientationToRotation,
  transformCell,
  rotateGridCells,
  clampToWorkspace,
  clampCellToWorkspace,
  computeGroundLift,
} from "../assembly/grid-utils";
import { findBestSnap, findBestConnectorSnap, type GridRay } from "../assembly/snap";
import { detectCollidingPartIds, detectCollidingPartIdsMesh } from "../assembly/collision";
import { registerPartGeometry, hasRegisteredGeometry } from "../assembly/geometry-registry";
import { ResizeHandles, type ResizePreview } from "./ResizeHandles";
import {
  resizeEnvelopeOf,
  bestPartForSize,
  clampToSupportLength,
  orientationForSize,
  placedPartBounds,
  IDENTITY_ROTATION,
  MAX_SUPPORT_LENGTH,
} from "../assembly/part-sizing";
import { resolveDraw } from "../assembly/draw";
import {
  ShadowSettings,
  type LightSettings,
  lightPosition,
  loadLightSettings,
  saveLightSettings,
} from "./ShadowSettings";
import { type AttachmentPoint, targetCellOf } from "../assembly/compatibility";
import { settleWithGravity, restOnCollision, placementIsGrounded } from "../assembly/gravity";

/** Pointer travel (px) above which a press counts as a drag rather than a click */
const DRAG_THRESHOLD = 5;

/**
 * Create a MeshStandardMaterial with a custom color, preserving surface detail
 * (normal maps, roughness maps, AO) from the original GLB material when available.
 */
function makeColorMaterial(
  color: string,
  original?: THREE.Material | null,
  overrides?: {
    transparent?: boolean;
    opacity?: number;
    emissive?: THREE.Color;
    emissiveIntensity?: number;
  },
): THREE.MeshStandardMaterial {
  const src = original instanceof THREE.MeshStandardMaterial ? original : null;
  return new THREE.MeshStandardMaterial({
    ...(src as THREE.MeshStandardMaterialParameters),
    color: new THREE.Color(color),
    vertexColors: false,
    ...overrides,
  });
}

interface ViewportProps {
  parts: PlacedPart[];
  mode: InteractionMode;
  selectedPartIds: Set<string>;
  assembly: AssemblyState;
  onPlacePart: (
    definitionId: string,
    position: GridPosition,
    rotation: PlacedPart["rotation"],
    orientation?: Axis,
  ) => void;
  onDraw: (position: GridPosition, size: [number, number, number]) => void;
  onResizePart: (instanceId: string, position: GridPosition, size: [number, number, number]) => void;
  onMovePart: (instanceId: string, newPosition: GridPosition, rotation?: Rotation3, orientation?: Axis) => void;
  onMoveSelectedParts: (primaryId: string, newPosition: GridPosition, rotation?: Rotation3, orientation?: Axis) => void;
  onClickPart: (instanceId: string, shiftKey: boolean, gridPoint?: GridPosition) => void;
  /** Attachment point picked by re-clicking the selected part, highlighted in the scene */
  selectedPoint: AttachmentPoint | null;
  /** Suggestion under the cursor in the sidebar, previewed in place */
  previewSuggestion: { definitionId: string; position: GridPosition; rotation: Rotation3 } | null;
  onClickEmpty: () => void;
  onDeleteSelected: () => void;
  onPasteParts: (clipboard: ClipboardData, targetPosition: GridPosition, extraRotation?: Rotation3) => void;
  onBoxSelect: (ids: string[]) => void;
  onNudgeParts: (dx: number, dy: number, dz: number) => void;
  onRotateSelectedParts: (axis: 0 | 1 | 2) => void;
  onOrientSelectedParts: () => void;
  onEscape: () => void;
  flashPartId: string | null;
  flashDefinitionId: string | null;
  snapEnabled: boolean;
  gravityEnabled: boolean;
  showCollisions: boolean;
  fineMeshCollisions: boolean;
}

/** Compute the 1×1×N span on the ground from drag start/end cells. */
export function computeDrawSpan(
  start: GridPosition,
  end: GridPosition,
  axis: DrawAxis = "horizontal",
): { position: GridPosition; size: [number, number, number] } {
  // The cell the drag started on stays anchored, so capping the length shortens the
  // far end rather than sliding the whole bar away from where the drag began.
  if (axis === "vertical") {
    // An upright bar stands on the cell that was clicked and grows towards the sky
    const n = Math.min(Math.max(1, end[1] - start[1] + 1), MAX_SUPPORT_LENGTH);
    return { position: [start[0], start[1], start[2]], size: [1, n, 1] };
  }

  const dx = end[0] - start[0];
  const dz = end[2] - start[2];
  if (Math.abs(dx) >= Math.abs(dz)) {
    const n = Math.min(Math.abs(dx) + 1, MAX_SUPPORT_LENGTH);
    const minX = dx < 0 ? start[0] - (n - 1) : start[0];
    return { position: [minX, start[1], start[2]], size: [n, 1, 1] };
  }
  const n = Math.min(Math.abs(dz) + 1, MAX_SUPPORT_LENGTH);
  const minZ = dz < 0 ? start[2] - (n - 1) : start[2];
  return { position: [start[0], start[1], minZ], size: [1, 1, n] };
}

const CAMERA_MODE_STORAGE_KEY = "homeracker-camera-orthographic";
const MIRROR_STORAGE_KEY = "homeracker-mirror-minimap";

/** Half-width the shadow camera and the shadow catcher have to span */
const SHADOW_EXTENT = WORKSPACE_EXTENT * BASE_UNIT + BASE_UNIT;

/**
 * Inset geometry, in fractions of the viewport. Fractions rather than pixels so the
 * scissored render and the CSS frames are driven by the very same numbers — a pixel
 * margin would have to be duplicated in the stylesheet and could drift out of step.
 */
const INSET_MARGIN = 0.02;
const MIRROR_SIZE = 0.26;
const JUNCTION_SIZE = 0.2;

/** The three points of view offered on a picked position, and how they are aimed. */
const JUNCTION_VIEWS: { key: string; label: string; direction: [number, number, number] }[] = [
  { key: "front", label: "Front", direction: [0, 0.4, 1] },
  { key: "side", label: "Side", direction: [1, 0.4, 0] },
  { key: "top", label: "Top", direction: [0.001, 1, 0.001] },
];

/** Distance the junction cameras sit from the cell, in world units */
const JUNCTION_DISTANCE = 8 * BASE_UNIT;

/**
 * The shadow map only needs redrawing when the scene or the light changes, not on
 * every frame. Left on automatic it re-renders the whole scene from the light 60
 * times a second, which is most of the cost of having shadows at all — and enough,
 * under software WebGL, to saturate the main thread.
 */
function ShadowUpdater({ parts, light }: { parts: PlacedPart[]; light: LightSettings }) {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    return () => {
      gl.shadowMap.autoUpdate = true;
    };
  }, [gl]);

  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
  }, [gl, parts, light]);

  return null;
}

type InsetRect = { x: number; y: number; w: number; h: number };

/** The same fractions the scissor uses, as CSS so the frame lands on the render. */
function insetStyle(rect: InsetRect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

/** Where each inset sits, measured from the top-left in viewport fractions. */
function mirrorRect(): InsetRect {
  return { x: 1 - MIRROR_SIZE - INSET_MARGIN, y: 1 - MIRROR_SIZE - INSET_MARGIN, w: MIRROR_SIZE, h: MIRROR_SIZE };
}

function junctionRect(index: number): InsetRect {
  return {
    x: 1 - JUNCTION_SIZE - INSET_MARGIN,
    y: INSET_MARGIN + index * (JUNCTION_SIZE + INSET_MARGIN),
    w: JUNCTION_SIZE,
    h: JUNCTION_SIZE,
  };
}

/**
 * Extra views drawn over the main one: the mirror minimap, and three points of view
 * zoomed on a picked position while its suggestions are offered.
 *
 * They share one component because taking a render priority hands rendering over
 * entirely — two components each doing that would draw the main view twice and
 * fight over the insets. Each inset is confined by a scissor, which also keeps
 * `render`'s own clear from wiping what came before.
 */
function ViewportInsets({ mirror, junction }: { mirror: boolean; junction: GridPosition | null }) {
  const { gl, scene, camera, size, controls } = useThree();
  const insetCamera = useMemo(() => new THREE.PerspectiveCamera(50, 1, 1, 10000), []);
  const target = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const ratio = gl.getPixelRatio();
    const width = Math.max(1, Math.round(size.width * ratio));
    const height = Math.max(1, Math.round(size.height * ratio));

    gl.setScissorTest(false);
    gl.setViewport(0, 0, width, height);
    gl.render(scene, camera);

    const drawInset = (rect: InsetRect, place: (cam: THREE.PerspectiveCamera) => void) => {
      const w = Math.max(1, Math.round(rect.w * width));
      const h = Math.max(1, Math.round(rect.h * height));
      const x = Math.round(rect.x * width);
      // GL counts from the bottom, the rects from the top
      const y = Math.round((1 - rect.y - rect.h) * height);

      insetCamera.aspect = w / h;
      place(insetCamera);
      insetCamera.updateProjectionMatrix();

      gl.setScissorTest(true);
      gl.setViewport(x, y, w, h);
      gl.setScissor(x, y, w, h);
      gl.render(scene, insetCamera);
    };

    if (mirror) {
      const orbit = controls as { target?: THREE.Vector3 } | null;
      target.copy(orbit?.target ?? new THREE.Vector3());
      drawInset(mirrorRect(), (cam) => {
        // Reflect both the eye and what it looks at; world up is kept so the inset
        // reads the right way round rather than upside down like a true mirror
        cam.position.set(camera.position.x, -camera.position.y, camera.position.z);
        cam.up.set(0, 1, 0);
        cam.lookAt(target.x, -target.y, target.z);
      });
    }

    if (junction) {
      const centre = gridToWorld(junction);
      JUNCTION_VIEWS.forEach((view, index) => {
        drawInset(junctionRect(index), (cam) => {
          const [dx, dy, dz] = view.direction;
          const length = Math.hypot(dx, dy, dz);
          cam.position.set(
            centre[0] + (dx / length) * JUNCTION_DISTANCE,
            centre[1] + (dy / length) * JUNCTION_DISTANCE,
            centre[2] + (dz / length) * JUNCTION_DISTANCE,
          );
          cam.up.set(0, 1, 0);
          cam.lookAt(centre[0], centre[1], centre[2]);
        });
      });
    }

    gl.setScissorTest(false);
    gl.setViewport(0, 0, width, height);
  }, 1);

  return null;
}

type CameraSwitchSnapshot = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  target: THREE.Vector3;
  fov?: number;
  frustumHeight?: number;
  zoom?: number;
};

function OrthoIcon() {
  return (
    <svg viewBox="641.712 107.069 51.822 62.187" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M 667.623 139.077 L 641.712 123.073 L 667.623 107.069 L 693.534 123.073 L 667.623 139.077 Z"
      />
      <path
        fill="currentColor"
        d="M 667.623 169.256 L 667.623 139.077 L 693.534 123.073 L 693.534 153.252 L 667.623 169.256 Z"
        opacity="0.25"
      />
      <path
        fill="currentColor"
        d="M 667.623 169.256 L 641.712 153.252 L 641.712 123.073 L 667.623 139.077 L 667.623 169.256 Z"
        opacity="0.5"
      />
    </svg>
  );
}

function PerspIcon() {
  return (
    <svg viewBox="573.563 112.631 54.108 49.236" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M 600.616 130.34 L 573.563 120.122 L 600.329 112.631 L 627.671 120.122 L 600.616 130.34 Z"
      />
      <path
        fill="currentColor"
        d="M 600.688 161.817 L 600.616 130.308 L 627.671 119.984 L 627.671 151.494 L 600.688 161.817 Z"
        opacity="0.25"
      />
      <path
        fill="currentColor"
        d="M 600.677 161.867 L 573.623 151.692 L 573.623 120.182 L 600.677 130.357 L 600.677 161.867 Z"
        opacity="0.5"
      />
    </svg>
  );
}

/** Convert grid coordinates to world position (mm).
 *  Y is offset by half a cell so that grid Y=0 sits ON the ground (bottom at world Y=0). */
function gridToWorld(pos: GridPosition): [number, number, number] {
  return [pos[0] * BASE_UNIT, pos[1] * BASE_UNIT + BASE_UNIT / 2, pos[2] * BASE_UNIT];
}

/** Snap a world position to the nearest grid point (inverse of gridToWorld) */
function snapToGrid(worldPos: THREE.Vector3): GridPosition {
  return [
    Math.round(worldPos.x / BASE_UNIT),
    Math.round((worldPos.y - BASE_UNIT / 2) / BASE_UNIT),
    Math.round(worldPos.z / BASE_UNIT),
  ];
}

/**
 * Compute the offset to center a GLB model over its grid cells.
 * GLB models are centered at origin; this shifts them so the model
 * spans all occupied cells correctly.
 *
 * Grid cells are center-based: gridToWorld maps index → cell center.
 * The offset is the average of cell center positions (in oriented space).
 *
 * When an orientation is provided, cells are first transformed to the
 * oriented space. The offset is computed in world space (OUTSIDE the
 * orientation rotation group).
 */
function modelCenterOffset(def: { gridCells: GridPosition[] }, orientation: Axis = "y"): [number, number, number] {
  const cells = def.gridCells.map((c) => transformCell(c, orientation));
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));
  return [((minX + maxX) / 2) * BASE_UNIT, ((minY + maxY) / 2) * BASE_UNIT, ((minZ + maxZ) / 2) * BASE_UNIT];
}

/** A placed part rendered with its actual GLB model (or custom STL geometry) */
function PartMesh({
  part,
  isSelected,
  isDragging,
  isPlacing,
  isFlashing,
  isColliding,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  isColliding: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;

  if (isCustomPart(part.definitionId)) {
    return (
      <CustomPartMesh
        part={part}
        isSelected={isSelected}
        isDragging={isDragging}
        isPlacing={isPlacing}
        isFlashing={isFlashing}
        isColliding={isColliding}
        onPointerDown={onPointerDown}
      />
    );
  }

  return (
    <Suspense fallback={<PartMeshFallback part={part} isSelected={isSelected} onClick={() => {}} />}>
      <PartMeshLoaded
        part={part}
        isSelected={isSelected}
        isDragging={isDragging}
        isPlacing={isPlacing}
        isFlashing={isFlashing}
        isColliding={isColliding}
        onPointerDown={onPointerDown}
      />
    </Suspense>
  );
}

/**
 * Ghost of a hovered suggestion, standing at the spot it was suggested for with the
 * rotation that lines its arms up — so hovering the list shows the result in place.
 */
function SuggestionPreview({
  definitionId,
  position,
  rotation,
}: {
  definitionId: string;
  position: GridPosition;
  rotation: Rotation3;
}) {
  return (
    <group position={gridToWorld(position)}>
      <Suspense fallback={<GhostFallback definitionId={definitionId} isSnapped />}>
        <GhostModel definitionId={definitionId} rotation={rotation} isSnapped />
      </Suspense>
    </group>
  );
}

/** Marks the spot a re-click picked on the selected part, and where a part would go */
function AttachmentMarker({ point }: { point: AttachmentPoint }) {
  const worldPos = gridToWorld(targetCellOf(point));
  // A pull-through spot sits inside the part, so its marker has to sit around the
  // cell as a collar instead of inside it, where the mesh would swallow it
  const side = BASE_UNIT * (point.fit === "through" ? 1.25 : 0.9);
  return (
    <group position={worldPos}>
      <mesh>
        <boxGeometry args={[side, side, side]} />
        <meshBasicMaterial color={PART_COLORS.ghost_snapped} wireframe transparent opacity={0.95} />
      </mesh>
      <mesh>
        <boxGeometry args={[side, side, side]} />
        <meshBasicMaterial color={PART_COLORS.ghost_snapped} transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Ghost box while dragging out the span of a new support */
function DrawSpanGhost({ position, size }: { position: GridPosition; size: [number, number, number] }) {
  const [sx, sy, sz] = size;
  const worldPos = gridToWorld(position);
  const offset: [number, number, number] = [
    ((sx - 1) / 2) * BASE_UNIT,
    ((sy - 1) / 2) * BASE_UNIT,
    ((sz - 1) / 2) * BASE_UNIT,
  ];
  return (
    <group position={worldPos}>
      <mesh position={offset}>
        <boxGeometry args={[sx * BASE_UNIT * 0.98, sy * BASE_UNIT * 0.98, sz * BASE_UNIT * 0.98]} />
        <meshStandardMaterial color={PART_COLORS.ghost_valid} transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh position={offset}>
        <boxGeometry args={[sx * BASE_UNIT * 0.98, sy * BASE_UNIT * 0.98, sz * BASE_UNIT * 0.98]} />
        <meshBasicMaterial color={PART_COLORS.ghost_valid} wireframe transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

/**
 * While a resize is in flight, show what the part will become: the catalog part
 * that fills the dragged length, keeping its current definition when none does.
 */
function previewPart(part: PlacedPart, preview: ResizePreview): PlacedPart {
  const capped = clampToSupportLength(preview.size);
  const match = bestPartForSize(capped, getPartDefinition(part.definitionId)?.category);
  return {
    ...part,
    position: preview.position,
    definitionId: match ? match.id : part.definitionId,
    // The orientation has to follow too. Keeping the old one drew the bar along the
    // axis it used to run, so a drag that re-aimed it left the mesh behind.
    orientation: match ? orientationForSize(match, capped) : part.orientation,
    rotation: match ? IDENTITY_ROTATION : part.rotation,
  };
}

/**
 * Length of the bar being resized or selected, in cube units and centimetres. Pinned
 * to the bar rather than the corner of the screen, so it is where the eye already is.
 * pointerEvents stays off: R3F raycasts through the container this sits in, and a
 * label that swallowed clicks would break selecting the part underneath.
 */
function DimensionLabel({ min, size }: { min: GridPosition; size: [number, number, number] }) {
  const cells = Math.max(size[0], size[1], size[2]);
  const centre = gridToWorld([min[0] + (size[0] - 1) / 2, min[1] + (size[1] - 1) / 2, min[2] + (size[2] - 1) / 2]);
  return (
    <Html
      position={[centre[0], centre[1] + BASE_UNIT * 0.9, centre[2]]}
      center
      zIndexRange={[15, 10]}
      style={{ pointerEvents: "none" }}
    >
      <span className="dimension-label">
        {cells}u · {((cells * BASE_UNIT) / 10).toFixed(1)} cm
      </span>
    </Html>
  );
}

/**
 * Guides for a part standing off the ground: its footprint below it, posts down to
 * that footprint, and one tick per grid level so the height can be read by counting
 * rather than guessed from perspective.
 */
function HeightGuides({ min, size }: { min: GridPosition; size: [number, number, number] }) {
  const positions = useMemo(() => {
    const u = BASE_UNIT;
    const x0 = min[0] * u - u / 2;
    const x1 = (min[0] + size[0]) * u - u / 2;
    const z0 = min[2] * u - u / 2;
    const z1 = (min[2] + size[2]) * u - u / 2;
    const bottom = min[1] * u;
    const ground = 0.05; // clear of the grid lines
    const pts: number[] = [];
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) =>
      pts.push(ax, ay, az, bx, by, bz);

    seg(x0, ground, z0, x1, ground, z0);
    seg(x1, ground, z0, x1, ground, z1);
    seg(x1, ground, z1, x0, ground, z1);
    seg(x0, ground, z1, x0, ground, z0);

    seg(x0, ground, z0, x0, bottom, z0);
    seg(x1, ground, z0, x1, bottom, z0);
    seg(x1, ground, z1, x1, bottom, z1);
    seg(x0, ground, z1, x0, bottom, z1);

    for (let level = 1; level <= min[1]; level++) {
      const y = level * u;
      seg(x0, y, z0, x0 - u * 0.4, y, z0);
    }
    return new Float32Array(pts);
  }, [min[0], min[1], min[2], size[0], size[1], size[2]]);

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PART_COLORS.selected} transparent opacity={0.7} depthWrite={false} />
    </lineSegments>
  );
}

/** Outline of the buildable area, so its edge is visible rather than a mystery wall */
function WorkspaceBounds() {
  const points = useMemo(() => {
    const e = WORKSPACE_EXTENT * BASE_UNIT + BASE_UNIT / 2;
    return new Float32Array([-e, 0, -e, e, 0, -e, e, 0, e, -e, 0, e]);
  }, []);
  return (
    <lineLoop position={[0, 0.05, 0]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PART_COLORS.selected} transparent opacity={0.9} />
    </lineLoop>
  );
}

/**
 * 1×1×1 cell that follows the cursor before a draw drag starts. Under gravity it
 * sits on top of whatever is already there, so the cell you are about to anchor on
 * is the cell the part will actually start from.
 */
function DrawSpanCursor({ assembly, gravityEnabled }: { assembly: AssemblyState; gravityEnabled: boolean }) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>([0, 0, 0]);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(plane, intersectPoint)) return;
    const grid = clampCellToWorkspace(snapToGrid(intersectPoint));
    grid[1] = 0;
    const settled = resolveDraw(assembly, grid, [1, 1, 1], gravityEnabled)?.position ?? grid;
    setGridPos((prev) => (prev[0] === settled[0] && prev[1] === settled[1] && prev[2] === settled[2] ? prev : settled));
  });

  return <DrawSpanGhost position={gridPos} size={[1, 1, 1]} />;
}

/** Rendered mesh for a custom STL-imported part */
function CustomPartMesh({
  part,
  isSelected,
  isDragging,
  isPlacing,
  isFlashing,
  isColliding,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  isColliding: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId)!;
  const geometry = getCustomPartGeometry(part.definitionId);
  if (!geometry) return null;

  const worldPos = gridToWorld(part.position);
  const partEuler = degreesToEuler(part.rotation);
  // Compute offset from ROTATED cells so it stays correct after rotation
  const rotatedCells = rotateGridCells(def.gridCells, part.rotation);
  const offset = modelCenterOffset({ gridCells: rotatedCells });
  const flashRef = useRef<THREE.MeshStandardMaterial>(null);
  const flashStart = useRef(0);

  useFrame(({ clock }) => {
    if (!flashRef.current) return;
    if (isFlashing) {
      if (flashStart.current === 0) flashStart.current = clock.elapsedTime;
      const t = clock.elapsedTime - flashStart.current;
      const pulse = Math.sin(t * 10) * 0.5 + 0.5; // fast oscillation
      flashRef.current.emissiveIntensity = pulse * 0.8;
      flashRef.current.emissive = new THREE.Color(0xffffff);
    } else {
      flashStart.current = 0;
      flashRef.current.emissiveIntensity = 0;
      flashRef.current.emissive.setHex(0x000000);
    }
  });

  const categoryColor = part.color ?? PART_COLORS.custom;
  const color = isSelected ? PART_COLORS.selected : isColliding ? PART_COLORS.collision : categoryColor;
  const opacity = isDragging ? 0.3 : 1;

  return (
    <group
      name={`placed-${part.instanceId}`}
      position={worldPos}
      onPointerDown={(e) => {
        if (!isPlacing) e.stopPropagation();
        onPointerDown(e);
      }}
      onClick={(e) => {
        if (!isPlacing) e.stopPropagation();
      }}
    >
      <group position={offset}>
        <group rotation={partEuler}>
          <mesh geometry={geometry}>
            <meshStandardMaterial
              ref={flashRef}
              color={color}
              roughness={1}
              metalness={0}
              transparent={isDragging}
              opacity={opacity}
            />
          </mesh>
        </group>
      </group>
      {isSelected && !isDragging && (
        <mesh position={offset}>
          <boxGeometry args={[BASE_UNIT * 1.1, BASE_UNIT * 1.1, BASE_UNIT * 1.1]} />
          <meshBasicMaterial color={PART_COLORS.selected} wireframe transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}

/** GLB-loaded part mesh */
function PartMeshLoaded({
  part,
  isSelected,
  isDragging,
  isPlacing,
  isFlashing,
  isColliding,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  isColliding: boolean;
  onPointerDown: (e: any) => void;
}) {
  const def = getPartDefinition(part.definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  // Placed parts cast and receive; ghosts deliberately do neither
  const cloned = useMemo(() => {
    const copy = scene.clone();
    copy.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return copy;
  }, [scene]);
  const worldPos = gridToWorld(part.position);
  const groupRef = useRef<THREE.Group>(null);

  // Register merged geometry for collision detection (once per definition)
  useEffect(() => {
    if (hasRegisteredGeometry(part.definitionId)) return;
    const geometries: THREE.BufferGeometry[] = [];
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        geometries.push(child.geometry);
      }
    });
    if (geometries.length > 0) {
      const merged = geometries.length === 1 ? geometries[0].clone() : mergeGeometries(geometries, false);
      if (merged) registerPartGeometry(part.definitionId, merged);
    }
  }, [scene, part.definitionId]);

  // Store original materials so we can restore them on deselect
  const originalMaterials = useRef<WeakMap<THREE.Mesh, THREE.Material>>(new WeakMap());

  // Apply selection highlight, drag dimming, or custom color (skip while flashing — useFrame handles that)
  useEffect(() => {
    if (!groupRef.current || isFlashing) return;
    groupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Save original material on first encounter
        if (!originalMaterials.current.has(child)) {
          originalMaterials.current.set(child, child.material);
        }
        const orig = originalMaterials.current.get(child) ?? child.material;
        if (isDragging) {
          if (part.color) {
            child.material = makeColorMaterial(part.color, orig, {
              transparent: true,
              opacity: 0.3,
            });
          } else {
            const mat = orig.clone();
            mat.transparent = true;
            mat.opacity = 0.3;
            child.material = mat;
          }
        } else if (isSelected) {
          if (part.color) {
            child.material = makeColorMaterial(part.color, orig, {
              emissive: new THREE.Color(PART_COLORS.selected),
              emissiveIntensity: 0.3,
            });
          } else {
            const mat = orig.clone();
            mat.emissive = new THREE.Color(PART_COLORS.selected);
            mat.emissiveIntensity = 0.3;
            child.material = mat;
          }
        } else if (isColliding) {
          child.material = makeColorMaterial(PART_COLORS.collision, orig, {
            emissive: new THREE.Color(PART_COLORS.collision),
            emissiveIntensity: 0.4,
          });
        } else if (part.color) {
          child.material = makeColorMaterial(part.color, orig);
        } else {
          // Restore original material
          const orig = originalMaterials.current.get(child);
          if (orig) child.material = orig;
        }
      }
    });
  }, [isSelected, isDragging, isFlashing, isColliding, part.color]);

  // Flash animation for "find part" from selection panel
  const flashStart = useRef(0);
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    if (isFlashing) {
      if (flashStart.current === 0) flashStart.current = clock.elapsedTime;
      const t = clock.elapsedTime - flashStart.current;
      const pulse = Math.sin(t * 10) * 0.5 + 0.5;
      groupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material?.emissive) {
          child.material.emissive = new THREE.Color(0xffffff);
          child.material.emissiveIntensity = pulse * 0.8;
        }
      });
    } else if (flashStart.current !== 0) {
      flashStart.current = 0;
      // Restore after flash: reset emissive and re-apply color or original material
      groupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (part.color) {
            const orig = originalMaterials.current.get(child) ?? child.material;
            child.material = makeColorMaterial(part.color, orig);
          } else {
            const orig = originalMaterials.current.get(child);
            if (orig) {
              child.material = orig;
              if ((orig as THREE.MeshStandardMaterial).emissive) {
                (orig as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
                (orig as THREE.MeshStandardMaterial).emissiveIntensity = 0;
              }
            }
          }
        }
      });
    }
  });

  const partEuler = degreesToEuler(part.rotation);
  const orientEuler = degreesToEuler(orientationToRotation(part.orientation ?? "y"));
  // Compute offset from oriented THEN rotated cells — placed outside both rotation groups
  const orient = part.orientation ?? "y";
  // Rotate then orient — the same order AssemblyState uses to claim grid cells
  const rotatedCells = rotateGridCells(def.gridCells, part.rotation);
  const orientedCells = rotatedCells.map((c) => transformCell(c, orient));
  const offset = modelCenterOffset({ gridCells: orientedCells });

  return (
    <group
      name={`placed-${part.instanceId}`}
      position={worldPos}
      onPointerDown={(e) => {
        if (!isPlacing) e.stopPropagation();
        onPointerDown(e);
      }}
      onClick={(e) => {
        if (!isPlacing) e.stopPropagation();
      }}
    >
      <group position={offset}>
        <group rotation={orientEuler}>
          <group rotation={partEuler}>
            <primitive ref={groupRef} object={cloned} />
          </group>
        </group>
      </group>
      {isSelected && !isDragging && (
        <mesh position={offset}>
          <boxGeometry args={[BASE_UNIT * 1.1, BASE_UNIT * 1.1, BASE_UNIT * 1.1]} />
          <meshBasicMaterial color={PART_COLORS.selected} wireframe transparent opacity={0.3} />
        </mesh>
      )}
    </group>
  );
}

/** Fallback box while GLB is loading */
function PartMeshFallback({
  part,
  isSelected,
  onClick,
}: {
  part: PlacedPart;
  isSelected: boolean;
  onClick: () => void;
}) {
  const def = getPartDefinition(part.definitionId);
  if (!def) return null;

  const worldPos = gridToWorld(part.position);
  const color = isSelected ? PART_COLORS.selected : part.color || PART_COLORS[def.category] || "#888888";

  // Use oriented + rotated cells for correct sizing and offset
  const orient = part.orientation ?? "y";
  // Rotate then orient — the same order AssemblyState uses to claim grid cells
  const cells = rotateGridCells(def.gridCells, part.rotation).map((c) => transformCell(c, orient));
  const offset = modelCenterOffset({ gridCells: cells });

  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));

  const sizeX = (maxX - minX + 1) * BASE_UNIT;
  const sizeY = (maxY - minY + 1) * BASE_UNIT;
  const sizeZ = (maxZ - minZ + 1) * BASE_UNIT;

  // Box dimensions already reflect orientation + rotation — no rotation group needed
  return (
    <group position={worldPos}>
      <mesh
        position={offset}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        <boxGeometry args={[sizeX * 0.9, sizeY * 0.9, sizeZ * 0.9]} />
        <meshStandardMaterial color={color} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

/** Convert a Rotation3 (degrees) to a radians Euler tuple for Three.js */
function degreesToEuler(rot: Rotation3): [number, number, number] {
  return [(rot[0] * Math.PI) / 180, (rot[1] * Math.PI) / 180, (rot[2] * Math.PI) / 180];
}

/** Cycle a single rotation step: 0 -> 90 -> 180 -> 270 -> 0 */
function nextStep(step: RotationStep): RotationStep {
  const steps: RotationStep[] = [0, 90, 180, 270];
  return steps[(steps.indexOf(step) + 1) % 4];
}

/** Ghost preview model — loads the actual GLB with a transparent tint */
function GhostModel({
  definitionId,
  rotation,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId);
  if (!def) return null;

  if (!def.modelPath) {
    return <GhostFallback definitionId={definitionId} orientation={orientation} isSnapped={isSnapped} />;
  }

  if (isCustomPart(definitionId)) {
    return <CustomGhostModel definitionId={definitionId} rotation={rotation} isSnapped={isSnapped} />;
  }

  return (
    <GLBGhostModel definitionId={definitionId} rotation={rotation} orientation={orientation} isSnapped={isSnapped} />
  );
}

/** Ghost preview for GLB-based parts */
function GLBGhostModel({
  definitionId,
  rotation,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  const cloned = useMemo(() => scene.clone(), [scene]);
  const groupRef = useRef<THREE.Group>(null);
  const color = isSnapped ? PART_COLORS.ghost_snapped : PART_COLORS.ghost_valid;

  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = new THREE.MeshStandardMaterial({
          color,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        });
      }
    });
  }, [color]);

  const euler = degreesToEuler(rotation);
  const orient = orientation ?? "y";
  const orientEuler = degreesToEuler(orientationToRotation(orient));
  // Rotate then orient — the same order AssemblyState uses to claim grid cells
  const rotatedCells = rotateGridCells(def.gridCells, rotation);
  const orientedCells = rotatedCells.map((c) => transformCell(c, orient));
  const offset = modelCenterOffset({ gridCells: orientedCells });

  return (
    <group position={offset}>
      <group rotation={orientEuler}>
        <group rotation={euler}>
          <primitive ref={groupRef} object={cloned} />
        </group>
      </group>
    </group>
  );
}

/** Ghost preview for custom STL-imported parts */
function CustomGhostModel({
  definitionId,
  rotation,
  isSnapped,
}: {
  definitionId: string;
  rotation: Rotation3;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const geometry = getCustomPartGeometry(definitionId);
  if (!geometry) return null;

  const color = isSnapped ? PART_COLORS.ghost_snapped : PART_COLORS.ghost_valid;

  const euler = degreesToEuler(rotation);
  // Compute offset from rotated cells — placed outside rotation
  const rotatedCells = rotateGridCells(def.gridCells, rotation);
  const offset = modelCenterOffset({ gridCells: rotatedCells });

  return (
    <group position={offset}>
      <group rotation={euler}>
        <mesh geometry={geometry}>
          <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

/** Fallback box while the ghost GLB is loading, or for a part with no model */
function GhostFallback({
  definitionId,
  orientation,
  isSnapped,
}: {
  definitionId: string;
  orientation?: Axis;
  isSnapped?: boolean;
}) {
  const def = getPartDefinition(definitionId);
  if (!def) return null;

  const orient = orientation ?? "y";
  const cells = def.gridCells.map((c) => transformCell(c, orient));
  const offset = modelCenterOffset({ gridCells: cells });

  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const minZ = Math.min(...cells.map((c) => c[2]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const maxY = Math.max(...cells.map((c) => c[1]));
  const maxZ = Math.max(...cells.map((c) => c[2]));

  const sizeX = (maxX - minX + 1) * BASE_UNIT;
  const sizeY = (maxY - minY + 1) * BASE_UNIT;
  const sizeZ = (maxZ - minZ + 1) * BASE_UNIT;
  const color = isSnapped ? PART_COLORS.ghost_snapped : PART_COLORS.ghost_valid;

  // No rotation needed — box dimensions already reflect oriented space
  return (
    <mesh position={offset}>
      <boxGeometry args={[sizeX * 0.95, sizeY * 0.95, sizeZ * 0.95]} />
      <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
    </mesh>
  );
}

/** Shared ghost placement state — written by GhostPreview each frame, read by Scene on click */
interface GhostState {
  position: GridPosition;
  orientation: Axis;
  rotation: Rotation3;
  isSnapped: boolean;
}

/**
 * Shared hook: raycast cursor to ground/drag plane, apply grab offset,
 * snap to connectors/supports, compute ground lift — single source of truth
 * for placement, drag, and paste preview positioning.
 */
function useGhostSnap({
  definitionId,
  assembly,
  ghostOrientation,
  ghostRotation,
  yLift,
  snapEnabled,
  /** Grid-space offset from cursor to the anchor part (for paste mode) */
  cursorOffset,
  /** World-space Y for the raycast plane (default 0). Set to the part's
   *  original world Y during drag for perspective-correct cursor tracking. */
  planeY = 0,
  /** Initial grid position (used as starting state during drag) */
  initialPosition,
  /** World-space grab offset [dx, dz] captured on first frame of a drag.
   *  When provided, the hook subtracts it from the cursor hit before snapping. */
  grabOffsetRef,
  /** When set, a free placement settles under gravity: it climbs out of whatever
   *  it overlaps, then falls onto the first thing below it (the ground otherwise).
   *  The ids in the set count as absent — they are the parts being moved. */
  gravityIgnoreIds,
  /** Live drag state for the right button: while `active`, the cursor sets height
   *  instead of footprint. `used` survives the release, so a height chosen on
   *  purpose is not immediately undone by gravity pulling the part back down. */
  verticalDragRef,
  /** Optional ref written synchronously inside useFrame so click handlers
   *  always read the latest computed state without waiting for a React render. */
  syncRef,
}: {
  definitionId: string;
  assembly: AssemblyState;
  ghostOrientation: Axis;
  ghostRotation: Rotation3;
  yLift: number;
  snapEnabled: boolean;
  cursorOffset?: GridPosition;
  planeY?: number;
  initialPosition?: GridPosition;
  grabOffsetRef?: React.MutableRefObject<[number, number] | null>;
  gravityIgnoreIds?: Set<string>;
  verticalDragRef?: React.MutableRefObject<{ active: boolean; used: boolean; y: number }>;
  syncRef?: React.MutableRefObject<{
    position: GridPosition;
    orientation: Axis;
    rotation: Rotation3;
    isSnapped: boolean;
  }>;
}) {
  const { camera, raycaster, pointer } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>(initialPosition ?? [0, 0, 0]);
  const [effectiveOrientation, setEffectiveOrientation] = useState<Axis>(ghostOrientation);
  const [effectiveRotation, setEffectiveRotation] = useState<Rotation3>(ghostRotation);
  const [isSnapped, setIsSnapped] = useState(false);
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY), [planeY]);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  const def = getPartDefinition(definitionId);
  const isSupport = def?.category === "support";
  const ox = cursorOffset?.[0] ?? 0;
  const oy = cursorOffset?.[1] ?? 0;
  const oz = cursorOffset?.[2] ?? 0;

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(plane, intersectPoint)) return;

    // Apply grab offset if dragging (anchors part to grab point)
    if (grabOffsetRef) {
      if (grabOffsetRef.current === null && initialPosition) {
        const partWorldPos = gridToWorld(initialPosition);
        grabOffsetRef.current = [intersectPoint.x - partWorldPos[0], intersectPoint.z - partWorldPos[2]];
      }
      if (grabOffsetRef.current) {
        intersectPoint.x -= grabOffsetRef.current[0];
        intersectPoint.z -= grabOffsetRef.current[1];
      }
    }

    const cursorGrid = snapToGrid(intersectPoint);
    cursorGrid[1] = 0;

    const gridRay: GridRay = {
      origin: [
        raycaster.ray.origin.x / BASE_UNIT,
        raycaster.ray.origin.y / BASE_UNIT,
        raycaster.ray.origin.z / BASE_UNIT,
      ],
      direction: [raycaster.ray.direction.x, raycaster.ray.direction.y, raycaster.ray.direction.z],
    };

    // Snap position is the anchor part's absolute position (cursor + offset)
    const snapPos: GridPosition = [cursorGrid[0] + ox, cursorGrid[1] + oy, cursorGrid[2] + oz];

    // Try snapping: supports snap to connector sockets, connectors snap to support endpoints
    const snap = snapEnabled
      ? isSupport
        ? findBestSnap(assembly, definitionId, snapPos, 3, gridRay)
        : findBestConnectorSnap(assembly, definitionId, snapPos, 3, gridRay, ghostRotation)
      : null;

    const snapOrient = snap ? (isSupport ? snap.orientation : ghostOrientation) : ghostOrientation;
    const snapRotation: Rotation3 = snap
      ? isSupport
        ? [0, 0, 0]
        : (snap.autoRotation ?? ghostRotation)
      : ghostRotation;

    // Under gravity a socket is not enough: a downward socket can point through the
    // floor, and the span it implies can run straight through another part.
    const snapAllowed =
      !!snap &&
      (!gravityIgnoreIds ||
        placementIsGrounded(assembly, definitionId, snap.position, snapRotation, snapOrient, gravityIgnoreIds));

    if (snap && snapAllowed) {
      const orient = snapOrient;
      const liftedSnapPos: GridPosition = [snap.position[0], snap.position[1], snap.position[2]];
      // Debug: expose ghost snap state for e2e tests
      (window as any).__ghostDebug = {
        snapPos: snap.position,
        yLift,
        liftedSnapPos,
        orient,
        snapRotation,
        cursorGrid: [...cursorGrid],
        worldPos: gridToWorld(liftedSnapPos),
      };
      // Subtract offset to get group origin (for paste; no-op when offset is 0)
      const resultPos: GridPosition = [liftedSnapPos[0] - ox, liftedSnapPos[1] - oy, liftedSnapPos[2] - oz];
      setGridPos(resultPos);
      setEffectiveOrientation(orient);
      setEffectiveRotation(snapRotation);
      setIsSnapped(true);
      if (syncRef)
        syncRef.current = {
          position: resultPos,
          orientation: orient,
          rotation: snapRotation,
          isSnapped: true,
        };
      return;
    }

    // No snap — use free placement with current orientation/rotation
    const orient = isSupport ? ghostOrientation : "y";
    const lift = def ? computeGroundLift(def, ghostRotation, orient) : 0;
    cursorGrid[1] = lift + yLift;

    // Right button held: the footprint freezes and the cursor drives height instead,
    // read off a vertical plane through the part turned to face the camera.
    const vertical = verticalDragRef?.current;
    if (vertical?.active) {
      const held = syncRef?.current.position ?? gridPos;
      const anchor = new THREE.Vector3(...gridToWorld(held));
      const normal = new THREE.Vector3();
      camera.getWorldDirection(normal);
      normal.y = 0;
      if (normal.lengthSq() > 1e-6) {
        normal.normalize();
        const uprightPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
        const hit = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(uprightPlane, hit)) {
          cursorGrid[0] = held[0];
          cursorGrid[2] = held[2];
          cursorGrid[1] = Math.max(lift, Math.round((hit.y - BASE_UNIT / 2) / BASE_UNIT));
          vertical.y = cursorGrid[1];
        }
      }
    } else if (vertical?.used) {
      // The right button is usually released before the left. Keeping the chosen
      // height here is what stops that release from undoing it, while leaving
      // horizontal movement live so the part can still be positioned.
      cursorGrid[1] = Math.max(lift, vertical.y);
    }

    // Keep the part in the buildable area instead of letting it follow the cursor
    // off across the grid
    const boundedPos = def
      ? clampToWorkspace(rotateGridCells(def.gridCells, ghostRotation), cursorGrid, orient)
      : cursorGrid;

    // Gravity: climb out of anything in the way, then fall onto whatever is below.
    // A height set by hand only gets the climb, or the fall would cancel it.
    const heightChosen = !!verticalDragRef?.current.used;
    const freePos =
      gravityIgnoreIds && def
        ? heightChosen
          ? restOnCollision(assembly, definitionId, boundedPos, ghostRotation, orient, gravityIgnoreIds)
          : settleWithGravity(assembly, definitionId, boundedPos, ghostRotation, orient, lift, gravityIgnoreIds)
        : boundedPos;

    setEffectiveOrientation(orient);
    setEffectiveRotation(ghostRotation);
    setGridPos(freePos);
    setIsSnapped(false);
    if (syncRef)
      syncRef.current = {
        position: freePos,
        orientation: orient,
        rotation: ghostRotation,
        isSnapped: false,
      };
  });

  return { gridPos, effectiveOrientation, effectiveRotation, isSnapped, def };
}

/** Ghost preview for placement mode */
function GhostPreview({
  definitionId,
  assembly,
  ghostOrientation,
  ghostRotation,
  ghostStateRef,
  yLift,
  snapEnabled,
  gravityEnabled,
  onPlacePart,
}: {
  definitionId: string;
  assembly: AssemblyState;
  ghostOrientation: Axis;
  ghostRotation: Rotation3;
  ghostStateRef: React.MutableRefObject<GhostState>;
  yLift: number;
  snapEnabled: boolean;
  gravityEnabled: boolean;
  onPlacePart: (definitionId: string, position: GridPosition, rotation: Rotation3, orientation: Axis) => void;
}) {
  const noParts = useMemo(() => new Set<string>(), []);
  const { gridPos, effectiveOrientation, effectiveRotation, isSnapped, def } = useGhostSnap({
    definitionId,
    assembly,
    ghostOrientation,
    ghostRotation,
    yLift,
    snapEnabled,
    gravityIgnoreIds: gravityEnabled ? noParts : undefined,
    syncRef: ghostStateRef,
  });

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);

  // Expose rendered state for e2e debugging
  (window as any).__ghostRender = {
    gridPos: [...gridPos],
    worldPos: [...worldPos],
    rotation: [...effectiveRotation],
    orientation: effectiveOrientation,
    isSnapped,
  };

  const handleGhostClick = (e: any) => {
    e.stopPropagation();
    const gs = ghostStateRef.current;
    console.log("[GhostPreview] onClick — placing at", gs.position, gs.rotation, gs.orientation);
    onPlacePart(definitionId, gs.position, gs.rotation, gs.orientation);
  };

  return (
    <group name="ghost-preview" position={worldPos} onClick={handleGhostClick}>
      <Suspense fallback={<GhostFallback definitionId={definitionId} orientation={effectiveOrientation} />}>
        <GhostModel
          definitionId={definitionId}
          rotation={effectiveRotation}
          orientation={effectiveOrientation}
          isSnapped={isSnapped}
        />
      </Suspense>
    </group>
  );
}

/** Drag preview — uses shared snap hook with elevated plane + grab offset */
function DragPreview({
  dragState,
  assembly,
  dropTargetRef,
  yLift,
  snapEnabled,
  gravityEnabled,
  verticalDragRef,
  selectedPartIds,
  parts,
}: {
  dragState: DragState;
  assembly: AssemblyState;
  dropTargetRef: React.MutableRefObject<{
    position: GridPosition;
    orientation?: Axis;
    rotation?: Rotation3;
  }>;
  yLift: number;
  snapEnabled: boolean;
  gravityEnabled: boolean;
  verticalDragRef: React.MutableRefObject<{ active: boolean; used: boolean; y: number }>;
  selectedPartIds: Set<string>;
  parts: PlacedPart[];
}) {
  const grabOffsetRef = useRef<[number, number] | null>(null);
  const partWorldY = gridToWorld(dragState.originalPosition)[1];

  // Parts travelling with this drag move as one, so they never block each other
  const gravityIgnoreIds = useMemo(() => {
    if (!gravityEnabled) return undefined;
    const ids = new Set<string>([dragState.instanceId]);
    if (selectedPartIds.has(dragState.instanceId)) for (const id of selectedPartIds) ids.add(id);
    return ids;
  }, [gravityEnabled, dragState.instanceId, selectedPartIds]);

  const { gridPos, effectiveOrientation, isSnapped, def } = useGhostSnap({
    definitionId: dragState.definitionId,
    assembly,
    ghostOrientation: dragState.orientation ?? "y",
    ghostRotation: dragState.rotation,
    yLift,
    snapEnabled,
    planeY: partWorldY,
    initialPosition: dragState.originalPosition,
    grabOffsetRef,
    gravityIgnoreIds,
    verticalDragRef,
  });

  // Keep dropTargetRef in sync
  useEffect(() => {
    dropTargetRef.current = {
      position: gridPos,
      orientation: effectiveOrientation,
      rotation: dragState.rotation,
    };
  }, [gridPos, effectiveOrientation, dragState.rotation]);

  if (!def) return null;

  const worldPos = gridToWorld(gridPos);

  // The height is set during the drag, so the guides belong on the ghost too
  const ghostBounds = placedPartBounds({
    instanceId: dragState.instanceId,
    definitionId: dragState.definitionId,
    position: gridPos,
    rotation: dragState.rotation,
    orientation: effectiveOrientation,
  });

  // Compute delta for multi-drag ghost rendering
  const isMultiDrag = selectedPartIds.size > 1 && selectedPartIds.has(dragState.instanceId);
  const delta: GridPosition = [
    gridPos[0] - dragState.originalPosition[0],
    gridPos[1] - dragState.originalPosition[1],
    gridPos[2] - dragState.originalPosition[2],
  ];

  return (
    <group>
      {ghostBounds && ghostBounds.min[1] > 0 && <HeightGuides min={ghostBounds.min} size={ghostBounds.size} />}
      <group name="drag-preview" position={worldPos}>
        <Suspense fallback={<GhostFallback definitionId={dragState.definitionId} orientation={effectiveOrientation} />}>
          <GhostModel
            definitionId={dragState.definitionId}
            rotation={dragState.rotation}
            orientation={effectiveOrientation}
            isSnapped={isSnapped}
          />
        </Suspense>
      </group>
      {isMultiDrag &&
        parts
          .filter((p) => selectedPartIds.has(p.instanceId) && p.instanceId !== dragState.instanceId)
          .map((p) => {
            const offsetPos: GridPosition = [
              p.position[0] + delta[0],
              p.position[1] + delta[1],
              p.position[2] + delta[2],
            ];
            const wp = gridToWorld(offsetPos);
            return (
              <group key={p.instanceId} name={`drag-preview-${p.instanceId}`} position={wp}>
                <Suspense fallback={<GhostFallback definitionId={p.definitionId} orientation={p.orientation ?? "y"} />}>
                  <GhostModel
                    definitionId={p.definitionId}
                    rotation={p.rotation}
                    orientation={p.orientation ?? "y"}
                    isSnapped={isSnapped}
                  />
                </Suspense>
              </group>
            );
          })}
    </group>
  );
}

/** Expose the R3F scene, camera, and controls on window for e2e testing */
function ExposeScene() {
  const { scene, camera, controls } = useThree();
  useEffect(() => {
    (window as any).__scene = scene;
    (window as any).__camera = camera;
    (window as any).__controls = controls;
  }, [scene, camera, controls]);
  return null;
}

/** Apply stored camera/controls state after switching camera type */
function ApplyCameraSwitchSnapshot({
  isOrthographic,
  snapshotRef,
}: {
  isOrthographic: boolean;
  snapshotRef: React.MutableRefObject<CameraSwitchSnapshot | null>;
}) {
  const { camera, controls, size } = useThree();

  useLayoutEffect(() => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    const orbitControls = controls as any;
    if (!orbitControls?.target) return;
    const hasExpectedCameraType =
      (isOrthographic && camera instanceof THREE.OrthographicCamera) ||
      (!isOrthographic && camera instanceof THREE.PerspectiveCamera);
    if (!hasExpectedCameraType) return;

    camera.position.copy(snapshot.position);
    camera.quaternion.copy(snapshot.quaternion);
    orbitControls.target.copy(snapshot.target);

    const aspect = size.width / Math.max(1, size.height);
    const distance = camera.position.distanceTo(orbitControls.target);

    if (camera instanceof THREE.OrthographicCamera) {
      const fov = snapshot.fov ?? 50;
      const frustumHeight = snapshot.frustumHeight ?? 2 * Math.max(distance, 1) * Math.tan((fov * Math.PI) / 360);
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
      camera.right = (frustumHeight * aspect) / 2;
      camera.left = -(frustumHeight * aspect) / 2;
      if (snapshot.zoom !== undefined) camera.zoom = snapshot.zoom;
      camera.updateProjectionMatrix();
    } else if (camera instanceof THREE.PerspectiveCamera) {
      const frustumHeight = snapshot.frustumHeight;
      const fov =
        snapshot.fov ??
        (frustumHeight ? THREE.MathUtils.radToDeg(2 * Math.atan(frustumHeight / (2 * Math.max(distance, 1)))) : 50);
      camera.fov = THREE.MathUtils.clamp(fov, 10, 120);
      camera.updateProjectionMatrix();
    }

    orbitControls.update();
    snapshotRef.current = null;
  }, [isOrthographic, camera, controls, size.width, size.height, snapshotRef]);

  return null;
}

/** On first render with parts, fit camera to show all placed parts */
function FitCamera({ parts }: { parts: PlacedPart[] }) {
  const fitted = useRef(false);

  useEffect(() => {
    (window as any).__cameraFitted = false;
  }, []);

  useFrame(({ camera, controls, size }) => {
    if (fitted.current || parts.length === 0) return;
    const orbitControls = controls as any;
    if (!orbitControls?.target) return;

    // Compute bounding box of all part world positions
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (const part of parts) {
      const def = getPartDefinition(part.definitionId);
      if (!def) continue;
      const orient = part.orientation ?? "y";
      const cells = rotateGridCells(def.gridCells, part.rotation).map((c) => transformCell(c, orient));
      for (const cell of cells) {
        const wx = (part.position[0] + cell[0]) * BASE_UNIT;
        const wy = (part.position[1] + cell[1]) * BASE_UNIT + BASE_UNIT / 2;
        const wz = (part.position[2] + cell[2]) * BASE_UNIT;
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx + BASE_UNIT);
        minY = Math.min(minY, wy);
        maxY = Math.max(maxY, wy + BASE_UNIT);
        minZ = Math.min(minZ, wz);
        maxZ = Math.max(maxZ, wz + BASE_UNIT);
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

    fitted.current = true;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;

    const aspect = size.width / Math.max(1, size.height);
    const dist = Math.max(radius * 1.8, 100);

    camera.position.set(cx + dist * 0.6, cy + dist * 0.7, cz + dist * 0.6);
    camera.lookAt(cx, cy, cz);

    if (camera instanceof THREE.OrthographicCamera) {
      const padding = 1.3;
      const frustumHeight = Math.max(
        (dy || BASE_UNIT) * padding,
        ((dx || BASE_UNIT) * padding) / aspect,
        ((dz || BASE_UNIT) * padding) / aspect,
      );
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
      camera.right = (frustumHeight * aspect) / 2;
      camera.left = -(frustumHeight * aspect) / 2;
    } else if (camera instanceof THREE.PerspectiveCamera) {
      const fov = camera.fov ?? 50;
      const perspectiveDist = Math.max(radius / Math.tan(((fov / 2) * Math.PI) / 180), 100);
      camera.position.set(cx + perspectiveDist * 0.6, cy + perspectiveDist * 0.7, cz + perspectiveDist * 0.6);
      camera.lookAt(cx, cy, cz);
    }
    camera.updateProjectionMatrix();

    orbitControls.target.set(cx, cy, cz);
    orbitControls.update();
    (window as any).__cameraFitted = true;
  });

  return null;
}

/** Paste ghost state — same shape as GhostState so syncRef can write to it */
type PasteGhostState = GhostState;

/** Compose two Rotation3 values (add per-axis, mod 360) */
function addRotations(a: Rotation3, b: Rotation3): Rotation3 {
  return [
    ((a[0] + b[0]) % 360) as Rotation3[0],
    ((a[1] + b[1]) % 360) as Rotation3[1],
    ((a[2] + b[2]) % 360) as Rotation3[2],
  ];
}

/** Ghost preview for paste mode — renders all clipboard parts at cursor position, with snap */
function PasteGhostPreview({
  clipboard,
  pasteStateRef,
  assembly,
  snapEnabled,
  ghostRotation,
  onPasteParts,
}: {
  clipboard: ClipboardData;
  pasteStateRef: React.MutableRefObject<PasteGhostState>;
  assembly: AssemblyState;
  snapEnabled: boolean;
  ghostRotation: Rotation3;
  onPasteParts: (clipboard: ClipboardData, targetPosition: GridPosition, extraRotation?: Rotation3) => void;
}) {
  const anchor = clipboard.parts[0];
  const anchorRotation = anchor ? addRotations(anchor.rotation, ghostRotation) : ghostRotation;
  const { gridPos, isSnapped } = useGhostSnap({
    definitionId: anchor?.definitionId ?? "",
    assembly,
    ghostOrientation: anchor?.orientation ?? "y",
    ghostRotation: anchorRotation,
    yLift: 0,
    snapEnabled,
    cursorOffset: anchor?.offset,
    syncRef: pasteStateRef,
  });

  const handlePasteClick = (e: any) => {
    e.stopPropagation();
    const ps = pasteStateRef.current;
    console.log("[PasteGhostPreview] onClick — pasting at", ps.position, "rotation", ghostRotation);
    onPasteParts(clipboard, ps.position, ghostRotation);
  };

  return (
    <group name="paste-preview" onClick={handlePasteClick}>
      {clipboard.parts.map((cp, i) => {
        const pos: GridPosition = [gridPos[0] + cp.offset[0], gridPos[1] + cp.offset[1], gridPos[2] + cp.offset[2]];
        const worldPos = gridToWorld(pos);
        const rot = addRotations(cp.rotation, ghostRotation);
        return (
          <group key={i} position={worldPos}>
            <Suspense fallback={<GhostFallback definitionId={cp.definitionId} orientation={cp.orientation} />}>
              <GhostModel
                definitionId={cp.definitionId}
                rotation={rot}
                orientation={cp.orientation}
                isSnapped={isSnapped}
              />
            </Suspense>
          </group>
        );
      })}
    </group>
  );
}

interface SceneProps extends ViewportProps {
  ghostRotation: Rotation3;
  ghostOrientation: Axis;
  ghostStateRef: React.MutableRefObject<GhostState>;
  pasteStateRef: React.MutableRefObject<PasteGhostState>;
  dragState: DragState | null;
  dropTargetRef: React.MutableRefObject<{
    position: GridPosition;
    orientation?: Axis;
    rotation?: Rotation3;
  }>;
  onPartPointerDown: (instanceId: string, nativeEvent: PointerEvent, hit?: THREE.Vector3) => void;
  verticalDragRef: React.MutableRefObject<{ active: boolean; used: boolean; y: number }>;
  pressOriginRef: React.MutableRefObject<{ x: number; y: number } | null>;
  hoveredPartId: string | null;
  onHoverPart: (instanceId: string | null) => void;
  light: LightSettings;
  yLift: number;
  boxSelectActive: boolean;
  collidingPartIds: Set<string>;
  drawDrag: { start: GridPosition; current: GridPosition } | null;
  onDrawPointerDown: (grid: GridPosition) => void;
  onDrawPointerMove: (grid: GridPosition) => void;
  onDrawPointerUp: () => void;
  resizePreview: ResizePreview | null;
  onResizePreview: (preview: ResizePreview | null) => void;
  selectedResizable: { part: PlacedPart; origin: GridPosition; size: [number, number, number] } | null;
}

/** Scene contents — lives inside the Canvas */
function Scene({
  parts,
  mode,
  selectedPartIds,
  assembly,
  onPlacePart,
  onPasteParts,
  onClickEmpty,
  onResizePart,
  ghostRotation,
  ghostOrientation,
  ghostStateRef,
  pasteStateRef,
  dragState,
  dropTargetRef,
  onPartPointerDown,
  verticalDragRef,
  pressOriginRef,
  hoveredPartId,
  onHoverPart,
  light,
  yLift,
  flashPartId,
  flashDefinitionId,
  snapEnabled,
  gravityEnabled,
  selectedPoint,
  previewSuggestion,
  boxSelectActive,
  collidingPartIds,
  drawDrag,
  onDrawPointerDown,
  onDrawPointerMove,
  onDrawPointerUp,
  resizePreview,
  onResizePreview,
  selectedResizable,
}: SceneProps) {
  const groundRef = useRef<THREE.Mesh>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const gridFromPointerEvent = useCallback((e: { point?: THREE.Vector3 }) => {
    if (e.point) {
      return snapToGrid(e.point);
    }
    return null;
  }, []);

  const handleGroundClick = useCallback(
    (e: any) => {
      if (dragState) return;
      // The browser reports the end of a camera orbit as a click too. Taking that for
      // a click on the scene would place a part, or drop the picked position, every
      // time the view is moved.
      const origin = pressOriginRef.current;
      const native = e.nativeEvent as PointerEvent | undefined;
      if (origin && native && Math.hypot(native.clientX - origin.x, native.clientY - origin.y) >= DRAG_THRESHOLD) {
        return;
      }
      if (mode.type === "draw") return; // handled by pointer up
      if (mode.type === "place") {
        e.stopPropagation();
        const gs = ghostStateRef.current;
        onPlacePart(mode.definitionId, gs.position, gs.rotation, gs.orientation);
      } else if (mode.type === "paste") {
        e.stopPropagation();
        const ps = pasteStateRef.current;
        onPasteParts(mode.clipboard, ps.position, ghostRotation);
      } else {
        onClickEmpty();
      }
    },
    [
      mode,
      onPlacePart,
      onPasteParts,
      onClickEmpty,
      ghostStateRef,
      pasteStateRef,
      dragState,
      ghostRotation,
      pressOriginRef,
    ],
  );

  const handleGroundPointerDown = useCallback(
    (e: any) => {
      if (mode.type !== "draw") return;
      if (e.button !== 0) return; // right button cancels, middle pans — neither draws
      e.stopPropagation();
      const grid = gridFromPointerEvent(e);
      if (!grid) return;
      grid[1] = 0;
      const anchor = clampCellToWorkspace(grid);
      // Anchor where the part will actually rest, so an upright draw starts on top
      // of whatever is already on that cell rather than inside it
      const settled = resolveDraw(assembly, anchor, [1, 1, 1], gravityEnabled)?.position ?? anchor;
      onDrawPointerDown(settled);
    },
    [mode, gridFromPointerEvent, onDrawPointerDown],
  );

  const handleGroundPointerMove = useCallback(
    (e: any) => {
      if (mode.type !== "draw" || !drawDrag) return;
      e.stopPropagation();
      const grid = gridFromPointerEvent(e);
      if (!grid) return;
      grid[1] = drawDrag?.start[1] ?? 0;
      onDrawPointerMove(clampCellToWorkspace(grid));
    },
    [mode, drawDrag, gridFromPointerEvent, onDrawPointerMove],
  );

  // onDrawPointerUp is handled by window listeners in ViewportCanvas
  void onDrawPointerUp;

  // Guides for any selected part that is off the ground
  const heightGuides = useMemo(() => {
    const out: { id: string; min: GridPosition; size: [number, number, number] }[] = [];
    for (const part of parts) {
      if (!selectedPartIds.has(part.instanceId)) continue;
      if (dragState?.instanceId === part.instanceId) continue; // the ghost carries its own
      const bounds = placedPartBounds(part);
      if (!bounds || bounds.min[1] <= 0) continue;
      out.push({ id: part.instanceId, min: bounds.min, size: bounds.size });
    }
    return out;
  }, [parts, selectedPartIds, dragState]);

  // Live while resizing, otherwise whatever the cursor is over. Only bars get one —
  // "1u" on a connector would be noise.
  const dimensionBox = useMemo(() => {
    if (resizePreview) return { min: resizePreview.position, size: resizePreview.size };
    if (!hoveredPartId) return null;
    const part = parts.find((p) => p.instanceId === hoveredPartId);
    if (!part) return null;
    const bounds = placedPartBounds(part);
    if (!bounds || Math.max(...bounds.size) <= 1) return null;
    return bounds;
  }, [resizePreview, hoveredPartId, parts]);

  const sceneDrawAxis: DrawAxis = mode.type === "draw" ? mode.axis : "horizontal";
  const drawSpan = drawDrag ? computeDrawSpan(drawDrag.start, drawDrag.current, sceneDrawAxis) : null;
  // Preview the settled placement, not the raw span — same resolver as the commit
  const drawPreview = drawSpan
    ? (resolveDraw(assembly, drawSpan.position, drawSpan.size, gravityEnabled) ?? drawSpan)
    : null;

  return (
    <>
      <ExposeScene />
      <FitCamera parts={parts} />
      {/* Lighting */}
      <ShadowUpdater parts={parts} light={light} />
      <ambientLight intensity={light.ambient} />
      {/* Same direction as before, pushed out so the orthographic shadow camera has
          room to span the workspace instead of the default few units */}
      <directionalLight
        position={lightPosition(light)}
        intensity={light.intensity}
        castShadow={light.shadows}
        shadow-mapSize={[light.resolution, light.resolution]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={1}
        shadow-camera-far={2000}
        shadow-bias={-0.0006}
        shadow-normalBias={0.08}
      />
      <directionalLight position={[-50, 100, -50]} intensity={1.0} />
      <directionalLight position={[0, -100, 50]} intensity={0.8} />

      {/* Solid floor that catches the shadows. Single-sided with its face up, so it
          reads as opaque from above yet lets the mirror minimap see the underside
          from below. Sits under the grid lines, and out of raycasting — it shares
          the ground with the pick plane. */}
      {light.floor && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -1.5, 0]}
          receiveShadow
          raycast={() => null}
          renderOrder={-2}
        >
          <planeGeometry args={[SHADOW_EXTENT * 2, SHADOW_EXTENT * 2]} />
          {/*
            depthWrite off is what stops the grid flickering. Two near-coplanar planes
            spanning to the horizon cannot be separated by the depth buffer at grazing
            angles, whatever the gap; leaving the floor out of the buffer entirely
            removes the contest instead of trying to win it. renderOrder puts it first,
            so the grid and the parts still draw over it.
          */}
          <meshStandardMaterial color="#343450" depthWrite={false} />
        </mesh>
      )}

      {/* Camera controls — disabled during drag, box select, draw, or handle resize */}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        enabled={!dragState && !boxSelectActive && !drawDrag && !handleDragging}
      />

      {/* Grid floor */}
      <Grid
        position={[0, -0.1, 0]}
        args={[GRID_EXTENT * BASE_UNIT * 2, GRID_EXTENT * BASE_UNIT * 2]}
        cellSize={BASE_UNIT}
        cellThickness={0.5}
        cellColor="#666666"
        sectionSize={BASE_UNIT * 5}
        sectionThickness={1}
        sectionColor="#888888"
        fadeDistance={GRID_EXTENT * BASE_UNIT * 8}
        fadeStrength={1}
        infiniteGrid
      />

      {dimensionBox && <DimensionLabel min={dimensionBox.min} size={dimensionBox.size} />}

      {heightGuides.map((g) => (
        <HeightGuides key={g.id} min={g.min} size={g.size} />
      ))}

      {selectedPoint && <AttachmentMarker point={selectedPoint} />}
      {previewSuggestion && (
        <SuggestionPreview
          definitionId={previewSuggestion.definitionId}
          position={previewSuggestion.position}
          rotation={previewSuggestion.rotation}
        />
      )}

      <WorkspaceBounds />

      {/* Invisible ground plane for raycasting */}
      <mesh
        ref={groundRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        onClick={handleGroundClick}
        onPointerDown={handleGroundPointerDown}
        onPointerMove={handleGroundPointerMove}
        visible={false}
      >
        <planeGeometry args={[GRID_EXTENT * BASE_UNIT * 4, GRID_EXTENT * BASE_UNIT * 4]} />
        <meshBasicMaterial />
      </mesh>

      {/* Axes indicator */}
      <GizmoHelper alignment="bottom-left" margin={[60, 60]}>
        <GizmoViewport labelColor="white" axisHeadScale={0.8} />
      </GizmoHelper>

      {/* Placed parts */}
      {parts.map((part) => {
        const preview = resizePreview && resizePreview.instanceId === part.instanceId ? resizePreview : null;
        const renderPart: PlacedPart = preview ? previewPart(part, preview) : part;
        return (
          <group
            key={part.instanceId}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHoverPart(part.instanceId);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              onHoverPart(null);
            }}
          >
            <PartMesh
              part={renderPart}
              isSelected={selectedPartIds.has(part.instanceId)}
              isDragging={dragState?.instanceId === part.instanceId}
              isPlacing={mode.type === "place" || mode.type === "draw"}
              isFlashing={flashPartId === part.instanceId || flashDefinitionId === part.definitionId}
              isColliding={collidingPartIds.has(part.instanceId)}
              onPointerDown={(e) => onPartPointerDown(part.instanceId, e.nativeEvent, e.point)}
            />
          </group>
        );
      })}

      {selectedResizable && mode.type === "select" && !dragState && (
        <>
          <ResizeHandles
            part={selectedResizable.part}
            origin={selectedResizable.origin}
            size={selectedResizable.size}
            onPreview={onResizePreview}
            onResize={onResizePart}
            onDraggingChange={setHandleDragging}
          />
        </>
      )}

      {mode.type === "draw" &&
        (drawPreview ? (
          <DrawSpanGhost position={drawPreview.position} size={drawPreview.size} />
        ) : (
          <DrawSpanCursor assembly={assembly} gravityEnabled={gravityEnabled} />
        ))}

      {/* Ghost preview in placement mode */}
      {mode.type === "place" && (
        <GhostPreview
          definitionId={mode.definitionId}
          assembly={assembly}
          ghostOrientation={ghostOrientation}
          ghostRotation={ghostRotation}
          ghostStateRef={ghostStateRef}
          yLift={yLift}
          snapEnabled={snapEnabled}
          gravityEnabled={gravityEnabled}
          onPlacePart={onPlacePart}
        />
      )}

      {/* Drag preview */}
      {dragState && (
        <DragPreview
          dragState={dragState}
          assembly={assembly}
          dropTargetRef={dropTargetRef}
          yLift={yLift}
          snapEnabled={snapEnabled}
          gravityEnabled={gravityEnabled}
          verticalDragRef={verticalDragRef}
          selectedPartIds={selectedPartIds}
          parts={parts}
        />
      )}

      {/* Paste preview */}
      {mode.type === "paste" && (
        <PasteGhostPreview
          clipboard={mode.clipboard}
          pasteStateRef={pasteStateRef}
          assembly={assembly}
          snapEnabled={snapEnabled}
          ghostRotation={ghostRotation}
          onPasteParts={onPasteParts}
        />
      )}
    </>
  );
}

export function ViewportCanvas(props: ViewportProps) {
  const [computingCollisions, setComputingCollisions] = useState(false);
  const [collidingPartIds, setCollidingPartIds] = useState<Set<string>>(new Set());
  // Three points of view on a junction: the position being picked, or a selected
  // connector — which is what a suggestion becomes once placed, so the views stay up
  // across that step instead of blinking out at the moment of interest.
  const junctionCell = useMemo(() => {
    if (props.selectedPoint) return targetCellOf(props.selectedPoint);
    if (props.selectedPartIds.size !== 1) return null;
    const id = [...props.selectedPartIds][0];
    const part = props.parts.find((p) => p.instanceId === id);
    if (!part) return null;
    const isConnector = getPartDefinition(part.definitionId)?.category === "connector";
    return isConnector ? ([...part.position] as GridPosition) : null;
  }, [props.selectedPoint, props.selectedPartIds, props.parts]);

  const [light, setLight] = useState<LightSettings>(loadLightSettings);
  const [lightPanelOpen, setLightPanelOpen] = useState(false);

  useEffect(() => {
    saveLightSettings(light);
  }, [light]);

  const [mirrorMinimap, setMirrorMinimap] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MIRROR_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(MIRROR_STORAGE_KEY, mirrorMinimap ? "1" : "0");
    } catch {
      // Ignore storage errors
    }
  }, [mirrorMinimap]);

  const [isOrthographic, setIsOrthographic] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CAMERA_MODE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const cameraSwitchSnapshotRef = useRef<CameraSwitchSnapshot | null>(null);

  const [ghostRotation, setGhostRotation] = useState<Rotation3>([0, 0, 0]);
  const [ghostOrientation, setGhostOrientation] = useState<Axis>("y");
  const ghostStateRef = useRef<GhostState>({
    position: [0, 0, 0],
    orientation: "y",
    rotation: [0, 0, 0],
    isSnapped: false,
  });

  // Paste state
  const pasteStateRef = useRef<PasteGhostState>({
    position: [0, 0, 0],
    orientation: "y",
    rotation: [0, 0, 0],
    isSnapped: false,
  });

  // Drag state
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dropTargetRef = useRef<{
    position: GridPosition;
    orientation?: Axis;
    rotation?: Rotation3;
  }>({
    position: [0, 0, 0],
  });
  /** Right button during a part drag: height instead of footprint */
  const verticalDragRef = useRef({ active: false, used: false, y: 0 });

  /** Where the current press started, for telling clicks from camera drags */
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);

  /** Part under the cursor, so its length can be read without selecting it */
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);

  const pendingDragRef = useRef<{
    instanceId: string;
    startX: number;
    startY: number;
    gridPoint?: GridPosition;
    /** Pressed with the right button: this drag moves the part in height */
    vertical?: boolean;
  } | null>(null);

  const [drawDrag, setDrawDrag] = useState<{ start: GridPosition; current: GridPosition } | null>(null);
  const drawDragRef = useRef(drawDrag);
  drawDragRef.current = drawDrag;
  const [resizePreview, setResizePreview] = useState<ResizePreview | null>(null);

  const handleDrawPointerDown = useCallback((grid: GridPosition) => {
    setDrawDrag({ start: grid, current: grid });
  }, []);

  const handleDrawPointerMove = useCallback((grid: GridPosition) => {
    setDrawDrag((prev) => (prev ? { ...prev, current: grid } : null));
  }, []);

  const drawAxis: DrawAxis = props.mode.type === "draw" ? props.mode.axis : "horizontal";

  const handleDrawPointerUp = useCallback(() => {
    const drag = drawDragRef.current;
    if (!drag) return;
    drawDragRef.current = null;
    setDrawDrag(null);
    const { position, size } = computeDrawSpan(drag.start, drag.current, drawAxis);
    props.onDraw(position, size);
  }, [props.onDraw, drawAxis]);

  // Continue draw tracking even if the pointer leaves the ground mesh
  useEffect(() => {
    if (!drawDrag) return;
    const hit = new THREE.Vector3();
    const anchor = drawDrag.start;

    // Horizontal drags read off the ground. An upright drag needs a vertical plane
    // through the anchor cell, turned to face the camera so the height tracks the
    // cursor no matter which way the scene is orbited.
    // At the anchor cell's centre height, matching how the drag preview picks its
    // plane — reading the span off y=0 instead would skew it under perspective
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -gridToWorld(anchor)[1]);
    const uprightPlane = new THREE.Plane();
    const anchorWorld = new THREE.Vector3(...gridToWorld(anchor));

    const handleMove = (e: PointerEvent) => {
      const camera = (window as any).__camera as THREE.Camera | undefined;
      const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement | null;
      if (!camera || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);

      if (drawAxis === "vertical") {
        const normal = new THREE.Vector3();
        camera.getWorldDirection(normal);
        normal.y = 0;
        if (normal.lengthSq() < 1e-6) return; // looking straight down: no height to read
        normal.normalize();
        uprightPlane.setFromNormalAndCoplanarPoint(normal, anchorWorld);
        if (!raycaster.ray.intersectPlane(uprightPlane, hit)) return;
        const y = Math.max(anchor[1], Math.round((hit.y - BASE_UNIT / 2) / BASE_UNIT));
        setDrawDrag((prev) => (prev ? { ...prev, current: [anchor[0], y, anchor[2]] } : null));
        return;
      }

      if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;
      const grid = clampCellToWorkspace(snapToGrid(hit));
      grid[1] = anchor[1];
      setDrawDrag((prev) => (prev ? { ...prev, current: grid } : null));
    };
    const handleUp = () => {
      handleDrawPointerUp();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [drawDrag, handleDrawPointerUp, drawAxis]);

  // Clear draw drag when leaving draw mode
  useEffect(() => {
    if (props.mode.type !== "draw") setDrawDrag(null);
  }, [props.mode.type]);

  const selectedResizable = useMemo(() => {
    if (props.selectedPartIds.size !== 1) return null;
    const id = [...props.selectedPartIds][0];
    const part = props.parts.find((p) => p.instanceId === id);
    if (!part) return null;
    const envelope = resizeEnvelopeOf(part);
    return envelope ? { part, ...envelope } : null;
  }, [props.selectedPartIds, props.parts]);

  // Collision detection runs in the outer (DOM) React tree so state updates are visible
  useEffect(() => {
    if (!props.showCollisions || dragState) {
      setCollidingPartIds(new Set());
      return;
    }
    if (!props.fineMeshCollisions) {
      const timer = setTimeout(() => {
        setCollidingPartIds(detectCollidingPartIds(props.assembly));
      }, 100);
      return () => clearTimeout(timer);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setComputingCollisions(true);
      detectCollidingPartIdsMesh(props.assembly, controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setCollidingPartIds(result);
          setComputingCollisions(false);
        }
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setComputingCollisions(false);
    };
  }, [props.showCollisions, props.fineMeshCollisions, props.parts, dragState]);

  // Box-select (marquee) state
  const boxSelectRef = useRef<{ startX: number; startY: number } | null>(null);
  const [boxSelectRect, setBoxSelectRect] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  // Determine if we're placing a support (orientation cycling) vs connector (rotation)
  const placingId = props.mode.type === "place" ? props.mode.definitionId : null;
  const placingDef = placingId ? getPartDefinition(placingId) : null;
  const isPlacingSupport = placingDef?.category === "support";

  // Y-axis lift (W/S keys) — additive on top of auto ground lift
  const [yLift, setYLift] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(CAMERA_MODE_STORAGE_KEY, isOrthographic ? "1" : "0");
    } catch {
      // Ignore storage errors
    }
  }, [isOrthographic]);

  const handleToggleCameraMode = useCallback(() => {
    const camera = (window as any).__camera as THREE.Camera | undefined;
    const orbitControls = (window as any).__controls as { target?: THREE.Vector3 } | undefined;

    if (camera && orbitControls?.target) {
      const distance = camera.position.distanceTo(orbitControls.target);
      let fov: number | undefined;
      let frustumHeight: number | undefined;
      let zoom: number | undefined;

      if (camera instanceof THREE.PerspectiveCamera) {
        fov = camera.fov;
        frustumHeight = 2 * Math.max(distance, 1) * Math.tan((camera.fov * Math.PI) / 360);
      } else if (camera instanceof THREE.OrthographicCamera) {
        // Effective visible height must account for orthographic zoom.
        frustumHeight = (camera.top - camera.bottom) / Math.max(camera.zoom, 0.0001);
        zoom = camera.zoom;
      }

      cameraSwitchSnapshotRef.current = {
        position: camera.position.clone(),
        quaternion: camera.quaternion.clone(),
        target: orbitControls.target.clone(),
        fov,
        frustumHeight,
        zoom,
      };
    }

    setIsOrthographic((prev) => !prev);
  }, []);

  // Reset rotation, orientation, and lift when switching parts
  useEffect(() => {
    setGhostRotation([0, 0, 0]);
    setGhostOrientation("y");
    setYLift(0);
  }, [placingId]);

  const rotateAxis = useCallback((axis: 0 | 1 | 2) => {
    setGhostRotation((prev) => {
      const next: Rotation3 = [...prev];
      next[axis] = nextStep(next[axis]);
      return next;
    });
  }, []);

  // Handle pointer down on a part — records pending drag start
  const handlePartPointerDown = useCallback(
    (instanceId: string, nativeEvent: PointerEvent, hit?: THREE.Vector3) => {
      if (props.mode.type !== "select") return;
      // Left drags the footprint, right drags the height; middle is left to panning
      if (nativeEvent.button !== 0 && nativeEvent.button !== 2) return;
      pendingDragRef.current = {
        instanceId,
        startX: nativeEvent.clientX,
        startY: nativeEvent.clientY,
        // Kept so a click on an already-selected part can resolve which spot was hit
        gridPoint: hit ? snapToGrid(hit) : undefined,
        vertical: nativeEvent.button === 2,
      };
    },
    [props.mode],
  );

  // Window-level pointer move/up for drag detection and box-select
  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      // While a part is dragged the left button is already down, so the right button
      // never arrives as its own pointerdown — only as a chorded move. Reading
      // `buttons` here is what makes holding it detectable at all.
      if (dragState) {
        const held = (e.buttons & 2) !== 0;
        verticalDragRef.current.active = held;
        if (held) verticalDragRef.current.used = true;
      }

      // Box-select tracking
      const boxStart = boxSelectRef.current;
      if (boxStart) {
        const dx = e.clientX - boxStart.startX;
        const dy = e.clientY - boxStart.startY;
        if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
          setBoxSelectRect({
            x1: boxStart.startX,
            y1: boxStart.startY,
            x2: e.clientX,
            y2: e.clientY,
          });
        }
        return;
      }

      // Part drag tracking
      const pending = pendingDragRef.current;
      if (!pending) return;
      if (dragState) return; // Already dragging

      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
        const part = props.assembly.getPartById(pending.instanceId);
        if (part) {
          // Preserve current Y elevation: yLift = currentY - autoGroundLift
          const def = getPartDefinition(part.definitionId);
          const groundLift = def ? computeGroundLift(def, part.rotation, part.orientation ?? "y") : 0;
          setYLift(Math.max(0, part.position[1] - groundLift));
          // A right-initiated drag is vertical from its very first frame
          verticalDragRef.current = {
            active: !!pending.vertical,
            used: !!pending.vertical,
            y: part.position[1],
          };
          setDragState({
            instanceId: part.instanceId,
            definitionId: part.definitionId,
            originalPosition: part.position,
            rotation: part.rotation,
            orientation: part.orientation,
          });
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      // Box-select finalize
      if (boxSelectRef.current) {
        if (boxSelectRect) {
          // Project each part to screen space and check if inside the rect
          const camera = (window as any).__camera as THREE.Camera | undefined;
          const canvas = document.querySelector(".viewport canvas") as HTMLCanvasElement | null;
          if (camera && canvas) {
            const rect = canvas.getBoundingClientRect();
            const minX = Math.min(boxSelectRect.x1, boxSelectRect.x2);
            const maxX = Math.max(boxSelectRect.x1, boxSelectRect.x2);
            const minY = Math.min(boxSelectRect.y1, boxSelectRect.y2);
            const maxY = Math.max(boxSelectRect.y1, boxSelectRect.y2);

            const matched: string[] = [];
            for (const part of props.parts) {
              const worldPos = new THREE.Vector3(
                part.position[0] * BASE_UNIT,
                part.position[1] * BASE_UNIT + BASE_UNIT / 2,
                part.position[2] * BASE_UNIT,
              );
              worldPos.project(camera);
              const sx = (worldPos.x * 0.5 + 0.5) * rect.width + rect.left;
              const sy = (-worldPos.y * 0.5 + 0.5) * rect.height + rect.top;
              if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
                matched.push(part.instanceId);
              }
            }
            if (matched.length > 0) {
              props.onBoxSelect(matched);
            }
          }
        }
        boxSelectRef.current = null;
        setBoxSelectRect(null);
        return;
      }

      // Part drag/click finalize
      const pending = pendingDragRef.current;
      if (!pending) return;

      if (dragState) {
        const target = dropTargetRef.current;
        // If dragging a part from a multi-selection, move all selected parts by the same delta
        if (props.selectedPartIds.size > 1 && props.selectedPartIds.has(dragState.instanceId)) {
          props.onMoveSelectedParts(dragState.instanceId, target.position, target.rotation, target.orientation);
        } else {
          props.onMovePart(dragState.instanceId, target.position, target.rotation, target.orientation);
        }
        setDragState(null);
      } else {
        props.onClickPart(pending.instanceId, e.shiftKey, pending.gridPoint);
      }
      pendingDragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, boxSelectRect, props.parts, props.assembly, props.onMovePart, props.onClickPart, props.onBoxSelect]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture keystrokes when an input/textarea is focused (e.g. color hex input)
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") {
        // The panel owns Escape while it is open
        if (lightPanelOpen) {
          setLightPanelOpen(false);
          return;
        }
        cancelCurrentAction();
      } else if ((e.key === "Delete" || e.key === "Backspace") && props.selectedPartIds.size > 0) {
        props.onDeleteSelected();
      } else if (dragState) {
        const rotateDrag = (axis: 0 | 1 | 2) => {
          const next: Rotation3 = [...dragState.rotation];
          next[axis] = nextStep(next[axis]);
          setDragState({ ...dragState, rotation: next });
        };
        switch (e.key.toLowerCase()) {
          case "r":
            rotateDrag(1);
            break;
          case "f":
            rotateDrag(2);
            break;
          case "t":
            rotateDrag(0);
            break;
          case "o": {
            const def = getPartDefinition(dragState.definitionId);
            if (def?.category === "support") {
              const newOrient = nextOrientation(dragState.orientation ?? "y");
              setDragState({ ...dragState, orientation: newOrient });
            }
            break;
          }
          case "w":
            setYLift((prev) => prev + 1);
            break;
          case "s":
            setYLift((prev) => Math.max(0, prev - 1));
            break;
        }
      } else if (props.mode.type === "select" && props.selectedPartIds.size > 0) {
        // Arrow key nudge, W/S lift, and R/T/F/O rotation for selected parts
        const fine = e.shiftKey ? 0.05 : 1;
        switch (e.key) {
          case "ArrowLeft":
            e.preventDefault();
            props.onNudgeParts(-fine, 0, 0);
            break;
          case "ArrowRight":
            e.preventDefault();
            props.onNudgeParts(fine, 0, 0);
            break;
          case "ArrowUp":
            e.preventDefault();
            props.onNudgeParts(0, 0, -fine);
            break;
          case "ArrowDown":
            e.preventDefault();
            props.onNudgeParts(0, 0, fine);
            break;
          case "w":
          case "W":
            props.onNudgeParts(0, fine, 0);
            break;
          case "s":
          case "S":
            props.onNudgeParts(0, -fine, 0);
            break;
          case "r":
          case "R":
            props.onRotateSelectedParts(1);
            break;
          case "t":
          case "T":
            props.onRotateSelectedParts(0);
            break;
          case "f":
          case "F":
            props.onRotateSelectedParts(2);
            break;
          case "o":
          case "O":
            props.onOrientSelectedParts();
            break;
        }
      } else if (props.mode.type === "place" || props.mode.type === "paste") {
        switch (e.key.toLowerCase()) {
          case "r":
            rotateAxis(1);
            break;
          case "f":
            rotateAxis(2);
            break;
          case "t":
            rotateAxis(0);
            break;
          case "o":
            if (isPlacingSupport) {
              setGhostOrientation((prev) => nextOrientation(prev));
            }
            break;
          case "w":
            setYLift((prev) => prev + 1);
            break;
          case "s":
            setYLift((prev) => Math.max(0, prev - 1));
            break;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    props.onEscape,
    props.onDeleteSelected,
    props.onNudgeParts,
    props.onRotateSelectedParts,
    props.onOrientSelectedParts,
    props.selectedPartIds,
    props.mode,
    isPlacingSupport,
    rotateAxis,
    dragState,
    lightPanelOpen,
  ]);

  // Shared by the Escape key and the right-click gesture
  const cancelCurrentAction = useCallback(() => {
    if (dragState) {
      setDragState(null);
      pendingDragRef.current = null;
      return;
    }
    drawDragRef.current = null;
    setDrawDrag(null);
    props.onEscape();
  }, [dragState, props.onEscape]);

  // Right-press origin, used to tell a cancelling right-click from a right-drag pan
  const rightPressRef = useRef<{ x: number; y: number } | null>(null);

  // Start box-select on shift+pointerdown on empty space
  const handleViewportPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Remembered for every press: the scene needs it to tell a click from the tail
      // end of a camera drag, which the browser reports as a click all the same
      pressOriginRef.current = { x: e.clientX, y: e.clientY };
      if (e.button === 2) {
        // A right press that landed on a part starts a height drag, so it must not
        // also register as the click that cancels or deselects
        rightPressRef.current = pendingDragRef.current ? null : { x: e.clientX, y: e.clientY };
        return;
      }
      if (props.mode.type !== "select") return;
      if (!e.shiftKey) return;
      // If a part was clicked, pendingDragRef is already set — don't start box select
      if (pendingDragRef.current) return;
      boxSelectRef.current = { startX: e.clientX, startY: e.clientY };
    },
    [props.mode],
  );

  // A stationary right-click acts as Escape; a right-drag still pans the camera
  const handleViewportPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const press = rightPressRef.current;
      rightPressRef.current = null;
      if (e.button !== 2 || !press) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_THRESHOLD) return;
      cancelCurrentAction();
    },
    [cancelCurrentAction],
  );

  // The viewport owns the right button, so the native menu never applies here
  const handleViewportContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Hint text
  let hintText: string | null = null;
  if (dragState) {
    const dragDef = getPartDefinition(dragState.definitionId);
    hintText =
      dragDef?.category === "support"
        ? "T(X) R(Y) F(Z) rotate · O orientation · W/S raise/lower · Release to place · Right-click or Esc cancel"
        : "T(X) R(Y) F(Z) rotate · W/S raise/lower · Release to place · Right-click or Esc cancel";
  } else if (props.mode.type === "place") {
    hintText = isPlacingSupport
      ? "Click to place · T(X) R(Y) F(Z) rotate · O orientation · W/S raise/lower · Right-click or Esc cancel"
      : "Click to place · T(X) R(Y) F(Z) rotate · W/S raise/lower · Right-click or Esc cancel";
  } else if (props.mode.type === "draw") {
    hintText =
      props.mode.axis === "vertical"
        ? "Click a cell and drag up to stand a support · Right-click or Esc cancel"
        : "Drag across the ground to lay down a support · Right-click or Esc cancel";
  } else if (props.mode.type === "select" && props.selectedPartIds.size > 0) {
    hintText = selectedResizable
      ? "Drag face handles to resize · Suggested parts appear on the right · Del delete · Right-click or Esc deselect"
      : "Arrow keys nudge · Shift+arrow fine nudge · w/s up and down - ctrl-c/v copy/paste - Del delete · Right-click or Esc deselect";
  } else if (props.mode.type === "paste") {
    hintText = `Click to paste ${props.mode.clipboard.parts.length} part(s) · T(X) R(Y) F(Z) rotate · Esc cancel`;
  }

  return (
    <div
      className="viewport"
      data-placing={props.mode.type === "place" ? props.mode.definitionId : undefined}
      data-drawing={props.mode.type === "draw" ? "true" : undefined}
      onPointerDown={handleViewportPointerDown}
      onPointerUp={handleViewportPointerUp}
      onContextMenu={handleViewportContextMenu}
    >
      <Canvas shadows gl={{ antialias: true }} scene={{ background: new THREE.Color("#3d3d5c") }}>
        {isOrthographic ? (
          <OrthographicCamera makeDefault position={[150, 200, 150]} near={-20000} far={20000} zoom={1} />
        ) : (
          <PerspectiveCamera makeDefault position={[150, 200, 150]} fov={50} near={1} far={10000} />
        )}
        <ApplyCameraSwitchSnapshot isOrthographic={isOrthographic} snapshotRef={cameraSwitchSnapshotRef} />
        <Scene
          {...props}
          ghostRotation={ghostRotation}
          ghostOrientation={ghostOrientation}
          ghostStateRef={ghostStateRef}
          pasteStateRef={pasteStateRef}
          dragState={dragState}
          dropTargetRef={dropTargetRef}
          onPartPointerDown={handlePartPointerDown}
          verticalDragRef={verticalDragRef}
          pressOriginRef={pressOriginRef}
          hoveredPartId={hoveredPartId}
          onHoverPart={setHoveredPartId}
          light={light}
          yLift={yLift}
          boxSelectActive={!!boxSelectRect}
          collidingPartIds={collidingPartIds}
          drawDrag={drawDrag}
          onDrawPointerDown={handleDrawPointerDown}
          onDrawPointerMove={handleDrawPointerMove}
          onDrawPointerUp={handleDrawPointerUp}
          resizePreview={resizePreview}
          onResizePreview={setResizePreview}
          selectedResizable={selectedResizable}
        />
        {(mirrorMinimap || junctionCell) && <ViewportInsets mirror={mirrorMinimap} junction={junctionCell} />}
      </Canvas>
      {mirrorMinimap &&
        (() => {
          const rect = mirrorRect();
          return (
            <div className="viewport-inset" style={insetStyle(rect)} aria-hidden="true">
              <span className="viewport-inset__label">Mirror y=0</span>
            </div>
          );
        })()}
      {junctionCell &&
        JUNCTION_VIEWS.map((view, index) => (
          <div key={view.key} className="viewport-inset" style={insetStyle(junctionRect(index))} aria-hidden="true">
            <span className="viewport-inset__label">{view.label}</span>
          </div>
        ))}
      <button
        className={`viewport-shadow-toggle${light.shadows ? " viewport-mirror-toggle--on" : ""}`}
        type="button"
        onClick={() => setLightPanelOpen(true)}
        title="Lighting and shadow settings"
      >
        Shadows
      </button>
      {lightPanelOpen && (
        <ShadowSettings settings={light} onChange={setLight} onClose={() => setLightPanelOpen(false)} />
      )}
      <button
        className={`viewport-mirror-toggle${mirrorMinimap ? " viewport-mirror-toggle--on" : ""}`}
        type="button"
        onClick={() => setMirrorMinimap((v) => !v)}
        title="Minimap showing the camera mirrored through the ground plane — the underside"
      >
        Mirror
      </button>
      <button
        className={`viewport-camera-toggle ${isOrthographic ? "viewport-camera-toggle--ortho" : "viewport-camera-toggle--persp"}`}
        type="button"
        onClick={handleToggleCameraMode}
        title="Toggle perspective/orthographic camera"
      >
        <span className="viewport-camera-toggle__thumb">{isOrthographic ? <OrthoIcon /> : <PerspIcon />}</span>
        <span className="viewport-camera-toggle__label">{isOrthographic ? "ORTHO" : "PERSP"}</span>
      </button>
      {boxSelectRect && (
        <div
          className="box-select-overlay"
          style={{
            left: Math.min(boxSelectRect.x1, boxSelectRect.x2),
            top: Math.min(boxSelectRect.y1, boxSelectRect.y2),
            width: Math.abs(boxSelectRect.x2 - boxSelectRect.x1),
            height: Math.abs(boxSelectRect.y2 - boxSelectRect.y1),
          }}
        />
      )}
      {hintText && <div className="viewport-hint">{hintText}</div>}
      {computingCollisions && <div className="collision-computing-indicator">Computing collisions...</div>}
    </div>
  );
}
