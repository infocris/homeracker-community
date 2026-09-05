import * as THREE from "three";

/**
 * Simple volumes, drawn to the same door as an imported model.
 *
 * A shape is turned into a binary STL and registered exactly as an import is, rather
 * than given a path of its own. Everything a custom part already knows how to do — the
 * voxel footprint, the ghost, IndexedDB between sessions, the copy embedded in a save
 * file, the share link — then works for it without a line of its own, and a shape a
 * user drew is a part like any other from that moment on.
 */

export type PrimitiveKind = "box" | "cylinder";

/** What a box is asked for, in millimetres — the unit the grid itself is measured in */
export interface BoxDimensions {
  width: number;
  height: number;
  depth: number;
}

/** What a cylinder is asked for, in millimetres */
export interface CylinderDimensions {
  diameter: number;
  height: number;
}

export type PrimitiveDimensions =
  | { kind: "box"; box: BoxDimensions }
  | { kind: "cylinder"; cylinder: CylinderDimensions };

/** Round enough to keep a wall of a cylinder from being a polygon you can count */
const CYLINDER_SEGMENTS = 48;

export function primitiveGeometry(dimensions: PrimitiveDimensions): THREE.BufferGeometry {
  if (dimensions.kind === "box") {
    const { width, height, depth } = dimensions.box;
    return new THREE.BoxGeometry(width, height, depth);
  }
  const { diameter, height } = dimensions.cylinder;
  return new THREE.CylinderGeometry(diameter / 2, diameter / 2, height, CYLINDER_SEGMENTS);
}

/** The name a shape carries until it is given another, dimensions included */
export function primitiveName(dimensions: PrimitiveDimensions): string {
  if (dimensions.kind === "box") {
    const { width, height, depth } = dimensions.box;
    return `Box ${width}×${height}×${depth} mm`;
  }
  const { diameter, height } = dimensions.cylinder;
  return `Cylinder ⌀${diameter}×${height} mm`;
}

/**
 * The geometry as a binary STL, which is the form every custom part is kept in.
 *
 * Written from the triangles themselves with a zero normal apiece: a normal of zero
 * tells a reader to work the facet out from the winding, which is what three's own
 * loader does, and what the rest of this app does with these models anyway.
 */
export function geometryToBinarySTL(geometry: THREE.BufferGeometry): ArrayBuffer {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const triangles = index ? index.count / 3 : positions.count / 3;

  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);

  let offset = 84;
  for (let t = 0; t < triangles; t++) {
    offset += 12; // the normal, left at zero
    for (let corner = 0; corner < 3; corner++) {
      const i = index ? index.getX(t * 3 + corner) : t * 3 + corner;
      view.setFloat32(offset, positions.getX(i), true);
      view.setFloat32(offset + 4, positions.getY(i), true);
      view.setFloat32(offset + 8, positions.getZ(i), true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }
  return buffer;
}
