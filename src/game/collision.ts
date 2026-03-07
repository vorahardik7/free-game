import * as THREE from "three";
import type { Collider, Obb2 } from "./types";
import { clamp } from "./math";

export interface CollisionQuery {
  position: THREE.Vector3;
  radius: number;
}

export interface ResolveMotionResult {
  position: THREE.Vector3;
  hit: boolean;
  blockedRatio: number;
  contactCount: number;
}

function keyFor(x: number, z: number): string {
  return `${x},${z}`;
}

function boundsForCollider(collider: Collider): { minX: number; maxX: number; minZ: number; maxZ: number } {
  if (!collider.obb) {
    return {
      minX: collider.aabb.minX,
      maxX: collider.aabb.maxX,
      minZ: collider.aabb.minZ,
      maxZ: collider.aabb.maxZ,
    };
  }

  const obb = collider.obb;
  const corners = [
    new THREE.Vector2(obb.halfX, obb.halfZ),
    new THREE.Vector2(obb.halfX, -obb.halfZ),
    new THREE.Vector2(-obb.halfX, obb.halfZ),
    new THREE.Vector2(-obb.halfX, -obb.halfZ),
  ];

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const corner of corners) {
    const rx = corner.x * Math.cos(obb.angle) - corner.y * Math.sin(obb.angle);
    const rz = corner.x * Math.sin(obb.angle) + corner.y * Math.cos(obb.angle);
    const px = obb.centerX + rx;
    const pz = obb.centerZ + rz;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minZ = Math.min(minZ, pz);
    maxZ = Math.max(maxZ, pz);
  }

  return { minX, maxX, minZ, maxZ };
}

export class SpatialHash {
  private readonly cellSize: number;

  private buckets = new Map<string, Collider[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.buckets.clear();
  }

  insert(collider: Collider): void {
    const b = boundsForCollider(collider);
    const minCX = Math.floor(b.minX / this.cellSize);
    const maxCX = Math.floor(b.maxX / this.cellSize);
    const minCZ = Math.floor(b.minZ / this.cellSize);
    const maxCZ = Math.floor(b.maxZ / this.cellSize);

    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const key = keyFor(cx, cz);
        const list = this.buckets.get(key);
        if (list) {
          list.push(collider);
        } else {
          this.buckets.set(key, [collider]);
        }
      }
    }
  }

  bulkInsert(colliders: Collider[]): void {
    this.clear();
    colliders.forEach((c) => this.insert(c));
  }

  query(pos: THREE.Vector3, radius: number): Collider[] {
    const minCX = Math.floor((pos.x - radius) / this.cellSize);
    const maxCX = Math.floor((pos.x + radius) / this.cellSize);
    const minCZ = Math.floor((pos.z - radius) / this.cellSize);
    const maxCZ = Math.floor((pos.z + radius) / this.cellSize);
    const seen = new Set<string>();
    const result: Collider[] = [];

    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const bucket = this.buckets.get(keyFor(cx, cz));
        if (!bucket) {
          continue;
        }
        for (const collider of bucket) {
          if (seen.has(collider.id)) {
            continue;
          }
          seen.add(collider.id);
          result.push(collider);
        }
      }
    }

    return result;
  }
}

function circleVsAabb(pos: THREE.Vector3, radius: number, collider: Collider): THREE.Vector2 | null {
  const nearestX = clamp(pos.x, collider.aabb.minX, collider.aabb.maxX);
  const nearestZ = clamp(pos.z, collider.aabb.minZ, collider.aabb.maxZ);

  const dx = pos.x - nearestX;
  const dz = pos.z - nearestZ;
  const distSq = dx * dx + dz * dz;

  if (distSq > radius * radius) {
    return null;
  }

  const dist = Math.sqrt(distSq);
  if (dist > 1e-6) {
    const depth = radius - dist;
    return new THREE.Vector2((dx / dist) * depth, (dz / dist) * depth);
  }

  const left = Math.abs(pos.x - collider.aabb.minX);
  const right = Math.abs(collider.aabb.maxX - pos.x);
  const front = Math.abs(collider.aabb.maxZ - pos.z);
  const back = Math.abs(pos.z - collider.aabb.minZ);

  const minEdge = Math.min(left, right, front, back);
  if (minEdge === left) {
    return new THREE.Vector2(-(radius - left), 0);
  }
  if (minEdge === right) {
    return new THREE.Vector2(radius - right, 0);
  }
  if (minEdge === front) {
    return new THREE.Vector2(0, radius - front);
  }
  return new THREE.Vector2(0, -(radius - back));
}

function circleVsObb(pos: THREE.Vector3, radius: number, obb: Obb2): THREE.Vector2 | null {
  const cos = Math.cos(-obb.angle);
  const sin = Math.sin(-obb.angle);
  const lx = (pos.x - obb.centerX) * cos - (pos.z - obb.centerZ) * sin;
  const lz = (pos.x - obb.centerX) * sin + (pos.z - obb.centerZ) * cos;

  const nearestX = clamp(lx, -obb.halfX, obb.halfX);
  const nearestZ = clamp(lz, -obb.halfZ, obb.halfZ);
  const dx = lx - nearestX;
  const dz = lz - nearestZ;

  const distSq = dx * dx + dz * dz;
  if (distSq > radius * radius) {
    return null;
  }

  const dist = Math.sqrt(distSq);
  let pushLocal = new THREE.Vector2();

  if (dist > 1e-6) {
    const depth = radius - dist;
    pushLocal = new THREE.Vector2((dx / dist) * depth, (dz / dist) * depth);
  } else {
    const left = Math.abs(-obb.halfX - lx);
    const right = Math.abs(obb.halfX - lx);
    const top = Math.abs(obb.halfZ - lz);
    const bottom = Math.abs(-obb.halfZ - lz);
    const minEdge = Math.min(left, right, top, bottom);
    if (minEdge === left) {
      pushLocal.set(-(radius - left), 0);
    } else if (minEdge === right) {
      pushLocal.set(radius - right, 0);
    } else if (minEdge === top) {
      pushLocal.set(0, radius - top);
    } else {
      pushLocal.set(0, -(radius - bottom));
    }
  }

  const wx = pushLocal.x * Math.cos(obb.angle) - pushLocal.y * Math.sin(obb.angle);
  const wz = pushLocal.x * Math.sin(obb.angle) + pushLocal.y * Math.cos(obb.angle);
  return new THREE.Vector2(wx, wz);
}

function separationVector(pos: THREE.Vector3, radius: number, collider: Collider): THREE.Vector2 | null {
  return collider.obb ? circleVsObb(pos, radius, collider.obb) : circleVsAabb(pos, radius, collider);
}

export function resolveMotion(
  start: THREE.Vector3,
  delta: THREE.Vector3,
  radius: number,
  hash: SpatialHash,
  filter?: (collider: Collider) => boolean,
): ResolveMotionResult {
  const length = Math.hypot(delta.x, delta.z);
  const steps = Math.max(1, Math.ceil(length / Math.max(radius * 0.45, 0.25)));
  const stepX = delta.x / steps;
  const stepZ = delta.z / steps;

  const position = start.clone();
  let contactCount = 0;
  let blocked = 0;

  for (let i = 0; i < steps; i += 1) {
    position.x += stepX;
    const xNeighbors = hash.query(position, radius + 0.25);
    for (const collider of xNeighbors) {
      if (!collider.blocking || (filter && !filter(collider))) {
        continue;
      }
      const push = separationVector(position, radius, collider);
      if (push && Math.abs(push.x) > 1e-5) {
        position.x += push.x;
        contactCount += 1;
        blocked += Math.min(Math.abs(push.x), Math.abs(stepX));
      }
    }

    position.z += stepZ;
    const zNeighbors = hash.query(position, radius + 0.25);
    for (const collider of zNeighbors) {
      if (!collider.blocking || (filter && !filter(collider))) {
        continue;
      }
      const push = separationVector(position, radius, collider);
      if (push && Math.abs(push.y) > 1e-5) {
        position.z += push.y;
        contactCount += 1;
        blocked += Math.min(Math.abs(push.y), Math.abs(stepZ));
      }
    }
  }

  const blockedRatio = clamp(blocked / (Math.abs(delta.x) + Math.abs(delta.z) + 1e-5), 0, 1);
  return {
    position,
    hit: contactCount > 0,
    blockedRatio,
    contactCount,
  };
}

export function collidesAtAltitude(position: THREE.Vector3, radius: number, colliders: Collider[], altitudePadding = 2): boolean {
  for (const collider of colliders) {
    const nearestX = clamp(position.x, collider.aabb.minX, collider.aabb.maxX);
    const nearestZ = clamp(position.z, collider.aabb.minZ, collider.aabb.maxZ);
    const dx = position.x - nearestX;
    const dz = position.z - nearestZ;
    if (dx * dx + dz * dz > radius * radius) {
      continue;
    }
    if (position.y <= collider.aabb.maxY + altitudePadding) {
      return true;
    }
  }
  return false;
}

export function makeAabbCollider(
  id: string,
  kind: Collider["kind"],
  zone: Collider["zone"],
  center: THREE.Vector3,
  halfSize: THREE.Vector3,
  blocking = true,
): Collider {
  return {
    id,
    kind,
    zone,
    blocking,
    aabb: {
      minX: center.x - halfSize.x,
      maxX: center.x + halfSize.x,
      minY: center.y - halfSize.y,
      maxY: center.y + halfSize.y,
      minZ: center.z - halfSize.z,
      maxZ: center.z + halfSize.z,
    },
  };
}
