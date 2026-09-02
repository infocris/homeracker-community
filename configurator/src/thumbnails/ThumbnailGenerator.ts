import * as THREE from "three";
import { PART_INTERIOR_LIGHT } from "../constants";
import { loadModel } from "../scene/PartLoader";

const SIZE = 80;
/** For the hover card: one render, cached, big enough to read the part's shape. */
export const PREVIEW_SIZE = 320;

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

/** Renders of the same part at two sizes are two images, so the size joins the key. */
function cacheKey(key: string, size: number): string {
  return `${key}@${size}`;
}

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  const ambient = new THREE.AmbientLight(0xffffff, 2.0);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 1.5);
  dir.position.set(1, 1.5, 1);
  scene.add(dir);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
}

function fitCameraToObject(object: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.8;
  camera!.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
  camera!.lookAt(center);
  camera!.updateProjectionMatrix();
  return center;
}

/** Frame the object in the shared scene and read the result back as a PNG. */
function renderToDataURL(object: THREE.Object3D, size: number): string {
  renderer!.setSize(size, size);
  scene!.add(object);
  const centre = fitCameraToObject(object);

  // A lamp at the middle of the body, which reaches the inward-facing surfaces and
  // nothing else: every panel of the shell has its back to it
  const inside = new THREE.PointLight(0xffffff, PART_INTERIOR_LIGHT);
  inside.decay = 0;
  inside.position.copy(centre);
  scene!.add(inside);

  renderer!.render(scene!, camera!);
  const dataURL = renderer!.domElement.toDataURL("image/png");

  scene!.remove(inside);
  inside.dispose();
  scene!.remove(object);
  return dataURL;
}

/**
 * Generate a square render of a GLB model, returning a cached data URL.
 *
 * `size` defaults to the catalog thumbnail; pass `PREVIEW_SIZE` for the hover card,
 * which is a separate cache entry rather than the small image stretched.
 */
export async function generateThumbnail(modelPath: string, size: number = SIZE): Promise<string> {
  const key = cacheKey(modelPath, size);
  if (cache.has(key)) return cache.get(key)!;
  if (pending.has(key)) return pending.get(key)!;

  const promise = (async () => {
    ensureRenderer();
    const model = await loadModel(modelPath);
    const dataURL = renderToDataURL(model, size);
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
    cache.set(key, dataURL);
    pending.delete(key);
    return dataURL;
  })();

  pending.set(key, promise);
  return promise;
}

/** Generate a render from a BufferGeometry (for custom STL parts). */
export function generateThumbnailFromGeometry(
  defId: string,
  geometry: THREE.BufferGeometry,
  color: string,
  size: number = SIZE,
): string {
  const key = cacheKey(defId, size);
  if (cache.has(key)) return cache.get(key)!;
  ensureRenderer();
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  const dataURL = renderToDataURL(mesh, size);
  material.dispose();
  cache.set(key, dataURL);
  return dataURL;
}

/** Get a cached render synchronously, or null if not yet generated. */
export function getCachedThumbnail(key: string, size: number = SIZE): string | null {
  return cache.get(cacheKey(key, size)) ?? null;
}
