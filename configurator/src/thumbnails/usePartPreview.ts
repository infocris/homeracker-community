import { useEffect, useState } from "react";
import { PART_COLORS } from "../constants";
import { getCustomPartGeometry, isCustomPart } from "../data/custom-parts";
import type { PartDefinition } from "../types";
import {
  generateThumbnail,
  generateThumbnailFromGeometry,
  getCachedThumbnail,
  PREVIEW_SIZE,
} from "./ThumbnailGenerator";

/**
 * A large render of a part, made the first time it is asked for.
 *
 * `enabled` is the hover: nothing is rendered until the pointer settles on the item,
 * and the render is cached for the session, so a second pass over the library is free.
 * The catalog thumbnail is a separate, smaller entry — this is a real render at the
 * card's size rather than that little image stretched.
 */
export function usePartPreview(part: PartDefinition, enabled: boolean): string | null {
  const key = isCustomPart(part.id) ? part.id : part.modelPath;
  const [dataURL, setDataURL] = useState<string | null>(() => (key ? getCachedThumbnail(key, PREVIEW_SIZE) : null));

  useEffect(() => {
    if (!enabled || dataURL) return;

    if (isCustomPart(part.id)) {
      const geometry = getCustomPartGeometry(part.id);
      if (geometry) {
        setDataURL(generateThumbnailFromGeometry(part.id, geometry, PART_COLORS.custom, PREVIEW_SIZE));
      }
      return;
    }

    if (!part.modelPath) return;
    let live = true;
    generateThumbnail(part.modelPath, PREVIEW_SIZE)
      .then((url) => {
        if (live) setDataURL(url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, dataURL, part.id, part.modelPath]);

  return dataURL;
}
