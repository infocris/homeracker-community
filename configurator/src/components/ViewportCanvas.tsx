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
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as THREE from "three";
import { BASE_UNIT, PART_COLORS, GRID_EXTENT } from "../constants";
import type {
  PlacedPart,
  Direction,
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
import { AssemblyState, gridKeysForCell } from "../assembly/AssemblyState";
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
import { KeyBindingsPanel } from "./KeyBindingsPanel";
import { MouseGlyph, nameForButtons, useHeldButtons } from "./MouseGlyph";
import { buttonsLabel, gestureLogIsOn, logGesture, setGestureLogOn, subscribeGestureLog } from "../debug/gesture-log";
import type { ActionId } from "../input/actions";
import { actionOf, bindings, comboLabel, keyLabel, subscribeBindings } from "../input/keybindings";
import {
  type AttachmentPoint,
  type ConnectorAdaptation,
  type FreeSpot,
  adaptiveConnectorsFor,
  hookupAxisAt,
  supportHookupIsSound,
  targetCellOf,
} from "../assembly/compatibility";
import { settleWithGravity, restOnCollision, placementIsGrounded } from "../assembly/gravity";
import {
  WORKSPACE_LIMITS,
  getWorkspace,
  setWorkspace,
  subscribeWorkspace,
  type WorkspaceSize,
} from "../assembly/workspace";
import { WorkspaceSettings } from "./WorkspaceSettings";

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
  /**
   * `held` is a draw begun on a connector's own free side: the bar is plugged into
   * that arm, so gravity has no say over where it ends up.
   */
  onDraw: (position: GridPosition, size: [number, number, number], held?: boolean) => void;
  onResizePart: (instanceId: string, position: GridPosition, size: [number, number, number]) => void;
  onMovePart: (
    instanceId: string,
    newPosition: GridPosition,
    rotation?: Rotation3,
    orientation?: Axis,
    /** Connectors to swap in the same breath, so one gesture is one undo */
    adaptations?: ConnectorAdaptation[],
  ) => void;
  onMoveSelectedParts: (primaryId: string, newPosition: GridPosition, rotation?: Rotation3, orientation?: Axis) => void;
  /** `solo` asks for the one part hit rather than the group it belongs to */
  onClickPart: (instanceId: string, shiftKey: boolean, gridPoint?: GridPosition, solo?: boolean) => void;
  /** Middle-clicked: a copy of it goes on the cursor */
  onDuplicatePart: (instanceId: string) => void;
  /** The cell the coming turn pivots about, so the rings show what will happen */
  rotationPivot: GridPosition | null;
  /** Parts held in place — selectable and clickable, but not draggable */
  lockedPartIds: Set<string>;
  onLockedPartDrag: () => void;
  /** Attachment point picked by re-clicking the selected part, highlighted in the scene */
  selectedPoint: AttachmentPoint | null;
  /** Suggestion under the cursor in the sidebar, previewed in place */
  previewSuggestion: {
    definitionId: string;
    position: GridPosition;
    rotation: Rotation3;
    orientation?: Axis;
    replaces?: string;
  } | null;
  /** The sides of the selected connector with nothing on them yet */
  freeSpots: { instanceId: string; cell: GridPosition; spots: FreeSpot[] } | null;
  /** Trade the selected connector for one reaching the way a handle points */
  onGrowConnector: (instanceId: string, definitionId: string, rotation: Rotation3) => void;
  /** Ghost a connector where it would stand, or clear the ghost with null */
  onPreviewConnector: (
    preview: { definitionId: string; position: GridPosition; rotation: Rotation3; replaces?: string } | null,
  ) => void;
  onClickEmpty: () => void;
  onDeleteSelected: () => void;
  onPasteParts: (clipboard: ClipboardData, targetPosition: GridPosition, extraRotation?: Rotation3) => void;
  onBoxSelect: (ids: string[]) => void;
  onNudgeParts: (dx: number, dy: number, dz: number) => void;
  onRotateSelectedParts: (axis: 0 | 1 | 2, turns?: 1 | 3) => void;
  onOrientSelectedParts: () => void;
  onEscape: () => void;
  flashPartId: string | null;
  flashDefinitionId: string | null;
  snapEnabled: boolean;
  gravityEnabled: boolean;
  adaptiveEnabled: boolean;
  showCollisions: boolean;
  fineMeshCollisions: boolean;
}

/** Compute the 1×1×N span on the ground from drag start/end cells. */
export function computeDrawSpan(
  start: GridPosition,
  end: GridPosition,
  axis: DrawAxis = "horizontal",
  /**
   * The way the bar runs, when the draw began somewhere that settles it — a
   * connector's free side faces one way and one way only, and a bar laid across that
   * side rather than along it is not a hookup the assembly would accept.
   */
  direction?: Direction,
): { position: GridPosition; size: [number, number, number] } {
  // The cell the drag started on stays anchored, so capping the length shortens the
  // far end rather than sliding the whole bar away from where the drag began.
  if (direction) {
    const step = DIRECTION_STEP[direction];
    const i = step[0] !== 0 ? 0 : step[1] !== 0 ? 1 : 2;
    const sign = step[i];
    // How far the pointer has gone the way the bar runs; going back the other way
    // leaves the single cell the draw started in
    const n = Math.min(Math.max(1, (end[i] - start[i]) * sign + 1), MAX_SUPPORT_LENGTH);
    const position: GridPosition = [...start];
    if (sign < 0) position[i] = start[i] - (n - 1);
    const size: [number, number, number] = [1, 1, 1];
    size[i] = n;
    return { position, size };
  }

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
const CONNECTORS_STORAGE_KEY = "homeracker-show-connectors";
const ROTATION_GUIDES_STORAGE_KEY = "homeracker-rotation-guides";
const MIRROR_STORAGE_KEY = "homeracker-mirror-minimap";

/** Half-width the shadow camera and the shadow catcher have to span */
/** How far the shadow camera and the floor reach, for a buildable area of this size */
function shadowExtentFor(extent: number) {
  return extent * BASE_UNIT + BASE_UNIT;
}

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
  { key: "back", label: "Back", direction: [0, 0.4, -1] },
  { key: "top", label: "Top", direction: [0.001, 1, 0.001] },
  // Straight up from under the floor. Nothing hides it: the floor plane is
  // single-sided and faces up, so it is culled when looked at from below.
  { key: "bottom", label: "Bottom", direction: [0.001, -1, 0.001] },
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

/** How much of a part is left showing when it stands in the way of the junction. */
const FADED_OPACITY = 0.2;

/** Walks up to the part a mesh belongs to, or null for the grid, ghosts and markers. */
function ownerPartOf(object: THREE.Object3D): string | null {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    const id = node.userData?.partInstanceId;
    if (typeof id === "string") return id;
  }
  return null;
}

/** The nearest hit on a placed part, or null when the ray only met the scenery. */
function firstPartHit(intersections: THREE.Intersection[]): THREE.Intersection | null {
  for (const hit of intersections) {
    if (ownerPartOf(hit.object)) return hit;
  }
  return null;
}

/**
 * The empty cell beside a hit on a part: half a cell out along the face that was hit.
 *
 * A press on a surface means the cell in front of it, not the cell behind it, and a
 * point lying exactly on a face boundary rounds either way — which is what makes the
 * step out necessary rather than merely tidy.
 */
function cellBesideHit(hit: THREE.Intersection): GridPosition | null {
  if (!hit.face) return null;
  const outward = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  return snapToGrid(hit.point.clone().addScaledVector(outward, BASE_UNIT * 0.5));
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
function ViewportInsets({
  mirror,
  junction,
  junctionParts,
}: {
  mirror: boolean;
  junction: GridPosition | null;
  /** Parts standing on the junction cell — the ones the close-ups are about */
  junctionParts: Set<string>;
}) {
  const { gl, scene, camera, size, controls } = useThree();
  const insetCamera = useMemo(() => new THREE.PerspectiveCamera(50, 1, 1, 10000), []);
  const target = useMemo(() => new THREE.Vector3(), []);

  /*
   * The close-ups look at a cell buried inside the assembly, so whatever is in the
   * way is turned translucent for those passes only — swapped in after the main view
   * is drawn and swapped back before the frame ends.
   *
   * The clones are kept per source material rather than mutating it: a material is
   * shared between every part that uses it, and the selected connector is often one
   * of them. Swapping `mesh.material` is per mesh, so it cannot leak sideways.
   */
  const fadedMaterials = useMemo(() => new WeakMap<THREE.Material, THREE.Material>(), []);
  const swapped = useMemo<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[]>(() => [], []);

  const fadedVersionOf = (material: THREE.Material): THREE.Material => {
    let faded = fadedMaterials.get(material);
    if (!faded) {
      faded = material.clone();
      faded.transparent = true;
      faded.opacity = FADED_OPACITY;
      // Out of the depth buffer, so the junction shows through whatever is nearer
      faded.depthWrite = false;
      fadedMaterials.set(material, faded);
    }
    return faded;
  };

  const fadeSurroundings = () => {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const owner = ownerPartOf(mesh);
      if (!owner || junctionParts.has(owner)) return;
      swapped.push({ mesh, material: mesh.material });
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fadedVersionOf) : fadedVersionOf(mesh.material);
    });
  };

  const restoreSurroundings = () => {
    for (const entry of swapped) entry.mesh.material = entry.material;
    swapped.length = 0;
  };

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
      fadeSurroundings();
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
      restoreSurroundings();
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
  isFaded,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  isColliding: boolean;
  /** Standing between the camera and the selection: ghosted, and out of the way of clicks */
  isFaded: boolean;
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
        isFaded={isFaded}
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
        isFaded={isFaded}
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
  orientation,
  solid,
}: {
  definitionId: string;
  position: GridPosition;
  rotation: Rotation3;
  /** A bar lies along an axis; without this it would be ghosted standing up */
  orientation?: Axis;
  /**
   * Show the part as it would be built rather than as a ghost.
   *
   * For a swap that is the truthful preview: the connector standing there steps aside
   * for this one, and something *is* on that cell either way — a see-through stand-in
   * made the junction look like it had gone missing. A ghost is for a part that is not
   * there yet.
   */
  solid?: boolean;
}) {
  return (
    <group position={gridToWorld(position)}>
      <Suspense fallback={<GhostFallback definitionId={definitionId} orientation={orientation} isSnapped />}>
        <GhostModel definitionId={definitionId} rotation={rotation} orientation={orientation} isSnapped solid={solid} />
      </Suspense>
    </group>
  );
}

/** Colour per axis on the rotation rings: the same three the app uses for x, y, z. */
/** Colour by the key, not the axis: a ring badged X is red wherever the camera stands. */
const KEY_COLOR: Record<"X" | "Y" | "Z", string> = { X: "#ff5a5a", Y: "#5aff8f", Z: "#5a9dff" };
/** The plane each ring draws, named by the axes that span it. */
const AXIS_RING_PLANE = ["yz", "xz", "xy"];

/** One cell step per direction, for placing a handle just outside the connector. */
const DIRECTION_STEP: Record<Direction, [number, number, number]> = {
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
  "+y": [0, 1, 0],
  "-y": [0, -1, 0],
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
};

/**
 * A handle on every side of the selected connector that is not already serving a bar.
 *
 * The two things you can do from a free side are the two the handle offers: trade the
 * connector for one that reaches that way — a plus, since that is a junction gaining a
 * branch — or draw a bar from there by dragging, which is the same gesture the draw
 * tool uses and lands on the same resolver.
 *
 * A side whose arm is already there has nothing to trade for, so its handle only draws.
 */
function FreeSpotHandles({
  cell,
  spots,
  onGrow,
  onPreview,
  onDrawFrom,
  onCancelDraw,
}: {
  cell: GridPosition;
  spots: FreeSpot[];
  onGrow: (spot: FreeSpot) => void;
  onPreview: (spot: FreeSpot | null) => void;
  onDrawFrom: (spot: FreeSpot) => void;
  onCancelDraw: () => void;
}) {
  /*
   * A press on a handle is not yet either gesture. The draw starts at once — it has to,
   * or the first stretch of the drag would be lost while it waited to be sure — and a
   * release that never travelled cancels it and trades the connector instead.
   */
  const press = useRef<{ x: number; y: number; spot: FreeSpot } | null>(null);

  return (
    <group position={gridToWorld(cell)}>
      {spots.map((spot) => {
        const step = DIRECTION_STEP[spot.direction];
        const grows = !!spot.grow;
        return (
          <Html
            key={spot.direction}
            position={step.map((u) => u * BASE_UNIT * 0.85) as [number, number, number]}
            center
            zIndexRange={[16, 10]}
            style={{ pointerEvents: "none" }}
          >
            <button
              type="button"
              className={`free-spot${grows ? " free-spot-grows" : ""}`}
              style={{ pointerEvents: "auto" }}
              title={
                grows
                  ? `Click to trade this connector for ${spot.grow?.def.name}, reaching ${spot.direction} as well — or drag to draw a bar`
                  : `Drag to draw a bar ${spot.direction} from this arm`
              }
              // R3F listens on an ancestor of this overlay: an unstopped event would
              // also be raycast into the scene and pick whatever stands behind
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button !== 0) return;
                press.current = { x: e.clientX, y: e.clientY, spot };
                // The pointer leaves this 22px button almost at once; captured, the
                // release still arrives here, which is where the two gestures part
                e.currentTarget.setPointerCapture(e.pointerId);
                onPreview(null);
                onDrawFrom(spot);
              }}
              onPointerUp={(e) => {
                const held = press.current;
                press.current = null;
                if (!held) return;
                if (Math.hypot(e.clientX - held.x, e.clientY - held.y) >= DRAG_THRESHOLD) return;
                /*
                 * Never travelled: this was a click. Stopping the event here is what
                 * keeps the draw's own listener on the window from committing the
                 * one-cell bar the press had begun.
                 */
                e.stopPropagation();
                onCancelDraw();
                if (held.spot.grow) onGrow(held.spot);
              }}
              onPointerEnter={() => onPreview(spot)}
              onPointerLeave={() => onPreview(null)}
            >
              {grows ? "+" : "\u00b7"}
            </button>
          </Html>
        );
      })}
    </group>
  );
}

/**
 * Which axis each rotation key turns about, from where the camera stands.
 *
 * X is the plane parallel to the ground, which needs no point of view — it is the same
 * plane from anywhere. The two upright planes are another matter: which one is "the"
 * vertical turn depends entirely on where you are standing, so Y is the one whose plane
 * faces the camera, turning the part the way a clock hand turns on the screen, and Z is
 * the one running away from it, tipping the part toward or away from you.
 */
function rotationAxesFromCamera(camera: THREE.Camera): { x: 0 | 1 | 2; y: 0 | 1 | 2; z: 0 | 1 | 2 } {
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  // Of the two ground axes, the one pointing more nearly along the line of sight is the
  // one a turn about it appears to happen in the plane of the screen
  const intoScreen = Math.abs(forward.x) >= Math.abs(forward.z) ? 0 : 2;
  return { x: 1, y: intoScreen as 0 | 2, z: (intoScreen === 0 ? 2 : 0) as 0 | 2 };
}

/**
 * Whether the app's own quarter turn about this axis reads as clockwise from where the
 * camera stands.
 *
 * Measured rather than derived from a handedness rule: the turn is applied through
 * rotateGridCells and the two points are projected, so the answer holds whatever
 * convention that function follows. The sign of the screen-space cross product between
 * the arm and the way its tip moves is the whole test — negative is clockwise, with
 * normalised device coordinates counting y upward.
 */
function quarterTurnIsClockwise(camera: THREE.Camera, centre: [number, number, number], axis: 0 | 1 | 2): boolean {
  const probe = KEY_BADGE_LATTICE[axis];
  const turned = rotateGridCells([probe], AXIS_QUARTER_TURN[axis])[0];
  const at = (v: GridPosition) =>
    new THREE.Vector3(centre[0] + v[0] * BASE_UNIT, centre[1] + v[1] * BASE_UNIT, centre[2] + v[2] * BASE_UNIT).project(
      camera,
    );
  const middle = new THREE.Vector3(centre[0], centre[1], centre[2]).project(camera);
  const from = at(probe);
  const to = at(turned);
  const arm = { x: from.x - middle.x, y: from.y - middle.y };
  const move = { x: to.x - from.x, y: to.y - from.y };
  return arm.x * move.y - arm.y * move.x < 0;
}

/** The key that drives the ring turning about this axis, for the camera as it stands. */
function keyForAxis(camera: THREE.Camera, axis: 0 | 1 | 2): "X" | "Y" | "Z" {
  const axes = rotationAxesFromCamera(camera);
  if (axis === axes.x) return "X";
  return axis === axes.y ? "Y" : "Z";
}

/** The screen axis each turn action asks for, named as the keys were */
const TURN_AXIS: Partial<Record<ActionId, "x" | "y" | "z">> = {
  "turn-x": "x",
  "turn-y": "y",
  "turn-z": "z",
};

/** The ground step each nudge action asks for, as arrowGroundSteps names them */
const NUDGE_STEP: Partial<Record<ActionId, string>> = {
  "nudge-right": "ArrowRight",
  "nudge-left": "ArrowLeft",
  "nudge-forward": "ArrowUp",
  "nudge-back": "ArrowDown",
};

type GroundStep = [number, number, number];

/**
 * What the four arrows mean on the ground, seen from where the camera stands.
 *
 * Fixed axes per key meant the same press walked a part left or right depending on
 * which side the camera happened to be on. The arrows should mean what they look like.
 *
 * The two pairs are decided together, not key by key. Scoring each key on its own looks
 * reasonable until the camera sits at 45°, where both axes score alike for "right" and
 * the tie can break one way for right and the other for left — leaving the two keys on
 * different axes, so pressing one then the other does not come back. Choosing the axis
 * once and taking its opposite for the other key cannot do that. Height stays on w/s,
 * which needs no such help.
 */
function arrowGroundSteps(camera: THREE.Camera, around: THREE.Vector3): Record<string, GroundStep> {
  const from = around.clone().project(camera);
  /** Screen movement of one cell along a ground axis, in NDC */
  const screenDelta = (step: GroundStep) => {
    const to = around
      .clone()
      .add(new THREE.Vector3(step[0] * BASE_UNIT, 0, step[2] * BASE_UNIT))
      .project(camera);
    return { x: to.x - from.x, y: to.y - from.y };
  };

  const alongX: GroundStep = [1, 0, 0];
  const alongZ: GroundStep = [0, 0, 1];
  const dx = screenDelta(alongX);
  const dz = screenDelta(alongZ);

  // Whichever axis runs more sideways on screen carries left and right
  const sideways = Math.abs(dx.x) >= Math.abs(dz.x) ? { axis: alongX, delta: dx } : { axis: alongZ, delta: dz };
  const away = sideways.axis === alongX ? { axis: alongZ, delta: dz } : { axis: alongX, delta: dx };

  const signed = (step: GroundStep, positive: boolean): GroundStep =>
    positive ? step : [-step[0], -step[1], -step[2]];

  const right = signed(sideways.axis, sideways.delta.x >= 0);
  const up = signed(away.axis, away.delta.y >= 0);

  return { ArrowRight: right, ArrowLeft: signed(right, false), ArrowUp: up, ArrowDown: signed(up, false) };
}

/** A cell and its six face neighbours: what counts as touching the selection. */
const TOUCHING_CELLS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const DIAGONAL = Math.SQRT1_2;

/**
 * Where each ring carries its shortcut, as a unit vector scaled by the radius. Each
 * sits at 45° in its own ring's plane, in a direction the other two rings do not pass
 * through, so the three badges stay apart whatever the camera does.
 */
const KEY_BADGE_AT: [number, number, number][] = [
  [0, DIAGONAL, DIAGONAL],
  [DIAGONAL, 0, DIAGONAL],
  [DIAGONAL, DIAGONAL, 0],
];

/**
 * The same three directions as lattice vectors, so the app's own rotateGridCells can
 * turn them exactly — which is how the on-screen direction of a turn is worked out
 * without a second, possibly disagreeing, notion of which way a quarter turn goes.
 */
const KEY_BADGE_LATTICE: GridPosition[] = [
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 0],
];

/** The elementary quarter turn about each axis, in the app's convention. */
const AXIS_QUARTER_TURN: Rotation3[] = [
  [90, 0, 0],
  [0, 90, 0],
  [0, 0, 90],
];

/**
 * Quarter-turn handles for a set of parts: one ring per axis, drawn around the middle
 * of what is selected.
 *
 * A ring is clicked rather than dragged. The grid only admits quarter turns, so a
 * sweep would land on the same four positions a click already reaches, and a click
 * cannot be mistaken for an attempt to orbit the camera. Shift turns the other way.
 */
function RotationHandles({
  centre,
  radii,
  onRotate,
}: {
  centre: [number, number, number];
  /** One radius per axis: how far the body reaches in that axis's plane of turn */
  radii: [number, number, number];
  onRotate: (axis: 0 | 1 | 2, turns: 1 | 3) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const camera = useThree((state) => state.camera);

  /*
   * Which key drives which ring depends on where the camera stands, so the badges have
   * to follow it round. Checked each frame but only written when the answer actually
   * changes, which happens when the camera crosses a diagonal and not otherwise.
   */
  const [keys, setKeys] = useState<("X" | "Y" | "Z")[]>(() => [0, 1, 2].map((a) => keyForAxis(camera, a as 0 | 1 | 2)));
  useFrame(() => {
    const next = [0, 1, 2].map((a) => keyForAxis(camera, a as 0 | 1 | 2)) as ("X" | "Y" | "Z")[];
    if (next.some((k, i) => k !== keys[i])) setKeys(next);
  });

  /*
   * What the badge says is the key that is actually bound to that turn, not the letter
   * the axis is named after: rebind the turn and the ring says so.
   */
  const bound = useSyncExternalStore(subscribeBindings, bindings);
  const badge = (axis: number) => {
    const combos = bound[`turn-${keys[axis].toLowerCase()}` as ActionId];
    return combos.length > 0 ? comboLabel(combos[0]) : "—";
  };
  // Perpendicular to the axis it turns about: the ring lies in the plane of the turn
  const lie: [number, number, number][] = [
    [0, Math.PI / 2, 0],
    [Math.PI / 2, 0, 0],
    [0, 0, 0],
  ];

  /**
   * Which way round the ring a single quarter turn carries this button, as seen from
   * where the camera stands: negative means it sweeps left across the screen.
   *
   * Read from the button's own position rather than the ring as a whole, because a
   * circle in perspective moves left at one end and right at the other — "left" only
   * means something at the point being clicked.
   */
  const screenSweep = (axis: 0 | 1 | 2): number => {
    const probe = KEY_BADGE_LATTICE[axis];
    const turned = rotateGridCells([probe], AXIS_QUARTER_TURN[axis])[0];
    const scale = radii[axis] / Math.hypot(probe[0], probe[1], probe[2]);
    const at = (v: GridPosition) =>
      new THREE.Vector3(centre[0] + v[0] * scale, centre[1] + v[1] * scale, centre[2] + v[2] * scale).project(camera);
    return at(turned).x - at(probe).x;
  };

  /** The turn whose sweep goes the way the pressed button asks for. */
  const turnsForButton = (axis: 0 | 1 | 2, button: number): 1 | 3 => {
    const forwardGoesLeft = screenSweep(axis) < 0;
    const wantLeft = button !== 2;
    return forwardGoesLeft === wantLeft ? 1 : 3;
  };

  return (
    <group position={centre}>
      {/* Rings are drawing, not controls: they show which plane each turn happens in
          and take no clicks, so nothing they pass in front of becomes unreachable. */}
      {[0, 1, 2].map((axis) => (
        <mesh key={axis} rotation={lie[axis]} raycast={() => {}}>
          <torusGeometry args={[radii[axis], BASE_UNIT * (hovered === axis ? 0.11 : 0.06), 8, 48]} />
          <meshBasicMaterial
            color={KEY_COLOR[keys[axis]]}
            transparent
            opacity={hovered === axis ? 0.95 : 0.4}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* The button for each plane, riding on its own ring. One per octant direction so
          the three never land on each other. */}
      {[0, 1, 2].map((axis) => (
        <Html
          key={axis}
          position={KEY_BADGE_AT[axis].map((u) => u * radii[axis]) as [number, number, number]}
          center
          zIndexRange={[16, 10]}
          style={{ pointerEvents: "none" }}
        >
          <button
            type="button"
            className="rotation-key"
            style={{
              color: KEY_COLOR[keys[axis]],
              opacity: hovered === null || hovered === axis ? 1 : 0.5,
              pointerEvents: "auto",
            }}
            title={`Quarter turn in the ${AXIS_RING_PLANE[axis]} plane (${badge(axis)}) — left sweeps one way, right the other`}
            /*
             * R3F listens on the canvas container, which is an ancestor of this
             * overlay, so an unstopped event would also be raycast into the scene and
             * pick whatever stands behind the button. The right button needs its own
             * care besides: unstopped it would reach the viewport, where a right press
             * means cancel, and bring up the browser menu on top of that.
             */
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              // Both buttons act here — onClick would only ever see the left one
              onRotate(axis as 0 | 1 | 2, turnsForButton(axis as 0 | 1 | 2, e.button));
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onPointerEnter={() => setHovered(axis)}
            onPointerLeave={() => setHovered(null)}
          >
            {badge(axis)}
          </button>
        </Html>
      ))}

      {hovered !== null && (
        <Html
          position={[0, Math.max(...radii) + BASE_UNIT * 0.75, 0]}
          center
          zIndexRange={[15, 10]}
          style={{ pointerEvents: "none" }}
        >
          <span className="dimension-label">
            {badge(hovered)} · quarter turn in the {AXIS_RING_PLANE[hovered]} plane
          </span>
        </Html>
      )}
    </group>
  );
}

/**
 * The working level, drawn only when it is off the ground.
 *
 * Out of the depth buffer and out of raycasting, like the floor: it is a place to
 * build on, not something to collide with or click.
 */
function WorkingLevel({ level, extent, opacity }: { level: number; extent: number; opacity: number }) {
  /* One line per cell across the buildable area, so the level can be read like the
     ground is — a bounded grid rather than a second endless one, which would have to
     fight the ground's for the depth buffer. */
  const lines = useMemo(() => {
    const half = extent * BASE_UNIT + BASE_UNIT / 2;
    const points: number[] = [];
    for (let i = -extent; i <= extent + 1; i++) {
      const at = i * BASE_UNIT - BASE_UNIT / 2;
      points.push(at, 0, -half, at, 0, half);
      points.push(-half, 0, at, half, 0, at);
    }
    return new Float32Array(points);
  }, [extent]);

  if (level <= 0) return null;
  const side = (extent * 2 + 1) * BASE_UNIT;
  const y = level * BASE_UNIT;
  return (
    <group position={[0, y, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={() => null} renderOrder={-1}>
        <planeGeometry args={[side, side]} />
        <meshBasicMaterial color={PART_COLORS.selected} transparent opacity={opacity} depthWrite={false} />
      </mesh>
      <lineSegments raycast={() => null} renderOrder={-1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[lines, 3]} />
        </bufferGeometry>
        {/* The lines stay readable when the surface is faint, and never outshine it */}
        <lineBasicMaterial
          color={PART_COLORS.selected}
          transparent
          opacity={Math.min(0.9, 0.25 + opacity)}
          depthWrite={false}
        />
      </lineSegments>
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
 * What the labelled part measures, and where it sits: its length, and — once it is off
 * the ground — how high its underside and its top face are.
 *
 * Both ends are given because both are what a shelf is measured by: the clearance
 * underneath for what goes below it, the top face for what stands on it. The counts in
 * cells match the ticks the height guides draw below the part, so the number and the
 * picture agree.
 *
 * Pinned to the part rather than the corner of the screen, so it is where the eye
 * already is. pointerEvents stays off: R3F raycasts through the container this sits
 * in, and a label that swallowed clicks would break selecting the part underneath.
 */
function DimensionLabel({ min, size }: { min: GridPosition; size: [number, number, number] }) {
  const cells = Math.max(size[0], size[1], size[2]);
  const centre = gridToWorld([min[0] + (size[0] - 1) / 2, min[1] + (size[1] - 1) / 2, min[2] + (size[2] - 1) / 2]);
  const reading = (units: number) => `${units}u · ${((units * BASE_UNIT) / 10).toFixed(1)} cm`;
  const base = min[1];
  return (
    <Html
      position={[centre[0], centre[1] + BASE_UNIT * 0.9, centre[2]]}
      center
      zIndexRange={[15, 10]}
      style={{ pointerEvents: "none" }}
    >
      <span className="dimension-label">
        {/* A single cell has no length worth stating; its height still does */}
        {cells > 1 && reading(cells)}
        {base > 0 && (
          <>
            <span className={cells > 1 ? "dimension-label-height" : undefined}>base {reading(base)}</span>
            <span className="dimension-label-height">top {reading(base + size[1])}</span>
          </>
        )}
      </span>
    </Html>
  );
}

/**
 * The levels where a flat part's plane meets the box being guided, one per part, so
 * the ground-parallel axes are drawn where there is something to read them against.
 *
 * A flat part lies in a plane; an upright one crosses planes rather than making one,
 * which is why only the flat ones are asked. Where the crossed part's own plane falls
 * outside the box — a shelf resting just under the box, or just on top of it — the
 * axis is drawn at the face they share, which is where the two are to be compared.
 */
function crossedPlanesOf(
  parts: PlacedPart[],
  min: GridPosition,
  size: [number, number, number],
  ignoreIds?: Set<string>,
): number[] {
  const top = min[1] + size[1];
  const levels = new Set<number>();
  for (const part of parts) {
    if (ignoreIds?.has(part.instanceId)) continue;
    const bounds = placedPartBounds(part);
    if (!bounds) continue;
    if (bounds.size[1] !== 1 || Math.max(bounds.size[0], bounds.size[2]) < 2) continue;
    const level = bounds.min[1];
    // Their heights have to touch at least: a shelf three levels below says nothing
    // about this part's placement that its own footprint does not already say
    if (level + 1 < min[1] || level > top) continue;
    levels.add(Math.min(Math.max(level, min[1]), top));
  }
  return [...levels].sort((a, b) => a - b);
}

/**
 * Guides for a part standing off the ground: its footprint below it, posts down to
 * that footprint, one tick per grid level so the height can be read by counting rather
 * than guessed from perspective, and — in each plane the part shares with a flat part
 * of the assembly — lines running out to the edge of the workspace.
 *
 * Those flat lines are the same idea as the posts, turned into the other two
 * dimensions: the posts say how high the part is above the ground, and the lines carry
 * its edges out across the assembly, so the part it passes at that height either meets
 * one or plainly does not. Nothing else in perspective tells you that. They follow the
 * parts crossed rather than the part's own underside, because a line in a plane where
 * nothing else stands has nothing to be read against.
 */
function HeightGuides({
  min,
  size,
  extent,
  parts,
  ignoreIds,
}: {
  min: GridPosition;
  size: [number, number, number];
  /** Half-width of the buildable area, in cells: how far the flat lines reach */
  extent: number;
  /** The assembly, for the planes the part crosses */
  parts: PlacedPart[];
  /** Parts to leave out: the guided part itself, and anything travelling with it */
  ignoreIds?: Set<string>;
}) {
  const planes = useMemo(
    () => crossedPlanesOf(parts, min, size, ignoreIds),
    [parts, ignoreIds, min[0], min[1], min[2], size[0], size[1], size[2]],
  );
  const positions = useMemo(() => {
    const u = BASE_UNIT;
    const x0 = min[0] * u - u / 2;
    const x1 = (min[0] + size[0]) * u - u / 2;
    const z0 = min[2] * u - u / 2;
    const z1 = (min[2] + size[2]) * u - u / 2;
    const bottom = min[1] * u;
    const ground = 0.05; // clear of the grid lines
    const reach = extent * u + u / 2;
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

    // The footprint again, up where the part actually is
    seg(x0, bottom, z0, x1, bottom, z0);
    seg(x1, bottom, z0, x1, bottom, z1);
    seg(x1, bottom, z1, x0, bottom, z1);
    seg(x0, bottom, z1, x0, bottom, z0);

    // In each crossed plane, the four edges carried on to the edge of the workspace,
    // both ways — with the footprint closed up there too, unless that plane is the
    // underside, which already has one
    for (const level of planes) {
      const y = level * u;
      if (level !== min[1]) {
        seg(x0, y, z0, x1, y, z0);
        seg(x1, y, z0, x1, y, z1);
        seg(x1, y, z1, x0, y, z1);
        seg(x0, y, z1, x0, y, z0);
      }
      seg(-reach, y, z0, x0, y, z0);
      seg(x1, y, z0, reach, y, z0);
      seg(-reach, y, z1, x0, y, z1);
      seg(x1, y, z1, reach, y, z1);
      seg(x0, y, -reach, x0, y, z0);
      seg(x0, y, z1, x0, y, reach);
      seg(x1, y, -reach, x1, y, z0);
      seg(x1, y, z1, x1, y, reach);
    }

    // The corner the ladder runs along carries on to the top face, so the rungs above
    // the underside have something to hang from
    const top = (min[1] + size[1]) * u;
    seg(x0, bottom, z0, x0, top, z0);

    // A rung per grid level, with the two the part actually ends at drawn longer:
    // those are the underside and the top face, the two heights worth reading off
    for (let level = 1; level <= min[1] + size[1]; level++) {
      const y = level * u;
      const isEnd = level === min[1] || level === min[1] + size[1];
      seg(x0, y, z0, x0 - u * (isEnd ? 0.75 : 0.4), y, z0);
    }
    return new Float32Array(pts);
  }, [min[0], min[1], min[2], size[0], size[1], size[2], extent, planes]);

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={PART_COLORS.selected} transparent opacity={0.7} depthWrite={false} />
    </lineSegments>
  );
}

/**
 * A box round every part of a group.
 *
 * Grouping is otherwise invisible: nothing about a bar says that clicking it will take
 * five. Drawn for the groups the selection is in and for the one under the pointer, so
 * what is tied to what can be read by moving the mouse over the assembly.
 */
function GroupOutline({ min, max }: { min: GridPosition; max: GridPosition }) {
  const lines = useRef<THREE.LineSegments>(null);
  const positions = useMemo(() => {
    const u = BASE_UNIT;
    const m = u * 0.12; // clear of the parts themselves, so the box does not z-fight
    const x0 = min[0] * u - u / 2 - m;
    const x1 = (max[0] + 1) * u - u / 2 + m;
    const y0 = min[1] * u - m;
    const y1 = (max[1] + 1) * u + m;
    const z0 = min[2] * u - u / 2 - m;
    const z1 = (max[2] + 1) * u - u / 2 + m;
    const corners: [number, number, number][] = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    const edges = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
    const pts: number[] = [];
    for (const [a, b] of edges) pts.push(...corners[a], ...corners[b]);
    return new Float32Array(pts);
  }, [min[0], min[1], min[2], max[0], max[1], max[2]]);

  // Dashes are what a dashed material measures along, and they are not there until
  // asked for; without this the box comes out solid, like the height guides
  useEffect(() => {
    lines.current?.computeLineDistances();
  }, [positions]);

  return (
    <lineSegments ref={lines}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineDashedMaterial
        color={PART_COLORS.selected}
        dashSize={BASE_UNIT * 0.45}
        gapSize={BASE_UNIT * 0.3}
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </lineSegments>
  );
}

/**
 * A mouse in the corner of the view, showing the buttons actually held.
 *
 * Which button is down is otherwise something you can only find out by what happens
 * next — a box appearing, a part moving, the view swinging round — and the chords this
 * viewport answers to are worth being sure of before the fact rather than after. It
 * doubles as the way into the full list, which is where the rest of them are written
 * down.
 */
function MouseIndicator({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const held = useHeldButtons();
  return (
    <button
      type="button"
      className={`viewport-mouse${held.length > 0 ? " viewport-mouse--held" : ""}`}
      onClick={onOpenShortcuts}
      title="What the mouse does here — click for the whole list"
    >
      <MouseGlyph buttons={held} size={22} />
      {held.length > 0 && <span className="viewport-mouse-label">{nameForButtons(held)}</span>}
    </button>
  );
}

/** Outline of the buildable area, so its edge is visible rather than a mystery wall */
function WorkspaceBounds({ extent }: { extent: number }) {
  const points = useMemo(() => {
    const e = extent * BASE_UNIT + BASE_UNIT / 2;
    return new Float32Array([-e, 0, -e, e, 0, -e, e, 0, e, -e, 0, e]);
  }, [extent]);
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
 *
 * What is under the pointer is asked of the parts first and of the plane only after:
 * a part standing in the way is nearer than the plane behind it, and reading the
 * plane through it would put the cell where the ground is *seen*, several cells from
 * the surface being pointed at.
 */
function DrawSpanCursor({
  assembly,
  gravityEnabled,
  level,
}: {
  assembly: AssemblyState;
  gravityEnabled: boolean;
  level: number;
}) {
  const { camera, raycaster, pointer, scene } = useThree();
  const [gridPos, setGridPos] = useState<GridPosition>([0, 0, 0]);
  // Drawing happens on the working level when one is up, so the cursor is picked
  // against that plane — taking it from the ground would put the cell under the eye
  // rather than under the pointer
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), -level * BASE_UNIT), [level]);
  const intersectPoint = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);

    const partGroups = scene.children.filter((child) => typeof child.userData?.partInstanceId === "string");
    const onPart = raycaster.intersectObjects(partGroups, true)[0];
    let grid = onPart ? cellBesideHit(onPart) : null;

    if (!grid) {
      if (!raycaster.ray.intersectPlane(plane, intersectPoint)) return;
      grid = snapToGrid(intersectPoint);
      grid[1] = level;
    }

    const settled = resolveDraw(assembly, clampCellToWorkspace(grid), [1, 1, 1], gravityEnabled)?.position ?? grid;
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
  isFaded,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  isColliding: boolean;
  isFaded: boolean;
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
  const opacity = isDragging ? 0.3 : isFaded ? 0.22 : 1;

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
          {/* A ghosted part is out of the way of clicks too — see PartMeshLoaded */}
          <mesh geometry={geometry} raycast={isFaded ? () => {} : undefined}>
            <meshStandardMaterial
              ref={flashRef}
              color={color}
              roughness={1}
              metalness={0}
              transparent={isDragging || isFaded}
              opacity={opacity}
              depthWrite={!isFaded}
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
  isFaded,
  onPointerDown,
}: {
  part: PlacedPart;
  isSelected: boolean;
  isDragging: boolean;
  isPlacing: boolean;
  isFlashing: boolean;
  isColliding: boolean;
  isFaded: boolean;
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
        // A ghosted part steps out of the way of the pointer as well as the eye: the
        // handles it was hiding are right behind it, and the nearest hit wins a
        // raycast whatever its opacity.
        child.raycast = isFaded ? () => {} : THREE.Mesh.prototype.raycast;
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
        } else if (isFaded) {
          if (part.color) {
            child.material = makeColorMaterial(part.color, orig, { transparent: true, opacity: 0.22 });
          } else {
            const mat = orig.clone();
            mat.transparent = true;
            mat.opacity = 0.22;
            mat.depthWrite = false;
            child.material = mat;
          }
        } else if (part.color) {
          child.material = makeColorMaterial(part.color, orig);
        } else {
          // Restore original material
          const orig = originalMaterials.current.get(child);
          if (orig) child.material = orig;
        }
      }
    });
  }, [isSelected, isDragging, isFlashing, isColliding, isFaded, part.color]);

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
  isUnsound,
  solid,
}: {
  definitionId: string;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
  /** Red: this is a hookup that cannot be built, and the click will refuse it */
  isUnsound?: boolean;
  /** Leave the model its own materials: this is a preview of the built part */
  solid?: boolean;
}) {
  const def = getPartDefinition(definitionId);
  if (!def) return null;

  if (!def.modelPath) {
    return (
      <GhostFallback
        definitionId={definitionId}
        orientation={orientation}
        isSnapped={isSnapped}
        isUnsound={isUnsound}
      />
    );
  }

  if (isCustomPart(definitionId)) {
    return (
      <CustomGhostModel definitionId={definitionId} rotation={rotation} isSnapped={isSnapped} isUnsound={isUnsound} />
    );
  }

  return (
    <GLBGhostModel
      definitionId={definitionId}
      rotation={rotation}
      orientation={orientation}
      isSnapped={isSnapped}
      isUnsound={isUnsound}
      solid={solid}
    />
  );
}

/**
 * A ghost is green where it stands, cyan when a socket has taken it, and red when the
 * hookup it shows cannot be built — the last is the click telling you in advance that
 * it will refuse.
 */
function ghostColor(isSnapped?: boolean, isUnsound?: boolean): string {
  if (isUnsound) return PART_COLORS.ghost_invalid;
  return isSnapped ? PART_COLORS.ghost_snapped : PART_COLORS.ghost_valid;
}

/** Ghost preview for GLB-based parts */
function GLBGhostModel({
  definitionId,
  rotation,
  orientation,
  isSnapped,
  isUnsound,
  solid,
}: {
  definitionId: string;
  rotation: Rotation3;
  orientation?: Axis;
  isSnapped?: boolean;
  isUnsound?: boolean;
  solid?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const { scene } = useGLTF(def.modelPath);
  const cloned = useMemo(() => scene.clone(), [scene]);
  const groupRef = useRef<THREE.Group>(null);
  const color = ghostColor(isSnapped, isUnsound);

  useEffect(() => {
    // Solid: the clone keeps the materials the model came with, which is what a placed
    // part is drawn in
    if (!groupRef.current || solid) return;
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
  }, [color, solid]);

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
  isUnsound,
}: {
  definitionId: string;
  rotation: Rotation3;
  isSnapped?: boolean;
  isUnsound?: boolean;
}) {
  const def = getPartDefinition(definitionId)!;
  const geometry = getCustomPartGeometry(definitionId);
  if (!geometry) return null;

  const color = ghostColor(isSnapped, isUnsound);

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
  isUnsound,
}: {
  definitionId: string;
  orientation?: Axis;
  isSnapped?: boolean;
  isUnsound?: boolean;
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
  const color = ghostColor(isSnapped, isUnsound);

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
  /**
   * Whether a snap may still aim the part for you. It stops as soon as the part has
   * been turned by hand: the aiming is a suggestion on arrival, not a grip. Left on,
   * it recomputes every frame and quietly puts back its own choice, so pressing a
   * rotation key only ever picked between equally-aimed orientations — the part could
   * not be turned at all.
   */
  autoAim = true,
}: {
  definitionId: string;
  assembly: AssemblyState;
  ghostOrientation: Axis;
  ghostRotation: Rotation3;
  yLift: number;
  snapEnabled: boolean;
  autoAim?: boolean;
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
  const [isUnsound, setIsUnsound] = useState(false);
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

    const snapOrient = snap && autoAim && isSupport ? snap.orientation : ghostOrientation;
    const snapRotation: Rotation3 =
      snap && autoAim ? (isSupport ? [0, 0, 0] : (snap.autoRotation ?? ghostRotation)) : ghostRotation;

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
      setIsUnsound(
        !supportHookupIsSound(assembly, definitionId, liftedSnapPos, snapRotation, orient, gravityIgnoreIds),
      );
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
    let orient = isSupport ? ghostOrientation : "y";
    let lift = def ? computeGroundLift(def, ghostRotation, orient) : 0;
    cursorGrid[1] = lift + yLift;

    /*
     * A connector arm reaching into this cell settles which way the tube must lie: the
     * arm goes inside the tube, along its axis, so a bar arriving across it is not a
     * hookup at all. The bar turns to the connection rather than being refused for
     * arriving the wrong way round.
     */
    if (isSupport && def) {
      const asked = hookupAxisAt(assembly, cursorGrid, gravityIgnoreIds);
      if (asked && asked !== orient) {
        orient = asked;
        lift = computeGroundLift(def, ghostRotation, orient);
        cursorGrid[1] = lift + yLift;
      }
    }

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
    setIsUnsound(!supportHookupIsSound(assembly, definitionId, freePos, ghostRotation, orient, gravityIgnoreIds));
    if (syncRef)
      syncRef.current = {
        position: freePos,
        orientation: orient,
        rotation: ghostRotation,
        isSnapped: false,
      };
  });

  return { gridPos, effectiveOrientation, effectiveRotation, isSnapped, isUnsound, def };
}

/** Ghost preview for placement mode */
function GhostPreview({
  definitionId,
  assembly,
  ghostOrientation,
  ghostRotation,
  ghostStateRef,
  autoAim,
  workingLevel,
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
  /** False once the part has been turned by hand: the snap stops aiming it */
  autoAim: boolean;
  /** Height of the working floor, in cells: where the cursor lands while placing */
  workingLevel: number;
  yLift: number;
  snapEnabled: boolean;
  gravityEnabled: boolean;
  onPlacePart: (definitionId: string, position: GridPosition, rotation: Rotation3, orientation: Axis) => void;
}) {
  const noParts = useMemo(() => new Set<string>(), []);
  const { gridPos, effectiveOrientation, effectiveRotation, isSnapped, isUnsound, def } = useGhostSnap({
    definitionId,
    assembly,
    ghostOrientation,
    ghostRotation,
    yLift,
    snapEnabled,
    // The cursor lands on the working level, so what is placed follows the eye
    planeY: workingLevel * BASE_UNIT,
    gravityIgnoreIds: gravityEnabled ? noParts : undefined,
    syncRef: ghostStateRef,
    autoAim,
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
    isUnsound,
  };

  const handleGhostClick = (e: any) => {
    e.stopPropagation();
    const gs = ghostStateRef.current;
    console.log("[GhostPreview] onClick — placing at", gs.position, gs.rotation, gs.orientation);
    onPlacePart(definitionId, gs.position, gs.rotation, gs.orientation);
  };

  return (
    <group name="ghost-preview" position={worldPos} onClick={handleGhostClick}>
      <Suspense
        fallback={
          <GhostFallback definitionId={definitionId} orientation={effectiveOrientation} isUnsound={isUnsound} />
        }
      >
        <GhostModel
          definitionId={definitionId}
          rotation={effectiveRotation}
          orientation={effectiveOrientation}
          isSnapped={isSnapped}
          isUnsound={isUnsound}
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
  onAdaptation,
  adaptiveEnabled,
  autoAim,
  workspaceExtent,
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
  /** Reports the connectors this drop would change, so they can be previewed */
  onAdaptation: (adaptations: ConnectorAdaptation[]) => void;
  adaptiveEnabled: boolean;
  /** False once the part has been turned by hand: the snap stops aiming it */
  autoAim: boolean;
  /** Half-width of the buildable area, for the guides the ghost carries */
  workspaceExtent: number;
}) {
  const grabOffsetRef = useRef<[number, number] | null>(null);
  const partWorldY = gridToWorld(dragState.originalPosition)[1];

  /*
   * The parts travelling with this drag: they move as one, so they never block each
   * other, and the ghost's guides read against the assembly they are leaving.
   *
   * A group comes along whether or not it was selected first — a press-and-drag in one
   * gesture never went through a click — so it is asked of the assembly rather than of
   * the selection alone. The drop does the same, from the other end.
   */
  const movingIds = useMemo(() => {
    const ids = new Set<string>([dragState.instanceId]);
    if (selectedPartIds.has(dragState.instanceId)) for (const id of selectedPartIds) ids.add(id);
    else for (const id of assembly.expandToGroups([dragState.instanceId])) ids.add(id);
    return ids;
  }, [assembly, dragState.instanceId, selectedPartIds]);
  const gravityIgnoreIds = gravityEnabled ? movingIds : undefined;

  const { gridPos, effectiveOrientation, isSnapped, isUnsound, def } = useGhostSnap({
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
    autoAim,
  });

  // Keep dropTargetRef in sync
  useEffect(() => {
    dropTargetRef.current = {
      position: gridPos,
      orientation: effectiveOrientation,
      rotation: dragState.rotation,
    };
    // Where a drag has got to, for the e2e suite and for debugging by hand
    (window as any).__dropDebug = {
      instanceId: dragState.instanceId,
      definitionId: dragState.definitionId,
      position: [...gridPos],
      orientation: effectiveOrientation,
      rotation: [...dragState.rotation],
      isSnapped,
      isUnsound,
    };
  }, [gridPos, effectiveOrientation, dragState.rotation, dragState.instanceId, dragState.definitionId, isSnapped]);

  /*
   * A support dropped end-on into a connector that has no arm for it: work out what
   * the connector would have to become, so the drag can show it and the release can
   * carry it out. Only a lone drag — moving a whole selection is a different gesture,
   * and the connectors around it are usually travelling too.
   */
  useEffect(() => {
    if (!adaptiveEnabled || (selectedPartIds.size > 1 && selectedPartIds.has(dragState.instanceId))) {
      onAdaptation([]);
      return;
    }
    onAdaptation(
      adaptiveConnectorsFor(assembly, {
        instanceId: dragState.instanceId,
        definitionId: dragState.definitionId,
        position: gridPos,
        rotation: dragState.rotation,
        orientation: effectiveOrientation,
      }),
    );
  }, [
    adaptiveEnabled,
    assembly,
    dragState.instanceId,
    dragState.definitionId,
    dragState.rotation,
    gridPos,
    effectiveOrientation,
    selectedPartIds,
    onAdaptation,
  ]);

  // The drop is off once the drag ends, whichever way it ended
  useEffect(() => () => onAdaptation([]), [onAdaptation]);

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

  // Ghosts for everything on the move, not only for the part under the pointer
  const isMultiDrag = movingIds.size > 1;
  const delta: GridPosition = [
    gridPos[0] - dragState.originalPosition[0],
    gridPos[1] - dragState.originalPosition[1],
    gridPos[2] - dragState.originalPosition[2],
  ];

  return (
    <group>
      {ghostBounds && ghostBounds.min[1] > 0 && (
        <>
          <HeightGuides
            min={ghostBounds.min}
            size={ghostBounds.size}
            extent={workspaceExtent}
            parts={parts}
            ignoreIds={movingIds}
          />
          {/* The guides let the height be counted; this says it, which is what you
              want while the part is still moving */}
          <DimensionLabel min={ghostBounds.min} size={ghostBounds.size} />
        </>
      )}
      <group name="drag-preview" position={worldPos}>
        <Suspense
          fallback={
            <GhostFallback
              definitionId={dragState.definitionId}
              orientation={effectiveOrientation}
              isUnsound={isUnsound}
            />
          }
        >
          <GhostModel
            definitionId={dragState.definitionId}
            rotation={dragState.rotation}
            orientation={effectiveOrientation}
            isSnapped={isSnapped}
            isUnsound={isUnsound}
          />
        </Suspense>
      </group>
      {isMultiDrag &&
        parts
          .filter((p) => movingIds.has(p.instanceId) && p.instanceId !== dragState.instanceId)
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
    (window as any).__computeDrawSpan = computeDrawSpan;
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
  drawDrag: {
    start: GridPosition;
    current: GridPosition;
    axis?: DrawAxis;
    direction?: Direction;
    held?: boolean;
  } | null;
  onDrawPointerDown: (grid: GridPosition) => void;
  /** Start a draw from a free side of the selected connector, along that side */
  onDrawFromSpot: (spot: FreeSpot) => void;
  /** Drop a draw without placing anything — the press turned out to be a click */
  onCancelDraw: () => void;
  onDrawPointerUp: () => void;
  resizePreview: ResizePreview | null;
  onResizePreview: (preview: ResizePreview | null) => void;
  selectedResizable: { part: PlacedPart; origin: GridPosition; size: [number, number, number] } | null;
  /** Connectors ghosted out of the way of a selected support */
  fadedPartIds: Set<string>;
  /** Off leaves only the bars, so the shape of a structure can be read on its own */
  showConnectors: boolean;
  /** Off hides the rotation rings; the keys still turn the selection */
  showRotationGuides: boolean;
  /** False once the part in hand has been turned by hand: the snap stops aiming it */
  autoAim: boolean;
  /** The buildable area as it stands, which the bounds outline and the shadows cover */
  workspace: WorkspaceSize;
  /** The connectors this drop would change, previewed until the drag ends */
  adaptations: ConnectorAdaptation[];
  onAdaptation: (adaptations: ConnectorAdaptation[]) => void;
  adaptiveEnabled: boolean;
  /** Middle and reach of a multi-part selection, for the rotation rings */
  selectionBody: { centre: [number, number, number]; radii: [number, number, number] } | null;
  onRotateSelectedParts: (axis: 0 | 1 | 2, turns?: 1 | 3) => void;
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
  freeSpots,
  onGrowConnector,
  onPreviewConnector,
  boxSelectActive,
  collidingPartIds,
  drawDrag,
  onDrawPointerDown,
  onDrawFromSpot,
  onCancelDraw,
  onDrawPointerUp,
  resizePreview,
  onResizePreview,
  selectedResizable,
  selectionBody,
  fadedPartIds,
  showConnectors,
  showRotationGuides,
  autoAim,
  workspace,
  adaptations,
  onAdaptation,
  adaptiveEnabled,
  onRotateSelectedParts,
}: SceneProps) {
  const groundRef = useRef<THREE.Mesh>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const gridFromPointerEvent = useCallback((e: { point?: THREE.Vector3 }) => {
    if (e.point) {
      return snapToGrid(e.point);
    }
    return null;
  }, []);

  /**
   * The cell under the pointer on the working level.
   *
   * The invisible pick plane lies on the ground, so its hit is the right cell only
   * while the level is the ground. Higher up, the ray has to be met at that height or
   * the drawn span lands where the ground is seen through the pointer, a cell or more
   * away from where it looks.
   */
  const gridOnWorkingPlane = useCallback(
    (e: { ray?: THREE.Ray; point?: THREE.Vector3 }, level: number): GridPosition | null => {
      if (level <= 0 || !e.ray) return e.point ? snapToGrid(e.point) : null;
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -level * BASE_UNIT);
      const hit = new THREE.Vector3();
      if (!e.ray.intersectPlane(plane, hit)) return null;
      return snapToGrid(hit);
    },
    [],
  );

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
      // A part under the pointer is what the press is on, plane or no plane — the same
      // reason the draw cursor asks the parts first
      const onPart = firstPartHit(e.intersections ?? []);
      const grid = onPart ? cellBesideHit(onPart) : gridOnWorkingPlane(e, workspace.level);
      if (!grid) return;
      if (!onPart) grid[1] = workspace.level;
      const anchor = clampCellToWorkspace(grid);
      // Anchor where the part will actually rest, so an upright draw starts on top
      // of whatever is already on that cell rather than inside it
      const settled = resolveDraw(assembly, anchor, [1, 1, 1], gravityEnabled)?.position ?? anchor;
      onDrawPointerDown(settled);
    },
    [mode, gridOnWorkingPlane, workspace.level, assembly, gravityEnabled, onDrawPointerDown],
  );

  // Tracking the drag itself is left to the window listeners in ViewportCanvas: they
  // read the span off a plane through the anchor cell, wherever that cell ended up,
  // and keep working when the pointer leaves the ground mesh
  void onDrawPointerUp;

  // Guides for any selected part that is off the ground
  const heightGuides = useMemo(() => {
    const out: {
      id: string;
      min: GridPosition;
      size: [number, number, number];
      ignore: Set<string>;
    }[] = [];
    for (const part of parts) {
      if (!selectedPartIds.has(part.instanceId)) continue;
      if (dragState?.instanceId === part.instanceId) continue; // the ghost carries its own
      const bounds = placedPartBounds(part);
      if (!bounds || bounds.min[1] <= 0) continue;
      out.push({ id: part.instanceId, min: bounds.min, size: bounds.size, ignore: new Set([part.instanceId]) });
    }
    return out;
  }, [parts, selectedPartIds, dragState]);

  /**
   * Boxes for the groups the selection is in, and for the group under the pointer.
   * A group left with a single part is not drawn: there is nothing to tie together.
   */
  const groupBoxes = useMemo(() => {
    const shown = new Set<string>();
    for (const part of parts) {
      if (!part.groupId) continue;
      if (selectedPartIds.has(part.instanceId) || part.instanceId === hoveredPartId) shown.add(part.groupId);
    }
    if (shown.size === 0) return [];

    const boxes = new Map<string, { min: GridPosition; max: GridPosition; count: number }>();
    for (const part of parts) {
      if (!part.groupId || !shown.has(part.groupId)) continue;
      const bounds = placedPartBounds(part);
      if (!bounds) continue;
      const hi: GridPosition = [
        bounds.min[0] + bounds.size[0] - 1,
        bounds.min[1] + bounds.size[1] - 1,
        bounds.min[2] + bounds.size[2] - 1,
      ];
      const box = boxes.get(part.groupId);
      if (!box) {
        boxes.set(part.groupId, { min: [...bounds.min] as GridPosition, max: hi, count: 1 });
        continue;
      }
      for (let i = 0; i < 3; i++) {
        box.min[i] = Math.min(box.min[i], bounds.min[i]);
        box.max[i] = Math.max(box.max[i], hi[i]);
      }
      box.count++;
    }
    return [...boxes.entries()]
      .filter(([, box]) => box.count > 1)
      .map(([id, box]) => ({ id, min: box.min, max: box.max }));
  }, [parts, selectedPartIds, hoveredPartId]);

  // Live while resizing, otherwise whatever the cursor is over. Only bars get one —
  // "1u" on a connector would be noise.
  const dimensionBox = useMemo(() => {
    if (resizePreview) return { min: resizePreview.position, size: resizePreview.size };
    if (!hoveredPartId) return null;
    const part = parts.find((p) => p.instanceId === hoveredPartId);
    if (!part) return null;
    const bounds = placedPartBounds(part);
    if (!bounds) return null;
    // A single cell on the ground has nothing to report; off the ground, its height does
    if (Math.max(...bounds.size) <= 1 && bounds.min[1] <= 0) return null;
    return bounds;
  }, [resizePreview, hoveredPartId, parts]);

  /*
   * Rings round a lone connector are wider than the part and say nothing that can be
   * acted on: a connector's business is which way its arms point, which the handles on
   * its free sides and the replacement list both answer. The keys still turn it.
   */
  const turnableSelection = useMemo(
    () =>
      parts.some(
        (p) => selectedPartIds.has(p.instanceId) && getPartDefinition(p.definitionId)?.category !== "connector",
      ),
    [parts, selectedPartIds],
  );

  const sceneDrawAxis: DrawAxis = drawDrag?.axis ?? (mode.type === "draw" ? mode.axis : "horizontal");
  const drawSpan = drawDrag
    ? computeDrawSpan(drawDrag.start, drawDrag.current, sceneDrawAxis, drawDrag.direction)
    : null;
  // Preview the settled placement, not the raw span — same resolver as the commit
  const drawPreview = drawSpan
    ? (resolveDraw(assembly, drawSpan.position, drawSpan.size, gravityEnabled && !drawDrag?.held) ?? drawSpan)
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
        shadow-camera-left={-shadowExtentFor(workspace.extent)}
        shadow-camera-right={shadowExtentFor(workspace.extent)}
        shadow-camera-top={shadowExtentFor(workspace.extent)}
        shadow-camera-bottom={-shadowExtentFor(workspace.extent)}
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
          <planeGeometry args={[shadowExtentFor(workspace.extent) * 2, shadowExtentFor(workspace.extent) * 2]} />
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
        <HeightGuides
          key={g.id}
          min={g.min}
          size={g.size}
          extent={workspace.extent}
          parts={parts}
          ignoreIds={g.ignore}
        />
      ))}

      {groupBoxes.map((box) => (
        <GroupOutline key={box.id} min={box.min} max={box.max} />
      ))}

      {selectedPoint && <AttachmentMarker point={selectedPoint} />}
      {previewSuggestion && (
        <SuggestionPreview
          definitionId={previewSuggestion.definitionId}
          position={previewSuggestion.position}
          rotation={previewSuggestion.rotation}
          orientation={previewSuggestion.orientation}
          solid={!!previewSuggestion.replaces}
        />
      )}
      {adaptations.map((a) => (
        <SuggestionPreview key={a.instanceId} definitionId={a.definitionId} position={a.cell} rotation={a.rotation} />
      ))}

      <WorkspaceBounds extent={workspace.extent} />
      <WorkingLevel level={workspace.level} extent={workspace.extent} opacity={workspace.levelOpacity} />

      {/* Invisible ground plane for raycasting */}
      <mesh
        ref={groundRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        onClick={handleGroundClick}
        onPointerDown={handleGroundPointerDown}
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
        // A replacement ghost stands on this very cell, so the connector it would
        // replace steps aside for it — otherwise the two are drawn into each other
        if (previewSuggestion?.replaces === part.instanceId) return null;
        // A connector an adaptive drop would change steps aside for its own ghost
        if (adaptations.some((a) => a.instanceId === part.instanceId)) return null;
        if (!showConnectors && getPartDefinition(part.definitionId)?.category === "connector") return null;
        const preview = resizePreview && resizePreview.instanceId === part.instanceId ? resizePreview : null;
        const renderPart: PlacedPart = preview ? previewPart(part, preview) : part;
        return (
          <group
            key={part.instanceId}
            // Lets the close-up views tell a part's meshes from the rest of the scene
            userData={{ partInstanceId: part.instanceId }}
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
              isFaded={fadedPartIds.has(part.instanceId)}
              isDragging={dragState?.instanceId === part.instanceId}
              isPlacing={mode.type === "place" || mode.type === "draw"}
              isFlashing={flashPartId === part.instanceId || flashDefinitionId === part.definitionId}
              isColliding={collidingPartIds.has(part.instanceId)}
              onPointerDown={(e) => onPartPointerDown(part.instanceId, e.nativeEvent, e.point)}
            />
          </group>
        );
      })}

      {showRotationGuides && selectionBody && turnableSelection && mode.type === "select" && !dragState && (
        <RotationHandles centre={selectionBody.centre} radii={selectionBody.radii} onRotate={onRotateSelectedParts} />
      )}

      {freeSpots && mode.type === "select" && !dragState && (
        <FreeSpotHandles
          cell={freeSpots.cell}
          spots={freeSpots.spots}
          onGrow={(spot) => spot.grow && onGrowConnector(freeSpots.instanceId, spot.grow.def.id, spot.grow.rotation)}
          onPreview={(spot) =>
            onPreviewConnector(
              spot?.grow
                ? {
                    definitionId: spot.grow.def.id,
                    position: freeSpots.cell,
                    rotation: spot.grow.rotation,
                    replaces: freeSpots.instanceId,
                  }
                : null,
            )
          }
          onDrawFrom={onDrawFromSpot}
          onCancelDraw={onCancelDraw}
        />
      )}

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

      {/* A draw from a connector's free side happens in select mode, so the span is
          shown whenever one is being dragged out; the cursor cell belongs to the tool */}
      {drawPreview ? (
        <>
          <DrawSpanGhost position={drawPreview.position} size={drawPreview.size} />
          {/* The length while it is still being dragged out, not only once placed */}
          <DimensionLabel min={drawPreview.position} size={drawPreview.size} />
        </>
      ) : (
        mode.type === "draw" && (
          <DrawSpanCursor assembly={assembly} gravityEnabled={gravityEnabled} level={workspace.level} />
        )
      )}

      {/* Ghost preview in placement mode */}
      {mode.type === "place" && (
        <GhostPreview
          definitionId={mode.definitionId}
          assembly={assembly}
          ghostOrientation={ghostOrientation}
          ghostRotation={ghostRotation}
          ghostStateRef={ghostStateRef}
          autoAim={autoAim}
          workingLevel={workspace.level}
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
          onAdaptation={onAdaptation}
          adaptiveEnabled={adaptiveEnabled}
          autoAim={autoAim}
          workspaceExtent={workspace.extent}
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

  // Whatever stands on the junction cell stays solid in the close-ups; everything
  // else fades, since from those angles the assembly is mostly in the way. An empty
  // cell leaves the set empty, which is what a hovered suggestion wants: the ghost
  // is the only thing there is to look at.
  const junctionParts = useMemo(() => {
    const ids = new Set<string>();
    if (!junctionCell) return ids;
    for (const key of gridKeysForCell(junctionCell)) {
      for (const id of props.assembly.gridOccupancy.get(key) ?? []) ids.add(id);
    }
    return ids;
  }, [junctionCell, props.assembly, props.parts]);

  const [light, setLight] = useState<LightSettings>(loadLightSettings);
  const [lightPanelOpen, setLightPanelOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /*
   * The keys themselves, so the handler below and the hint that reads them out are
   * both rebuilt the moment one is changed.
   */
  const keys = useSyncExternalStore(subscribeBindings, bindings);
  const logging = useSyncExternalStore(subscribeGestureLog, gestureLogIsOn);

  useEffect(() => {
    saveLightSettings(light);
  }, [light]);

  /** The buildable area, watched so the outline and the shadows follow a change */
  const workspace = useSyncExternalStore(subscribeWorkspace, getWorkspace, getWorkspace);
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false);
  const [levelPanelOpen, setLevelPanelOpen] = useState(false);

  const [showRotationGuides, setShowRotationGuides] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ROTATION_GUIDES_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(ROTATION_GUIDES_STORAGE_KEY, showRotationGuides ? "1" : "0");
    } catch {
      /* ignore quota errors */
    }
  }, [showRotationGuides]);

  const [showConnectors, setShowConnectors] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CONNECTORS_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(CONNECTORS_STORAGE_KEY, showConnectors ? "1" : "0");
    } catch {
      /* ignore quota errors */
    }
  }, [showConnectors]);

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
  const [adaptations, setAdaptations] = useState<ConnectorAdaptation[]>([]);
  const adaptationsRef = useRef<ConnectorAdaptation[]>([]);
  adaptationsRef.current = adaptations;
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
    /** The part is locked and the refusal has already been reported */
    refused?: boolean;
  } | null>(null);

  const [drawDrag, setDrawDrag] = useState<{
    start: GridPosition;
    current: GridPosition;
    /** Set when the draw began on a connector's free side, which fixes its axis */
    axis?: DrawAxis;
    /** The side it began on, which fixes which way the bar runs and not just its axis */
    direction?: Direction;
    /** A bar plugged into an arm is held by it, whatever gravity would prefer */
    held?: boolean;
  } | null>(null);
  const drawDragRef = useRef(drawDrag);
  drawDragRef.current = drawDrag;
  const [resizePreview, setResizePreview] = useState<ResizePreview | null>(null);

  const handleDrawPointerDown = useCallback((grid: GridPosition) => {
    setDrawDrag({ start: grid, current: grid });
  }, []);

  /**
   * A draw begun on a free side of the selected connector: it starts in the cell that
   * side faces, and the side settles whether the bar is drawn out flat or upright.
   */
  const handleDrawFromSpot = useCallback((spot: FreeSpot) => {
    logGesture("draw from a connector's side", spot.direction);
    const axis: DrawAxis = spot.direction[1] === "y" ? "vertical" : "horizontal";
    const start: GridPosition = [...spot.cell];
    const begun = { start, current: [...start] as GridPosition, axis, direction: spot.direction, held: true };
    drawDragRef.current = begun;
    setDrawDrag(begun);
  }, []);

  /**
   * Drop the draw without placing anything.
   *
   * The ref goes with the state because the commit reads the ref, and both happen
   * inside the one release: a state change would not have landed in time.
   */
  const handleDrawCancel = useCallback(() => {
    drawDragRef.current = null;
    setDrawDrag(null);
  }, []);

  const drawAxis: DrawAxis = drawDrag?.axis ?? (props.mode.type === "draw" ? props.mode.axis : "horizontal");

  const handleDrawPointerUp = useCallback(() => {
    const drag = drawDragRef.current;
    if (!drag) return;
    drawDragRef.current = null;
    setDrawDrag(null);
    const { position, size } = computeDrawSpan(drag.start, drag.current, drawAxis, drag.direction);
    logGesture("draw", `${size.join("×")} at ${position.join(",")}`);
    props.onDraw(position, size, drag.held);
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
        // A draw with a side of its own grows the way that side faces, up or down;
        // one begun in draw mode only ever grows up from the cell that was clicked
        const level = Math.round((hit.y - BASE_UNIT / 2) / BASE_UNIT);
        const y = drawDrag.direction ? level : Math.max(anchor[1], level);
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

  // A fresh gesture gets the aiming back: it is given up only for the one in progress
  useEffect(() => {
    setAutoAim(true);
  }, [props.mode]);

  /**
   * Connectors touching a selected support, ghosted so the bar reads whole.
   *
   * A bar's ends are where its handles live and where its length is judged, and a
   * connector sitting on one swallows both. Only supports trigger it: selecting a
   * connector to look at it and having its neighbours vanish would be the opposite
   * of useful.
   */
  const fadedPartIds = useMemo(() => {
    const faded = new Set<string>();
    /*
     * While the library is proposing a part, nothing is ghosted out of the way: what
     * has to be judged is how the proposal meets the parts already there, and a
     * connector at 22% is no help in judging it. The bar being read whole is the point
     * of the fade, and it stops being the subject the moment a suggestion is hovered.
     */
    if (props.previewSuggestion) return faded;
    if (props.selectedPartIds.size === 0) return faded;

    const selectedSupports = props.parts.filter(
      (p) => props.selectedPartIds.has(p.instanceId) && getPartDefinition(p.definitionId)?.category === "support",
    );
    if (selectedSupports.length === 0) return faded;
    const supportIds = new Set(selectedSupports.map((p) => p.instanceId));

    const occupancy = props.assembly.gridOccupancy;
    for (const [key, ids] of occupancy) {
      if (!ids.some((id) => supportIds.has(id))) continue;
      const cell = key.split(",").map(Number);
      // The cell itself included: a pull-through connector shares it with the bar
      for (const [dx, dy, dz] of TOUCHING_CELLS) {
        const neighbours = occupancy.get(`${cell[0] + dx},${cell[1] + dy},${cell[2] + dz}`);
        if (!neighbours) continue;
        for (const id of neighbours) {
          if (props.selectedPartIds.has(id)) continue;
          const part = props.parts.find((p) => p.instanceId === id);
          if (part && getPartDefinition(part.definitionId)?.category === "connector") faded.add(id);
        }
      }
    }
    return faded;
  }, [props.selectedPartIds, props.parts, props.assembly, props.previewSuggestion]);

  /**
   * The pivot of the turn the rings offer, and how far the body reaches around it in
   * each plane of turn.
   *
   * Both matter for the rings to mean anything: a circle drawn round the middle of a
   * body that actually swings about its end says the wrong thing twice over. The
   * centre is the point the turn holds still, and each radius reaches the far side of
   * what moves, so the circle is the path that part travels rather than a hoop around
   * the scene.
   *
   * The pivot is handed down rather than worked out again here: the turn and the ring
   * that offers it have to be about the same point, and computing it twice is how they
   * would come to disagree.
   */
  const selectionBody = useMemo(() => {
    if (props.selectedPartIds.size === 0) return null;
    const selected = props.parts.filter((p) => props.selectedPartIds.has(p.instanceId));
    if (selected.length === 0) return null;

    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const part of selected) {
      const bounds = placedPartBounds(part);
      if (!bounds) continue;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], bounds.min[i]);
        max[i] = Math.max(max[i], bounds.min[i] + bounds.size[i] - 1);
      }
    }
    if (!Number.isFinite(min[0])) return null;

    const pivot = props.rotationPivot;
    if (!pivot) return null;
    const pivotCell: [number, number, number] = [pivot[0], pivot[1], pivot[2]];
    const centre = gridToWorld(pivotCell);

    // Reach of the body from the pivot, per plane: the farthest corner of the box,
    // measured in the two axes that plane turns in
    const away = [0, 1, 2].map((i) => Math.max(Math.abs(min[i] - pivotCell[i]), Math.abs(max[i] - pivotCell[i])));
    const inPlane = (a: number, b: number) => Math.hypot(away[a], away[b]) * BASE_UNIT;

    /*
     * A lone support carries length handles at its ends, and a ring running through
     * them takes their clicks, so it stands a little further out in that case. The
     * floor keeps a single-cell selection's rings big enough to aim at.
     */
    const clear = BASE_UNIT * (selected.length === 1 && resizeEnvelopeOf(selected[0]) ? 0.95 : 0.3);
    const radius = (raw: number) => Math.max(raw + clear, BASE_UNIT * 1.4);

    return {
      centre,
      radii: [radius(inPlane(1, 2)), radius(inPlane(0, 2)), radius(inPlane(0, 1))] as [number, number, number],
    };
  }, [props.selectedPartIds, props.parts, props.rotationPivot]);

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
  /**
   * A box-select gesture is under way — set on the press that begins it, not on the
   * first pixel of the rectangle.
   *
   * The camera has to be called off at the press. Waiting for the rectangle to appear
   * left the view turning for the few pixels the drag takes to pass the threshold,
   * which is a wobble on every box drawn. Kept in a ref beside the state because the
   * window listeners read it from a closure that outlives the render.
   */
  const boxGestureRef = useRef(false);
  const [boxGesture, setBoxGesture] = useState(false);
  const beginBoxGesture = useCallback((start: { startX: number; startY: number }) => {
    boxSelectRef.current ??= start;
    boxGestureRef.current = true;
    setBoxGesture(true);
  }, []);
  const endBoxGesture = useCallback(() => {
    boxGestureRef.current = false;
    setBoxGesture(false);
  }, []);
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

  /**
   * Whether a snap may still aim the part being placed or dragged. Any turn by hand
   * gives it up for the rest of the gesture, and it comes back with the next one.
   */
  const [autoAim, setAutoAim] = useState(true);

  const rotateAxis = useCallback((axis: 0 | 1 | 2) => {
    setAutoAim(false);
    setGhostRotation((prev) => {
      const next: Rotation3 = [...prev];
      next[axis] = nextStep(next[axis]);
      return next;
    });
  }, []);

  /**
   * A middle press that landed on a part. Released without travelling it duplicates
   * the part; travelled, it was the camera being panned — the same bargain the right
   * button strikes between cancelling and panning.
   */
  const middlePressRef = useRef<{ x: number; y: number; instanceId: string } | null>(null);

  // Handle pointer down on a part — records pending drag start
  const handlePartPointerDown = useCallback(
    (instanceId: string, nativeEvent: PointerEvent, hit?: THREE.Vector3) => {
      if (props.mode.type !== "select") return;
      logGesture("press on part", `${instanceId.slice(0, 12)} · buttons ${buttonsLabel(nativeEvent.buttons)}`);
      if (nativeEvent.button === 1) {
        // Nothing is taken from the camera here: the release decides. preventDefault
        // only sees off the browser's own middle-click habits, autoscroll above all.
        nativeEvent.preventDefault();
        middlePressRef.current = { x: nativeEvent.clientX, y: nativeEvent.clientY, instanceId };
        return;
      }
      // Left drags the footprint, right drags the height
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

      /*
       * The same reading, for the box the two buttons draw. A press of the second
       * button does not always arrive — a mouse driver or a context menu can swallow
       * it, and then the chord would never be noticed at all — but a move that carries
       * both of them says the same thing, and says it every frame.
       */
      if (
        !dragState &&
        !boxSelectRef.current &&
        !drawDragRef.current &&
        props.mode.type === "select" &&
        (e.buttons & 1) !== 0 &&
        (e.buttons & 2) !== 0
      ) {
        pendingDragRef.current = null;
        rightPressRef.current = null;
        beginBoxGesture({ startX: e.clientX, startY: e.clientY });
        logGesture("box select armed", "both buttons, seen on a move");
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
        // A locked part keeps its press: the pending entry stays so the release still
        // reads as a click and selects, it just never becomes a drag. Said once, or
        // every further move over the threshold would say it again.
        // A locked connector inside a group still drags: the whole body goes with it,
        // so the joint it holds is not being pulled apart
        if (props.lockedPartIds.has(pending.instanceId) && !props.assembly.getPartById(pending.instanceId)?.groupId) {
          if (!pending.refused) {
            pending.refused = true;
            props.onLockedPartDrag();
          }
          return;
        }
        logGesture("drag started", pending.vertical ? "height, from a right press" : "footprint");
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
          setAutoAim(true);
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
            logGesture("box select", `${matched.length} part(s) caught`);
            if (matched.length > 0) {
              props.onBoxSelect(matched);
            }
          }
        }
        boxSelectRef.current = null;
        setBoxSelectRect(null);
        // Only once nothing is held: handing the view back while the other button of
        // a two-button box is still down would let it move on the way up
        if (e.buttons === 0) endBoxGesture();
        return;
      }

      middlePressRef.current = null;
      if (boxGestureRef.current && e.buttons === 0) endBoxGesture();

      // Part drag/click finalize
      const pending = pendingDragRef.current;
      if (!pending) return;

      if (dragState) {
        const target = dropTargetRef.current;
        logGesture("dropped", `at ${target.position.join(",")}`);
        // If dragging a part from a multi-selection, move all selected parts by the same delta
        if (props.selectedPartIds.size > 1 && props.selectedPartIds.has(dragState.instanceId)) {
          props.onMoveSelectedParts(dragState.instanceId, target.position, target.rotation, target.orientation);
        } else {
          props.onMovePart(
            dragState.instanceId,
            target.position,
            target.rotation,
            target.orientation,
            adaptationsRef.current,
          );
        }
        setDragState(null);
        setAdaptations([]);
      } else {
        props.onClickPart(pending.instanceId, e.shiftKey, pending.gridPoint, e.altKey);
      }
      pendingDragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
    // The lock has to be in here: the handlers below live in the listener's closure,
    // so a set that changed after the last subscription would go unnoticed
  }, [
    dragState,
    boxSelectRect,
    props.parts,
    props.assembly,
    props.mode,
    props.lockedPartIds,
    props.onLockedPartDrag,
    props.onMovePart,
    props.onClickPart,
    props.onBoxSelect,
    beginBoxGesture,
    endBoxGesture,
  ]);

  /*
   * Keyboard shortcuts, by the action a keystroke stands for rather than by the key
   * itself — which is what makes them rebindable, and what keeps the app's own chords
   * out of here: Ctrl+Z reads as undo, an action this handler does not own, so it no
   * longer turns the selection about z on its way to the history.
   *
   * The action is the same in every context; what it does depends on what is in hand.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture keystrokes when an input/textarea is focused (e.g. color hex input)
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const action = actionOf(e);
      if (!action) return;
      const camera = () => (window as any).__camera as THREE.Camera | undefined;

      if (action === "shortcuts") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (action === "cancel") {
        // The panel owns Escape while it is open
        if (lightPanelOpen) {
          setLightPanelOpen(false);
          return;
        }
        cancelCurrentAction();
      } else if (action === "delete" && props.selectedPartIds.size > 0) {
        props.onDeleteSelected();
      } else if (dragState) {
        const rotateDrag = (axis: 0 | 1 | 2) => {
          setAutoAim(false);
          const next: Rotation3 = [...dragState.rotation];
          next[axis] = nextStep(next[axis]);
          setDragState({ ...dragState, rotation: next });
        };
        const turn = TURN_AXIS[action];
        if (turn) {
          const cam = camera();
          if (cam) rotateDrag(rotationAxesFromCamera(cam)[turn]);
        } else if (action === "orient") {
          const def = getPartDefinition(dragState.definitionId);
          if (def?.category === "support") {
            setAutoAim(false);
            setDragState({ ...dragState, orientation: nextOrientation(dragState.orientation ?? "y") });
          }
        } else if (action === "raise") {
          setYLift((prev) => prev + 1);
        } else if (action === "lower") {
          setYLift((prev) => Math.max(0, prev - 1));
        }
      } else if (props.mode.type === "select" && props.selectedPartIds.size > 0) {
        // Nudge, lift, turn and re-aim the selection. Shift makes a nudge finer and a
        // turn go the other way.
        const fine = e.shiftKey ? 0.05 : 1;
        const nudge = NUDGE_STEP[action];
        if (nudge) {
          e.preventDefault();
          // Same route to the camera the box-select projection already takes
          const cam = camera();
          const orbit = (window as any).__controls as { target?: THREE.Vector3 } | undefined;
          const around = orbit?.target?.clone() ?? new THREE.Vector3();
          const step = cam ? arrowGroundSteps(cam, around)[nudge] : undefined;
          if (step) props.onNudgeParts(step[0] * fine, step[1] * fine, step[2] * fine);
          return;
        }
        const turn = TURN_AXIS[action];
        if (turn) {
          const cam = camera();
          if (cam) {
            const axis = rotationAxesFromCamera(cam)[turn];
            // A press turns the part clockwise on the screen, shift the other way —
            // which world direction that is depends on which side the camera is on
            const pivot = props.rotationPivot ?? [0, 0, 0];
            const clockwise = quarterTurnIsClockwise(cam, gridToWorld(pivot), axis);
            const turns: 1 | 3 = clockwise === !e.shiftKey ? 1 : 3;
            props.onRotateSelectedParts(axis, turns);
          }
        } else if (action === "raise") {
          props.onNudgeParts(0, fine, 0);
        } else if (action === "lower") {
          props.onNudgeParts(0, -fine, 0);
        } else if (action === "orient") {
          props.onOrientSelectedParts();
        }
      } else if (props.mode.type === "place" || props.mode.type === "paste") {
        const turn = TURN_AXIS[action];
        if (turn) {
          const cam = camera();
          if (cam) rotateAxis(rotationAxesFromCamera(cam)[turn]);
        } else if (action === "orient") {
          if (isPlacingSupport) {
            setAutoAim(false);
            setGhostOrientation((prev) => nextOrientation(prev));
          }
        } else if (action === "raise") {
          setYLift((prev) => prev + 1);
        } else if (action === "lower") {
          setYLift((prev) => Math.max(0, prev - 1));
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
    keys,
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

  // Start box-select on shift+pointerdown, or on both buttons together, over empty space
  const handleViewportPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Remembered for every press: the scene needs it to tell a click from the tail
      // end of a camera drag, which the browser reports as a click all the same
      pressOriginRef.current = { x: e.clientX, y: e.clientY };

      /*
       * Both buttons held at once: the other way to drag a selection box, for hands
       * that would rather not hold Shift. Anywhere in the viewport, over a part as
       * readily as over bare ground — an assembly of any size leaves little bare
       * ground to start on, which is where it was wanted in the first place.
       *
       * Two presses are called off here. The one that had begun on a part, so its
       * release neither selects nor moves it; and the right press, whose release would
       * otherwise deselect everything the box had just caught. A part already on the
       * move keeps its drag: there the right button means height, and the chord has
       * been that gesture's second half for longer.
       */
      logGesture("press", `button ${e.button} · buttons ${buttonsLabel(e.buttons)} · mode ${props.mode.type}`);

      const bothButtons = (e.buttons & 1) !== 0 && (e.buttons & 2) !== 0;
      if (bothButtons && props.mode.type === "select" && !dragState) {
        pendingDragRef.current = null;
        rightPressRef.current = null;
        beginBoxGesture({ startX: e.clientX, startY: e.clientY });
        logGesture("box select armed", "both buttons — the camera is held still");
        return;
      }
      if (bothButtons) {
        logGesture(
          "both buttons ignored",
          dragState ? "a part is already on the move" : `mode is ${props.mode.type}, not select`,
        );
      }

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
      beginBoxGesture({ startX: e.clientX, startY: e.clientY });
      logGesture("box select armed", "shift+drag — the camera is held still");
    },
    [props.mode, dragState, beginBoxGesture],
  );

  /**
   * A stationary right-click acts as Escape and a stationary middle-click duplicates;
   * a drag with either button still moves the camera.
   */
  const handleViewportPointerUp = useCallback(
    (e: React.PointerEvent) => {
      logGesture("release", `button ${e.button} · still held ${buttonsLabel(e.buttons)}`);
      if (e.button === 1) {
        const middle = middlePressRef.current;
        middlePressRef.current = null;
        if (!middle) return; // the press began on empty space: the camera's business
        if (Math.hypot(e.clientX - middle.x, e.clientY - middle.y) >= DRAG_THRESHOLD) {
          logGesture("middle drag", "the camera panned; nothing duplicated");
          return;
        }
        logGesture("duplicate", "a copy goes on the cursor");
        props.onDuplicatePart(middle.instanceId);
        return;
      }
      const press = rightPressRef.current;
      rightPressRef.current = null;
      if (e.button !== 2 || !press) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_THRESHOLD) return;
      cancelCurrentAction();
    },
    [cancelCurrentAction, props.onDuplicatePart],
  );

  // The viewport owns the right button, so the native menu never applies here
  const handleViewportContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  /*
   * The hint, spelled with the keys as they are bound right now — it used to name keys
   * of its own (T, R, F) that nothing answered to. Clicking it opens the full list.
   */
  const turnKeys = `${keyLabel("turn-x")}/${keyLabel("turn-y")}/${keyLabel("turn-z")}`;
  const liftKeys = `${keyLabel("raise")}/${keyLabel("lower")}`;
  const nudgeKeys = `${keyLabel("nudge-left")}${keyLabel("nudge-right")}${keyLabel("nudge-forward")}${keyLabel("nudge-back")}`;
  const cancelKey = keyLabel("cancel");

  let hintText: string | null = null;
  if (dragState) {
    const dragDef = getPartDefinition(dragState.definitionId);
    hintText =
      dragDef?.category === "support"
        ? `${turnKeys} rotate · ${keyLabel("orient")} orientation · ${liftKeys} raise/lower · Release to place · Right-click or ${cancelKey} cancel`
        : `${turnKeys} rotate · ${liftKeys} raise/lower · Release to place · Right-click or ${cancelKey} cancel`;
  } else if (props.mode.type === "place") {
    hintText = isPlacingSupport
      ? `Click to place · ${turnKeys} rotate · ${keyLabel("orient")} orientation · ${liftKeys} raise/lower · Right-click or ${cancelKey} cancel`
      : `Click to place · ${turnKeys} rotate · ${liftKeys} raise/lower · Right-click or ${cancelKey} cancel`;
  } else if (props.mode.type === "draw") {
    hintText =
      props.mode.axis === "vertical"
        ? `Click a cell and drag up to stand a support · Right-click or ${cancelKey} cancel`
        : `Drag across the ground to lay down a support · Right-click or ${cancelKey} cancel`;
  } else if (props.mode.type === "select" && props.selectedPartIds.size > 0) {
    hintText = selectedResizable
      ? `Drag face handles to resize · Suggested parts appear on the right · Middle-click to duplicate · ${keyLabel("delete")} delete · Right-click or ${cancelKey} deselect`
      : `${nudgeKeys} nudge, Shift for finer · ${liftKeys} up and down · ${turnKeys} turn in the xz, xy and yz planes, Shift to reverse · ${keyLabel("copy")}/${keyLabel("paste")} copy/paste, middle-click duplicates · ${keyLabel("delete")} delete · Right-click or ${cancelKey} deselect`;
  } else if (props.mode.type === "paste") {
    hintText = `Click to paste ${props.mode.clipboard.parts.length} part(s) · ${turnKeys} rotate · ${cancelKey} cancel`;
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
          boxSelectActive={!!boxSelectRect || boxGesture}
          collidingPartIds={collidingPartIds}
          drawDrag={drawDrag}
          onDrawPointerDown={handleDrawPointerDown}
          onDrawFromSpot={handleDrawFromSpot}
          onCancelDraw={handleDrawCancel}
          onDrawPointerUp={handleDrawPointerUp}
          resizePreview={resizePreview}
          onResizePreview={setResizePreview}
          selectedResizable={selectedResizable}
          selectionBody={selectionBody}
          fadedPartIds={fadedPartIds}
          showConnectors={showConnectors}
          showRotationGuides={showRotationGuides}
          autoAim={autoAim}
          workspace={workspace}
          adaptations={adaptations}
          onAdaptation={setAdaptations}
          adaptiveEnabled={props.adaptiveEnabled}
          onRotateSelectedParts={props.onRotateSelectedParts}
        />
        {(mirrorMinimap || junctionCell) && (
          <ViewportInsets mirror={mirrorMinimap} junction={junctionCell} junctionParts={junctionParts} />
        )}
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
      {/* One flexible row: fixed left offsets could not take another control */}
      <div className="viewport-bottom">
        {hintText && (
          <button
            type="button"
            className="viewport-hint"
            onClick={() => setShortcutsOpen(true)}
            title="Every shortcut, and where to change them"
          >
            {hintText}
          </button>
        )}
        <div className="viewport-toolbelt">
          <button
            className={`viewport-shadow-toggle${light.shadows ? " viewport-mirror-toggle--on" : ""}`}
            type="button"
            onClick={() => setLightPanelOpen(true)}
            title="Lighting and shadow settings"
          >
            Shadows
          </button>
          {/*
          The working level is moved while building, not configured once, so it gets a
          control of its own rather than a row inside a panel: one press per cell, and
          the readout doubles as the way back to the ground.
        */}
          <div className="viewport-level">
            <button
              type="button"
              className="viewport-level-step"
              // Read the live value, not this render's: presses in quick succession would
              // otherwise all compute from the same stale number and move it once
              onClick={() => setWorkspace({ level: getWorkspace().level - 1 })}
              disabled={workspace.level <= 0}
              title="Lower the working level by one cell"
            >
              −
            </button>
            <button
              type="button"
              className="viewport-level-readout"
              onClick={() => setWorkspace({ level: 0 })}
              title={
                workspace.level > 0 ? "Put the working level back on the ground" : "The working level is the ground"
              }
            >
              {workspace.level === 0
                ? "Level: ground"
                : `Level: ${workspace.level} · ${Math.round((workspace.level * BASE_UNIT) / 10)} cm`}
            </button>
            <button
              type="button"
              className="viewport-level-step"
              onClick={() => setWorkspace({ level: getWorkspace().level + 1 })}
              disabled={workspace.level >= workspace.height}
              title="Raise the working level by one cell"
            >
              +
            </button>
            <button
              type="button"
              className="viewport-level-step"
              onClick={() => setLevelPanelOpen((v) => !v)}
              title="How solid the level looks"
            >
              ⋯
            </button>
            {levelPanelOpen && (
              <div className="viewport-level-panel" role="dialog" aria-label="Working level">
                <label className="shadow-settings-row">
                  <span className="shadow-settings-label">Opacity</span>
                  <input
                    type="range"
                    min={WORKSPACE_LIMITS.levelOpacity.min}
                    max={WORKSPACE_LIMITS.levelOpacity.max}
                    step={0.02}
                    value={workspace.levelOpacity}
                    onChange={(e) => setWorkspace({ levelOpacity: Number(e.target.value) })}
                  />
                  <span className="shadow-settings-value">{Math.round(workspace.levelOpacity * 100)}%</span>
                </label>
              </div>
            )}
          </div>
          <button
            className="viewport-workspace-toggle"
            type="button"
            onClick={() => setWorkspacePanelOpen(true)}
            title="Size of the buildable area"
          >
            Workspace
          </button>
          <button
            className="viewport-workspace-toggle"
            type="button"
            onClick={() => setShortcutsOpen(true)}
            title={`Every keyboard shortcut, and where to change them (${keyLabel("shortcuts")})`}
          >
            Keys
          </button>
          <button
            className={`viewport-connectors-toggle${logging ? " viewport-mirror-toggle--on" : ""}`}
            type="button"
            onClick={() => setGestureLogOn(!logging)}
            title="Write every press, gesture and change of mode into a list on the right"
          >
            Gestures: {logging ? "On" : "Off"}
          </button>
          <button
            className={`viewport-connectors-toggle${!showRotationGuides ? " viewport-mirror-toggle--on" : ""}`}
            type="button"
            onClick={() => setShowRotationGuides((v) => !v)}
            title="The rotation rings around a selection — the keys turn it either way"
          >
            Guides: {showRotationGuides ? "On" : "Off"}
          </button>
          <button
            className={`viewport-connectors-toggle${!showConnectors ? " viewport-mirror-toggle--on" : ""}`}
            type="button"
            onClick={() => setShowConnectors((v) => !v)}
            title="Hide the connectors to read the run of the bars on their own"
          >
            Connectors: {showConnectors ? "On" : "Off"}
          </button>
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
        </div>
      </div>
      {lightPanelOpen && (
        <ShadowSettings settings={light} onChange={setLight} onClose={() => setLightPanelOpen(false)} />
      )}
      {workspacePanelOpen && (
        <WorkspaceSettings size={workspace} onChange={setWorkspace} onClose={() => setWorkspacePanelOpen(false)} />
      )}
      <MouseIndicator onOpenShortcuts={() => setShortcutsOpen(true)} />
      {shortcutsOpen && <KeyBindingsPanel onClose={() => setShortcutsOpen(false)} />}
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
      {computingCollisions && <div className="collision-computing-indicator">Computing collisions...</div>}
    </div>
  );
}
