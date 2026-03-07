import * as THREE from "three";

export type VehicleId = "cab" | "plane";

export type VehicleMode = "ground" | "airborne" | "takeoff-roll" | "landing-roll";

export type ColliderKind =
  | "building"
  | "tree"
  | "prop"
  | "curb"
  | "barrier"
  | "runway"
  | "water-edge";

export type ZoneId = "downtown" | "residential" | "park" | "airport" | "waterfront";

export interface Aabb3 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface Obb2 {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  angle: number;
  minY: number;
  maxY: number;
}

export interface Collider {
  id: string;
  kind: ColliderKind;
  zone: ZoneId;
  blocking: boolean;
  aabb: Aabb3;
  obb?: Obb2;
}

export type RoadTileType = "straight" | "corner" | "t-junction" | "cross" | "boulevard" | "runway";

export interface RoadTile {
  id: string;
  gx: number;
  gz: number;
  tileType: RoadTileType;
  laneCount: number;
  speedLimit: number;
  isRunway: boolean;
  sidewalks: boolean;
}

export interface BuildingArchetype {
  id:
    | "glass-office"
    | "stepped-tower"
    | "art-deco-midrise"
    | "podium-tower"
    | "residential-balcony"
    | "corner-rounded"
    | "warehouse-loft"
    | "hangar-terminal";
  footprint: number;
  minHeight: number;
  maxHeight: number;
  materialSet: "glass" | "concrete" | "brick" | "metal";
}

export type PedestrianState = "walk" | "wait" | "dodge" | "fade";

export interface SidewalkNode {
  id: number;
  position: THREE.Vector3;
  neighbors: number[];
  crosswalk: boolean;
}

export interface PedestrianAgent {
  id: number;
  state: PedestrianState;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  targetNode: number;
  currentNode: number;
  fadeTimer: number;
  waitTimer: number;
  dodgeTimer: number;
  bobPhase: number;
  speed: number;
  active: boolean;
  bodyScale: number;
  shoulderScale: number;
  headScale: number;
  styleSeed: number;
  hasHat: boolean;
  hasBag: boolean;
  hasJacket: boolean;
  hasHair: boolean;
  bodyColorIndex: number;
  bagColorIndex: number;
  hatColorIndex: number;
  jacketColorIndex: number;
  skinToneIndex: number;
}

export interface WorldConfig {
  tileSize: number;
  gridHalf: number;
  pedestrianCap: number;
  treeCount: number;
  runwayTakeoffSpeed: number;
  runwayRollDistance: number;
  worldLimit: number;
}

export interface MinimapTile {
  gx: number;
  gz: number;
  key: string;
  zone: string;
  road: boolean;
  isRunway: boolean;
}

export interface WorldBuildResult {
  colliders: Collider[];
  roadTiles: RoadTile[];
  tileMeta: MinimapTile[];
  pickupAnchors: THREE.Vector3[];
  sidewalkNodes: SidewalkNode[];
  runwayBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  occluders: THREE.Object3D[];
  debugObjects: THREE.Object3D[];
}

export interface VehicleState {
  id: VehicleId;
  mode: VehicleMode;
  position: THREE.Vector3;
  heading: number;
  speed: number;
  verticalSpeed: number;
  rollDistance: number;
  lastImpact: number;
}

export interface HudSnapshot {
  vehicle: VehicleId;
  mode: VehicleMode;
  money: number;
  rating: number;
  rides: number;
  speed: number;
  message: string;
  objective: "Pickup" | "Dropoff";
  serviceState: "searching" | "boarding" | "in-ride";
  targetDistance: number;
  recentEvent: string;
  collisionPulse: number;
  farePenalty: number;
  fps: number;
  hasPassenger: boolean;
  worldLimit: number;
  playerX: number;
  playerZ: number;
  pickupX: number;
  pickupZ: number;
  dropoffX: number;
  dropoffZ: number;
  heading: number;
  minimapDataUrl: string;
}
