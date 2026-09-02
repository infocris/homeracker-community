import { useState, useCallback, useEffect, useRef, useSyncExternalStore, useMemo } from "react";
import { ViewportCanvas } from "./ViewportCanvas";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { BOMPanel } from "./BOMPanel";
import { AssemblyState } from "../assembly/AssemblyState";
import { HistoryManager, type Command } from "../assembly/HistoryManager";
import type {
  InteractionMode,
  GridPosition,
  PlacedPart,
  Axis,
  Rotation3,
  RotationStep,
  ClipboardData,
  DrawAxis,
} from "../types";
import { PART_CATALOG, getPartDefinition } from "../data/catalog";
import {
  bestPartForSize,
  clampToSupportLength,
  orientationForSize,
  placedPartBounds,
  IDENTITY_ROTATION,
} from "../assembly/part-sizing";
import { resolveDraw } from "../assembly/draw";
import { rotateBlock } from "../assembly/block-rotation";
import {
  type AttachmentPoint,
  type ConnectorAdaptation,
  type PointPlacement,
  adaptiveConnectorsFor,
  attachmentPointsOf,
  compatiblePartsAt,
  nearestAttachmentPoint,
  branchDirectionsAt,
  placementAtPoint,
  replacementSuggestionsAt,
  targetCellOf,
  throughDirectionsAt,
  topologySuggestionsAt,
} from "../assembly/compatibility";
import {
  findBestSnap,
  findSnapPoints,
  findBestConnectorSnap,
  findConnectorSnapPoints,
  computeAutoRotation,
} from "../assembly/snap";
import {
  computeGroundLift,
  getWorldCells,
  nextOrientation,
  clampToWorkspace,
  rotateGridCells,
} from "../assembly/grid-utils";
import { detectCollidingPartIds, detectCollidingPartIdsMesh } from "../assembly/collision";
import {
  placementCollides,
  placementFloor,
  placementIsGrounded,
  restOnCollision,
  settleWithGravity,
} from "../assembly/gravity";
import {
  restoreCustomParts,
  importModelFile,
  isCustomPart,
  getEmbeddedCustomParts,
  restoreEmbeddedCustomParts,
} from "../data/custom-parts";
import { encodeAssemblyToHash, decodeAssemblyFromHash, hasCustomParts } from "../sharing/url-sharing";

/** True for an element that owns its own copy/paste/undo behaviour. */
function isTextEntry(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Global singleton instances
const assembly = new AssemblyState();
const history = new HistoryManager();

const STORAGE_KEY = "homeracker-scene";
const INVENTORY_STORAGE_KEY = "homeracker-inventory";

// Restore custom parts (IndexedDB) THEN assembly (localStorage or URL hash).
// Custom part definitions must exist before deserialize() resolves their IDs.
const initPromise = restoreCustomParts()
  .catch(() => {}) // IndexedDB may be unavailable
  .then(async () => {
    // URL hash takes priority over localStorage
    if (location.hash.startsWith("#scene=")) {
      const data = await decodeAssemblyFromHash(location.hash);
      if (data) {
        assembly.deserialize(data);
        window.history.replaceState(null, "", location.pathname + location.search);
        return;
      }
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) assembly.deserialize(JSON.parse(saved));
    } catch {
      // Ignore corrupt/missing data
    }
  });

// Auto-persist scene to localStorage on every change
assembly.subscribe(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(assembly.serialize()));
  } catch {
    // Ignore quota errors
  }
});

// Expose for e2e testing
(window as any).__assembly = assembly;
(window as any).__snap = {
  findBestSnap,
  findSnapPoints,
  findBestConnectorSnap,
  findConnectorSnapPoints,
  computeAutoRotation,
};
(window as any).__importSTL = importModelFile; // backward compat for e2e
(window as any).__importModel = importModelFile;
(window as any).__computeGroundLift = computeGroundLift;
(window as any).__collision = {
  detectCollidingPartIds,
  detectCollidingPartIdsMesh,
};
(window as any).__placedPartBounds = placedPartBounds;
(window as any).__resolveDraw = resolveDraw;
(window as any).__rotateBlock = rotateBlock;
(window as any).__compat = {
  attachmentPointsOf,
  nearestAttachmentPoint,
  compatiblePartsAt,
  branchDirectionsAt,
  throughDirectionsAt,
  topologySuggestionsAt,
  replacementSuggestionsAt,
  adaptiveConnectorsFor,
};
(window as any).__gravity = {
  placementCollides,
  placementFloor,
  placementIsGrounded,
  restOnCollision,
  settleWithGravity,
};

type PartSpec = {
  definitionId: string;
  position: GridPosition;
  rotation?: Rotation3;
  /** Given wherever it is known: two identical bars may share a cell across axes */
  orientation?: Axis;
};

/**
 * Removes one part per spec, matched on what the part is rather than on its id.
 *
 * Ids must not be captured when a command is built. Every move is a remove plus an
 * add, so a part comes back with a fresh id, and an id noted at build time goes stale
 * the moment any neighbouring command in the stack runs. That is what duplicated a
 * part on a second undo: the first undo reissued the id the older command was waiting
 * to remove, so nothing was removed and the old part was added alongside it.
 */
function removeMatchingParts(specs: PartSpec[]): void {
  const claimed = new Set<string>();
  for (const spec of specs) {
    const match = assembly.getAllParts().find((p) => {
      if (claimed.has(p.instanceId)) return false;
      if (p.definitionId !== spec.definitionId) return false;
      if (
        p.position[0] !== spec.position[0] ||
        p.position[1] !== spec.position[1] ||
        p.position[2] !== spec.position[2]
      )
        return false;
      if (
        spec.rotation &&
        (p.rotation[0] !== spec.rotation[0] || p.rotation[1] !== spec.rotation[1] || p.rotation[2] !== spec.rotation[2])
      )
        return false;
      // The sparse collision rules let two identical bars cross on one cell, so the
      // axis a support runs along is part of what names it
      if (spec.orientation !== undefined && p.orientation !== spec.orientation) return false;
      return true;
    });
    if (!match) continue;
    claimed.add(match.instanceId);
    assembly.removePart(match.instanceId);
  }
}

/**
 * The cell the next turn pivots about: a spot picked on the part if there is one, the
 * pivot a run of turns is already holding, a lone part's own anchor, or the cell
 * nearest the middle of a set turning as one body.
 *
 * A plain function, so the turn and the rings that offer it read the same answer from
 * the same inputs. Going through a ref assigned during render was not reliable — the
 * handler could see a value from a different render than the one the rings were drawn
 * from, and the pivot then walked a cell at every other turn.
 */
function resolveRotationPivot(
  selected: PlacedPart[],
  point: AttachmentPoint | null,
  held: { ids: string[]; cell: GridPosition } | null,
): GridPosition | null {
  if (selected.length === 0) return null;
  if (point && selected.length === 1) return [...point.cell] as GridPosition;

  const ids = new Set(selected.map((p) => p.instanceId));
  if (held && held.ids.length === selected.length && held.ids.every((id) => ids.has(id))) {
    return [...held.cell] as GridPosition;
  }

  if (selected.length === 1) return [...selected[0].position] as GridPosition;

  const min: GridPosition = [Infinity, Infinity, Infinity];
  const max: GridPosition = [-Infinity, -Infinity, -Infinity];
  for (const part of selected) {
    const bounds = placedPartBounds(part);
    if (!bounds) continue;
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], bounds.min[i]);
      max[i] = Math.max(max[i], bounds.min[i] + bounds.size[i] - 1);
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return [0, 1, 2].map((i) => Math.round((min[i] + max[i]) / 2)) as GridPosition;
}

/** The part standing at this definition and position — how a moved part's new id is found */
function findPlacedPart(definitionId: string, position: GridPosition): PlacedPart | undefined {
  return assembly
    .getAllParts()
    .find(
      (p) =>
        p.definitionId === definitionId &&
        p.position[0] === position[0] &&
        p.position[1] === position[1] &&
        p.position[2] === position[2],
    );
}

export function App() {
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<InteractionMode>({ type: "select" });
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set());
  const [flashPartId, setFlashPartId] = useState<string | null>(null);
  const [flashDefinitionId, setFlashDefinitionId] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Record<string, number>>({});

  const handleFlashPart = useCallback((instanceId: string) => {
    setFlashPartId(instanceId);
    setTimeout(() => setFlashPartId(null), 600);
  }, []);

  const handleFlashDefinition = useCallback((definitionId: string) => {
    setFlashDefinitionId(definitionId);
    setTimeout(() => setFlashDefinitionId(null), 600);
  }, []);

  const handleSetInventory = useCallback((newInventory: Record<string, number>) => {
    setInventory(newInventory);
    try {
      localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(newInventory));
    } catch {
      /* ignore quota errors */
    }
  }, []);

  // Wait for custom parts + assembly restore before rendering
  useEffect(() => {
    initPromise.then(() => {
      // Restore inventory from localStorage
      try {
        const saved = localStorage.getItem(INVENTORY_STORAGE_KEY);
        if (saved) setInventory(JSON.parse(saved));
      } catch {
        /* ignore */
      }
      setReady(true);
    });
  }, []);

  // Subscribe to assembly changes for re-renders
  const snapshot = useSyncExternalStore(
    (cb) => assembly.subscribe(cb),
    () => assembly.getSnapshot(),
  );

  /**
   * Connectors a deliberate act has released. They are held in place otherwise: a
   * connector is the joint the parts around it were aimed at, so dragging one loose
   * by accident undoes more than it looks like it does. The lock is implicit — no
   * gesture applies it — and only an explicit unlock lifts it.
   */
  const [unlockedPartIds, setUnlockedPartIds] = useState<Set<string>>(new Set());

  // The move handlers are deliberately dependency-free and outlive any one render,
  // so they read the lock through a ref rather than closing over a stale set
  const lockedPartIdsRef = useRef<Set<string>>(new Set());
  /**
   * The cell a run of turns keeps turning about, with the selection it belongs to.
   *
   * A turn reissues the parts it moves, and a part's anchor is the min corner of its
   * cells — which the turn moves. Taking the pivot from the anchor each time therefore
   * made it walk: three turns about "the same" point left the part four cells from
   * where it started. Holding it fixes that, and storing it against the ids it was
   * computed for means selecting anything else drops it without a word from anyone.
   */
  const heldPivotRef = useRef<{ ids: string[]; cell: GridPosition } | null>(null);
  const selectedPointRef = useRef<AttachmentPoint | null>(null);

  const lockedPartIds = useMemo(() => {
    const ids = new Set<string>();
    for (const part of snapshot.parts) {
      if (getPartDefinition(part.definitionId)?.category !== "connector") continue;
      if (!unlockedPartIds.has(part.instanceId)) ids.add(part.instanceId);
    }
    return ids;
  }, [snapshot.parts, unlockedPartIds]);

  lockedPartIdsRef.current = lockedPartIds;

  /** The selected connector, for the inspector at the top of the list */
  const inspected = useMemo(() => {
    if (selectedPartIds.size !== 1) return null;
    const part = assembly.getPartById([...selectedPartIds][0]);
    const def = part ? getPartDefinition(part.definitionId) : undefined;
    if (!def || def.category !== "connector") return null;
    return { definitionId: def.id, name: def.name };
  }, [selectedPartIds, snapshot.parts]);

  /** The selected connectors, and whether the lock is off on all of them */
  const lockSelection = useMemo(() => {
    const connectors = [...selectedPartIds].filter((id) => {
      const part = assembly.getPartById(id);
      return part ? getPartDefinition(part.definitionId)?.category === "connector" : false;
    });
    if (connectors.length === 0) return null;
    return { ids: connectors, unlocked: connectors.every((id) => unlockedPartIds.has(id)) };
  }, [selectedPartIds, unlockedPartIds, snapshot.parts]);

  const handleToggleLock = useCallback(() => {
    if (!lockSelection) return;
    const { ids, unlocked } = lockSelection;
    setUnlockedPartIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (unlocked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [lockSelection]);

  /**
   * A move is a remove plus an add, so a part comes back with a new id. Carrying the
   * release across keeps an unlocked connector unlocked until the lock is deliberately
   * put back, instead of snapping shut the moment the part is touched.
   */
  const keepUnlocked = useCallback((pairs: Iterable<[string, string]>) => {
    setUnlockedPartIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const [oldId, newId] of pairs) {
        if (next.delete(oldId)) {
          next.add(newId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const handleLockedPartDrag = useCallback(() => {
    setToast("Connector locked — use Unlock in the toolbar to move it");
    setTimeout(() => setToast(null), 2500);
  }, []);

  const handlePlacePart = useCallback(
    (
      definitionId: string,
      position: GridPosition,
      rotation: PlacedPart["rotation"] = [0, 0, 0],
      orientation?: Axis,
    ) => {
      const cmd: Command = {
        description: `Place ${definitionId}`,
        execute() {
          assembly.addPart(definitionId, position, rotation, orientation);
        },
        undo() {
          // Find the most recently added part with this definition at this position
          const parts = assembly.getAllParts();
          const match = parts.find(
            (p) =>
              p.definitionId === definitionId &&
              p.position[0] === position[0] &&
              p.position[1] === position[1] &&
              p.position[2] === position[2],
          );
          if (match) assembly.removePart(match.instanceId);
        },
      };
      history.execute(cmd);
    },
    [],
  );

  const handleDeleteSelected = useCallback(() => {
    if (selectedPartIds.size === 0) return;
    const partsToDelete = [...selectedPartIds]
      .map((id) => assembly.getPartById(id))
      .filter((p): p is PlacedPart => !!p)
      .map((p) => ({ ...p }));
    if (partsToDelete.length === 0) return;

    const cmd: Command = {
      description: `Delete ${partsToDelete.length} part(s)`,
      execute() {
        removeMatchingParts(partsToDelete);
      },
      undo() {
        for (const p of partsToDelete) {
          assembly.addPart(p.definitionId, p.position, p.rotation, p.orientation, p.color);
        }
      },
    };
    history.execute(cmd);
    setSelectedPartIds(new Set());
  }, [selectedPartIds]);

  const handleMovePart = useCallback(
    (
      instanceId: string,
      newPosition: GridPosition,
      newRotation?: PlacedPart["rotation"],
      newOrientation?: Axis,
      adaptations?: ConnectorAdaptation[],
    ) => {
      const part = assembly.getPartById(instanceId);
      if (!part) return;
      // The authority on the lock, whichever gesture asked for the move
      if (lockedPartIdsRef.current.has(instanceId)) return;

      const rotation = newRotation ?? part.rotation;
      const orientation = newOrientation ?? part.orientation;
      const samePosition =
        part.position[0] === newPosition[0] &&
        part.position[1] === newPosition[1] &&
        part.position[2] === newPosition[2];
      const sameRotation =
        part.rotation[0] === rotation[0] && part.rotation[1] === rotation[1] && part.rotation[2] === rotation[2];
      const sameOrientation = part.orientation === orientation;
      if (samePosition && sameRotation && sameOrientation) return; // No-op

      const oldPosition = part.position;
      const oldRotation = part.rotation;
      const oldOrientation = part.orientation;
      const oldColor = part.color;
      const definitionId = part.definitionId;

      /*
       * Connectors the drop asks to change travel with the move as one command: the
       * gesture was single, so the undo should be too. Captured by value, since the
       * parts they name will have been reissued by the time undo runs.
       */
      const adapted = (adaptations ?? []).flatMap((adaptation) => {
        const connector = assembly.getPartById(adaptation.instanceId);
        if (!connector) return [];
        return [
          {
            before: {
              definitionId: connector.definitionId,
              position: [...connector.position] as GridPosition,
              rotation: [...connector.rotation] as Rotation3,
              orientation: connector.orientation,
              color: connector.color,
            },
            after: {
              definitionId: adaptation.definitionId,
              position: [...adaptation.cell] as GridPosition,
              rotation: adaptation.rotation,
              orientation: connector.orientation,
              color: connector.color,
            },
          },
        ];
      });

      const cmd: Command = {
        description:
          adapted.length > 0 ? `Move ${definitionId} and adapt ${adapted.length} connector(s)` : `Move ${definitionId}`,
        execute() {
          removeMatchingParts([
            { definitionId, position: oldPosition, rotation: oldRotation, orientation: oldOrientation },
          ]);
          for (const swap of adapted) {
            removeMatchingParts([swap.before]);
            assembly.addPart(
              swap.after.definitionId,
              swap.after.position,
              swap.after.rotation,
              swap.after.orientation,
              swap.after.color,
            );
          }
          assembly.addPart(definitionId, newPosition, rotation, orientation, oldColor);
        },
        undo() {
          for (const swap of adapted) {
            removeMatchingParts([swap.after]);
            assembly.addPart(
              swap.before.definitionId,
              swap.before.position,
              swap.before.rotation,
              swap.before.orientation,
              swap.before.color,
            );
          }
          // Find the part at the new position and move it back
          const parts = assembly.getAllParts();
          const match = parts.find(
            (p) =>
              p.definitionId === definitionId &&
              p.position[0] === newPosition[0] &&
              p.position[1] === newPosition[1] &&
              p.position[2] === newPosition[2],
          );
          if (match) {
            assembly.removePart(match.instanceId);
            assembly.addPart(definitionId, oldPosition, oldRotation, oldOrientation, oldColor);
          }
        },
      };
      history.execute(cmd);
      const moved = findPlacedPart(definitionId, newPosition);
      if (moved) keepUnlocked([[instanceId, moved.instanceId]]);
    },
    [keepUnlocked],
  );

  const handleMoveSelectedParts = useCallback(
    (primaryId: string, newPosition: GridPosition, newRotation?: PlacedPart["rotation"], newOrientation?: Axis) => {
      const primary = assembly.getPartById(primaryId);
      if (!primary) return;

      const delta: GridPosition = [
        newPosition[0] - primary.position[0],
        newPosition[1] - primary.position[1],
        newPosition[2] - primary.position[2],
      ];
      if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0 && !newRotation && !newOrientation) return;

      // Snapshot all selected parts before moving
      const partsToMove: {
        id: string;
        def: string;
        oldPos: GridPosition;
        oldRot: Rotation3;
        oldOrient?: Axis;
        color?: string;
        newPos: GridPosition;
        newRot: Rotation3;
        newOrient?: Axis;
      }[] = [];
      for (const id of selectedPartIds) {
        const part = assembly.getPartById(id);
        if (!part) continue;
        const isPrimary = id === primaryId;
        partsToMove.push({
          id,
          def: part.definitionId,
          oldPos: part.position,
          oldRot: part.rotation,
          oldOrient: part.orientation,
          color: part.color,
          newPos: isPrimary
            ? newPosition
            : [part.position[0] + delta[0], part.position[1] + delta[1], part.position[2] + delta[2]],
          newRot: isPrimary ? (newRotation ?? part.rotation) : part.rotation,
          newOrient: isPrimary ? (newOrientation ?? part.orientation) : part.orientation,
        });
      }

      const cmd: Command = {
        description: `Move ${partsToMove.length} part(s)`,
        execute() {
          // Remove all first, then re-add at new positions (avoids collision with each other)
          removeMatchingParts(
            partsToMove.map((p) => ({
              definitionId: p.def,
              position: p.oldPos,
              rotation: p.oldRot,
              orientation: p.oldOrient,
            })),
          );
          for (const p of partsToMove) assembly.addPart(p.def, p.newPos, p.newRot, p.newOrient, p.color);
        },
        undo() {
          // Remove parts at new positions, re-add at old positions
          const allParts = assembly.getAllParts();
          for (const p of partsToMove) {
            const match = allParts.find(
              (ap) =>
                ap.definitionId === p.def &&
                ap.position[0] === p.newPos[0] &&
                ap.position[1] === p.newPos[1] &&
                ap.position[2] === p.newPos[2],
            );
            if (match) assembly.removePart(match.instanceId);
          }
          for (const p of partsToMove) assembly.addPart(p.def, p.oldPos, p.oldRot, p.oldOrient, p.color);
        },
      };
      history.execute(cmd);
      keepUnlocked(
        partsToMove
          .map((p) => [p.id, findPlacedPart(p.def, p.newPos)?.instanceId] as const)
          .filter((pair): pair is [string, string] => !!pair[1]),
      );
    },
    [selectedPartIds, keepUnlocked],
  );

  /**
   * Slides parts by a whole number of cells as one undoable step, and reports the
   * ids they come back with — a move is a remove plus an add, so each part is
   * reissued. Returns null when nothing moves: an offset of zero, no part left to
   * move, or a step that would push something out of the buildable area, in which
   * case the whole group stays put rather than deforming against the wall.
   */
  const shiftParts = useCallback(
    (ids: Iterable<string>, delta: GridPosition, description: string): Map<string, string> | null => {
      const [dx, dy, dz] = delta;
      if (dx === 0 && dy === 0 && dz === 0) return null;

      const moving: {
        id: string;
        def: string;
        oldPos: GridPosition;
        rot: Rotation3;
        orient?: Axis;
        color?: string;
      }[] = [];
      for (const id of ids) {
        const part = assembly.getPartById(id);
        if (!part) continue;
        moving.push({
          id,
          def: part.definitionId,
          oldPos: part.position,
          rot: part.rotation,
          orient: part.orientation,
          color: part.color,
        });
      }
      if (moving.length === 0) return null;

      const movedPositionOf = (p: (typeof moving)[number]): GridPosition => [
        p.oldPos[0] + dx,
        p.oldPos[1] + dy,
        p.oldPos[2] + dz,
      ];

      for (const p of moving) {
        const def = getPartDefinition(p.def);
        if (!def) continue;
        const next = movedPositionOf(p);
        const bounded = clampToWorkspace(rotateGridCells(def.gridCells, p.rot), next, p.orient);
        if (bounded[0] !== next[0] || bounded[1] !== next[1] || bounded[2] !== next[2]) return null;
      }

      /** The part now standing where one of the moved parts was put */
      const findMoved = (p: (typeof moving)[number]) => {
        const pos = movedPositionOf(p);
        return assembly
          .getAllParts()
          .find(
            (ap) =>
              ap.definitionId === p.def &&
              ap.position[0] === pos[0] &&
              ap.position[1] === pos[1] &&
              ap.position[2] === pos[2],
          );
      };

      const cmd: Command = {
        description,
        execute() {
          removeMatchingParts(
            moving.map((p) => ({ definitionId: p.def, position: p.oldPos, rotation: p.rot, orientation: p.orient })),
          );
          for (const p of moving) assembly.addPart(p.def, movedPositionOf(p), p.rot, p.orient, p.color);
        },
        undo() {
          for (const p of moving) {
            const match = findMoved(p);
            if (match) assembly.removePart(match.instanceId);
          }
          for (const p of moving) assembly.addPart(p.def, p.oldPos, p.rot, p.orient, p.color);
        },
      };
      history.execute(cmd);

      const remap = new Map<string, string>();
      for (const p of moving) {
        const match = findMoved(p);
        if (match) remap.set(p.id, match.instanceId);
      }
      keepUnlocked(remap);
      return remap;
    },
    [keepUnlocked],
  );

  const handleNudgeParts = useCallback(
    (dx: number, dy: number, dz: number) => {
      const ids = [...selectedPartIds];
      if (ids.length === 0) return;
      // A locked connector on its own does not budge. Inside a wider selection it
      // travels with the block, which keeps the joint where its parts expect it.
      if (ids.length === 1 && lockedPartIdsRef.current.has(ids[0])) return;

      const remap = shiftParts(ids, [dx, dy, dz], `Nudge ${ids.length} part(s)`);
      if (!remap) return;
      setSelectedPartIds(new Set(remap.values()));
    },
    [selectedPartIds, shiftParts],
  );

  /** Slide the whole assembly so it stands in the middle of the buildable area. */
  const handleCentreAssembly = useCallback(() => {
    const parts = assembly.getAllParts();
    if (parts.length === 0) return;

    // Measured over occupied cells, not part origins, so a long bar counts its length
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const part of parts) {
      const def = getPartDefinition(part.definitionId);
      if (!def) continue;
      for (const cell of getWorldCells(
        rotateGridCells(def.gridCells, part.rotation),
        part.position,
        part.orientation ?? "y",
      )) {
        minX = Math.min(minX, cell[0]);
        maxX = Math.max(maxX, cell[0]);
        minZ = Math.min(minZ, cell[2]);
        maxZ = Math.max(maxZ, cell[2]);
      }
    }
    if (!Number.isFinite(minX)) return;

    // Only across the floor: the buildable area rests on the ground, and lifting the
    // assembly to centre it in height would stand it on nothing.
    const delta: GridPosition = [-Math.round((minX + maxX) / 2), 0, -Math.round((minZ + maxZ) / 2)];
    if (delta[0] === 0 && delta[2] === 0) {
      setToast("The assembly is already centred");
      setTimeout(() => setToast(null), 2000);
      return;
    }

    const remap = shiftParts(
      parts.map((p) => p.instanceId),
      delta,
      "Centre the assembly",
    );
    if (!remap) {
      setToast("Centring would push the assembly outside the buildable area");
      setTimeout(() => setToast(null), 2500);
      return;
    }
    setSelectedPartIds((prev) => new Set([...prev].map((id) => remap.get(id) ?? id)));
  }, [shiftParts]);

  /**
   * Turns the selection a quarter about an axis: one part on itself, a set of parts as
   * one body.
   *
   * A body turn was the missing half. Bumping each part's own rotation and leaving its
   * position alone spins the pieces where they stand — the layout never turns, which
   * for anything but a single part is not a rotation at all.
   */
  const handleRotateSelectedParts = useCallback(
    (axis: 0 | 1 | 2, turns: 1 | 3 = 1) => {
      const selected = [...selectedPartIds].map((id) => assembly.getPartById(id)).filter((p): p is PlacedPart => !!p);
      if (selected.length === 0) return;

      const pivot = resolveRotationPivot(selected, selectedPointRef.current, heldPivotRef.current) ?? undefined;

      /** Whether every part of a turned body still stands inside the buildable area */
      const fits = (candidate: ReturnType<typeof rotateBlock>) =>
        !!candidate &&
        candidate.every((t) => {
          const def = getPartDefinition(t.definitionId);
          if (!def) return true;
          const bounded = clampToWorkspace(rotateGridCells(def.gridCells, t.rotation), t.position, t.orientation);
          return bounded[0] === t.position[0] && bounded[1] === t.position[1] && bounded[2] === t.position[2];
        });

      /*
       * A quarter turn that cannot be made is skipped rather than refused: the body
       * carries on to the half turn, and to the three-quarter turn if that will not do
       * either. Turning a shelf standing on the floor asks for exactly this — the first
       * quarter would bury half of it, while the half turn is perfectly fine.
       */
      const order: (1 | 2 | 3)[] = turns === 1 ? [1, 2, 3] : [3, 2, 1];
      let turned: ReturnType<typeof rotateBlock> = null;
      for (const quarters of order) {
        const candidate = rotateBlock(selected, axis, quarters, pivot);
        if (fits(candidate)) {
          turned = candidate;
          break;
        }
      }

      if (!turned) {
        setToast("No turn about that axis leaves the selection inside the buildable area");
        setTimeout(() => setToast(null), 2500);
        return;
      }

      const before = selected.map((p) => ({
        id: p.instanceId,
        definitionId: p.definitionId,
        position: p.position,
        rotation: p.rotation,
        orientation: p.orientation,
        color: p.color,
      }));

      /*
       * A turn moves bar ends just as a drag does, so the connectors they leave and
       * meet are recomputed the same way — grown for an end that arrives with nowhere
       * to land, simplified for one whose arm falls idle. Connectors inside the
       * selection are turning with the body and are left alone.
       */
      const adapted = (
        assembly.adaptiveEnabled
          ? turned
              .filter((t) => getPartDefinition(t.definitionId)?.category === "support")
              .flatMap((t) =>
                adaptiveConnectorsFor(assembly, {
                  instanceId: t.id,
                  definitionId: t.definitionId,
                  position: t.position,
                  rotation: t.rotation,
                  orientation: t.orientation,
                }),
              )
              .filter((a) => !selectedPartIds.has(a.instanceId))
          : []
      )
        .filter((a, i, all) => all.findIndex((b) => b.instanceId === a.instanceId) === i)
        .flatMap((a) => {
          const connector = assembly.getPartById(a.instanceId);
          if (!connector) return [];
          return [
            {
              before: {
                definitionId: connector.definitionId,
                position: [...connector.position] as GridPosition,
                rotation: [...connector.rotation] as Rotation3,
                orientation: connector.orientation,
                color: connector.color,
              },
              after: {
                definitionId: a.definitionId,
                position: [...a.cell] as GridPosition,
                rotation: a.rotation,
                orientation: connector.orientation,
                color: connector.color,
              },
            },
          ];
        });

      // The ids the turn issues, kept by the command itself rather than looked up
      // afterwards: two parts of one definition can share a cell, so definition and
      // position do not always name one part.
      let created: string[] = [];

      const cmd: Command = {
        description:
          adapted.length > 0
            ? `Rotate ${before.length} part(s) and adapt ${adapted.length} connector(s)`
            : `Rotate ${before.length} part(s)`,
        execute() {
          removeMatchingParts(before);
          for (const swap of adapted) {
            removeMatchingParts([swap.before]);
            assembly.addPart(
              swap.after.definitionId,
              swap.after.position,
              swap.after.rotation,
              swap.after.orientation,
              swap.after.color,
            );
          }
          created = [];
          for (const t of turned) {
            const id = assembly.addPart(t.definitionId, t.position, t.rotation, t.orientation, t.color);
            if (id) created.push(id);
          }
          setSelectedPartIds(new Set(created));
        },
        undo() {
          removeMatchingParts(turned);
          for (const swap of adapted) {
            removeMatchingParts([swap.after]);
            assembly.addPart(
              swap.before.definitionId,
              swap.before.position,
              swap.before.rotation,
              swap.before.orientation,
              swap.before.color,
            );
          }
          const restored: string[] = [];
          for (const p of before) {
            const id = assembly.addPart(p.definitionId, p.position, p.rotation, p.orientation, p.color);
            if (id) restored.push(id);
          }
          setSelectedPartIds(new Set(restored));
        },
      };
      history.execute(cmd);
      if (pivot) heldPivotRef.current = { ids: [...created], cell: pivot };
      keepUnlocked(before.map((p, i) => [p.id, created[i]] as [string, string]).filter((pair) => !!pair[1]));
    },
    [selectedPartIds, keepUnlocked],
  );

  const handleOrientSelectedParts = useCallback(() => {
    if (selectedPartIds.size === 0) return;

    const partsToOrient: {
      id: string;
      def: string;
      pos: GridPosition;
      rot: Rotation3;
      oldOrient: Axis;
      color?: string;
    }[] = [];
    for (const id of selectedPartIds) {
      const part = assembly.getPartById(id);
      if (!part) continue;
      const def = getPartDefinition(part.definitionId);
      if (def?.category !== "support") continue;
      partsToOrient.push({
        id,
        def: part.definitionId,
        pos: part.position,
        rot: part.rotation,
        oldOrient: part.orientation ?? "y",
        color: part.color,
      });
    }
    if (partsToOrient.length === 0) return;

    const cmd: Command = {
      description: `Orient ${partsToOrient.length} support(s)`,
      execute() {
        removeMatchingParts(
          partsToOrient.map((p) => ({
            definitionId: p.def,
            position: p.pos,
            rotation: p.rot,
            orientation: p.oldOrient,
          })),
        );
        for (const p of partsToOrient) {
          assembly.addPart(p.def, p.pos, p.rot, nextOrientation(p.oldOrient), p.color);
        }
      },
      undo() {
        const allParts = assembly.getAllParts();
        for (const p of partsToOrient) {
          const match = allParts.find(
            (ap) =>
              ap.definitionId === p.def &&
              ap.position[0] === p.pos[0] &&
              ap.position[1] === p.pos[1] &&
              ap.position[2] === p.pos[2],
          );
          if (match) assembly.removePart(match.instanceId);
        }
        for (const p of partsToOrient) assembly.addPart(p.def, p.pos, p.rot, p.oldOrient, p.color);
      },
    };
    history.execute(cmd);
    // Re-select oriented parts
    const allParts = assembly.getAllParts();
    const newIds = new Set<string>(selectedPartIds);
    const released: [string, string][] = [];
    for (const p of partsToOrient) {
      newIds.delete(p.id);
      const match = allParts.find(
        (ap) =>
          ap.definitionId === p.def &&
          ap.position[0] === p.pos[0] &&
          ap.position[1] === p.pos[1] &&
          ap.position[2] === p.pos[2],
      );
      if (match) {
        newIds.add(match.instanceId);
        released.push([p.id, match.instanceId]);
      }
    }
    setSelectedPartIds(newIds);
    keepUnlocked(released);
  }, [selectedPartIds, keepUnlocked]);

  /** Spot picked by re-clicking an already-selected part */
  const [selectedPoint, setSelectedPoint] = useState<AttachmentPoint | null>(null);
  // On by default: picking a spot is a deliberate act, so narrowing the catalog to
  // what fits there is the useful outcome. Unticking widens it back.
  const [filterByPosition, setFilterByPosition] = useState(true);

  const handleClickPart = useCallback(
    (instanceId: string, shiftKey: boolean, gridPoint?: GridPosition) => {
      if (mode.type !== "select") return;

      // Clicking the part that is already the whole selection picks a spot on it
      // rather than deselecting, so the same gesture drills down one level.
      const alreadySoleSelection = !shiftKey && selectedPartIds.size === 1 && selectedPartIds.has(instanceId);
      if (alreadySoleSelection && gridPoint) {
        const part = assembly.getPartById(instanceId);
        const next = part ? nearestAttachmentPoint(part, gridPoint) : null;
        // Re-clicking the spot already picked clears it, then a further click deselects
        setSelectedPoint((prev) =>
          prev && next && prev.direction === next.direction && prev.cell.join() === next.cell.join() ? null : next,
        );
        if (next) return;
      }

      setSelectedPoint(null);
      setSelectedPartIds((prev) => {
        if (shiftKey) {
          const next = new Set(prev);
          if (next.has(instanceId)) next.delete(instanceId);
          else next.add(instanceId);
          return next;
        }
        // Toggle single selection
        if (prev.size === 1 && prev.has(instanceId)) return new Set();
        return new Set([instanceId]);
      });
    },
    [mode, selectedPartIds],
  );

  /** What the rings draw — the same answer the turn itself will get */
  const rotationPivot = useMemo<GridPosition | null>(
    () =>
      resolveRotationPivot(
        snapshot.parts.filter((p) => selectedPartIds.has(p.instanceId)),
        selectedPoint,
        heldPivotRef.current,
      ),
    [selectedPartIds, selectedPoint, snapshot.parts],
  );
  selectedPointRef.current = selectedPoint;

  // A spot only means something while its part is the selection
  const activePoint = useMemo(() => {
    if (!selectedPoint || selectedPartIds.size !== 1) return null;
    return selectedPoint;
  }, [selectedPoint, selectedPartIds]);

  /** Connectors whose arm layout matches the branches meeting at the picked spot */
  const topology = useMemo(() => {
    if (!activePoint) return null;
    const cell = targetCellOf(activePoint);
    const found = topologySuggestionsAt(assembly, cell);
    return found.suggestions.length > 0 || found.branches.length > 0 ? { cell, ...found } : null;
    // snapshot.parts is in the deps because the branches depend on what is placed
  }, [activePoint, snapshot.parts]);

  /** Suggestion under the cursor in the sidebar, ghosted at its spot */
  const [previewSuggestion, setPreviewSuggestion] = useState<{
    definitionId: string;
    position: GridPosition;
    rotation: Rotation3;
    /** A bar lies along an axis; without this the ghost would stand the wrong way */
    orientation?: Axis;
    /** Connector this one would stand in for, hidden while the ghost takes its place */
    replaces?: string;
  } | null>(null);

  // The suggestion list unmounts when the picked spot changes, and an unmounting
  // element fires no pointerleave — so drop the ghost here rather than rely on it
  useEffect(() => {
    setPreviewSuggestion(null);
  }, [activePoint, selectedPartIds]);

  /** Drop a suggestion straight onto the spot it was suggested for */
  const handlePlaceAtPoint = useCallback(
    (definitionId: string, position: GridPosition, rotation: Rotation3, orientation?: Axis) => {
      handlePlacePart(definitionId, position, rotation, orientation);
      setSelectedPoint(null);
      setPreviewSuggestion(null);
      // Select what was just placed, so the junction views carry on showing it
      // Reversed rather than findLast: the tsconfig lib predates it
      const placed = [...assembly.getAllParts()]
        .reverse()
        .find(
          (p) =>
            p.definitionId === definitionId &&
            p.position[0] === position[0] &&
            p.position[1] === position[1] &&
            p.position[2] === position[2],
        );
      if (placed) setSelectedPartIds(new Set([placed.instanceId]));
    },
    [handlePlacePart],
  );

  /**
   * Connectors that could take the place of the selected one. Offered on plain
   * selection — before any spot on it is picked — since replacing the connector and
   * attaching something to it are two different intents.
   */
  const replacement = useMemo(() => {
    if (activePoint || selectedPartIds.size !== 1) return null;
    const part = assembly.getPartById([...selectedPartIds][0]);
    if (!part) return null;
    const found = replacementSuggestionsAt(assembly, part);
    if (found.suggestions.length === 0) return null;
    return {
      instanceId: part.instanceId,
      definitionId: part.definitionId,
      rotation: part.rotation,
      cell: [...part.position] as GridPosition,
      ...found,
    };
    // snapshot.parts is in the deps because the branches and the clearances depend
    // on what is placed around the connector
  }, [activePoint, selectedPartIds, snapshot.parts]);

  /** Swap a placed connector for another one on the same cell. */
  const handleReplaceConnector = useCallback((instanceId: string, definitionId: string, rotation: Rotation3) => {
    const part = assembly.getPartById(instanceId);
    if (!part) return;
    const before: PlacedPart = { ...part, position: [...part.position], rotation: [...part.rotation] as Rotation3 };
    const sameRotation = before.rotation.every((step, i) => step === rotation[i]);
    if (before.definitionId === definitionId && sameRotation) return;

    const position = before.position;
    const cmd: Command = {
      description: `Replace ${before.definitionId} with ${definitionId}`,
      execute() {
        removeMatchingParts([
          {
            definitionId: before.definitionId,
            position: before.position,
            rotation: before.rotation,
            orientation: before.orientation,
          },
        ]);
        const newId = assembly.addPart(definitionId, position, rotation, before.orientation, before.color);
        if (newId) setSelectedPartIds(new Set([newId]));
      },
      undo() {
        const current = assembly
          .getAllParts()
          .find(
            (p) =>
              p.definitionId === definitionId &&
              p.position[0] === position[0] &&
              p.position[1] === position[1] &&
              p.position[2] === position[2],
          );
        if (current) assembly.removePart(current.instanceId);
        const restored = assembly.addPart(
          before.definitionId,
          before.position,
          before.rotation,
          before.orientation,
          before.color,
        );
        if (restored) setSelectedPartIds(new Set([restored]));
      },
    };
    history.execute(cmd);
    setPreviewSuggestion(null);
  }, []);

  /**
   * Where each catalog part would go if it were chosen for the picked spot.
   *
   * Worked out once and used three ways — to filter the list, to ghost a part under
   * the pointer, and to drop the one that is clicked — so the list cannot offer a
   * part the click would put somewhere else.
   */
  const placementsAtPoint = useMemo(() => {
    if (!activePoint || selectedPartIds.size !== 1) return null;
    const part = assembly.getPartById([...selectedPartIds][0]);
    if (!part) return null;
    const found = new Map<string, PointPlacement>();
    for (const def of PART_CATALOG) {
      const spot = placementAtPoint(assembly, part, activePoint, def);
      if (spot) found.set(def.id, spot);
    }
    return found;
    // snapshot.parts is in the deps because occupancy decides what still fits
  }, [activePoint, selectedPartIds, snapshot.parts]);

  const compatibleDefinitionIds = useMemo(() => {
    if (!filterByPosition || !placementsAtPoint) return null;
    return new Set(placementsAtPoint.keys());
  }, [filterByPosition, placementsAtPoint]);

  /**
   * Choosing a part from the library.
   *
   * With a spot picked on the selection, a part that fits it goes straight there —
   * the spot was the request, so asking for a click in the scene as well would be
   * asking twice. Anything that does not fit arms the cursor as before.
   */
  const handleSelectPart = useCallback(
    (definitionId: string) => {
      const spot = placementsAtPoint?.get(definitionId);
      if (spot) {
        handlePlaceAtPoint(definitionId, spot.position, spot.rotation, spot.orientation);
        return;
      }
      setMode({ type: "place", definitionId });
      setSelectedPartIds(new Set());
    },
    [placementsAtPoint, handlePlaceAtPoint],
  );

  const handleClickEmpty = useCallback(() => {
    setSelectedPartIds(new Set());
  }, []);

  const handleBoxSelect = useCallback((ids: string[]) => {
    setSelectedPartIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const handleEscape = useCallback(() => {
    setMode({ type: "select" });
    setSelectedPartIds(new Set());
  }, []);

  const handleDrawMode = useCallback((axis: DrawAxis) => {
    // Clicking the active axis leaves draw mode; the other axis switches to it
    setMode((prev) => (prev.type === "draw" && prev.axis === axis ? { type: "select" } : { type: "draw", axis }));
    setSelectedPartIds(new Set());
  }, []);

  const handleDraw = useCallback((anchor: GridPosition, size: [number, number, number]) => {
    // Same resolution the ghost used, so the part lands where the preview showed it
    const drawn = resolveDraw(assembly, anchor, size, assembly.gravityEnabled);
    if (!drawn) return;
    const { definitionId, orientation, position } = drawn;

    const cmd: Command = {
      description: `Draw ${definitionId}`,
      execute() {
        assembly.addPart(definitionId, position, IDENTITY_ROTATION, orientation);
      },
      undo() {
        const parts = assembly.getAllParts();
        const match = parts.find(
          (p) =>
            p.definitionId === definitionId &&
            p.position[0] === position[0] &&
            p.position[1] === position[1] &&
            p.position[2] === position[2],
        );
        if (match) assembly.removePart(match.instanceId);
      },
    };
    history.execute(cmd);
    const match = assembly
      .getAllParts()
      .find(
        (p) =>
          p.definitionId === definitionId &&
          p.position[0] === position[0] &&
          p.position[1] === position[1] &&
          p.position[2] === position[2],
      );
    if (match) setSelectedPartIds(new Set([match.instanceId]));
  }, []);

  const handleResizePart = useCallback((instanceId: string, position: GridPosition, size: [number, number, number]) => {
    const part = assembly.getPartById(instanceId);
    if (!part) return;
    const before: PlacedPart = { ...part, position: [...part.position] };

    // A support follows its box: it becomes the support of the new length. Dragging
    // past the longest one the catalog has stops there rather than breaking the part.
    if (getPartDefinition(before.definitionId)?.category !== "support") return;
    const capped = clampToSupportLength(size);
    const target = bestPartForSize(capped, "support");
    if (!target) return;

    const newDefId = target.id;
    const newOrientation = orientationForSize(target, capped);

    // Orientation belongs in this comparison: re-aiming a bar keeps its definition and
    // its min corner, so leaving it out made a pure rotation look like a no-op.
    if (
      before.definitionId === newDefId &&
      before.orientation === newOrientation &&
      before.position[0] === position[0] &&
      before.position[1] === position[1] &&
      before.position[2] === position[2]
    ) {
      return;
    }

    const cmd: Command = {
      description: `Resize ${newDefId}`,
      execute() {
        removeMatchingParts([
          {
            definitionId: before.definitionId,
            position: before.position,
            rotation: before.rotation,
            orientation: before.orientation,
          },
        ]);
        const newId = assembly.addPart(newDefId, position, IDENTITY_ROTATION, newOrientation, before.color);
        if (newId) setSelectedPartIds(new Set([newId]));
      },
      undo() {
        const current = assembly
          .getAllParts()
          .find(
            (p) =>
              p.definitionId === newDefId &&
              p.position[0] === position[0] &&
              p.position[1] === position[1] &&
              p.position[2] === position[2],
          );
        if (current) assembly.removePart(current.instanceId);
        const restored = assembly.addPart(
          before.definitionId,
          before.position,
          before.rotation,
          before.orientation,
          before.color,
        );
        if (restored) setSelectedPartIds(new Set([restored]));
      },
    };
    history.execute(cmd);
  }, []);

  const handleUndo = useCallback(() => {
    history.undo();
    setSelectedPartIds(new Set());
  }, []);
  const handleRedo = useCallback(() => {
    history.redo();
    setSelectedPartIds(new Set());
  }, []);

  // The system clipboard is best-effort: browsers gate reads behind a permission
  // that Firefox and Safari never grant to a page. This in-app buffer is what makes
  // copy → paste work every time; the system clipboard only adds cross-tab pasting.
  const clipboardRef = useRef<ClipboardData | null>(null);

  const handleCopy = useCallback(() => {
    if (selectedPartIds.size === 0) return;
    const parts = [...selectedPartIds].map((id) => assembly.getPartById(id)).filter((p): p is PlacedPart => !!p);
    if (parts.length === 0) return;

    const cx = parts.reduce((s, p) => s + p.position[0], 0) / parts.length;
    const cy = parts.reduce((s, p) => s + p.position[1], 0) / parts.length;
    const cz = parts.reduce((s, p) => s + p.position[2], 0) / parts.length;
    const centerX = Math.round(cx);
    const centerY = Math.round(cy);
    const centerZ = Math.round(cz);

    const clipboard: ClipboardData = {
      parts: parts.map((p) => ({
        definitionId: p.definitionId,
        offset: [p.position[0] - centerX, p.position[1] - centerY, p.position[2] - centerZ] as GridPosition,
        rotation: p.rotation,
        orientation: p.orientation,
        color: p.color,
      })),
    };
    clipboardRef.current = clipboard;
    navigator.clipboard.writeText(JSON.stringify({ homeracker: "clipboard", ...clipboard })).catch(() => {});
    setToast(`Copied ${parts.length} part(s)`);
    setTimeout(() => setToast(null), 2000);
  }, [selectedPartIds]);

  /** Parse pasted text, or null when it is not a HomeRacker payload. */
  const parseClipboardText = (text: string | null | undefined): ClipboardData | null => {
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      if (data?.homeracker !== "clipboard" || !Array.isArray(data.parts) || data.parts.length === 0) return null;
      return { parts: data.parts };
    } catch {
      return null;
    }
  };

  const handlePaste = useCallback((text?: string | null) => {
    const clipboard = parseClipboardText(text) ?? clipboardRef.current;
    if (!clipboard || clipboard.parts.length === 0) {
      setToast("Nothing to paste — copy a selection first (Ctrl/Cmd+C)");
      setTimeout(() => setToast(null), 2500);
      return;
    }
    setMode({ type: "paste", clipboard });
    setSelectedPartIds(new Set());
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave text fields alone — Ctrl+C/V/Z there belong to the field
      if (isTextEntry(e.target)) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        handleCopy();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        // No preventDefault: that would suppress the `paste` event below, which is
        // the only way to read the system clipboard without a permission prompt.
        handlePaste();
      }
    };

    // Fires right after the Ctrl+V keydown. Parts copied in another tab arrive here;
    // anything else leaves the in-app buffer that keydown already pasted in place.
    const handleClipboardPaste = (e: ClipboardEvent) => {
      if (isTextEntry(e.target)) return;
      const fromSystem = e.clipboardData?.getData("text/plain");
      if (parseClipboardText(fromSystem)) {
        e.preventDefault();
        handlePaste(fromSystem);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("paste", handleClipboardPaste);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("paste", handleClipboardPaste);
    };
  }, [handleUndo, handleRedo, handleCopy, handlePaste]);

  const handleClear = useCallback(() => {
    assembly.clear();
    history.clear();
    setSelectedPartIds(new Set());
  }, []);

  const handleSave = useCallback(async () => {
    const data = assembly.serialize();
    // Embed custom STL/3MF binaries so the file is portable
    const embedded = await getEmbeddedCustomParts(data.parts.map((p) => p.type));
    if (embedded.length > 0) {
      data.customParts = embedded;
    }
    // Include inventory if any values are set
    const hasInventory = Object.values(inventory).some((v) => v > 0);
    if (hasInventory) {
      data.inventory = inventory;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name.replace(/\s+/g, "-").toLowerCase()}.homeracker.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [inventory]);

  const handleLoad = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.homeracker.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        // Restore embedded custom parts before deserializing the assembly
        if (data.customParts && Array.isArray(data.customParts)) {
          await restoreEmbeddedCustomParts(data.customParts);
        }
        assembly.deserialize(data);
        history.clear();
        setSelectedPartIds(new Set());
        // Restore inventory from loaded file
        if (data.inventory && typeof data.inventory === "object") {
          handleSetInventory(data.inventory);
        } else {
          handleSetInventory({});
        }
      } catch (e) {
        console.error("Failed to load assembly:", e);
      }
    };
    input.click();
  }, [handleSetInventory]);

  const handleToggleAdaptive = useCallback(() => {
    assembly.setAdaptiveEnabled(!assembly.adaptiveEnabled);
  }, []);

  const handleToggleGravity = useCallback(() => {
    assembly.setGravityEnabled(!assembly.gravityEnabled);
  }, []);

  const handleToggleSnap = useCallback(() => {
    assembly.setSnapEnabled(!assembly.snapEnabled);
  }, []);

  const handleToggleCollisions = useCallback(() => {
    assembly.setShowCollisions(!assembly.showCollisions);
  }, []);

  const handleToggleFineMesh = useCallback(() => {
    assembly.setFineMeshCollisions(!assembly.fineMeshCollisions);
  }, []);

  const [toast, setToast] = useState<string | null>(null);

  const handleShare = useCallback(async () => {
    const data = assembly.serialize();
    if (hasCustomParts(data)) {
      data.parts = data.parts.filter((p) => !isCustomPart(p.type));
      if (data.parts.length === 0) {
        setToast("Nothing to share — custom STL parts can't be included in links");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      setToast("Custom STL parts excluded from shared link");
      setTimeout(() => setToast(null), 3000);
    }
    const hash = await encodeAssemblyToHash(data);
    const url = location.origin + location.pathname + hash;
    await navigator.clipboard.writeText(url);
    setToast((prev) => prev ?? "Link copied to clipboard!");
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handlePasteParts = useCallback(
    (clipboard: ClipboardData, targetPosition: GridPosition, extraRotation?: Rotation3) => {
      const addRot = (a: Rotation3, b: Rotation3): Rotation3 => [
        ((a[0] + b[0]) % 360) as Rotation3[0],
        ((a[1] + b[1]) % 360) as Rotation3[1],
        ((a[2] + b[2]) % 360) as Rotation3[2],
      ];
      const addedParts: {
        definitionId: string;
        position: GridPosition;
        rotation: Rotation3;
        orientation?: Axis;
        color?: string;
      }[] = [];
      for (const cp of clipboard.parts) {
        const pos: GridPosition = [
          targetPosition[0] + cp.offset[0],
          targetPosition[1] + cp.offset[1],
          targetPosition[2] + cp.offset[2],
        ];
        const rot = extraRotation ? addRot(cp.rotation, extraRotation) : cp.rotation;
        addedParts.push({
          definitionId: cp.definitionId,
          position: pos,
          rotation: rot,
          orientation: cp.orientation,
          color: cp.color,
        });
      }
      if (addedParts.length === 0) return;

      const cmd: Command = {
        description: `Paste ${addedParts.length} part(s)`,
        execute() {
          for (const p of addedParts) {
            assembly.addPart(p.definitionId, p.position, p.rotation, p.orientation, p.color);
          }
        },
        undo() {
          // Remove in reverse order
          for (let i = addedParts.length - 1; i >= 0; i--) {
            const p = addedParts[i];
            const parts = assembly.getAllParts();
            const match = parts.find(
              (pp) =>
                pp.definitionId === p.definitionId &&
                pp.position[0] === p.position[0] &&
                pp.position[1] === p.position[1] &&
                pp.position[2] === p.position[2],
            );
            if (match) assembly.removePart(match.instanceId);
          }
        },
      };
      history.execute(cmd);
      setMode({ type: "select" });
    },
    [],
  );

  const handleSetColor = useCallback(
    (color: string | undefined) => {
      if (selectedPartIds.size === 0) return;

      const colorChanges: Array<{
        instanceId: string;
        oldColor: string | undefined;
      }> = [];
      for (const id of selectedPartIds) {
        const part = assembly.getPartById(id);
        if (part) {
          colorChanges.push({ instanceId: id, oldColor: part.color });
        }
      }
      if (colorChanges.length === 0) return;

      const ids = colorChanges.map((c) => c.instanceId);

      const cmd: Command = {
        description: `Color ${colorChanges.length} part(s)`,
        execute() {
          assembly.setPartsColor(ids, color);
        },
        undo() {
          for (const { instanceId, oldColor } of colorChanges) {
            assembly.setPartColor(instanceId, oldColor);
          }
        },
      };
      history.execute(cmd);
    },
    [selectedPartIds],
  );

  const bom = assembly.getBOM();

  // Rendered without waiting on the restore: the ordering that matters — custom part
  // definitions before deserialize — is guaranteed inside initPromise, not by holding
  // the UI back. The store notifies once parts land, so the scene fills itself in.
  void ready;

  return (
    <div className="app">
      <Sidebar
        onSelectPart={handleSelectPart}
        placementsAtPoint={placementsAtPoint}
        activeMode={mode}
        usedDefinitionIds={new Set(snapshot.parts.map((p) => p.definitionId))}
        hasSelectedPoint={!!activePoint}
        filterByPosition={filterByPosition}
        onToggleFilterByPosition={() => setFilterByPosition((v) => !v)}
        compatibleDefinitionIds={compatibleDefinitionIds}
        onDrawMode={handleDrawMode}
        topology={topology}
        onPlaceAtPoint={handlePlaceAtPoint}
        onHoverSuggestion={setPreviewSuggestion}
        replacement={replacement}
        onReplaceConnector={handleReplaceConnector}
        inspected={inspected}
      />
      <div className="main-area">
        <Toolbar
          onUndo={handleUndo}
          onRedo={handleRedo}
          onDelete={selectedPartIds.size > 0 ? handleDeleteSelected : undefined}
          selectedCount={selectedPartIds.size}
          onClear={handleClear}
          onSave={handleSave}
          onLoad={handleLoad}
          onShare={handleShare}
          onEscape={handleEscape}
          mode={mode}
          snapEnabled={snapshot.snapEnabled}
          onToggleSnap={handleToggleSnap}
          gravityEnabled={snapshot.gravityEnabled}
          onToggleGravity={handleToggleGravity}
          adaptiveEnabled={snapshot.adaptiveEnabled}
          onToggleAdaptive={handleToggleAdaptive}
          showCollisions={snapshot.showCollisions}
          onToggleCollisions={handleToggleCollisions}
          fineMeshCollisions={snapshot.fineMeshCollisions}
          onToggleFineMesh={handleToggleFineMesh}
          lockSelection={lockSelection ? { count: lockSelection.ids.length, unlocked: lockSelection.unlocked } : null}
          onToggleLock={handleToggleLock}
          onCentre={snapshot.parts.length > 0 ? handleCentreAssembly : undefined}
        />
        <ViewportCanvas
          parts={snapshot.parts}
          mode={mode}
          selectedPartIds={selectedPartIds}
          assembly={assembly}
          onPlacePart={handlePlacePart}
          onDraw={handleDraw}
          onResizePart={handleResizePart}
          onMovePart={handleMovePart}
          onMoveSelectedParts={handleMoveSelectedParts}
          onClickPart={handleClickPart}
          rotationPivot={rotationPivot}
          lockedPartIds={lockedPartIds}
          onLockedPartDrag={handleLockedPartDrag}
          selectedPoint={activePoint}
          previewSuggestion={previewSuggestion}
          onClickEmpty={handleClickEmpty}
          onBoxSelect={handleBoxSelect}
          onNudgeParts={handleNudgeParts}
          onRotateSelectedParts={handleRotateSelectedParts}
          onOrientSelectedParts={handleOrientSelectedParts}
          onDeleteSelected={handleDeleteSelected}
          onPasteParts={handlePasteParts}
          onEscape={handleEscape}
          flashPartId={flashPartId}
          flashDefinitionId={flashDefinitionId}
          snapEnabled={snapshot.snapEnabled}
          gravityEnabled={snapshot.gravityEnabled}
          adaptiveEnabled={snapshot.adaptiveEnabled}
          showCollisions={snapshot.showCollisions}
          fineMeshCollisions={snapshot.fineMeshCollisions}
        />
      </div>
      <div className="right-panel">
        <BOMPanel
          entries={bom}
          selectedPartIds={selectedPartIds}
          parts={snapshot.parts}
          onFlashPart={handleFlashPart}
          onFlashDefinition={handleFlashDefinition}
          onSetColor={handleSetColor}
          inventory={inventory}
          onSetInventory={handleSetInventory}
        />
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
