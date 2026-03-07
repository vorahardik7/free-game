import * as THREE from "three";
import { HUD_TICK_MS, WORLD_CONFIG } from "./config";
import { SpatialHash } from "./collision";
import { createCameraController } from "./camera";
import { dist2d } from "./math";
import { createPedestrianSystem } from "./pedestrians";
import type { HudSnapshot, VehicleId } from "./types";
import { createWorld, generateMinimapDataUrl } from "./world";
import {
  applyVehicleVisuals,
  createInitialVehicleState,
  createVehicleVisuals,
  getVehicleForward,
  switchVehicle,
  updateVehiclePhysics,
} from "./vehicles";

interface RuntimeOptions {
  mount: HTMLDivElement;
  onHud: (hud: HudSnapshot) => void;
  debug: boolean;
}

interface RideState {
  hasPassenger: boolean;
  isBoarding: boolean;
  boardingTimer: number;
  pickup: THREE.Vector3;
  dropoff: THREE.Vector3;
  comfort: number;
  money: number;
  rating: number;
  rides: number;
  rideStartMs: number;
  rideDistance: number;
  minDropoffUnlockSeconds: number;
  minDropoffUnlockDistance: number;
  message: string;
  collisionPulse: number;
  toast: string;
  toastTimer: number;
  recentEvent: string;
}

const vehicleLabel: Record<VehicleId, string> = {
  cab: "City Cab",
  plane: "Sky Hopper",
};

function createBeacon(color: string, label: string): THREE.Group {
  const g = new THREE.Group();
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.7, 28, 18, 1, true),
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.22, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide }),
  );
  pillar.position.y = 14;

  const marker = new THREE.Mesh(
    new THREE.IcosahedronGeometry(3.0, 0),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.65, roughness: 0.3, metalness: 0.2 }),
  );
  marker.position.y = 29;

  // Floating text label
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.font = "bold 36px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 128, 32);
  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(8, 2, 1);
  sprite.position.y = 34;

  g.add(pillar, marker, sprite);
  return g;
}

function createGroundRing(color: string): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(4.0, 5.5, 36),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  return ring;
}

function createPassengerVisual(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.35, 1.08, 3, 6),
    new THREE.MeshStandardMaterial({ color: "#3b82f6", roughness: 0.7 }),
  );
  body.position.y = 1.28;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 10, 10),
    new THREE.MeshStandardMaterial({ color: "#f9d4bb", roughness: 0.85 }),
  );
  head.position.y = 2.45;

  const bag = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.45, 0.21),
    new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.8 }),
  );
  bag.position.set(0.32, 1.43, -0.09);

  g.add(body, head, bag);
  return g;
}

function createNavArrow(): THREE.Group {
  const g = new THREE.Group();
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.2, 8),
    new THREE.MeshStandardMaterial({ color: "#22d3ee", emissive: "#22d3ee", emissiveIntensity: 0.5, depthTest: false }),
  );
  head.rotation.x = -Math.PI / 2;
  head.position.z = 0.8;
  head.renderOrder = 998;

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6),
    new THREE.MeshStandardMaterial({ color: "#22d3ee", emissive: "#22d3ee", emissiveIntensity: 0.4, depthTest: false }),
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.2;
  shaft.renderOrder = 998;

  g.add(head, shaft);
  return g;
}

function pickAnchorInRange(
  anchors: THREE.Vector3[],
  origin: THREE.Vector3,
  minDistance: number,
  maxDistance: number,
): THREE.Vector3 {
  if (anchors.length === 0) {
    return new THREE.Vector3(0, 1, 0);
  }

  const inRange = anchors.filter((anchor) => {
    const d = dist2d(anchor, origin);
    return d >= minDistance && d <= maxDistance;
  });

  if (inRange.length > 0) {
    return inRange[Math.floor(Math.random() * inRange.length)]!.clone();
  }

  // Fallback: pick the closest anchor to the middle of desired range.
  const targetDistance = (minDistance + maxDistance) * 0.5;
  let best = anchors[0]!.clone();
  let bestScore = Math.abs(dist2d(best, origin) - targetDistance);
  for (const anchor of anchors) {
    const score = Math.abs(dist2d(anchor, origin) - targetDistance);
    if (score < bestScore) {
      best = anchor.clone();
      bestScore = score;
    }
  }
  return best;
}

export class GameRuntime {
  private readonly mount: HTMLDivElement;

  private readonly onHud: (hud: HudSnapshot) => void;

  private readonly debug: boolean;

  private renderer: THREE.WebGLRenderer | null = null;

  private scene: THREE.Scene | null = null;

  private camera: THREE.PerspectiveCamera | null = null;

  private raf = 0;

  private hudTime = 0;

  private fpsAccumulator = 0;

  private fpsFrames = 0;

  private currentFps = 60;

  private stopped = false;

  private lastFrameMs = 0;

  private readonly keys = new Set<string>();

  constructor(options: RuntimeOptions) {
    this.mount = options.mount;
    this.onHud = options.onHud;
    this.debug = options.debug;
  }

  start(): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(this.mount.clientWidth, this.mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#ffca8d");
    scene.fog = new THREE.Fog("#ffc993", 95, 420);

    const camera = new THREE.PerspectiveCamera(60, this.mount.clientWidth / this.mount.clientHeight, 0.1, 900);
    camera.position.set(0, 8, -14);

    const hemi = new THREE.HemisphereLight("#fff4d6", "#355d7e", 1.2);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight("#ffdf99", 1.25);
    sun.position.set(-55, 88, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.left = -180;
    sun.shadow.camera.right = 180;
    sun.shadow.camera.top = 180;
    sun.shadow.camera.bottom = -180;
    scene.add(sun);

    const fill = new THREE.DirectionalLight("#ffc078", 0.42);
    fill.position.set(90, 24, 72);
    scene.add(fill);

    const cityGlow = new THREE.Mesh(
      new THREE.SphereGeometry(180, 26, 20),
      new THREE.MeshBasicMaterial({ color: "#f97316", transparent: true, opacity: 0.06 }),
    );
    cityGlow.position.set(-35, 35, -40);
    scene.add(cityGlow);

    const world = createWorld(scene, this.debug);
    const minimapDataUrl = generateMinimapDataUrl(world.roadTiles);
    const hash = new SpatialHash(WORLD_CONFIG.tileSize);
    hash.bulkInsert(world.colliders);

    const visuals = createVehicleVisuals(scene);
    const vehicle = createInitialVehicleState();

    const pedestrianSystem = createPedestrianSystem(scene, world.sidewalkNodes, WORLD_CONFIG.pedestrianCap);

    const pickupBeacon = createBeacon("#2dd4bf", "PICKUP");
    const dropoffBeacon = createBeacon("#fb7185", "DROPOFF");
    const pickupRing = createGroundRing("#2dd4bf");
    const dropoffRing = createGroundRing("#fb7185");
    scene.add(pickupBeacon, dropoffBeacon);
    scene.add(pickupRing, dropoffRing);

    const waitingPassenger = createPassengerVisual();
    waitingPassenger.visible = true;
    scene.add(waitingPassenger);

    const navArrow = createNavArrow();
    scene.add(navArrow);

    const ride: RideState = {
      hasPassenger: false,
      isBoarding: false,
      boardingTimer: 0,
      pickup: pickAnchorInRange(world.pickupAnchors, vehicle.position, 40, 100),
      dropoff: pickAnchorInRange(world.pickupAnchors, vehicle.position, 140, 300),
      comfort: 1,
      money: 0,
      rating: 5,
      rides: 0,
      rideStartMs: 0,
      rideDistance: 0,
      minDropoffUnlockSeconds: 3.5,
      minDropoffUnlockDistance: 16,
      message: "Drive to the aqua beacon. Passenger is waiting.",
      collisionPulse: 0,
      toast: "",
      toastTimer: 0,
      recentEvent: "",
    };

    const cameraController = createCameraController(camera, world.occluders);

    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      this.keys.add(key);
      if (key === "1") {
        switchVehicle(vehicle, visuals, "cab");
        ride.message = `${vehicleLabel.cab} active.`;
      } else if (key === "2") {
        switchVehicle(vehicle, visuals, "plane");
        ride.message = "Sky Hopper active. Taxi to runway and hold Q to lift.";
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      this.keys.delete(event.key.toLowerCase());
    };

    const onResize = (): void => {
      if (!this.mount || !this.renderer || !this.camera) {
        return;
      }
      this.camera.aspect = this.mount.clientWidth / this.mount.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.mount.clientWidth, this.mount.clientHeight);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("resize", onResize);

    const startBoarding = (): void => {
      ride.isBoarding = true;
      ride.boardingTimer = 0.9;
      ride.message = "Passenger boarding...";
      ride.toast = "Pickup confirmed";
      ride.toastTimer = 1.2;
      ride.recentEvent = "Pickup Confirmed";
    };

    const finalizeBoarding = (): void => {
      ride.hasPassenger = true;
      ride.isBoarding = false;
      ride.dropoff = pickAnchorInRange(world.pickupAnchors, ride.pickup, 140, 300);
      ride.rideStartMs = performance.now();
      ride.rideDistance = dist2d(ride.pickup, ride.dropoff);
      ride.comfort = 1;
      ride.message = "Fare started. Head to coral beacon for dropoff.";
      ride.toast = "Fare Started";
      ride.toastTimer = 1.4;
      ride.recentEvent = "Fare Started";
    };

    const completeRide = (): void => {
      const elapsedSec = (performance.now() - ride.rideStartMs) / 1000;
      const baseFare = 14 + ride.rideDistance * 0.18;
      const paceBonus = Math.max(0, 22 - elapsedSec * 0.4);
      const qualityMultiplier = 0.7 + ride.comfort * 0.7;
      const gross = Math.round((baseFare + paceBonus) * qualityMultiplier);
      const net = Math.max(0, gross);

      ride.money += net;
      ride.rides += 1;
      const rideRating = Math.max(3.4, Math.min(5, 3.5 + ride.comfort * 1.5));
      ride.rating = (ride.rating * (ride.rides - 1) + rideRating) / ride.rides;
      ride.hasPassenger = false;
      ride.pickup = pickAnchorInRange(world.pickupAnchors, ride.dropoff, 40, 100);
      ride.message = `Ride complete +$${net}. Find next pickup.`;
      ride.toast = `Ride Complete +$${net}`;
      ride.toastTimer = 1.6;
      ride.recentEvent = `Ride Complete +$${net}`;
    };

    const tick = (): void => {
      if (this.stopped) {
        return;
      }

      const frameMs = performance.now();
      const dt = Math.min((frameMs - this.lastFrameMs) / 1000, 0.04);
      this.lastFrameMs = frameMs;
      const now = performance.now() * 0.001;

      const throttle = (this.keys.has("w") || this.keys.has("arrowup") ? 1 : 0) + (this.keys.has("s") || this.keys.has("arrowdown") ? -1 : 0);
      const steer = (this.keys.has("a") || this.keys.has("arrowleft") ? 1 : 0) + (this.keys.has("d") || this.keys.has("arrowright") ? -1 : 0);
      const ascend = this.keys.has("q") ? 1 : 0;
      const descend = this.keys.has("e") ? 1 : 0;
      const boost = this.keys.has("shift");

      const vehicleResult = updateVehiclePhysics(
        vehicle,
        {
          throttle,
          steer,
          ascend,
          descend,
          boost,
        },
        dt,
        hash,
        world.runwayBounds,
      );

      if (vehicleResult.impactSeverity > 0.19) {
        ride.collisionPulse = Math.max(ride.collisionPulse, vehicleResult.impactSeverity);
      }
      ride.collisionPulse = Math.max(0, ride.collisionPulse - dt * 1.9);

      const forward = getVehicleForward(vehicle);
      const activeTarget = ride.hasPassenger ? ride.dropoff : ride.pickup;
      const proximity = dist2d(vehicle.position, activeTarget);
      const groundedForService = vehicle.id !== "plane" || vehicle.mode !== "airborne";
      const triggerDistance = groundedForService ? 4.8 : 999;

      if (!ride.hasPassenger && !ride.isBoarding) {
        waitingPassenger.visible = true;
        waitingPassenger.position.set(ride.pickup.x + 0.8, 0, ride.pickup.z + 0.4);
        waitingPassenger.position.y += Math.sin(now * 5.2) * 0.02;

        if (proximity <= triggerDistance && Math.abs(vehicle.speed) <= 4.2) {
          startBoarding();
        } else if (proximity <= triggerDistance) {
          ride.message = "Slow down to pick up passenger.";
        }
      }

      if (ride.isBoarding) {
        waitingPassenger.visible = true;
        const doorOffset = new THREE.Vector3(1.3, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.heading);
        const boardTarget = vehicle.position.clone().add(doorOffset);
        waitingPassenger.position.lerp(boardTarget, 0.18);
        ride.boardingTimer -= dt;
        if (ride.boardingTimer <= 0) {
          waitingPassenger.visible = false;
          finalizeBoarding();
        }
      }

      if (ride.hasPassenger) {
        waitingPassenger.visible = false;
        const elapsed = (performance.now() - ride.rideStartMs) / 1000;
        const travelFromPickup = dist2d(vehicle.position, ride.pickup);
        const dropoffUnlocked = elapsed >= ride.minDropoffUnlockSeconds && travelFromPickup >= ride.minDropoffUnlockDistance;
        if (proximity <= triggerDistance && dropoffUnlocked) {
          completeRide();
        } else if (proximity <= triggerDistance && !dropoffUnlocked) {
          ride.message = "Continue driving. Dropoff not unlocked yet.";
        }
      }

      if (!ride.hasPassenger && !ride.isBoarding) {
        dropoffBeacon.visible = false;
      } else {
        dropoffBeacon.visible = ride.hasPassenger;
      }

      if (ride.hasPassenger) {
        const smoothnessPenalty = Math.abs(steer) * (vehicle.id === "plane" && vehicle.mode === "airborne" ? 0.003 : 0.008);
        ride.comfort = Math.max(0.35, Math.min(1, ride.comfort - smoothnessPenalty + dt * 0.01));
      }

      pickupBeacon.visible = !ride.hasPassenger;
      pickupRing.visible = !ride.hasPassenger;
      pickupBeacon.position.set(ride.pickup.x, 0.5 + Math.sin(now * 2.8) * 0.4, ride.pickup.z);
      pickupRing.position.set(ride.pickup.x, 0.08, ride.pickup.z);
      pickupRing.scale.setScalar(1 + Math.sin(now * 3.4) * 0.06);
      dropoffBeacon.position.set(ride.dropoff.x, 0.5 + Math.sin(now * 2.8 + 1.3) * 0.4, ride.dropoff.z);
      dropoffRing.visible = ride.hasPassenger;
      dropoffRing.position.set(ride.dropoff.x, 0.08, ride.dropoff.z);
      dropoffRing.scale.setScalar(1 + Math.sin(now * 3.1 + 0.8) * 0.08);

      if (ride.toastTimer > 0) {
        ride.toastTimer = Math.max(0, ride.toastTimer - dt);
      }

      // Navigation arrow: point toward active target
      const navForward = getVehicleForward(vehicle);
      navArrow.position.set(
        vehicle.position.x + navForward.x * 6,
        (vehicle.id === "plane" && vehicle.mode === "airborne" ? vehicle.position.y : 0) + 3.5 + Math.sin(now * 2.5) * 0.3,
        vehicle.position.z + navForward.z * 6,
      );
      const navDx = activeTarget.x - navArrow.position.x;
      const navDz = activeTarget.z - navArrow.position.z;
      navArrow.rotation.y = Math.atan2(navDx, navDz);
      // Color shift: cyan when far, green when close
      const navHeadMat = (navArrow.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      const navShaftMat = (navArrow.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (proximity < 20) {
        navHeadMat.color.set("#10b981");
        navHeadMat.emissive.set("#10b981");
        navShaftMat.color.set("#10b981");
        navShaftMat.emissive.set("#10b981");
      } else {
        navHeadMat.color.set("#22d3ee");
        navHeadMat.emissive.set("#22d3ee");
        navShaftMat.color.set("#22d3ee");
        navShaftMat.emissive.set("#22d3ee");
      }

      applyVehicleVisuals(vehicle, visuals, now, steer);
      pedestrianSystem.update(dt, vehicle.position, forward, Math.abs(vehicle.speed));

      cameraController.update(vehicle, dt);
      renderer.render(scene, camera);

      this.fpsAccumulator += dt;
      this.fpsFrames += 1;
      if (this.fpsAccumulator >= 0.35) {
        this.currentFps = Math.round(this.fpsFrames / this.fpsAccumulator);
        this.fpsAccumulator = 0;
        this.fpsFrames = 0;
      }

      const displayMessage = ride.toastTimer > 0 ? ride.toast : ride.message;

      this.hudTime += dt * 1000;
      if (this.hudTime >= HUD_TICK_MS) {
        this.hudTime = 0;
        const serviceState = ride.isBoarding ? "boarding" : ride.hasPassenger ? "in-ride" : "searching";
        this.onHud({
          vehicle: vehicle.id,
          mode: vehicle.mode,
          money: ride.money,
          rating: ride.rating,
          rides: ride.rides,
          speed: Math.round(Math.abs(vehicle.speed) * 3.2),
          message: displayMessage,
          objective: ride.hasPassenger ? "Dropoff" : "Pickup",
          serviceState,
          targetDistance: proximity,
          recentEvent: ride.toastTimer > 0 ? ride.recentEvent : "",
          collisionPulse: ride.collisionPulse,
          farePenalty: 0,
          fps: this.currentFps,
          hasPassenger: ride.hasPassenger,
          worldLimit: WORLD_CONFIG.worldLimit,
          playerX: vehicle.position.x,
          playerZ: vehicle.position.z,
          pickupX: ride.pickup.x,
          pickupZ: ride.pickup.z,
          dropoffX: ride.dropoff.x,
          dropoffZ: ride.dropoff.z,
          heading: vehicle.heading,
          minimapDataUrl,
        });
      }

      this.raf = window.requestAnimationFrame(tick);
    };

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.lastFrameMs = performance.now();
    this.raf = window.requestAnimationFrame(tick);

    this.cleanup = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
    };
  }

  private cleanup: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
    window.cancelAnimationFrame(this.raf);

    if (this.cleanup) {
      this.cleanup();
      this.cleanup = null;
    }

    if (this.renderer && this.mount.contains(this.renderer.domElement)) {
      this.mount.removeChild(this.renderer.domElement);
      this.renderer.dispose();
    }

    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }
}
