import { useMemo, useState } from "react";
import * as THREE from "three";
import { BASE_UNIT } from "../constants";
import { type PrimitiveDimensions, type PrimitiveKind, primitiveGeometry, primitiveName } from "../data/primitives";

/** Millimetres in, cells out — how much of the grid a shape of this size will take */
function cellsFor(dimensions: PrimitiveDimensions): [number, number, number] {
  const geometry = primitiveGeometry(dimensions);
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  geometry.dispose();
  return [size.x, size.y, size.z].map((mm) => Math.max(1, Math.ceil(mm / BASE_UNIT))) as [number, number, number];
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="shape-field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        max={2000}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="shape-unit">mm</span>
    </label>
  );
}

/**
 * A shape drawn rather than imported: its dimensions in millimetres, the unit the rack
 * itself is drawn in, and the cells it will take on the grid shown as they are typed —
 * a part 40 mm across takes 3 cells whether or not that was the intention, and it is
 * better said before the shape exists than after.
 */
export function ShapeDialog({
  onCreate,
  onClose,
}: {
  onCreate: (dimensions: PrimitiveDimensions, name: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<PrimitiveKind>("box");
  const [box, setBox] = useState({ width: 60, height: 30, depth: 60 });
  const [cylinder, setCylinder] = useState({ diameter: 60, height: 60 });
  const [name, setName] = useState("");

  const dimensions: PrimitiveDimensions = kind === "box" ? { kind: "box", box } : { kind: "cylinder", cylinder };
  const cells = useMemo(
    () => cellsFor(dimensions),
    [kind, box.width, box.height, box.depth, cylinder.diameter, cylinder.height],
  );
  const suggested = primitiveName(dimensions);
  const sound =
    kind === "box" ? box.width > 0 && box.height > 0 && box.depth > 0 : cylinder.diameter > 0 && cylinder.height > 0;

  return (
    <div className="shadow-settings-backdrop" onPointerDown={onClose}>
      <div
        className="shadow-settings shape-dialog"
        role="dialog"
        aria-label="New shape"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="shadow-settings-header">
          <h2>New shape</h2>
          <button type="button" className="shadow-settings-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="shape-kinds">
          <button
            type="button"
            className={`shape-kind${kind === "box" ? " shape-kind--on" : ""}`}
            onClick={() => setKind("box")}
          >
            Box
          </button>
          <button
            type="button"
            className={`shape-kind${kind === "cylinder" ? " shape-kind--on" : ""}`}
            onClick={() => setKind("cylinder")}
          >
            Cylinder
          </button>
        </div>

        {kind === "box" ? (
          <>
            <Field label="Width" value={box.width} onChange={(width) => setBox({ ...box, width })} />
            <Field label="Height" value={box.height} onChange={(height) => setBox({ ...box, height })} />
            <Field label="Depth" value={box.depth} onChange={(depth) => setBox({ ...box, depth })} />
          </>
        ) : (
          <>
            <Field
              label="Diameter"
              value={cylinder.diameter}
              onChange={(diameter) => setCylinder({ ...cylinder, diameter })}
            />
            <Field label="Height" value={cylinder.height} onChange={(height) => setCylinder({ ...cylinder, height })} />
          </>
        )}

        <label className="shape-field shape-field--name">
          <span>Name</span>
          <input type="text" value={name} placeholder={suggested} onChange={(e) => setName(e.target.value)} />
        </label>

        <p className="shadow-settings-note">
          Takes {cells[0]} × {cells[1]} × {cells[2]} cells of the grid, at {BASE_UNIT} mm to the cell. A shape that does
          not fall on the grid takes the cell it reaches into, whole.
        </p>

        <div className="shape-actions">
          <button type="button" className="shape-create" disabled={!sound} onClick={() => onCreate(dimensions, name)}>
            Add to Custom
          </button>
        </div>
      </div>
    </div>
  );
}
