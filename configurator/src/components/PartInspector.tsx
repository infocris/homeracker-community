import { Canvas } from "@react-three/fiber";
import { OrbitControls, Stage } from "@react-three/drei";
import { Suspense, useMemo } from "react";
import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import { getPartDefinition } from "../data/catalog";

/** The part itself, centred on its own bounding box so it turns about its middle. */
function Model({ modelPath }: { modelPath: string }) {
  const { scene } = useGLTF(modelPath);
  const centred = useMemo(() => {
    const copy = scene.clone();
    const box = new THREE.Box3().setFromObject(copy);
    const centre = box.getCenter(new THREE.Vector3());
    copy.position.sub(centre);
    return copy;
  }, [scene]);
  return <primitive object={centred} />;
}

/**
 * The selected connector, large and free to turn.
 *
 * Its own little scene rather than a camera on the main one: the point is to look at
 * the part from any side without moving the view of the assembly, which is the thing
 * being built. Mounted only while a connector is selected, so the second WebGL context
 * is not carried around for nothing.
 */
export function PartInspector({ definitionId, name }: { definitionId: string; name: string }) {
  const def = getPartDefinition(definitionId);
  if (!def?.modelPath) return null;

  return (
    <div className="part-inspector">
      <div className="part-inspector-canvas">
        <Canvas camera={{ position: [40, 30, 40], fov: 40 }} dpr={[1, 1.5]}>
          <ambientLight intensity={1.6} />
          <directionalLight position={[30, 40, 20]} intensity={2.2} />
          <directionalLight position={[-30, -10, -20]} intensity={0.8} />
          <Suspense fallback={null}>
            <Stage adjustCamera={1.1} environment={null} shadows={false} intensity={0}>
              <Model modelPath={def.modelPath} />
            </Stage>
          </Suspense>
          <OrbitControls enablePan={false} enableZoom makeDefault />
        </Canvas>
      </div>
      <div className="part-inspector-name">{name}</div>
      <div className="part-inspector-hint">Drag to turn it over</div>
    </div>
  );
}
