import { BASE_UNIT } from "../constants";
import { WORKSPACE_LIMITS, type WorkspaceSize } from "../assembly/workspace";

/** One cell in centimetres, for reading the size in something other than cells */
const CM = BASE_UNIT / 10;

function Row({
  label,
  value,
  min,
  max,
  reading,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  reading: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="shadow-settings-row">
      <span className="shadow-settings-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="shadow-settings-value">{reading}</span>
    </label>
  );
}

/**
 * The size of the buildable area, in cells and in centimetres.
 *
 * Both readings are shown because both are used in practice: the grid is what
 * placement obeys, and the centimetres are what the shelf has to fit into.
 */
export function WorkspaceSettings({
  size,
  onChange,
  onClose,
}: {
  size: WorkspaceSize;
  onChange: (size: Partial<WorkspaceSize>) => void;
  onClose: () => void;
}) {
  const across = size.extent * 2 + 1;
  return (
    <div className="shadow-settings-backdrop" onPointerDown={onClose}>
      <div
        className="shadow-settings"
        role="dialog"
        aria-label="Workspace size"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="shadow-settings-header">
          <h2>Workspace</h2>
          <button type="button" className="shadow-settings-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <Row
          label="Width and depth"
          value={size.extent}
          min={WORKSPACE_LIMITS.extent.min}
          max={WORKSPACE_LIMITS.extent.max}
          reading={`±${size.extent} · ${across} cells · ${Math.round(across * CM)} cm`}
          onChange={(extent) => onChange({ extent })}
        />
        <Row
          label="Height"
          value={size.height}
          min={WORKSPACE_LIMITS.height.min}
          max={WORKSPACE_LIMITS.height.max}
          reading={`${size.height} cells · ${Math.round(size.height * CM)} cm`}
          onChange={(height) => onChange({ height })}
        />

        <p className="shadow-settings-note">
          Parts already outside a shrunken area stay where they are; the bounds only hold back what is placed, drawn or
          moved from here on. Shadows cover the whole area at a fixed resolution, so a much larger one is a coarser one
          — the resolution slider is under Shadows.
        </p>
      </div>
    </div>
  );
}
