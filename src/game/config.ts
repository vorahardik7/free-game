import type { BuildingArchetype, WorldConfig } from "./types";

export const WORLD_CONFIG: WorldConfig = {
  tileSize: 24,
  gridHalf: 9,
  pedestrianCap: 450,
  treeCount: 340,
  runwayTakeoffSpeed: 16,
  runwayRollDistance: 16,
  worldLimit: 240,
};

export const BUILDING_ARCHETYPES: BuildingArchetype[] = [
  { id: "glass-office", footprint: 14, minHeight: 30, maxHeight: 60, materialSet: "glass" },
  { id: "stepped-tower", footprint: 16, minHeight: 28, maxHeight: 54, materialSet: "concrete" },
  { id: "art-deco-midrise", footprint: 15, minHeight: 18, maxHeight: 34, materialSet: "concrete" },
  { id: "podium-tower", footprint: 18, minHeight: 26, maxHeight: 45, materialSet: "glass" },
  { id: "residential-balcony", footprint: 16, minHeight: 14, maxHeight: 28, materialSet: "brick" },
  { id: "corner-rounded", footprint: 13, minHeight: 15, maxHeight: 30, materialSet: "brick" },
  { id: "warehouse-loft", footprint: 19, minHeight: 8, maxHeight: 18, materialSet: "metal" },
  { id: "hangar-terminal", footprint: 22, minHeight: 10, maxHeight: 20, materialSet: "metal" },
];

export const HUD_TICK_MS = 100;

export const SAFE_FLIGHT_ALTITUDE = 8;

export const PLAYER_RADIUS = {
  cab: 1.55,
  planeGround: 2.1,
  planeAir: 2.5,
};
