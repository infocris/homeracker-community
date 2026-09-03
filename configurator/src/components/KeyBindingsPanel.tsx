import { useEffect, useState, useSyncExternalStore } from "react";
import type { ActionId } from "../input/actions";
import {
  ACTIONS,
  type ActionSpec,
  bindings,
  comboLabel,
  comboOf,
  conflictOf,
  isCustomised,
  isReserved,
  resetKeys,
  setKeys,
  specOf,
  subscribeBindings,
} from "../input/keybindings";

const GROUPS: ActionSpec["group"][] = ["Edit", "Selection", "Placing", "Help"];

const GROUP_NOTES: Record<ActionSpec["group"], string> = {
  Edit: "Anywhere in the app",
  Selection: "With parts selected — and while one is being placed, for the height",
  Placing: "While a part is in hand, being dragged, or selected",
  Help: "",
};

/**
 * The list of shortcuts, and where they are changed.
 *
 * The panel takes the keyboard for as long as it is up: the app's own shortcuts would
 * otherwise fire underneath it — pressing X to record it would turn the selection —
 * and a keystroke being recorded must be seen here before anywhere else.
 */
export function KeyBindingsPanel({ onClose }: { onClose: () => void }) {
  const bound = useSyncExternalStore(subscribeBindings, bindings);
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!capturing) {
        // Tab, Enter and Space still work the panel itself — swallowing them would
        // leave it unusable from the keyboard, which is a poor showing for a panel
        // about the keyboard
        if (e.key === "Tab" || e.key === "Enter" || e.key === " ") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") onClose();
        return;
      }

      // A keystroke being recorded is seen here and nowhere else, whichever element
      // has the focus — this listener is on the window, in the capture phase
      e.preventDefault();
      e.stopImmediatePropagation();

      // Escape calls off the recording rather than being recorded — which is why the
      // action Escape belongs to is the one binding that cannot be changed
      if (e.key === "Escape") {
        setCapturing(null);
        setMessage(null);
        return;
      }

      const combo = comboOf(e);
      if (!combo) return; // a modifier held on its own: keep waiting for the key

      if (isReserved(combo)) {
        setMessage(`${comboLabel(combo)} belongs to the browser — it would never reach us`);
        setCapturing(null);
        return;
      }

      const clash = conflictOf(combo, capturing);
      if (clash) {
        setMessage(`${comboLabel(combo)} already belongs to “${specOf(clash).label}”`);
        setCapturing(null);
        return;
      }

      setKeys(capturing, [combo]);
      setMessage(`${specOf(capturing).label} is now ${comboLabel(combo)}`);
      setCapturing(null);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [capturing, onClose]);

  const anyCustomised = ACTIONS.some((spec) => isCustomised(spec.id));

  return (
    <div className="shadow-settings-backdrop" onPointerDown={onClose}>
      <div
        className="shadow-settings keybindings"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="shadow-settings-header">
          <h2>Shortcuts</h2>
          <button type="button" className="shadow-settings-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="keybindings-list">
          {GROUPS.map((group) => {
            const specs = ACTIONS.filter((spec) => spec.group === group);
            if (specs.length === 0) return null;
            return (
              <section key={group} className="keybindings-group">
                <h3>
                  {group}
                  {GROUP_NOTES[group] && <span className="keybindings-group-note">{GROUP_NOTES[group]}</span>}
                </h3>
                {specs.map((spec) => {
                  const keys = bound[spec.id];
                  const recording = capturing === spec.id;
                  return (
                    <div className="keybindings-row" key={spec.id}>
                      <div className="keybindings-name">
                        <span className="keybindings-label">{spec.label}</span>
                        <span className="keybindings-detail">
                          {spec.detail}
                          {spec.shiftVariant && <em> · with Shift: {spec.shiftVariant}</em>}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`keybindings-key${recording ? " keybindings-key--recording" : ""}`}
                        disabled={spec.fixed}
                        onClick={() => {
                          setMessage(null);
                          setCapturing(recording ? null : spec.id);
                        }}
                        title={
                          spec.fixed
                            ? "Escape calls off a recording, so it cannot itself be recorded"
                            : "Click, then press the keys you want"
                        }
                      >
                        {recording ? "Press a key…" : keys.map(comboLabel).join(" or ")}
                      </button>
                      <button
                        type="button"
                        className="keybindings-reset"
                        onClick={() => {
                          setMessage(null);
                          resetKeys(spec.id);
                        }}
                        disabled={!isCustomised(spec.id)}
                        title="Back to the key it was shipped with"
                      >
                        ↺
                      </button>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>

        <div className="keybindings-foot">
          <span className="keybindings-message">{message ?? (capturing ? "Esc calls it off" : "")}</span>
          <button
            type="button"
            className="keybindings-reset-all"
            onClick={() => {
              setMessage("Back to the shipped keys");
              resetKeys();
            }}
            disabled={!anyCustomised}
          >
            Reset all
          </button>
        </div>
      </div>
    </div>
  );
}
