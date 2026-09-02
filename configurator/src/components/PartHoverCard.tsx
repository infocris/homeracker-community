import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PART_COLORS } from "../constants";
import { usePartPreview } from "../thumbnails/usePartPreview";
import type { PartDefinition } from "../types";

/** Clear of the cursor, so the card never sits under the pointer it belongs to */
const GAP = 18;
/** Kept off the very edge of the window */
const MARGIN = 8;

/**
 * The hovered library part, rendered large beside the cursor.
 *
 * Portalled to the body: the sidebar scrolls and clips its overflow, and the card is
 * meant to spill over the viewport. It flips to the other side of the cursor when
 * there is no room on the right, and is inert to the pointer so moving across it
 * cannot steal the hover from the item underneath.
 */
export function PartHoverCard({ part, at }: { part: PartDefinition; at: { x: number; y: number } }) {
  const preview = usePartPreview(part, true);
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  // Measured rather than assumed: the description wraps to a height we cannot predict
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const spillsRight = at.x + GAP + width + MARGIN > window.innerWidth;
    const left = spillsRight ? Math.max(MARGIN, at.x - GAP - width) : at.x + GAP;
    const top = Math.min(Math.max(MARGIN, at.y - height / 2), window.innerHeight - height - MARGIN);
    setPlacement({ left, top });
  }, [at.x, at.y, preview, part.id]);

  const color = PART_COLORS[part.category] || PART_COLORS.custom;
  const arms = part.connectionPoints.length;
  const cells = part.gridCells.length;

  return createPortal(
    <div
      ref={ref}
      className="part-hover-card"
      // Hidden rather than unmounted for the first frame: it has to be laid out to be
      // measured, and showing it at 0,0 first would read as a flash in the corner.
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        visibility: placement ? "visible" : "hidden",
      }}
    >
      <div className="part-hover-card-image" style={{ borderColor: color }}>
        {preview ? <img src={preview} alt={part.name} /> : <div className="part-hover-card-loading" />}
      </div>
      <div className="part-hover-card-name">{part.name}</div>
      {part.description && <div className="part-hover-card-description">{part.description}</div>}
      <div className="part-hover-card-facts">
        {arms > 0 && (
          <span>
            {arms} {arms === 1 ? "arm" : "arms"}
          </span>
        )}
        <span>
          {cells} {cells === 1 ? "cell" : "cells"}
        </span>
      </div>
    </div>,
    document.body,
  );
}
