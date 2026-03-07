import * as THREE from "three";
import { choose, randRange, seededRng } from "./math";
import { shouldPedestrianDodge, shouldPedestrianFade } from "./sim-rules";
import type { PedestrianAgent, PedestrianState, SidewalkNode } from "./types";

export interface PedestrianSystem {
  agents: PedestrianAgent[];
  update: (dt: number, playerPosition: THREE.Vector3, playerForward: THREE.Vector3, playerSpeed: number) => void;
}

const BODY_COLORS = [
  "#f59e0b",
  "#3b82f6",
  "#ec4899",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#f97316",
  "#14b8a6",
  "#f43f5e",
  "#06b6d4",
  "#f43f5e",
  "#22c55e",
  "#facc15",
  "#60a5fa",
];
const HAT_COLORS = ["#111827", "#334155", "#7c2d12", "#1d4ed8", "#831843", "#14532d", "#854d0e"];
const BAG_COLORS = ["#1f2937", "#854d0e", "#0f766e", "#6b21a8", "#0f172a", "#4c1d95"];
const JACKET_COLORS = ["#0f172a", "#1e3a8a", "#7f1d1d", "#14532d", "#831843", "#334155"];
const SKIN_TONES = ["#f8d4b4", "#e9bf9b", "#cf9b74", "#b77f59", "#8d5d42"];

function pickNextNode(rng: () => number, nodes: SidewalkNode[], current: SidewalkNode, previousId: number): number {
  const options = current.neighbors.filter((id) => id !== previousId);
  if (options.length === 0) {
    return current.neighbors[0] ?? current.id;
  }
  return choose(rng, options);
}

function setHidden(matrix: THREE.Matrix4): void {
  matrix.makeScale(0.0001, 0.0001, 0.0001);
  matrix.setPosition(0, -1000, 0);
}

function updatePedestrianState(
  agent: PedestrianAgent,
  nodes: SidewalkNode[],
  rng: () => number,
  dt: number,
  playerPosition: THREE.Vector3,
  playerForward: THREE.Vector3,
  playerSpeed: number,
): void {
  const distToPlayer = agent.position.distanceTo(playerPosition);
  agent.active = distToPlayer < 320;
  if (!agent.active) {
    agent.velocity.set(0, 0, 0);
    return;
  }

  if (agent.fadeTimer > 0) {
    agent.fadeTimer = Math.max(0, agent.fadeTimer - dt);
    if (agent.fadeTimer <= 0) {
      agent.state = "walk";
    }
  }

  if (agent.dodgeTimer > 0) {
    agent.dodgeTimer = Math.max(0, agent.dodgeTimer - dt);
    if (agent.dodgeTimer <= 0 && agent.state === "dodge") {
      agent.state = "walk";
    }
  }

  const toPed = agent.position.clone().sub(playerPosition);
  const dist = toPed.length();
  const dirToPed = toPed.lengthSq() > 1e-6 ? toPed.normalize() : new THREE.Vector3();
  const approachDot = playerForward.dot(dirToPed);

  if (playerSpeed > 2.4 && shouldPedestrianDodge(dist, approachDot)) {
    agent.state = "dodge";
    agent.dodgeTimer = 0.52;
  }

  if (shouldPedestrianFade(dist)) {
    agent.state = "fade";
    agent.fadeTimer = 0.45;
  }

  if (agent.waitTimer > 0) {
    agent.waitTimer -= dt;
    agent.velocity.set(0, 0, 0);
  } else {
    const target = nodes[agent.targetNode];
    const toTarget = target.position.clone().sub(agent.position);
    toTarget.y = 0;
    const distance = toTarget.length();

    if (distance < 0.32) {
      const prev = agent.currentNode;
      agent.currentNode = agent.targetNode;
      const currentNode = nodes[agent.currentNode];
      agent.targetNode = pickNextNode(rng, nodes, currentNode, prev);

      if (currentNode.crosswalk && rng() < 0.36) {
        agent.waitTimer = randRange(rng, 0.2, 0.9);
        agent.state = "wait";
      } else if (agent.state !== "fade" && agent.state !== "dodge") {
        agent.state = "walk";
      }
    } else {
      toTarget.normalize();
      let speed = agent.speed;

      if (agent.state === "dodge") {
        const dodge = new THREE.Vector3(-playerForward.z, 0, playerForward.x).multiplyScalar(0.82);
        toTarget.addScaledVector(dodge, 0.85).normalize();
        speed *= 1.5;
      }

      if (agent.state === "fade") {
        speed *= 0.68;
      }

      agent.velocity.copy(toTarget).multiplyScalar(speed);
      agent.position.addScaledVector(agent.velocity, dt);
    }
  }

  agent.bobPhase += dt * (2.4 + agent.speed * 0.54);
}

export function createPedestrianSystem(
  scene: THREE.Scene,
  sidewalkNodes: SidewalkNode[],
  cap: number,
): PedestrianSystem {
  const rng = seededRng(44091);

  const bodyGeometry = new THREE.CapsuleGeometry(0.32, 0.95, 4, 8);
  const headGeometry = new THREE.SphereGeometry(0.24, 10, 10);
  const hatGeometry = new THREE.CylinderGeometry(0.22, 0.25, 0.16, 10);
  const bagGeometry = new THREE.BoxGeometry(0.22, 0.32, 0.15);
  const jacketGeometry = new THREE.CapsuleGeometry(0.35, 0.44, 4, 8);
  const hairGeometry = new THREE.SphereGeometry(0.18, 8, 8);

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.68, metalness: 0.1 });
  const headMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, metalness: 0.03 });
  const hatMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.7, metalness: 0.1 });
  const bagMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.8, metalness: 0.1 });
  const jacketMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.7, metalness: 0.1 });
  const hairMaterial = new THREE.MeshStandardMaterial({ color: "#111827", roughness: 0.9, metalness: 0.03 });

  const bodyMesh = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, cap);
  const headMesh = new THREE.InstancedMesh(headGeometry, headMaterial, cap);
  const hatMesh = new THREE.InstancedMesh(hatGeometry, hatMaterial, cap);
  const bagMesh = new THREE.InstancedMesh(bagGeometry, bagMaterial, cap);
  const jacketMesh = new THREE.InstancedMesh(jacketGeometry, jacketMaterial, cap);
  const hairMesh = new THREE.InstancedMesh(hairGeometry, hairMaterial, cap);

  bodyMesh.castShadow = true;
  headMesh.castShadow = true;
  hatMesh.castShadow = true;
  bagMesh.castShadow = true;
  jacketMesh.castShadow = true;
  hairMesh.castShadow = true;

  scene.add(bodyMesh, headMesh, hatMesh, bagMesh, jacketMesh, hairMesh);

  const agents: PedestrianAgent[] = [];
  for (let i = 0; i < cap; i += 1) {
    const currentNode = Math.floor(rng() * sidewalkNodes.length);
    const current = sidewalkNodes[currentNode];
    const targetNode = current.neighbors.length > 0 ? choose(rng, current.neighbors) : current.id;

    agents.push({
      id: i,
      state: "walk",
      position: current.position.clone(),
      velocity: new THREE.Vector3(),
      targetNode,
      currentNode,
      fadeTimer: 0,
      waitTimer: randRange(rng, 0, 2),
      dodgeTimer: 0,
      bobPhase: rng() * Math.PI * 2,
      speed: randRange(rng, 1.15, 2.3),
      active: true,
      bodyScale: randRange(rng, 0.88, 1.22),
      shoulderScale: randRange(rng, 0.92, 1.15),
      headScale: randRange(rng, 0.9, 1.2),
      styleSeed: rng(),
      hasHat: rng() < 0.38,
      hasBag: rng() < 0.42,
      hasJacket: rng() < 0.5,
      hasHair: rng() < 0.56,
      bodyColorIndex: Math.floor(rng() * BODY_COLORS.length),
      bagColorIndex: Math.floor(rng() * BAG_COLORS.length),
      hatColorIndex: Math.floor(rng() * HAT_COLORS.length),
      jacketColorIndex: Math.floor(rng() * JACKET_COLORS.length),
      skinToneIndex: Math.floor(rng() * SKIN_TONES.length),
    });
  }

  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  return {
    agents,
    update(dt, playerPosition, playerForward, playerSpeed) {
      for (const agent of agents) {
        updatePedestrianState(agent, sidewalkNodes, rng, dt, playerPosition, playerForward, playerSpeed);

        if (!agent.active) {
          setHidden(matrix);
          bodyMesh.setMatrixAt(agent.id, matrix);
          headMesh.setMatrixAt(agent.id, matrix);
          hatMesh.setMatrixAt(agent.id, matrix);
          bagMesh.setMatrixAt(agent.id, matrix);
          jacketMesh.setMatrixAt(agent.id, matrix);
          hairMesh.setMatrixAt(agent.id, matrix);
          continue;
        }

        const fade = agent.fadeTimer > 0 ? 0.45 : 1;
        const bob = Math.sin(agent.bobPhase) * 0.03;
        const sway = Math.sin(agent.bobPhase * 0.6) * 0.05;

        matrix.makeScale(agent.shoulderScale, fade * agent.bodyScale, agent.shoulderScale);
        matrix.setPosition(agent.position.x, 1.1 + bob, agent.position.z);
        bodyMesh.setMatrixAt(agent.id, matrix);

        matrix.makeScale(agent.headScale, fade * agent.headScale, agent.headScale);
        matrix.setPosition(agent.position.x, 2.0 + bob, agent.position.z);
        headMesh.setMatrixAt(agent.id, matrix);

        if (agent.hasHat) {
          matrix.makeScale(agent.headScale, fade * agent.headScale, agent.headScale);
          matrix.setPosition(agent.position.x, 2.26 + bob, agent.position.z);
          hatMesh.setMatrixAt(agent.id, matrix);
        } else {
          setHidden(matrix);
          hatMesh.setMatrixAt(agent.id, matrix);
        }

        if (agent.hasBag) {
          matrix.makeScale(1, fade, 1);
          matrix.setPosition(agent.position.x + 0.3 + sway, 1.3 + bob, agent.position.z - 0.07);
          bagMesh.setMatrixAt(agent.id, matrix);
        } else {
          setHidden(matrix);
          bagMesh.setMatrixAt(agent.id, matrix);
        }

        if (agent.hasJacket) {
          matrix.makeScale(0.95, fade * 0.88, 0.93);
          matrix.setPosition(agent.position.x, 1.38 + bob, agent.position.z);
          jacketMesh.setMatrixAt(agent.id, matrix);
        } else {
          setHidden(matrix);
          jacketMesh.setMatrixAt(agent.id, matrix);
        }

        if (agent.hasHair) {
          matrix.makeScale(1, fade, 1);
          matrix.setPosition(agent.position.x, 2.2 + bob, agent.position.z);
          hairMesh.setMatrixAt(agent.id, matrix);
        } else {
          setHidden(matrix);
          hairMesh.setMatrixAt(agent.id, matrix);
        }

        const paletteColor = BODY_COLORS[agent.bodyColorIndex % BODY_COLORS.length];
        color.set(paletteColor);
        if (agent.state === "dodge") {
          color.offsetHSL(0, 0.04, 0.08);
        }
        if (agent.state === "fade") {
          color.lerp(new THREE.Color("#dbeafe"), 0.5);
        }
        bodyMesh.setColorAt(agent.id, color);

        color.set(SKIN_TONES[agent.skinToneIndex % SKIN_TONES.length] ?? "#f9d4bb");
        headMesh.setColorAt(agent.id, color);

        color.set(HAT_COLORS[agent.hatColorIndex % HAT_COLORS.length] ?? "#111827");
        hatMesh.setColorAt(agent.id, color);

        color.set(BAG_COLORS[agent.bagColorIndex % BAG_COLORS.length] ?? "#1f2937");
        bagMesh.setColorAt(agent.id, color);

        color.set(JACKET_COLORS[agent.jacketColorIndex % JACKET_COLORS.length] ?? "#334155");
        jacketMesh.setColorAt(agent.id, color);
      }

      bodyMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
      hatMesh.instanceMatrix.needsUpdate = true;
      bagMesh.instanceMatrix.needsUpdate = true;
      jacketMesh.instanceMatrix.needsUpdate = true;
      hairMesh.instanceMatrix.needsUpdate = true;
      if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
      if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
      if (hatMesh.instanceColor) hatMesh.instanceColor.needsUpdate = true;
      if (bagMesh.instanceColor) bagMesh.instanceColor.needsUpdate = true;
      if (jacketMesh.instanceColor) jacketMesh.instanceColor.needsUpdate = true;
    },
  };
}

export function createPedestrianAgentForTest(state: PedestrianState, position: THREE.Vector3): PedestrianAgent {
  return {
    id: 0,
    state,
    position,
    velocity: new THREE.Vector3(),
    targetNode: 0,
    currentNode: 0,
    fadeTimer: 0,
    waitTimer: 0,
    dodgeTimer: 0,
    bobPhase: 0,
    speed: 1.5,
    active: true,
    bodyScale: 1,
    shoulderScale: 1,
    headScale: 1,
    styleSeed: 0,
    hasHat: false,
    hasBag: false,
    hasJacket: false,
    hasHair: false,
    bodyColorIndex: 0,
    bagColorIndex: 0,
    hatColorIndex: 0,
    jacketColorIndex: 0,
    skinToneIndex: 0,
  };
}

export function updatePedestrianForTest(
  agent: PedestrianAgent,
  nodes: SidewalkNode[],
  dt: number,
  playerPosition: THREE.Vector3,
  playerForward: THREE.Vector3,
  playerSpeed: number,
): void {
  const rng = seededRng(1234);
  updatePedestrianState(agent, nodes, rng, dt, playerPosition, playerForward, playerSpeed);
}
