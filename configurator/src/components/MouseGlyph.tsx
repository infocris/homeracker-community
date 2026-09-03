import { useEffect, useId, useState } from "react";

export type MouseButton = "left" | "right" | "middle";

export const BUTTON_NAMES: Record<MouseButton, string> = { left: "Left", middle: "Middle", right: "Right" };

export const sameButtons = (a: MouseButton[], b: MouseButton[]) =>
  a.length === b.length && a.every((button) => b.includes(button));

/**
 * A mouse with the buttons a gesture uses picked out.
 *
 * Drawn rather than spelled: "middle-click, holding the right button" is a phrase the
 * reader has to turn back into a hand on a mouse, and a picture of the buttons is
 * already that.
 */
export function MouseGlyph({ buttons, size = 20 }: { buttons: MouseButton[]; size?: number }) {
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

/**
 * The buttons held down right now, wherever on the page they are pressed.
 *
 * Read off `buttons` rather than counted from presses and releases: a release that
 * happens over another window never arrives, and a count would be left holding a
 * button nobody is pressing. Every event carries the whole truth, so the first one
 * back puts it right.
 */
export function useHeldButtons(): MouseButton[] {
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
 * What the mouse does in the viewport. Not bindable — these are gestures rather than
 * keys — but they need announcing somewhere, and a gesture nobody can find may as well
 * not be there.
 */
export const MOUSE_GESTURES: { gesture: string; detail: string; buttons: MouseButton[] }[] = [
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

/** How a held set of buttons is named: the gesture, when only one answers to it. */
export function nameForButtons(buttons: MouseButton[]): string {
  const matches = MOUSE_GESTURES.filter((row) => sameButtons(row.buttons, buttons));
  if (matches.length === 1) return matches[0].gesture;
  return `${buttons.map((button) => BUTTON_NAMES[button]).join(" and ")} button${buttons.length > 1 ? "s" : ""}`;
}
