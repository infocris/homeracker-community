import { useMemo } from "react";

export type LightSettings = {
  shadows: boolean;
  floor: boolean;
  /** Compass bearing of the light, in degrees */
  azimuth: number;
  /** Height of the light above the horizon, in degrees */
  elevation: number;
  intensity: number;
  ambient: number;
  /** Shadow map resolution, in texels per side */
  resolution: number;
};

const STORAGE_KEY = "homeracker-light-settings";

/** Matches the hand-tuned lighting the scene shipped with. */
export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
  shadows: true,
  floor: true,
  azimuth: 45,
  elevation: 55,
  intensity: 2.9,
  ambient: 2.1,
  resolution: 1024,
};

export function loadLightSettings(): LightSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_LIGHT_SETTINGS;
    const parsed = JSON.parse(saved);
    // Merge rather than trust: a stored blob from an older shape must not win
    return { ...DEFAULT_LIGHT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_LIGHT_SETTINGS;
  }
}

export function saveLightSettings(settings: LightSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

/** Distance the light sits from the origin. Only its direction matters for shading,
 *  but the shadow camera needs room to span the scene from out there. */
const LIGHT_DISTANCE = 700;

/** Turn a compass bearing and a height angle into a light position. */
export function lightPosition(settings: LightSettings): [number, number, number] {
  const azimuth = (settings.azimuth * Math.PI) / 180;
  const elevation = (settings.elevation * Math.PI) / 180;
  const horizontal = Math.cos(elevation) * LIGHT_DISTANCE;
  return [horizontal * Math.sin(azimuth), Math.sin(elevation) * LIGHT_DISTANCE, horizontal * Math.cos(azimuth)];
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="shadow-settings-row">
      <span className="shadow-settings-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="shadow-settings-value">
        {Math.round(value * 100) / 100}
        {unit ?? ""}
      </span>
    </label>
  );
}

export function ShadowSettings({
  settings,
  onChange,
  onClose,
}: {
  settings: LightSettings;
  onChange: (settings: LightSettings) => void;
  onClose: () => void;
}) {
  const set = useMemo(
    () =>
      <K extends keyof LightSettings>(key: K, value: LightSettings[K]) =>
        onChange({ ...settings, [key]: value }),
    [settings, onChange],
  );

  return (
    <div className="shadow-settings-backdrop" onPointerDown={onClose}>
      <div
        className="shadow-settings"
        role="dialog"
        aria-label="Lighting and shadows"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="shadow-settings-header">
          <h2>Lighting &amp; shadows</h2>
          <button type="button" className="shadow-settings-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <label className="shadow-settings-check">
          <input type="checkbox" checked={settings.shadows} onChange={(e) => set("shadows", e.target.checked)} />
          <span>Cast shadows</span>
        </label>

        <label className="shadow-settings-check">
          <input type="checkbox" checked={settings.floor} onChange={(e) => set("floor", e.target.checked)} />
          <span>Solid floor</span>
        </label>

        <Slider
          label="Direction"
          value={settings.azimuth}
          min={0}
          max={360}
          step={1}
          unit="°"
          onChange={(v) => set("azimuth", v)}
        />
        <Slider
          label="Height"
          value={settings.elevation}
          min={10}
          max={89}
          step={1}
          unit="°"
          onChange={(v) => set("elevation", v)}
        />
        <Slider
          label="Light"
          value={settings.intensity}
          min={0}
          max={6}
          step={0.1}
          onChange={(v) => set("intensity", v)}
        />
        <Slider
          label="Ambient"
          value={settings.ambient}
          min={0}
          max={6}
          step={0.1}
          onChange={(v) => set("ambient", v)}
        />
        <Slider
          label="Sharpness"
          value={settings.resolution}
          min={512}
          max={4096}
          step={512}
          onChange={(v) => set("resolution", v)}
        />

        <p className="shadow-settings-note">
          A shadow is the absence of direct light, so it only reads while Light stays above Ambient.
        </p>

        <button type="button" className="toolbar-btn" onClick={() => onChange(DEFAULT_LIGHT_SETTINGS)}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
