import * as THREE from "three";
import { BUILDING_ARCHETYPES, WORLD_CONFIG } from "./config";
import { choose, randRange, seededRng } from "./math";
import { makeAabbCollider } from "./collision";
import type { BuildingArchetype, Collider, RoadTile, SidewalkNode, WorldBuildResult } from "./types";

const ROAD_DIRECTIONS = [
  { name: "N", dx: 0, dz: -1 },
  { name: "E", dx: 1, dz: 0 },
  { name: "S", dx: 0, dz: 1 },
  { name: "W", dx: -1, dz: 0 },
] as const;

type WorldZone = "downtown" | "residential" | "park" | "airport" | "waterfront";

interface TileConnectivity {
  N: boolean;
  E: boolean;
  S: boolean;
  W: boolean;
}

interface TileMeta {
  gx: number;
  gz: number;
  key: string;
  zone: WorldZone;
  road: boolean;
  isRunway: boolean;
}

interface BuildingMeshResult {
  group: THREE.Group;
  width: number;
  depth: number;
  height: number;
}

type TreeKind = "oak" | "pine" | "canopy" | "palm";

function tileKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}

function zoneFor(gx: number, gz: number): WorldZone {
  if (gz <= -5) {
    return gx <= -3 || gx >= 3 ? "waterfront" : "airport";
  }
  if (gz >= 3) {
    return "park";
  }
  if (Math.abs(gx) <= 2 && gz >= -1 && gz <= 2) {
    return "downtown";
  }
  return "residential";
}

function isRoadTile(gx: number, gz: number): boolean {
  const runway = gz <= -5 && Math.abs(gx) <= 1;
  if (runway) {
    return true;
  }

  if (gz <= -5) {
    return gx === -2 || gx === 2 || gz === -6;
  }

  if (gz >= 7) {
    return gx === -4 || gx === 0 || gx === 4;
  }

  const majorHorizontal = gz === -3 || gz === 0 || gz === 5;
  const majorVertical = gx === -5 || gx === 0 || gx === 5;
  if (majorHorizontal || majorVertical) {
    return true;
  }

  return false;
}

function connectivityFor(meta: TileMeta, roadMap: Set<string>): TileConnectivity {
  const N = roadMap.has(tileKey(meta.gx, meta.gz - 1));
  const E = roadMap.has(tileKey(meta.gx + 1, meta.gz));
  const S = roadMap.has(tileKey(meta.gx, meta.gz + 1));
  const W = roadMap.has(tileKey(meta.gx - 1, meta.gz));
  return { N, E, S, W };
}

function classifyTile(connectivity: TileConnectivity, isRunway: boolean): RoadTile["tileType"] {
  if (isRunway) {
    return "runway";
  }

  const count = [connectivity.N, connectivity.E, connectivity.S, connectivity.W].filter(Boolean).length;

  if (count >= 4) {
    return "cross";
  }
  if (count === 3) {
    return "t-junction";
  }
  if (count === 2) {
    const straight = (connectivity.N && connectivity.S) || (connectivity.E && connectivity.W);
    return straight ? "straight" : "corner";
  }
  return "straight";
}

function shouldBeBoulevard(tile: TileMeta): boolean {
  return tile.gx === 0 || tile.gz === 0 || tile.gz === -4;
}

function createRoadTiles(): { tiles: RoadTile[]; tileMeta: TileMeta[] } {
  const tiles: RoadTile[] = [];
  const tileMeta: TileMeta[] = [];
  const roadMap = new Set<string>();

  for (let gz = -WORLD_CONFIG.gridHalf; gz <= WORLD_CONFIG.gridHalf; gz += 1) {
    for (let gx = -WORLD_CONFIG.gridHalf; gx <= WORLD_CONFIG.gridHalf; gx += 1) {
      const zone = zoneFor(gx, gz);
      const isRunway = gz <= -5 && Math.abs(gx) <= 1;
      const road = isRoadTile(gx, gz);
      const meta: TileMeta = { gx, gz, key: tileKey(gx, gz), zone, road, isRunway };
      tileMeta.push(meta);
      if (road) {
        roadMap.add(meta.key);
      }
    }
  }

  for (const meta of tileMeta) {
    if (!meta.road) {
      continue;
    }

    const connectivity = connectivityFor(meta, roadMap);
    let tileType = classifyTile(connectivity, meta.isRunway);
    if (shouldBeBoulevard(meta) && !meta.isRunway) {
      tileType = "boulevard";
    }

    tiles.push({
      id: meta.key,
      gx: meta.gx,
      gz: meta.gz,
      tileType,
      laneCount: tileType === "boulevard" || tileType === "runway" ? 4 : 2,
      speedLimit: tileType === "runway" ? 80 : tileType === "boulevard" ? 50 : 36,
      isRunway: meta.isRunway,
      sidewalks: !meta.isRunway,
    });
  }

  return { tiles, tileMeta };
}

function toWorld(gx: number, gz: number): THREE.Vector3 {
  return new THREE.Vector3(gx * WORLD_CONFIG.tileSize, 0, gz * WORLD_CONFIG.tileSize);
}

function roadMaterials() {
  return {
    asphalt: new THREE.MeshStandardMaterial({ color: "#232e3d", roughness: 0.9, metalness: 0.05 }),
    laneWhite: new THREE.MeshStandardMaterial({ color: "#f5f7fb", roughness: 0.35, emissive: "#c9d4e5", emissiveIntensity: 0.05 }),
    laneYellow: new THREE.MeshStandardMaterial({ color: "#f3bf4d", roughness: 0.35, emissive: "#7d5d12", emissiveIntensity: 0.1 }),
    crosswalk: new THREE.MeshStandardMaterial({ color: "#f8f3e3", roughness: 0.45 }),
    sidewalk: new THREE.MeshStandardMaterial({ color: "#bcc6cf", roughness: 0.82 }),
  };
}

function addRoadVisuals(
  scene: THREE.Scene,
  roadTiles: RoadTile[],
  colliders: Collider[],
  pickupAnchors: THREE.Vector3[],
): void {
  const mats = roadMaterials();
  const tileSize = WORLD_CONFIG.tileSize;
  const roadHalf = tileSize / 2;
  const roadLookup = new Set(roadTiles.map((tile) => tile.id));

  const addLine = (x: number, z: number, w: number, d: number, material: THREE.Material): void => {
    const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), material);
    line.position.set(x, 0.12, z);
    line.receiveShadow = true;
    scene.add(line);
  };

  for (const tile of roadTiles) {
    const center = toWorld(tile.gx, tile.gz);
    const sidewalkWidth = tile.isRunway ? 0 : 3.4;
    const northRoad = roadLookup.has(tileKey(tile.gx, tile.gz - 1));
    const southRoad = roadLookup.has(tileKey(tile.gx, tile.gz + 1));
    const eastRoad = roadLookup.has(tileKey(tile.gx + 1, tile.gz));
    const westRoad = roadLookup.has(tileKey(tile.gx - 1, tile.gz));

    const road = new THREE.Mesh(new THREE.BoxGeometry(tileSize + 0.1, 0.14, tileSize + 0.1), mats.asphalt);
    road.position.set(center.x, 0.07, center.z);
    road.receiveShadow = true;
    scene.add(road);

    if (tile.sidewalks) {
      const overlap = 0.4;

      const addSidewalkEdge = (
        axis: "x" | "z",
        side: number,
        perpStart: boolean,
        perpEnd: boolean,
      ): void => {
        let lo = -roadHalf - overlap;
        let hi = roadHalf + overlap;
        if (perpStart) lo = -roadHalf + sidewalkWidth;
        if (perpEnd) hi = roadHalf - sidewalkWidth;
        const span = hi - lo;
        if (span <= 0) return;
        const mid = (lo + hi) / 2;
        const w = axis === "x" ? span : sidewalkWidth + 0.2;
        const d = axis === "z" ? span : sidewalkWidth + 0.2;
        const ox = axis === "x" ? mid : side;
        const oz = axis === "z" ? mid : side;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, d), mats.sidewalk);
        mesh.position.set(center.x + ox, 0.16, center.z + oz);
        mesh.receiveShadow = true;
        scene.add(mesh);
      };

      if (!northRoad) addSidewalkEdge("x", -roadHalf + sidewalkWidth / 2, westRoad, eastRoad);
      if (!southRoad) addSidewalkEdge("x", roadHalf - sidewalkWidth / 2, westRoad, eastRoad);
      if (!westRoad) addSidewalkEdge("z", -roadHalf + sidewalkWidth / 2, northRoad, southRoad);
      if (!eastRoad) addSidewalkEdge("z", roadHalf - sidewalkWidth / 2, northRoad, southRoad);

      // Curb colliders at outer sidewalk edges to prevent driving onto grass
      const curbHeight = 0.5;
      const curbThickness = 0.6;
      if (!northRoad) {
        colliders.push(makeAabbCollider(
          `curb-n-${tile.gx},${tile.gz}`, "prop", "residential",
          new THREE.Vector3(center.x, curbHeight / 2, center.z - roadHalf),
          new THREE.Vector3(roadHalf, curbHeight / 2, curbThickness / 2),
          true,
        ));
      }
      if (!southRoad) {
        colliders.push(makeAabbCollider(
          `curb-s-${tile.gx},${tile.gz}`, "prop", "residential",
          new THREE.Vector3(center.x, curbHeight / 2, center.z + roadHalf),
          new THREE.Vector3(roadHalf, curbHeight / 2, curbThickness / 2),
          true,
        ));
      }
      if (!westRoad) {
        colliders.push(makeAabbCollider(
          `curb-w-${tile.gx},${tile.gz}`, "prop", "residential",
          new THREE.Vector3(center.x - roadHalf, curbHeight / 2, center.z),
          new THREE.Vector3(curbThickness / 2, curbHeight / 2, roadHalf),
          true,
        ));
      }
      if (!eastRoad) {
        colliders.push(makeAabbCollider(
          `curb-e-${tile.gx},${tile.gz}`, "prop", "residential",
          new THREE.Vector3(center.x + roadHalf, curbHeight / 2, center.z),
          new THREE.Vector3(curbThickness / 2, curbHeight / 2, roadHalf),
          true,
        ));
      }

      const cornerFillers = [
        { enabled: !northRoad && !westRoad, x: -roadHalf + sidewalkWidth / 2, z: -roadHalf + sidewalkWidth / 2 },
        { enabled: !northRoad && !eastRoad, x: roadHalf - sidewalkWidth / 2, z: -roadHalf + sidewalkWidth / 2 },
        { enabled: !southRoad && !westRoad, x: -roadHalf + sidewalkWidth / 2, z: roadHalf - sidewalkWidth / 2 },
        { enabled: !southRoad && !eastRoad, x: roadHalf - sidewalkWidth / 2, z: roadHalf - sidewalkWidth / 2 },
      ];

      cornerFillers.forEach((corner) => {
        if (!corner.enabled) {
          return;
        }
        const filler = new THREE.Mesh(new THREE.BoxGeometry(sidewalkWidth + 0.3, 0.19, sidewalkWidth + 0.3), mats.sidewalk);
        filler.position.set(center.x + corner.x, 0.16, center.z + corner.z);
        filler.receiveShadow = true;
        scene.add(filler);
      });

      // Rounded curb corner caps to remove diagonal gaps at road turns/intersections.
      const cornerRadius = sidewalkWidth + 0.24;
      const makeCornerCap = (cx: number, cz: number, thetaStart: number, enabled: boolean): void => {
        if (!enabled) {
          return;
        }
        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(cornerRadius, cornerRadius, 0.18, 18, 1, false, thetaStart, Math.PI / 2),
          mats.sidewalk,
        );
        cap.position.set(cx, 0.16, cz);
        cap.receiveShadow = true;
        scene.add(cap);
      };

      makeCornerCap(
        center.x - roadHalf,
        center.z - roadHalf,
        0,
        !northRoad && !westRoad,
      );
      makeCornerCap(
        center.x + roadHalf,
        center.z - roadHalf,
        Math.PI * 1.5,
        !northRoad && !eastRoad,
      );
      makeCornerCap(
        center.x + roadHalf,
        center.z + roadHalf,
        Math.PI,
        !southRoad && !eastRoad,
      );
      makeCornerCap(
        center.x - roadHalf,
        center.z + roadHalf,
        Math.PI * 0.5,
        !southRoad && !westRoad,
      );

      // Transition corner fills for mixed corners (one side road, one side sidewalk).
      // Square filler patches where the clipped sidewalk edge stops at a road opening.
      const transitionCorners = [
        { enabled: !northRoad && westRoad, x: -roadHalf + sidewalkWidth / 2, z: -roadHalf + sidewalkWidth / 2 },
        { enabled: !northRoad && eastRoad, x: roadHalf - sidewalkWidth / 2, z: -roadHalf + sidewalkWidth / 2 },
        { enabled: !southRoad && westRoad, x: -roadHalf + sidewalkWidth / 2, z: roadHalf - sidewalkWidth / 2 },
        { enabled: !southRoad && eastRoad, x: roadHalf - sidewalkWidth / 2, z: roadHalf - sidewalkWidth / 2 },
        { enabled: !westRoad && northRoad, x: -roadHalf + sidewalkWidth / 2, z: -roadHalf + sidewalkWidth / 2 },
        { enabled: !westRoad && southRoad, x: -roadHalf + sidewalkWidth / 2, z: roadHalf - sidewalkWidth / 2 },
        { enabled: !eastRoad && northRoad, x: roadHalf - sidewalkWidth / 2, z: -roadHalf + sidewalkWidth / 2 },
        { enabled: !eastRoad && southRoad, x: roadHalf - sidewalkWidth / 2, z: roadHalf - sidewalkWidth / 2 },
      ];
      const placedTransitions = new Set<string>();

      transitionCorners.forEach((tc) => {
        if (!tc.enabled) return;
        const key = `${tc.x},${tc.z}`;
        if (placedTransitions.has(key)) return;
        placedTransitions.add(key);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(sidewalkWidth + 0.3, 0.19, sidewalkWidth + 0.3),
          mats.sidewalk,
        );
        mesh.position.set(center.x + tc.x, 0.16, center.z + tc.z);
        mesh.receiveShadow = true;
        scene.add(mesh);
      });

      const anchorOffset = tileSize / 2 - 5;
      if (!northRoad) {
        pickupAnchors.push(new THREE.Vector3(center.x, 1, center.z - anchorOffset));
      }
      if (!southRoad) {
        pickupAnchors.push(new THREE.Vector3(center.x, 1, center.z + anchorOffset));
      }
      if (!eastRoad) {
        pickupAnchors.push(new THREE.Vector3(center.x + anchorOffset, 1, center.z));
      }
      if (!westRoad) {
        pickupAnchors.push(new THREE.Vector3(center.x - anchorOffset, 1, center.z));
      }
    }

    if (tile.tileType === "runway") {
      addLine(center.x, center.z, 1.25, tileSize * 0.95, mats.laneWhite);
      addLine(center.x - 4.7, center.z, 0.24, tileSize * 0.9, mats.laneWhite);
      addLine(center.x + 4.7, center.z, 0.24, tileSize * 0.9, mats.laneWhite);
      continue;
    }

    // Service anchors: place on roadside edges near sidewalks so pickups aren't in traffic
    const sideOffset = WORLD_CONFIG.tileSize / 2 - 3;
    const verticalFlow = northRoad && southRoad;
    const horizontalFlow = eastRoad && westRoad;
    if (verticalFlow && !horizontalFlow) {
      pickupAnchors.push(new THREE.Vector3(center.x - sideOffset, 1, center.z));
      pickupAnchors.push(new THREE.Vector3(center.x + sideOffset, 1, center.z));
    } else if (horizontalFlow && !verticalFlow) {
      pickupAnchors.push(new THREE.Vector3(center.x, 1, center.z - sideOffset));
      pickupAnchors.push(new THREE.Vector3(center.x, 1, center.z + sideOffset));
    } else {
      // Intersection: place at corners, not center
      pickupAnchors.push(new THREE.Vector3(center.x - sideOffset, 1, center.z - sideOffset));
      pickupAnchors.push(new THREE.Vector3(center.x + sideOffset, 1, center.z + sideOffset));
    }

    if (tile.tileType === "boulevard") {
      const boulevardVertical = verticalFlow || (!horizontalFlow && (northRoad || southRoad));
      if (boulevardVertical) {
        addLine(center.x - 0.36, center.z, 0.2, tileSize * 0.84, mats.laneYellow);
        addLine(center.x + 0.36, center.z, 0.2, tileSize * 0.84, mats.laneYellow);
      } else {
        addLine(center.x, center.z - 0.36, tileSize * 0.84, 0.2, mats.laneYellow);
        addLine(center.x, center.z + 0.36, tileSize * 0.84, 0.2, mats.laneYellow);
      }
      continue;
    }

    if (verticalFlow && !horizontalFlow) {
      addLine(center.x, center.z, 0.24, tileSize * 0.8, mats.laneWhite);
    } else if (horizontalFlow && !verticalFlow) {
      addLine(center.x, center.z, tileSize * 0.8, 0.24, mats.laneWhite);
    }
  }

  const shorelineBarrier = new THREE.Mesh(
    new THREE.BoxGeometry(340, 2, 2),
    new THREE.MeshStandardMaterial({ color: "#8f7b59", roughness: 0.9 }),
  );
  shorelineBarrier.position.set(0, 1, -WORLD_CONFIG.tileSize * 7.2);
  scene.add(shorelineBarrier);
  colliders.push(
    makeAabbCollider(
      "shoreline-barrier",
      "water-edge",
      "waterfront",
      shorelineBarrier.position.clone(),
      new THREE.Vector3(170, 1, 1),
      true,
    ),
  );
}

function tint(base: string, rng: () => number, hue = 0.02, sat = 0.06, light = 0.08): THREE.Color {
  const color = new THREE.Color(base);
  color.offsetHSL(randRange(rng, -hue, hue), randRange(rng, -sat, sat), randRange(rng, -light, light));
  return color;
}

function buildingMaterials(rng: () => number) {
  return {
    glass: new THREE.MeshStandardMaterial({ color: tint("#8eaecd", rng), metalness: 0.68, roughness: 0.18 }),
    concrete: new THREE.MeshStandardMaterial({ color: tint("#a3acb8", rng), metalness: 0.07, roughness: 0.82 }),
    brick: new THREE.MeshStandardMaterial({ color: tint("#b17055", rng), metalness: 0.04, roughness: 0.82 }),
    metal: new THREE.MeshStandardMaterial({ color: tint("#798494", rng), metalness: 0.46, roughness: 0.5 }),
    trim: new THREE.MeshStandardMaterial({ color: tint("#dbe3ee", rng, 0.01, 0.05, 0.06), metalness: 0.24, roughness: 0.3 }),
    dark: new THREE.MeshStandardMaterial({ color: tint("#2a3542", rng, 0.01, 0.03, 0.05), metalness: 0.25, roughness: 0.48 }),
    windowLit: new THREE.MeshStandardMaterial({ color: tint("#f8d695", rng, 0.01, 0.04, 0.06), emissive: "#a36b1c", emissiveIntensity: 0.18, roughness: 0.28, metalness: 0.4 }),
  };
}

function createBuildingMesh(archetype: BuildingArchetype, rng: () => number): BuildingMeshResult {
  const mats = buildingMaterials(rng);
  const group = new THREE.Group();
  const h = randRange(rng, archetype.minHeight, archetype.maxHeight);
  const width = archetype.footprint * randRange(rng, 0.88, 1.14);
  const depth = archetype.footprint * randRange(rng, 0.86, 1.13);

  const addBox = (w: number, y: number, d: number, material: THREE.Material, yPos: number, x = 0, z = 0): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, y, d), material);
    mesh.position.set(x, yPos, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  const addFacadeBands = (w: number, d: number, hBandCount: number): void => {
    for (let i = 0; i < hBandCount; i += 1) {
      const y = 2 + i * ((h * 0.7 - 2) / Math.max(1, hBandCount - 1));
      const band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.1, d * 0.9), mats.trim);
      band.position.set(0, y, 0);
      band.castShadow = true;
      band.receiveShadow = true;
      group.add(band);
    }
  };

  const addWindowGrid = (w: number, d: number, rows: number, cols: number, maxY?: number): void => {
    const panelThickness = 0.08;
    const topY = maxY ?? h;
    for (let r = 0; r < rows; r += 1) {
      const y = 2.1 + r * ((topY - 4.2) / Math.max(1, rows - 1));
      if (y > topY - 0.5) continue;
      for (let c = 0; c < cols; c += 1) {
        const x = -w / 2 + 1 + c * ((w - 2) / Math.max(1, cols - 1));
        const front = new THREE.Mesh(new THREE.BoxGeometry((w - 2) / Math.max(cols, 1) * 0.62, 0.4, panelThickness), mats.windowLit);
        front.position.set(x, y, d / 2 - 0.05);
        group.add(front);
        const back = front.clone();
        back.position.z = -d / 2 + 0.05;
        group.add(back);
      }
    }
  };

  switch (archetype.id) {
    case "glass-office": {
      addBox(width, h, depth, mats.glass, h / 2);
      for (let i = 0; i < 8; i += 1) {
        const x = -width / 2 + 1 + i * ((width - 2) / 7);
        addBox(0.1, h, depth - 0.1, mats.dark, h / 2, x);
      }
      addBox(width * 0.88, 0.3, depth * 0.88, mats.trim, h + 0.15);
      break;
    }
    case "stepped-tower": {
      addBox(width, h * 0.45, depth, mats.concrete, h * 0.225);
      addBox(width * 0.78, h * 0.34, depth * 0.78, mats.concrete, h * 0.45 + h * 0.17);
      addBox(width * 0.56, h * 0.21, depth * 0.56, mats.trim, h * 0.45 + h * 0.34 + h * 0.105);
      addWindowGrid(width, depth, 4, 6, h * 0.45);
      break;
    }
    case "art-deco-midrise": {
      addBox(width, h * 0.72, depth, mats.concrete, h * 0.36);
      addBox(width * 0.8, h * 0.2, depth * 0.8, mats.trim, h * 0.72 + h * 0.1);
      addBox(width * 0.25, h * 0.08, depth * 0.25, mats.trim, h * 0.72 + h * 0.2 + h * 0.04);
      addFacadeBands(width * 0.95, depth * 0.95, 5);
      addWindowGrid(width, depth, 5, 6, h * 0.72);
      break;
    }
    case "podium-tower": {
      addBox(width, h * 0.35, depth, mats.concrete, h * 0.175);
      addBox(width * 0.64, h * 0.65, depth * 0.64, mats.glass, h * 0.35 + h * 0.325);
      addBox(width * 0.6, 0.35, depth * 0.6, mats.trim, h + 0.2);
      addWindowGrid(width * 0.64, depth * 0.64, 5, 4, h);
      break;
    }
    case "residential-balcony": {
      addBox(width, h, depth, mats.brick, h / 2);
      const floors = Math.max(5, Math.floor(h / 3.2));
      for (let i = 0; i < floors; i += 1) {
        const y = 1.5 + i * (h / floors);
        addBox(width + 0.5, 0.16, depth + 0.5, mats.trim, y);
      }
      addWindowGrid(width, depth, floors, 6);
      break;
    }
    case "corner-rounded": {
      const radius = Math.min(width, depth) / 2;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 18), mats.brick);
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      addBox(width * 0.8, 0.35, depth * 0.8, mats.trim, h + 0.2);
      addFacadeBands(width * 0.75, depth * 0.75, 6);
      break;
    }
    case "warehouse-loft": {
      addBox(width, h * 0.8, depth, mats.metal, h * 0.4);
      for (let i = -2; i <= 2; i += 1) {
        addBox(0.2, h * 0.8, depth - 0.2, mats.dark, h * 0.4, i * (width / 5));
      }
      addBox(width * 0.95, h * 0.12, depth * 0.95, mats.trim, h * 0.86);
      addWindowGrid(width, depth, 3, 7, h * 0.8);
      break;
    }
    case "hangar-terminal": {
      addBox(width, h * 0.44, depth, mats.metal, h * 0.22);
      const roof = new THREE.Mesh(new THREE.CylinderGeometry(depth * 0.55, depth * 0.55, width * 0.95, 16, 1, false, Math.PI, Math.PI), mats.trim);
      roof.rotation.z = Math.PI / 2;
      roof.position.y = h * 0.48;
      roof.castShadow = true;
      roof.receiveShadow = true;
      group.add(roof);
      addWindowGrid(width, depth, 2, 8, h * 0.44);
      break;
    }
    default:
      addBox(width, h, depth, mats.concrete, h / 2);
  }

  // Rooftop details - small, flush with building top
  if (rng() < 0.3 && archetype.id !== "hangar-terminal") {
    const rooftop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 0.8, 8),
      new THREE.MeshStandardMaterial({ color: "#8e6a4c", roughness: 0.72, metalness: 0.12 }),
    );
    rooftop.position.set(randRange(rng, -width * 0.15, width * 0.15), h + 0.4, randRange(rng, -depth * 0.15, depth * 0.15));
    rooftop.castShadow = true;
    rooftop.receiveShadow = true;
    group.add(rooftop);
  } else {
    rng(); rng(); // consume RNG to keep determinism
  }

  if (rng() < 0.2 && h > 20) {
    const antennaH = randRange(rng, 1.5, 3.0);
    const antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, antennaH, 6),
      new THREE.MeshStandardMaterial({ color: "#c5d2de", roughness: 0.5, metalness: 0.55 }),
    );
    antenna.position.set(randRange(rng, -width * 0.2, width * 0.2), h + antennaH / 2, randRange(rng, -depth * 0.2, depth * 0.2));
    antenna.castShadow = true;
    group.add(antenna);
  } else {
    rng(); rng(); rng(); // consume RNG
  }

  // Street-level details - flush with walls, not protruding
  if (rng() < 0.3) {
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.3, 0.7, 0.1),
      new THREE.MeshStandardMaterial({ color: "#fbbf24", emissive: "#92400e", emissiveIntensity: 0.22, roughness: 0.3 }),
    );
    sign.position.set(0, Math.min(h * 0.4, 5), depth / 2 - 0.05);
    sign.castShadow = true;
    group.add(sign);
  }

  if (rng() < 0.35) {
    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.4, 0.12, 0.7),
      new THREE.MeshStandardMaterial({ color: "#d1dbe6", roughness: 0.35, metalness: 0.28 }),
    );
    awning.position.set(0, 2.5, depth / 2 + 0.35);
    awning.castShadow = true;
    group.add(awning);
  }

  // Facade details - kept flush with building face
  const facadeVariant = Math.floor(rng() * 4);
  if (facadeVariant === 0) {
    for (let i = 0; i < 3; i += 1) {
      const y = 2.5 + i * ((h * 0.6 - 2.5) / 3);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(width * 0.8, 0.08, 0.1), mats.trim);
      brace.position.set(0, y, depth / 2 - 0.02);
      group.add(brace);
    }
  } else if (facadeVariant === 1) {
    for (let i = -2; i <= 2; i += 1) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, h * 0.6, 0.12), mats.dark);
      fin.position.set(i * (width * 0.15), h * 0.35, depth / 2 - 0.02);
      group.add(fin);
    }
  }

  return { group, width, depth, height: h };
}

function addBuildings(
  scene: THREE.Scene,
  tileMeta: TileMeta[],
  roadSet: Set<string>,
  colliders: Collider[],
  occluders: THREE.Object3D[],
): void {
  const rng = seededRng(4815);

  for (const tile of tileMeta) {
    if (roadSet.has(tile.key)) {
      continue;
    }
    if (tile.zone === "park" && rng() < 0.72) {
      continue;
    }

    const center = toWorld(tile.gx, tile.gz);
    const lotCount = tile.zone === "downtown"
      ? (rng() < 0.52 ? 2 : 1)
      : tile.zone === "residential"
        ? (rng() < 0.35 ? 2 : 1)
        : 1;

    const lotOffsets: Array<{ x: number; z: number }> = lotCount === 2
      ? [{ x: -4.4, z: -1.8 }, { x: 4.4, z: 1.8 }]
      : [{ x: 0, z: 0 }];

    lotOffsets.forEach((offset, lotIndex) => {
      const candidates = BUILDING_ARCHETYPES.filter((b) => {
        if (tile.zone === "downtown") {
          return ["glass-office", "stepped-tower", "podium-tower", "corner-rounded", "art-deco-midrise"].includes(b.id);
        }
        if (tile.zone === "airport") {
          return ["warehouse-loft", "hangar-terminal", "podium-tower", "glass-office"].includes(b.id);
        }
        if (tile.zone === "waterfront") {
          return ["glass-office", "art-deco-midrise", "corner-rounded", "residential-balcony", "podium-tower"].includes(b.id);
        }
        if (tile.zone === "park") {
          return ["art-deco-midrise", "residential-balcony", "hangar-terminal"].includes(b.id);
        }
        return ["residential-balcony", "art-deco-midrise", "corner-rounded", "warehouse-loft", "podium-tower"].includes(b.id);
      });

      const archetype = choose(rng, candidates);
      const { group, width, depth, height } = createBuildingMesh(archetype, rng);

      const lotScale = lotCount === 2 ? randRange(rng, 0.52, 0.68) : randRange(rng, 0.92, 1.08);
      group.scale.setScalar(lotScale);

      const jitterX = randRange(rng, -1.8, 1.8);
      const jitterZ = randRange(rng, -1.8, 1.8);
      group.position.set(center.x + jitterX + offset.x, 0, center.z + jitterZ + offset.z);

      const finalWidth = width * lotScale;
      const finalDepth = depth * lotScale;
      const finalHeight = height * lotScale;

      const podiumPad = new THREE.Mesh(
        new THREE.BoxGeometry(finalWidth * 1.08, 0.3, finalDepth * 1.08),
        new THREE.MeshStandardMaterial({ color: "#b5bfc7", roughness: 0.7, metalness: 0.08 }),
      );
      podiumPad.position.set(group.position.x, 0.15, group.position.z);
      podiumPad.receiveShadow = true;
      scene.add(podiumPad);
      scene.add(group);
      occluders.push(group);

      colliders.push(
        makeAabbCollider(
          `building-${tile.key}-${archetype.id}-${lotIndex}`,
          "building",
          tile.zone,
          new THREE.Vector3(group.position.x, finalHeight / 2, group.position.z),
          new THREE.Vector3(finalWidth / 2, finalHeight / 2, finalDepth / 2),
          true,
        ),
      );
    });
  }
}

function addNature(
  scene: THREE.Scene,
  tileMeta: TileMeta[],
  roadSet: Set<string>,
  colliders: Collider[],
  occluders: THREE.Object3D[],
): void {
  const rng = seededRng(7712);
  const treePositions: Record<TreeKind, THREE.Vector3[]> = {
    oak: [],
    pine: [],
    canopy: [],
    palm: [],
  };

  const parkBand = new Set(tileMeta.filter((tile) => tile.zone === "park").map((tile) => tile.key));

  for (let i = 0; i < WORLD_CONFIG.treeCount; i += 1) {
    const gx = Math.floor(randRange(rng, -WORLD_CONFIG.gridHalf, WORLD_CONFIG.gridHalf + 1));
    const gz = Math.floor(randRange(rng, -WORLD_CONFIG.gridHalf, WORLD_CONFIG.gridHalf + 1));
    const key = tileKey(gx, gz);

    if (roadSet.has(key)) {
      continue;
    }

    const center = toWorld(gx, gz);
    const px = center.x + randRange(rng, -8.4, 8.4);
    const pz = center.z + randRange(rng, -8.4, 8.4);

    const zone = zoneFor(gx, gz);
    const kind: TreeKind = zone === "waterfront" || zone === "airport"
      ? "palm"
      : parkBand.has(key)
        ? choose<TreeKind>(rng, ["oak", "pine", "canopy"])
        : choose<TreeKind>(rng, ["oak", "canopy", "pine"]);

    treePositions[kind].push(new THREE.Vector3(px, 0, pz));

    colliders.push(
      makeAabbCollider(
        `tree-${kind}-${i}`,
        "tree",
        zone,
        new THREE.Vector3(px, 2, pz),
        new THREE.Vector3(0.8, 2.2, 0.8),
        true,
      ),
    );
  }

  const trunkMat = new THREE.MeshStandardMaterial({ color: "#6f4b34", roughness: 1 });
  const palmTrunkMat = new THREE.MeshStandardMaterial({ color: "#7f5a3f", roughness: 0.9 });
  const leaves = {
    oak: new THREE.MeshStandardMaterial({ color: "#2e8d4f", roughness: 0.85 }),
    pine: new THREE.MeshStandardMaterial({ color: "#2c7a40", roughness: 0.9 }),
    canopy: new THREE.MeshStandardMaterial({ color: "#4c9f58", roughness: 0.8 }),
    palm: new THREE.MeshStandardMaterial({ color: "#4fbf68", roughness: 0.75 }),
  };

  const buildInstancedTree = (
    id: "oak" | "pine" | "canopy" | "palm",
    trunkGeo: THREE.BufferGeometry,
    leafGeo: THREE.BufferGeometry,
    leafYOffset: number,
    trunkHeight: number,
  ): void => {
    const points = treePositions[id];
    if (points.length === 0) {
      return;
    }

    const trunk = new THREE.InstancedMesh(trunkGeo, id === "palm" ? palmTrunkMat : trunkMat, points.length);
    const crown = new THREE.InstancedMesh(leafGeo, leaves[id], points.length);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    crown.castShadow = true;

    const matrix = new THREE.Matrix4();
    points.forEach((point, idx) => {
      const s = id === "palm" ? randRange(rng, 0.9, 1.3) : randRange(rng, 0.8, 1.25);
      matrix.makeScale(s, s, s);
      matrix.setPosition(point.x, (trunkHeight * s) / 2, point.z);
      trunk.setMatrixAt(idx, matrix);

      matrix.makeScale(s, s, s);
      matrix.setPosition(point.x, leafYOffset * s, point.z);
      crown.setMatrixAt(idx, matrix);
    });

    trunk.instanceMatrix.needsUpdate = true;
    crown.instanceMatrix.needsUpdate = true;
    scene.add(trunk, crown);
    occluders.push(crown);
  };

  buildInstancedTree("oak", new THREE.CylinderGeometry(0.22, 0.32, 3.2, 6), new THREE.SphereGeometry(1.8, 8, 8), 3.8, 3.2);
  buildInstancedTree("pine", new THREE.CylinderGeometry(0.2, 0.3, 3.4, 6), new THREE.ConeGeometry(1.6, 3.7, 8), 4.3, 3.4);
  buildInstancedTree("canopy", new THREE.CylinderGeometry(0.22, 0.34, 3.3, 6), new THREE.SphereGeometry(2.2, 9, 8), 4.2, 3.3);
  buildInstancedTree("palm", new THREE.CylinderGeometry(0.18, 0.3, 4.5, 6), new THREE.SphereGeometry(1.4, 7, 6), 5.2, 4.5);
}

function addParkedCars(
  scene: THREE.Scene,
  roadTiles: RoadTile[],
  colliders: Collider[],
): void {
  const rng = seededRng(33781);
  const roadLookup = new Set(roadTiles.map((tile) => tile.id));
  const carPositions: { pos: THREE.Vector3; angle: number; colorIdx: number }[] = [];
  const CAR_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#e2e8f0", "#1e293b", "#06b6d4", "#f97316", "#a855f7"];

  for (const tile of roadTiles) {
    if (tile.isRunway || tile.tileType === "boulevard") continue;

    const center = toWorld(tile.gx, tile.gz);
    const northRoad = roadLookup.has(tileKey(tile.gx, tile.gz - 1));
    const southRoad = roadLookup.has(tileKey(tile.gx, tile.gz + 1));
    const eastRoad = roadLookup.has(tileKey(tile.gx + 1, tile.gz));
    const westRoad = roadLookup.has(tileKey(tile.gx - 1, tile.gz));

    // Place cars along edges that border non-road tiles
    const laneEdge = WORLD_CONFIG.tileSize / 2 - 4.5;
    const verticalFlow = northRoad && southRoad;
    const horizontalFlow = eastRoad && westRoad;

    if (verticalFlow && !horizontalFlow) {
      // Cars parked along east/west edges
      if (!eastRoad && rng() < 0.45) {
        const z = center.z + randRange(rng, -8, 8);
        carPositions.push({ pos: new THREE.Vector3(center.x + laneEdge, 0, z), angle: Math.PI / 2, colorIdx: Math.floor(rng() * CAR_COLORS.length) });
      } else { rng(); rng(); }
      if (!westRoad && rng() < 0.45) {
        const z = center.z + randRange(rng, -8, 8);
        carPositions.push({ pos: new THREE.Vector3(center.x - laneEdge, 0, z), angle: -Math.PI / 2, colorIdx: Math.floor(rng() * CAR_COLORS.length) });
      } else { rng(); rng(); }
    } else if (horizontalFlow && !verticalFlow) {
      if (!northRoad && rng() < 0.45) {
        const x = center.x + randRange(rng, -8, 8);
        carPositions.push({ pos: new THREE.Vector3(x, 0, center.z - laneEdge), angle: 0, colorIdx: Math.floor(rng() * CAR_COLORS.length) });
      } else { rng(); rng(); }
      if (!southRoad && rng() < 0.45) {
        const x = center.x + randRange(rng, -8, 8);
        carPositions.push({ pos: new THREE.Vector3(x, 0, center.z + laneEdge), angle: Math.PI, colorIdx: Math.floor(rng() * CAR_COLORS.length) });
      } else { rng(); rng(); }
    } else {
      rng(); rng(); rng(); rng(); // consume for determinism
    }
  }

  if (carPositions.length === 0) return;

  // Car body: simple box
  const bodyGeo = new THREE.BoxGeometry(3.8, 0.7, 1.8);
  const cabinGeo = new THREE.BoxGeometry(2.0, 0.6, 1.6);
  const bodyMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.4, metalness: 0.35 });
  const cabinMat = new THREE.MeshStandardMaterial({ color: "#334155", roughness: 0.3, metalness: 0.5, transparent: true, opacity: 0.8 });

  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, carPositions.length);
  const cabins = new THREE.InstancedMesh(cabinGeo, cabinMat, carPositions.length);
  bodies.castShadow = true;
  bodies.receiveShadow = true;
  cabins.castShadow = true;

  const matrix = new THREE.Matrix4();
  const rot = new THREE.Quaternion();
  const color = new THREE.Color();
  const euler = new THREE.Euler();

  carPositions.forEach((car, idx) => {
    const renderAngle = car.angle;
    euler.set(0, renderAngle, 0);
    rot.setFromEuler(euler);
    matrix.compose(new THREE.Vector3(car.pos.x, 0.75, car.pos.z), rot, new THREE.Vector3(1, 1, 1));
    bodies.setMatrixAt(idx, matrix);

    matrix.compose(new THREE.Vector3(car.pos.x, 1.2, car.pos.z), rot, new THREE.Vector3(1, 1, 1));
    cabins.setMatrixAt(idx, matrix);

    color.set(CAR_COLORS[car.colorIdx % CAR_COLORS.length]!);
    bodies.setColorAt(idx, color);

    // Collider for parked car
    const halfW = 1.9;
    const halfD = 0.9;
    const cosA = Math.cos(renderAngle);
    const sinA = Math.sin(renderAngle);
    const extentX = Math.abs(cosA) * halfW + Math.abs(sinA) * halfD;
    const extentZ = Math.abs(sinA) * halfW + Math.abs(cosA) * halfD;
    colliders.push(makeAabbCollider(
      `parked-car-${idx}`, "prop", "residential",
      new THREE.Vector3(car.pos.x, 0.6, car.pos.z),
      new THREE.Vector3(extentX, 0.6, extentZ),
      true,
    ));
  });

  bodies.instanceMatrix.needsUpdate = true;
  cabins.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  scene.add(bodies, cabins);
}

function addProps(
  scene: THREE.Scene,
  roadTiles: RoadTile[],
  colliders: Collider[],
): void {
  const rng = seededRng(99231);
  const lampPositions: THREE.Vector3[] = [];
  const roadLookup = new Set(roadTiles.map((tile) => tile.id));

  for (const tile of roadTiles) {
    if (!tile.sidewalks) {
      continue;
    }

    const c = toWorld(tile.gx, tile.gz);
    const offset = WORLD_CONFIG.tileSize / 2 - 2.5;
    const northRoad = roadLookup.has(tileKey(tile.gx, tile.gz - 1));
    const southRoad = roadLookup.has(tileKey(tile.gx, tile.gz + 1));
    const eastRoad = roadLookup.has(tileKey(tile.gx + 1, tile.gz));
    const westRoad = roadLookup.has(tileKey(tile.gx - 1, tile.gz));
    const sidewalkSpots: THREE.Vector3[] = [];
    if (!northRoad) sidewalkSpots.push(new THREE.Vector3(c.x, 0, c.z - offset));
    if (!southRoad) sidewalkSpots.push(new THREE.Vector3(c.x, 0, c.z + offset));
    if (!eastRoad) sidewalkSpots.push(new THREE.Vector3(c.x + offset, 0, c.z));
    if (!westRoad) sidewalkSpots.push(new THREE.Vector3(c.x - offset, 0, c.z));
    if (sidewalkSpots.length === 0) {
      continue;
    }

    if (rng() < 0.8) {
      lampPositions.push(sidewalkSpots[Math.floor(rng() * sidewalkSpots.length)]!.clone());
      if (rng() < 0.3 && sidewalkSpots.length > 1) {
        lampPositions.push(sidewalkSpots[Math.floor(rng() * sidewalkSpots.length)]!.clone());
      }
    }
  }

  if (lampPositions.length > 0) {
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 4.6, 8);
    const glowGeo = new THREE.SphereGeometry(0.28, 8, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: "#475569", roughness: 0.65, metalness: 0.35 });
    const glowMat = new THREE.MeshStandardMaterial({ color: "#fef3c7", emissive: "#f59e0b", emissiveIntensity: 0.8 });

    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampPositions.length);
    const glows = new THREE.InstancedMesh(glowGeo, glowMat, lampPositions.length);
    poles.castShadow = true;
    glows.castShadow = false;

    const m = new THREE.Matrix4();
    lampPositions.forEach((pos, idx) => {
      m.makeTranslation(pos.x, 2.3, pos.z);
      poles.setMatrixAt(idx, m);
      m.makeTranslation(pos.x, 4.7, pos.z);
      glows.setMatrixAt(idx, m);

      colliders.push(
        makeAabbCollider(
          `lamp-${idx}`,
          "prop",
          pos.z <= -120 ? "airport" : "residential",
          new THREE.Vector3(pos.x, 2.3, pos.z),
          new THREE.Vector3(0.28, 2.3, 0.28),
          false,
        ),
      );
    });
    poles.instanceMatrix.needsUpdate = true;
    glows.instanceMatrix.needsUpdate = true;
    scene.add(poles, glows);
  }
}

function createSidewalkGraph(tileMeta: TileMeta[], roadSet: Set<string>): SidewalkNode[] {
  const nodeMap = new Map<string, SidewalkNode>();
  const tileSize = WORLD_CONFIG.tileSize;
  const offset = tileSize / 2 - 2;
  const makeNodeKey = (tileId: string, corner: "NW" | "NE" | "SE" | "SW"): string => `${tileId}:${corner}`;

  const blockTiles = tileMeta.filter((tile) => !roadSet.has(tile.key));

  blockTiles.forEach((tile) => {
    const northRoad = roadSet.has(tileKey(tile.gx, tile.gz - 1));
    const southRoad = roadSet.has(tileKey(tile.gx, tile.gz + 1));
    const eastRoad = roadSet.has(tileKey(tile.gx + 1, tile.gz));
    const westRoad = roadSet.has(tileKey(tile.gx - 1, tile.gz));
    const hasRoadEdge = northRoad || southRoad || eastRoad || westRoad;
    if (!hasRoadEdge) {
      return;
    }

    const center = toWorld(tile.gx, tile.gz);
    const corners: Record<"NW" | "NE" | "SE" | "SW", THREE.Vector3> = {
      NW: new THREE.Vector3(center.x - offset, 0, center.z - offset),
      NE: new THREE.Vector3(center.x + offset, 0, center.z - offset),
      SE: new THREE.Vector3(center.x + offset, 0, center.z + offset),
      SW: new THREE.Vector3(center.x - offset, 0, center.z + offset),
    };

    (Object.keys(corners) as Array<"NW" | "NE" | "SE" | "SW">).forEach((corner) => {
      nodeMap.set(makeNodeKey(tile.key, corner), {
        id: -1,
        position: corners[corner].clone(),
        neighbors: [],
        crosswalk: false,
      });
    });
  });

  const addEdge = (a: string, b: string): void => {
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    if (!na || !nb) {
      return;
    }
    if (!na.neighbors.includes(nb.id)) {
      na.neighbors.push(nb.id);
    }
    if (!nb.neighbors.includes(na.id)) {
      nb.neighbors.push(na.id);
    }
  };

  const nodes = Array.from(nodeMap.values());
  nodes.forEach((node, idx) => {
    node.id = idx;
  });

  const keyToNode = new Map<string, SidewalkNode>();
  for (const [key, value] of nodeMap.entries()) {
    keyToNode.set(key, value);
  }

  for (const tile of blockTiles) {
    const perimeter: Array<["NW" | "NE" | "SE" | "SW", "NW" | "NE" | "SE" | "SW"]> = [
      ["NW", "NE"],
      ["NE", "SE"],
      ["SE", "SW"],
      ["SW", "NW"],
    ];

    for (const [a, b] of perimeter) {
      const na = keyToNode.get(`${tile.key}:${a}`);
      const nb = keyToNode.get(`${tile.key}:${b}`);
      if (!na || !nb) {
        continue;
      }
      if (!na.neighbors.includes(nb.id)) {
        na.neighbors.push(nb.id);
      }
      if (!nb.neighbors.includes(na.id)) {
        nb.neighbors.push(na.id);
      }
    }

    for (const dir of ROAD_DIRECTIONS) {
      const neighborTile = blockTiles.find((entry) => entry.gx === tile.gx + dir.dx && entry.gz === tile.gz + dir.dz);
      if (!neighborTile) {
        continue;
      }
      if (dir.name === "N") {
        addEdge(`${tile.key}:NW`, `${neighborTile.key}:SW`);
        addEdge(`${tile.key}:NE`, `${neighborTile.key}:SE`);
      } else if (dir.name === "S") {
        addEdge(`${tile.key}:SW`, `${neighborTile.key}:NW`);
        addEdge(`${tile.key}:SE`, `${neighborTile.key}:NE`);
      } else if (dir.name === "E") {
        addEdge(`${tile.key}:NE`, `${neighborTile.key}:NW`);
        addEdge(`${tile.key}:SE`, `${neighborTile.key}:SW`);
      } else {
        addEdge(`${tile.key}:NW`, `${neighborTile.key}:NE`);
        addEdge(`${tile.key}:SW`, `${neighborTile.key}:SE`);
      }
    }
  }

  return nodes;
}

function makeGround(scene: THREE.Scene): void {
  const mainGround = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshStandardMaterial({ color: "#819f77", roughness: 0.98, metalness: 0.02 }),
  );
  mainGround.rotation.x = -Math.PI / 2;
  mainGround.receiveShadow = true;
  scene.add(mainGround);

  const parkOverlay = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 140),
    new THREE.MeshStandardMaterial({ color: "#70995f", roughness: 0.95 }),
  );
  parkOverlay.rotation.x = -Math.PI / 2;
  parkOverlay.position.set(0, 0.03, 108);
  parkOverlay.receiveShadow = true;
  scene.add(parkOverlay);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 200),
    new THREE.MeshStandardMaterial({ color: "#5aa6cc", roughness: 0.2, metalness: 0.5, transparent: true, opacity: 0.55 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, 0.02, -190);
  scene.add(water);
}

function createDebugObjects(scene: THREE.Scene, colliders: Collider[], nodes: SidewalkNode[]): THREE.Object3D[] {
  const debugObjects: THREE.Object3D[] = [];

  colliders.forEach((collider) => {
    const center = new THREE.Vector3(
      (collider.aabb.minX + collider.aabb.maxX) / 2,
      (collider.aabb.minY + collider.aabb.maxY) / 2,
      (collider.aabb.minZ + collider.aabb.maxZ) / 2,
    );
    const size = new THREE.Vector3(
      collider.aabb.maxX - collider.aabb.minX,
      collider.aabb.maxY - collider.aabb.minY,
      collider.aabb.maxZ - collider.aabb.minZ,
    );
    const helper = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color: "#f43f5e", wireframe: true, transparent: true, opacity: 0.45 }),
    );
    helper.position.copy(center);
    helper.visible = false;
    scene.add(helper);
    debugObjects.push(helper);
  });

  nodes.forEach((node) => {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.33, 8, 8),
      new THREE.MeshBasicMaterial({ color: node.crosswalk ? "#facc15" : "#22d3ee", transparent: true, opacity: 0.85 }),
    );
    marker.position.copy(node.position);
    marker.position.y = 0.35;
    marker.visible = false;
    scene.add(marker);
    debugObjects.push(marker);
  });

  return debugObjects;
}

export function createWorld(scene: THREE.Scene, debug = false): WorldBuildResult {
  const colliders: Collider[] = [];
  const pickupAnchors: THREE.Vector3[] = [];
  const occluders: THREE.Object3D[] = [];

  makeGround(scene);

  const { tiles: roadTiles, tileMeta } = createRoadTiles();
  const roadSet = new Set(roadTiles.map((tile) => tile.id));

  addRoadVisuals(scene, roadTiles, colliders, pickupAnchors);
  addBuildings(scene, tileMeta, roadSet, colliders, occluders);
  addNature(scene, tileMeta, roadSet, colliders, occluders);
  addProps(scene, roadTiles, colliders);
  addParkedCars(scene, roadTiles, colliders);

  const sidewalkNodes = createSidewalkGraph(tileMeta, roadSet);

  const runwayTiles = roadTiles.filter((tile) => tile.isRunway);
  const runwayXs = runwayTiles.map((tile) => tile.gx * WORLD_CONFIG.tileSize);
  const runwayZs = runwayTiles.map((tile) => tile.gz * WORLD_CONFIG.tileSize);
  const runwayBounds = {
    minX: Math.min(...runwayXs) - WORLD_CONFIG.tileSize / 2,
    maxX: Math.max(...runwayXs) + WORLD_CONFIG.tileSize / 2,
    minZ: Math.min(...runwayZs) - WORLD_CONFIG.tileSize / 2,
    maxZ: Math.max(...runwayZs) + WORLD_CONFIG.tileSize / 2,
  };

  const debugObjects = debug ? createDebugObjects(scene, colliders, sidewalkNodes) : [];
  debugObjects.forEach((obj) => {
    obj.visible = debug;
  });

  return {
    colliders,
    roadTiles,
    tileMeta,
    pickupAnchors,
    sidewalkNodes,
    runwayBounds,
    occluders,
    debugObjects,
  };
}

export function generateMinimapDataUrl(roadTiles: RoadTile[], tileMeta: { gx: number; gz: number; key: string; zone: string }[]): string {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const gridHalf = WORLD_CONFIG.gridHalf;
  const worldSpan = (gridHalf * 2 + 1) * WORLD_CONFIG.tileSize;
  const worldMin = -gridHalf * WORLD_CONFIG.tileSize - WORLD_CONFIG.tileSize / 2;

  const toCanvas = (worldVal: number): number => {
    return ((worldVal - worldMin) / worldSpan) * size;
  };

  const tilePixelSize = (WORLD_CONFIG.tileSize / worldSpan) * size;

  // Background: subtle green for grass
  ctx.fillStyle = "#0f1f14";
  ctx.fillRect(0, 0, size, size);

  // Water area (north)
  const waterY = toCanvas(-5 * WORLD_CONFIG.tileSize - WORLD_CONFIG.tileSize / 2);
  ctx.fillStyle = "#0d1a2a";
  ctx.fillRect(0, 0, size, waterY);

  // Park area (south)
  const parkY = toCanvas(3 * WORLD_CONFIG.tileSize - WORLD_CONFIG.tileSize / 2);
  ctx.fillStyle = "#0f2218";
  ctx.fillRect(0, parkY, size, size - parkY);

  // Draw building blocks (non-road tiles)
  const roadSet = new Set(roadTiles.map((t) => t.id));
  for (const tile of tileMeta) {
    if (roadSet.has(tile.key)) continue;
    const cx = tile.gx * WORLD_CONFIG.tileSize;
    const cz = tile.gz * WORLD_CONFIG.tileSize;
    const px = toCanvas(cx) - tilePixelSize / 2;
    const py = toCanvas(cz) - tilePixelSize / 2;
    const pad = tilePixelSize * 0.12;

    if (tile.zone === "park") continue; // parks stay green
    if (tile.zone === "waterfront" && tile.gz <= -5) continue; // water stays blue

    // Building footprint
    ctx.fillStyle = tile.zone === "downtown" ? "#1a2535" : tile.zone === "airport" ? "#18222e" : "#161f28";
    ctx.fillRect(px + pad, py + pad, tilePixelSize - pad * 2, tilePixelSize - pad * 2);
  }

  // Draw roads on top
  for (const tile of roadTiles) {
    const cx = tile.gx * WORLD_CONFIG.tileSize;
    const cz = tile.gz * WORLD_CONFIG.tileSize;
    const px = toCanvas(cx) - tilePixelSize / 2;
    const py = toCanvas(cz) - tilePixelSize / 2;

    if (tile.isRunway) {
      ctx.fillStyle = "#2a3a4d";
    } else if (tile.tileType === "boulevard") {
      ctx.fillStyle = "#3a4a5e";
    } else {
      ctx.fillStyle = "#2e3e52";
    }
    ctx.fillRect(px, py, tilePixelSize, tilePixelSize);

    // Center line
    ctx.fillStyle = "rgba(255, 220, 150, 0.2)";
    if (tile.tileType !== "runway") {
      ctx.fillRect(px + tilePixelSize * 0.46, py, tilePixelSize * 0.08, tilePixelSize);
    }
  }

  return canvas.toDataURL();
}

export function isPointOnRunway(position: THREE.Vector3, runwayBounds: WorldBuildResult["runwayBounds"]): boolean {
  return (
    position.x >= runwayBounds.minX &&
    position.x <= runwayBounds.maxX &&
    position.z >= runwayBounds.minZ &&
    position.z <= runwayBounds.maxZ
  );
}
