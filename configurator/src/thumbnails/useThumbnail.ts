import { useState, useEffect } from "react";
import { generateThumbnail, generateThumbnailFromGeometry, getCachedThumbnail } from "./ThumbnailGenerator";
import { isCustomPart, getCustomPartGeometry } from "../data/custom-parts";
import { PART_COLORS } from "../constants";
import type { PartDefinition } from "../types";

/** Generated a little before the item scrolls in, so it feels instant */
const PRELOAD_MARGIN = "200px";

/**
 * Thumbnail for a catalog item, generated only once the item is actually near the
 * viewport. Generating on mount instead meant every part in every open section
 * loaded its model and rendered offscreen at startup — around eighty of them, most
 * scrolled out of sight.
 *
 * Attach the returned `ref` to the item's element; `dataURL` is null until ready.
 */
export function useThumbnail(part: PartDefinition): {
  ref: (node: HTMLElement | null) => void;
  dataURL: string | null;
} {
  const key = isCustomPart(part.id) ? part.id : part.modelPath;
  const [dataURL, setDataURL] = useState<string | null>(() => getCachedThumbnail(key));
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(false);

  // A scrolling ancestor clips the intersection, so the viewport is the right root
  useEffect(() => {
    if (!node || near || dataURL) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, near, dataURL]);

  useEffect(() => {
    if (!near || dataURL) return;

    if (isCustomPart(part.id)) {
      const geometry = getCustomPartGeometry(part.id);
      if (geometry) {
        setDataURL(generateThumbnailFromGeometry(part.id, geometry, PART_COLORS.custom));
      }
    } else if (part.modelPath) {
      generateThumbnail(part.modelPath)
        .then(setDataURL)
        .catch(() => {});
    }
  }, [near, key, part.id, part.modelPath, dataURL]);

  return { ref: setNode, dataURL };
}
