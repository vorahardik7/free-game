import * as THREE from "three";
import { PLAYER_RADIUS, SAFE_FLIGHT_ALTITUDE, WORLD_CONFIG } from "./config";
import { SpatialHash, collidesAtAltitude, resolveMotion } from "./collision";
import { clamp } from "./math";
import { canPlaneTakeoff } from "./sim-rules";
import type { VehicleId, VehicleState } from "./types";

export interface VehicleInput {
  throttle: number;
  steer: number;
  ascend: number;
  descend: number;
  boost: boolean;
}

export interface VehicleVisuals {
  groups: Record<VehicleId, THREE.Group>;
  planePropeller: THREE.Mesh;
}

export interface VehicleUpdateResult {
  impactSeverity: number;
  collided: boolean;
  onRunway: boolean;
}

const BASE_FORWARD = new THREE.Vector3(0, 0, 1);

const carConfig = {
  cab: { maxForward: 22, maxReverse: 14, accel: 14, reverseAccel: 18, drag: 0.955, turnRate: 1.45 },
};

const planeConfig = {
  groundMaxForward: 42,
  groundReverse: 7,
  minAirSpeed: 12,
  maxAirSpeed: 54,
  accel: 22,
  dragGround: 0.965,
  dragAir: 0.996,
  turnGround: 1.38,
  turnAir: 1.8,
  climbRate: 12,
  gravity: 4.8,
};

function wheel(radius: number, thickness: number, color = "#101827"): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, thickness, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.25 }),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  return mesh;
}

function createCabModel(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#f59e0b", metalness: 0.48, roughness: 0.35 });
  const trimMat = new THREE.MeshStandardMaterial({ color: "#dce4ec", metalness: 0.2, roughness: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.5, metalness: 0.45 });

  const base = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.86, 2.2), bodyMat);
  base.position.y = 0.9;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.75, 1.05, 2.03), bodyMat);
  cabin.position.set(-0.15, 1.65, 0);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.62, 1.84), new THREE.MeshStandardMaterial({ color: "#8ab8d6", roughness: 0.2, metalness: 0.45, transparent: true, opacity: 0.8 }));
  windshield.position.set(-1, 1.72, 0);
  const rearWindow = windshield.clone();
  rearWindow.position.x = 0.72;
  const bumperFront = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.35, 2.14), darkMat);
  bumperFront.position.set(-2.38, 0.56, 0);
  const bumperRear = bumperFront.clone();
  bumperRear.position.x = 2.38;
  const taxiLight = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.3, 0.68),
    new THREE.MeshStandardMaterial({ color: "#fde047", emissive: "#a16207", emissiveIntensity: 0.45, roughness: 0.35 }),
  );
  taxiLight.position.set(-0.1, 2.3, 0);

  const wheelArchMat = new THREE.MeshStandardMaterial({ color: "#252e39", roughness: 0.55, metalness: 0.25 });
  const archFrontL = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.44, 0.12), wheelArchMat);
  archFrontL.position.set(-1.45, 0.68, 1.06);
  const archFrontR = archFrontL.clone();
  archFrontR.position.z = -1.06;
  const archRearL = archFrontL.clone();
  archRearL.position.x = 1.45;
  const archRearR = archRearL.clone();
  archRearR.position.z = -1.06;

  const wheelPositions: [number, number][] = [
    [-1.5, -1.06],
    [-1.5, 1.06],
    [1.5, -1.06],
    [1.5, 1.06],
  ];

  wheelPositions.forEach(([x, z]) => {
    const w = wheel(0.49, 0.52);
    w.position.set(x, 0.42, z);
    g.add(w);
  });

  const sideTrim = new THREE.Mesh(new THREE.BoxGeometry(4.45, 0.1, 0.1), trimMat);
  sideTrim.position.set(0, 1.3, 1.08);
  const sideTrim2 = sideTrim.clone();
  sideTrim2.position.z = -1.08;

  // Headlights
  const headlightMat = new THREE.MeshStandardMaterial({ color: "#fffbe6", emissive: "#fff5cc", emissiveIntensity: 1.0, roughness: 0.1 });
  const headlightL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 0.5), headlightMat);
  headlightL.position.set(-2.5, 0.82, 0.65);
  const headlightR = headlightL.clone();
  headlightR.position.z = -0.65;

  // Taillights
  const taillightMat = new THREE.MeshStandardMaterial({ color: "#ef4444", emissive: "#dc2626", emissiveIntensity: 0.8, roughness: 0.2 });
  const taillightL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 0.45), taillightMat);
  taillightL.position.set(2.5, 0.82, 0.7);
  const taillightR = taillightL.clone();
  taillightR.position.z = -0.7;

  // Side mirrors
  const mirrorMat = new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.4, metalness: 0.6 });
  const mirrorL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 0.22), mirrorMat);
  mirrorL.position.set(-0.8, 1.52, 1.2);
  const mirrorR = mirrorL.clone();
  mirrorR.position.z = -1.2;

  // Door handles
  const handleMat = new THREE.MeshStandardMaterial({ color: "#c0c8d0", roughness: 0.3, metalness: 0.6 });
  const handleL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.06), handleMat);
  handleL.position.set(0.2, 1.3, 1.12);
  const handleR = handleL.clone();
  handleR.position.z = -1.12;

  g.add(
    base,
    cabin,
    windshield,
    rearWindow,
    bumperFront,
    bumperRear,
    taxiLight,
    sideTrim,
    sideTrim2,
    archFrontL,
    archFrontR,
    archRearL,
    archRearR,
    headlightL,
    headlightR,
    taillightL,
    taillightR,
    mirrorL,
    mirrorR,
    handleL,
    handleR,
  );
  return g;
}

function createPlaneModel(): { group: THREE.Group; propeller: THREE.Mesh } {
  const g = new THREE.Group();

  const fuselage = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.7, 4.8, 6, 16),
    new THREE.MeshStandardMaterial({ color: "#0ea5e9", roughness: 0.23, metalness: 0.58 }),
  );
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.y = 1.8;

  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.78, 10, 10),
    new THREE.MeshStandardMaterial({ color: "#9cd2ea", roughness: 0.12, metalness: 0.7, transparent: true, opacity: 0.82 }),
  );
  cockpit.position.set(-0.5, 2.15, 0);

  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.16, 7.8),
    new THREE.MeshStandardMaterial({ color: "#eaf4ff", roughness: 0.32, metalness: 0.28 }),
  );
  wing.position.set(-0.05, 1.8, 0);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 2.2), wing.material);
  tailWing.position.set(2.25, 2.4, 0);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.2, 0.65), wing.material);
  fin.position.set(2.45, 2.95, 0);

  const propeller = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 1.9, 0.2),
    new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.36, metalness: 0.55 }),
  );
  propeller.position.set(-2.8, 1.8, 0);

  g.add(fuselage, cockpit, wing, tailWing, fin, propeller);
  return { group: g, propeller };
}

export function createVehicleVisuals(scene: THREE.Scene): VehicleVisuals {
  const cab = createCabModel();
  const plane = createPlaneModel();

  cab.castShadow = true;
  plane.group.castShadow = true;

  scene.add(cab, plane.group);
  plane.group.visible = false;

  return {
    groups: {
      cab,
      plane: plane.group,
    },
    planePropeller: plane.propeller,
  };
}

export function createInitialVehicleState(): VehicleState {
  return {
    id: "cab",
    mode: "ground",
    position: new THREE.Vector3(0, 1, 0),
    heading: 0,
    speed: 0,
    verticalSpeed: 0,
    rollDistance: 0,
    lastImpact: 0,
  };
}

export function switchVehicle(state: VehicleState, visuals: VehicleVisuals, next: VehicleId): void {
  if (state.id === next) {
    return;
  }

  state.id = next;
  visuals.groups.cab.visible = next === "cab";
  visuals.groups.plane.visible = next === "plane";

  if (next === "plane") {
    state.mode = "ground";
    state.position.y = 1;
    state.rollDistance = 0;
    state.verticalSpeed = 0;
    state.speed = clamp(state.speed, 0, planeConfig.groundMaxForward);
  } else {
    state.mode = "ground";
    state.position.y = 1;
    state.verticalSpeed = 0;
    state.rollDistance = 0;
    state.speed = clamp(state.speed, -carConfig.cab.maxReverse, carConfig.cab.maxForward);
  }
}

function onRunway(position: THREE.Vector3, runwayBounds: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  return position.x >= runwayBounds.minX && position.x <= runwayBounds.maxX && position.z >= runwayBounds.minZ && position.z <= runwayBounds.maxZ;
}

function updateGroundVehicle(
  state: VehicleState,
  input: VehicleInput,
  dt: number,
  hash: SpatialHash,
): VehicleUpdateResult {
  const conf = carConfig.cab;
  const boostMul = input.boost ? 1.7 : 1;
  const maxForward = conf.maxForward * boostMul;
  const isReversing = input.throttle < 0;
  const accel = isReversing ? conf.reverseAccel : conf.accel * (input.boost ? 1.45 : 1);
  state.speed += input.throttle * accel * dt;

  // Active braking: if throttle opposes current direction, brake harder
  if ((state.speed > 0.5 && input.throttle < -0.1) || (state.speed < -0.5 && input.throttle > 0.1)) {
    state.speed *= 0.92;
  }

  if (Math.abs(input.throttle) < 0.01) {
    state.speed *= conf.drag;
  }
  if (Math.abs(state.speed) < 0.22) {
    state.speed = 0;
  }

  state.speed = clamp(state.speed, -conf.maxReverse * boostMul, maxForward);
  // Allow steering at any speed (including stopped/reversing) with a minimum influence
  const steeringInfluence = Math.max(0.4, clamp(Math.abs(state.speed) / conf.maxForward, 0.4, 1));
  state.heading += input.steer * conf.turnRate * dt * steeringInfluence * (state.speed >= 0 ? 1 : -1);

  const delta = new THREE.Vector3(Math.sin(state.heading) * state.speed * dt, 0, Math.cos(state.heading) * state.speed * dt);
  const result = resolveMotion(state.position, delta, PLAYER_RADIUS.cab, hash);
  state.position.copy(result.position);
  state.position.y = 1;

  state.position.x = clamp(state.position.x, -WORLD_CONFIG.worldLimit, WORLD_CONFIG.worldLimit);
  state.position.z = clamp(state.position.z, -WORLD_CONFIG.worldLimit, WORLD_CONFIG.worldLimit);

  // Softer collision: only lose speed proportional to how blocked we were
  if (result.hit) {
    state.speed *= (1 - result.blockedRatio * 0.35);
  }
  const impactSeverity = result.hit ? clamp(0.1 + result.blockedRatio * 0.3, 0.1, 0.5) : 0;
  state.lastImpact = impactSeverity;

  return {
    impactSeverity,
    collided: result.hit,
    onRunway: false,
  };
}

function updatePlane(
  state: VehicleState,
  input: VehicleInput,
  dt: number,
  hash: SpatialHash,
  runwayBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): VehicleUpdateResult {
  const beforeSpeed = Math.abs(state.speed);
  let collided = false;

  const nowOnRunway = onRunway(state.position, runwayBounds);

  if (state.mode !== "airborne") {
    const groundBoost = input.boost ? 1.28 : 1;
    state.speed += input.throttle * planeConfig.accel * groundBoost * dt;
    if (Math.abs(input.throttle) < 0.01) {
      state.speed *= planeConfig.dragGround;
    }
    state.speed = clamp(state.speed, -planeConfig.groundReverse, planeConfig.groundMaxForward * (input.boost ? 1.22 : 1));

    const speedRatio = Math.abs(state.speed) / planeConfig.groundMaxForward;
    const steerInfluence = speedRatio < 0.04 ? 0 : clamp(speedRatio, 0.18, 1);
    const steerDirection = state.speed >= 0 ? 1 : -1;
    state.heading += input.steer * planeConfig.turnGround * dt * steerInfluence * steerDirection;
    const groundDelta = new THREE.Vector3(Math.sin(state.heading) * state.speed * dt, 0, Math.cos(state.heading) * state.speed * dt);
    const resolve = resolveMotion(state.position, groundDelta, PLAYER_RADIUS.planeGround, hash);
    state.position.copy(resolve.position);
    state.position.y = 1;

    if (resolve.hit) {
      collided = true;
    }

    if (nowOnRunway && input.throttle > 0.05 && state.speed > 2) {
      state.rollDistance += Math.abs(state.speed * dt);
      if (state.speed > planeConfig.minAirSpeed) {
        state.mode = "takeoff-roll";
      }
    } else if (!nowOnRunway) {
      state.mode = "ground";
      state.rollDistance = 0;
    }

    if (
      canPlaneTakeoff(
        nowOnRunway,
        state.speed,
        state.rollDistance,
        WORLD_CONFIG.runwayTakeoffSpeed,
        WORLD_CONFIG.runwayRollDistance,
      )
    ) {
      state.mode = "airborne";
      state.position.y = 2.2;
      state.verticalSpeed = 5.6;
      state.rollDistance = 0;
    }

    // Arcade assist: Q should always let the player fly without strict runway gating.
    if (state.mode !== "airborne" && input.ascend > 0.2 && state.speed > 2) {
      state.mode = "airborne";
      state.position.y = 2.05;
      state.verticalSpeed = 2.6;
      state.rollDistance = 0;
      state.speed = Math.max(state.speed, planeConfig.minAirSpeed);
    }
  } else {
    state.speed += input.throttle * planeConfig.accel * (input.boost ? 1.2 : 1) * dt;
    state.speed *= planeConfig.dragAir;
    state.speed = clamp(state.speed, planeConfig.minAirSpeed, planeConfig.maxAirSpeed * (input.boost ? 1.22 : 1));

    state.heading += input.steer * planeConfig.turnAir * dt;
    const lift = clamp((state.speed - 14) * 0.22, 0.2, 5.4);
    const verticalTarget = input.ascend > 0.2
      ? 6.4 + lift * 0.45
      : input.descend > 0.2
        ? -5.8
        : -1.6;
    const smoothing = clamp(dt * 3.2, 0, 1);
    state.verticalSpeed = THREE.MathUtils.lerp(state.verticalSpeed, verticalTarget, smoothing);
    state.verticalSpeed -= planeConfig.gravity * dt * 0.1;
    state.verticalSpeed = clamp(state.verticalSpeed, -7, 10);

    state.position.x += Math.sin(state.heading) * state.speed * dt;
    state.position.z += Math.cos(state.heading) * state.speed * dt;
    state.position.y += state.verticalSpeed * dt;

    // Smooth touchdown: gradually reduce vertical speed as we approach ground
    if (state.position.y < 3.5 && state.verticalSpeed < 0) {
      const groundProximity = clamp((3.5 - state.position.y) / 2.5, 0, 1);
      state.verticalSpeed *= (1 - groundProximity * 0.15);
    }
    if (state.position.y < 1.1) {
      state.position.y = 1;
      state.mode = "landing-roll";
      state.verticalSpeed = 0;
      state.speed = Math.max(state.speed, 13);
    }

    if (state.position.y < SAFE_FLIGHT_ALTITUDE + 1) {
      const nearby = hash.query(state.position, PLAYER_RADIUS.planeAir + 0.5);
      if (collidesAtAltitude(state.position, PLAYER_RADIUS.planeAir, nearby, 1.4)) {
        state.verticalSpeed = Math.max(state.verticalSpeed, 9);
        state.position.y += 1.2;
        collided = true;
      }
    }
  }

  if (state.mode === "landing-roll" && state.speed < 9.5) {
    state.mode = "ground";
  }

  state.position.x = clamp(state.position.x, -WORLD_CONFIG.worldLimit, WORLD_CONFIG.worldLimit);
  state.position.z = clamp(state.position.z, -WORLD_CONFIG.worldLimit, WORLD_CONFIG.worldLimit);
  state.position.y = clamp(state.position.y, 1, 70);

  const afterSpeed = Math.abs(state.speed);
  const impactSeverity = collided ? clamp(0.25 + Math.abs(beforeSpeed - afterSpeed) * 0.08, 0.25, 0.75) : 0;
  state.lastImpact = impactSeverity;

  return {
    impactSeverity,
    collided,
    onRunway: nowOnRunway,
  };
}

export function updateVehiclePhysics(
  state: VehicleState,
  input: VehicleInput,
  dt: number,
  hash: SpatialHash,
  runwayBounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): VehicleUpdateResult {
  if (state.id === "plane") {
    return updatePlane(state, input, dt, hash, runwayBounds);
  }
  return updateGroundVehicle(state, input, dt, hash);
}

export function applyVehicleVisuals(state: VehicleState, visuals: VehicleVisuals, timeSec: number, steer: number): void {
  const active = visuals.groups[state.id];
  active.position.copy(state.position);
  active.rotation.set(0, state.heading + Math.PI / 2, 0);

  if (state.id === "plane") {
    active.rotation.z = THREE.MathUtils.lerp(active.rotation.z, -steer * 0.36, 0.08);
    active.rotation.x = THREE.MathUtils.lerp(active.rotation.x, state.mode === "airborne" ? -state.verticalSpeed * 0.03 : 0, 0.08);
    visuals.planePropeller.rotation.x += Math.min(Math.abs(state.speed) * 0.22, 1.25);
  } else {
    active.rotation.z = THREE.MathUtils.lerp(active.rotation.z, -steer * 0.08, 0.12);
    active.position.y += Math.sin(timeSec * 11) * 0.015;
  }
}

export function getVehicleForward(state: VehicleState): THREE.Vector3 {
  return BASE_FORWARD.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), state.heading).normalize();
}
