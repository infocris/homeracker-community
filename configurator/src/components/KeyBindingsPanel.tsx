import { useEffect, useId, useState, useSyncExternalStore } from "react";
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

type MouseButton = "left" | "right" | "middle";

/**
 * A mouse with the buttons a gesture uses picked out.
 *
 * Drawn rather than spelled: "middle-click, holding the right button" is a phrase the
 * reader has to turn back into a hand on a mouse, and a picture of the buttons is
 * already that.
 */
function MouseGlyph({ buttons, size = 20 }: { buttons: MouseButton[]; size?: number }) {
  const clip = useId();
  const fill = (button: MouseButton) => (buttons.includes(button) ? "var(--accent)" : "transparent");
  return (
    <svg className="mouse-glyph" viewBox="0 0 20 30" width={size} height={size * 1.5} aria-hidden="true">
      <title>{buttons.join(" and ")} button</title>
      <defs>
        <clipPath id={clip}>
          <rect x="1" y="1" width="18" height="28" rx="9" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="0" y="0" width="8.6" height="12" fill={fill("left")} />
        <rect x="8.6" y="0" width="2.8" height="12" fill={fill("middle")} />
        <rect x="11.4" y="0" width="8.6" height="12" fill={fill("right")} />
      </g>
      <path d="M1.5 12 H18.5 M8.6 1.5 V12 M11.4 1.5 V12" stroke="currentColor" strokeWidth="0.9" fill="none" />
      <rect x="1" y="1" width="18" height="28" rx="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

const BUTTON_NAMES: Record<MouseButton, string> = { left: "Left", middle: "Middle", right: "Right" };

const sameButtons = (a: MouseButton[], b: MouseButton[]) =>
  a.length === b.length && a.every((button) => b.includes(button));

/**
 * The buttons held down right now, wherever on the page they are pressed.
 *
 * Read off `buttons` rather than counted from presses and releases: a release that
 * happens over another window never arrives, and a count would be left holding a
 * button nobody is pressing. Every event carries the whole truth, so the first one
 * back puts it right.
 */
function useHeldButtons(): MouseButton[] {
  const [held, setHeld] = useState<MouseButton[]>([]);
  useEffect(() => {
    const read = (e: PointerEvent) => {
      const next: MouseButton[] = [];
      if (e.buttons & 1) next.push("left");
      if (e.buttons & 2) next.push("right");
      if (e.buttons & 4) next.push("middle");
      setHeld((prev) => (sameButtons(prev, next) ? prev : next));
    };
    for (const type of ["pointerdown", "pointerup", "pointermove"] as const) {
      window.addEventListener(type, read, true);
    }
    return () => {
      for (const type of ["pointerdown", "pointerup", "pointermove"] as const) {
        window.removeEventListener(type, read, true);
      }
    };
  }, []);
  return held;
}

/**
 * What the mouse does. Not bindable — these are gestures rather than keys — but this
 * is where someone looks for them, and a gesture nobody can find may as well not be
 * there.
 */
const MOUSE: { gesture: string; detail: string; buttons: MouseButton[] }[] = [
  { gesture: "Click a part", detail: "Select it — Alt+click takes one part out of a group", buttons: ["left"] },
  {
    gesture: "Drag a part",
    detail: "Move it; hold the right button as well to move it in height",
    buttons: ["left"],
  },
  {
    gesture: "Middle-click a part",
    detail: "A copy of it goes on the cursor, to be put down with a click",
    buttons: ["middle"],
  },
  { gesture: "Drag empty ground", detail: "Turn the view; the right or middle button pans it", buttons: ["left"] },
  {
    gesture: "Shift+drag, or both buttons",
    detail: "Draw a box over the parts to select",
    buttons: ["left", "right"],
  },
  { gesture: "Right-click", detail: "Deselect, or call off what is in hand", buttons: ["right"] },
  {
    gesture: "Drag a connector's handle",
    detail: "Draw a bar out of that side — a click trades the connector instead",
    buttons: ["left"],
  },
];

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

  /*
   * The mouse drawn beside the list answers the hand first and the pointer second: a
   * button actually held shows itself, and short of that, the gesture being read
   * about. Pressing a button is the quickest way to ask "what does this one do", and
   * the answer is the line that lights up.
   */
  const held = useHeldButtons();
  const [hoveredGesture, setHoveredGesture] = useState<string | null>(null);
  const hovered = MOUSE.find((row) => row.gesture === hoveredGesture);
  const shown = held.length > 0 ? held : (hovered?.buttons ?? []);
  // One button often does several things depending on what it is pressed on, so a
  // button held is named as a button unless it answers to exactly one gesture
  const matches = MOUSE.filter((row) => sameButtons(row.buttons, shown));
  const buttonNames = `${shown.map((button) => BUTTON_NAMES[button]).join(" and ")} button${shown.length > 1 ? "s" : ""}`;
  const caption =
    held.length > 0
      ? matches.length === 1
        ? matches[0].gesture
        : buttonNames
      : (hovered?.gesture ?? "Press a button");

  const anyCustomised = ACTIONS.some((spec) => isCustomised(spec.id));

  return (
    <div className="shadow-settings-backdrop" onPointerDown={onClose}>
      <div
        className="shadow-settings keybindings"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => {
          e.stopPropagation();
          // The buttons are meant to be tried out here, and the browser answers a
          // middle press with autoscroll and a right press with its own menu
          if (e.button === 1) e.preventDefault();
        }}
        onContextMenu={(e) => e.preventDefault()}
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
          <section className="keybindings-group">
            <h3>
              Mouse
              <span className="keybindings-group-note">In the viewport — press a button to find it here</span>
            </h3>
            <div className="keybindings-mouse">
              <div className="keybindings-mouse-list">
                {MOUSE.map((row) => (
                  <div
                    className={`keybindings-row keybindings-gesture${
                      sameButtons(row.buttons, shown) ? " keybindings-gesture--lit" : ""
                    }`}
                    key={row.gesture}
                    onPointerEnter={() => setHoveredGesture(row.gesture)}
                    onPointerLeave={() => setHoveredGesture(null)}
                  >
                    <span className="keybindings-name">
                      <span className="keybindings-label">{row.gesture}</span>
                      <span className="keybindings-detail">{row.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className="keybindings-mouse-figure">
                <MouseGlyph buttons={shown} size={54} />
                <span className="keybindings-mouse-caption">{caption}</span>
              </div>
            </div>
          </section>
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
