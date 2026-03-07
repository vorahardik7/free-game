import * as THREE from "three";
import type { VehicleState } from "./types";
import { clamp } from "./math";

interface CameraRigState {
  velocity: THREE.Vector3;
  lookVelocity: THREE.Vector3;
  lookTarget: THREE.Vector3;
}

export interface CameraController {
  update: (state: VehicleState, dt: number) => void;
}

const UP = new THREE.Vector3(0, 1, 0);

function damping(current: THREE.Vector3, target: THREE.Vector3, velocity: THREE.Vector3, smoothTime: number, dt: number): THREE.Vector3 {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

  const change = current.clone().sub(target);
  const temp = velocity.clone().addScaledVector(change, omega).multiplyScalar(dt);
  velocity.sub(temp.clone().multiplyScalar(omega)).multiplyScalar(exp);

  return target.clone().add(change.add(temp).multiplyScalar(exp));
}

export function createCameraController(
  camera: THREE.PerspectiveCamera,
  occluders: THREE.Object3D[],
): CameraController {
  const raycaster = new THREE.Raycaster();
  const rig: CameraRigState = {
    velocity: new THREE.Vector3(),
    lookVelocity: new THREE.Vector3(),
    lookTarget: new THREE.Vector3(0, 1, 0),
  };

  return {
    update(state, dt) {
      const speed = Math.abs(state.speed);
      const isPlane = state.id === "plane";
      const offset = isPlane
        ? new THREE.Vector3(0, 7.8, -23)
        : new THREE.Vector3(0, 6.4, -13.5);

      if (isPlane && state.mode === "airborne") {
        offset.y = 9.2;
        offset.z = -26;
      }

      offset.applyAxisAngle(UP, state.heading);

      const desired = state.position.clone().add(offset);
      const look = state.position.clone();
      look.y += isPlane ? 2.8 : 1.6;

      const rayDirection = desired.clone().sub(look);
      const desiredDistance = rayDirection.length();
      rayDirection.normalize();
      raycaster.set(look, rayDirection);
      raycaster.far = desiredDistance;

      const hits = raycaster.intersectObjects(occluders, true);
      if (hits.length > 0) {
        const hitDist = Math.max(4.5, hits[0].distance - 1.2);
        desired.copy(look.clone().add(rayDirection.multiplyScalar(hitDist)));
      }

      const smoothTime = isPlane ? 0.2 : 0.12;
      const smoothedPos = damping(camera.position, desired, rig.velocity, smoothTime, dt);
      camera.position.copy(smoothedPos);

      const lookSmoothTime = isPlane ? 0.16 : 0.1;
      rig.lookTarget = damping(rig.lookTarget, look, rig.lookVelocity, lookSmoothTime, dt);
      camera.lookAt(rig.lookTarget);

      const fovTarget = isPlane ? 56 + clamp(speed * 0.95, 0, 20) : 58 + clamp(speed * 0.8, 0, 14);
      camera.fov = THREE.MathUtils.lerp(camera.fov, fovTarget, 0.08);
      camera.updateProjectionMatrix();
    },
  };
}
