// The desktop free-roam spawn. store-walk.ts places the camera here, and the
// startup warmup compiles the same pose so the first walk frames are not the
// ones that build shaders and upload textures.
import * as THREE from 'three';

export const WALK_ENTRY_POSITION = Object.freeze({ x: 13, y: 5.5, z: 12.5 });
export const WALK_ENTRY_LOOK = Object.freeze({ x: 11, y: 5.3, z: 0 });

export function walkEntryDirection(): THREE.Vector3 {
  return new THREE.Vector3(
    WALK_ENTRY_LOOK.x - WALK_ENTRY_POSITION.x,
    WALK_ENTRY_LOOK.y - WALK_ENTRY_POSITION.y,
    WALK_ENTRY_LOOK.z - WALK_ENTRY_POSITION.z,
  ).normalize();
}

/** Same yaw store-walk.ts derives when walk mode starts: atan2(-dir.x, -dir.z). */
export function walkEntryYaw(direction: THREE.Vector3 = walkEntryDirection()): number {
  return Math.atan2(-direction.x, -direction.z);
}

/** Same pitch store-walk.ts derives, clamped before the asin. */
export function walkEntryPitch(direction: THREE.Vector3 = walkEntryDirection()): number {
  return Math.asin(THREE.MathUtils.clamp(direction.y, -0.9, 0.9));
}

/** Opening look first, then even turns. Four headings is a full look-around. */
export function walkLookHeadings(baseYaw: number = walkEntryYaw(), steps = 4): number[] {
  const count = Math.max(1, steps);
  const turn = (Math.PI * 2) / count;
  const headings: number[] = [];
  for (let index = 0; index < count; index++) headings.push(baseYaw + index * turn);
  return headings;
}

/** A camera that is not the live view. Compiling against it cannot move the visitor.
 *  The field of view is a little wider than the store's 60° so neighbouring
 *  headings overlap instead of leaving a seam of uncompiled meshes. */
export function walkWarmupCamera(
  position: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
  aspect = 16 / 9,
  fov = 70,
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fov, aspect > 0 ? aspect : 16 / 9, 0.1, 1000);
  camera.position.set(position.x, position.y, position.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = 0;
  camera.updateMatrixWorld(true);
  return camera;
}
