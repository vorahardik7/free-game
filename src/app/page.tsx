"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { INITIAL_HUD_STATE } from "@/game/hud-state";
import { GameRuntime } from "@/game/runtime";
import type { HudSnapshot } from "@/game/types";

const VEHICLE_NAME: Record<HudSnapshot["vehicle"], string> = {
  cab: "City Cab",
  plane: "Sky Hopper",
};

const MODE_NAME: Record<HudSnapshot["mode"], string> = {
  ground: "Ground",
  "takeoff-roll": "Takeoff Roll",
  "landing-roll": "Landing Roll",
  airborne: "Airborne",
};

function rotate(dx: number, dz: number, angle: number): { x: number; z: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: dx * c - dz * s,
    z: dx * s + dz * c,
  };
}

function cardinalFromVector(dx: number, dz: number): string {
  const angle = Math.atan2(dx, dz);
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round((angle / (Math.PI * 2)) * 8) & 7;
  return dirs[idx] ?? "N";
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<GameRuntime | null>(null);
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD_STATE);

  const debugEnabled = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("debug") === "1";
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const runtime = new GameRuntime({
      mount,
      onHud: setHud,
      debug: debugEnabled,
    });

    runtime.start();
    runtimeRef.current = runtime;

    return () => {
      runtime.stop();
      runtimeRef.current = null;
    };
  }, [debugEnabled]);

  const collisionClass = hud.collisionPulse > 0.15 ? "is-colliding" : "";
  const serviceLabel = hud.serviceState === "boarding" ? "Boarding" : hud.serviceState === "in-ride" ? "Fare Running" : "Searching";
  const isPlane = hud.vehicle === "plane";
  const targetX = hud.hasPassenger ? hud.dropoffX : hud.pickupX;
  const targetZ = hud.hasPassenger ? hud.dropoffZ : hud.pickupZ;
  const worldDx = targetX - hud.playerX;
  const worldDz = targetZ - hud.playerZ;
  const local = rotate(worldDx, worldDz, -hud.heading);
  const mapRange = 140;
  const mapDist = Math.hypot(local.x, local.z);
  const clampedScale = mapDist > mapRange ? mapRange / mapDist : 1;
  const plotX = 50 + (local.x * clampedScale / mapRange) * 42;
  const plotY = 50 - (local.z * clampedScale / mapRange) * 42;
  const targetFar = mapDist > mapRange;
  const arrowAngle = Math.atan2(plotX - 50, 50 - plotY) * (180 / Math.PI);
  const distanceMeters = Math.round(hud.targetDistance * 3.4);
  const dirLabel = cardinalFromVector(worldDx, worldDz);

  return (
    <div className={`game-shell ${collisionClass}`}>
      <div className="canvas-host" ref={mountRef} />

      <header className="hud-top-shell">
        <div className="brand-block">
          <p>Golden Hour Rides</p>
          <small>Coastal Cab + Air Service</small>
          <strong>{serviceLabel}</strong>
        </div>

        <div className="status-strip">
          <span>{VEHICLE_NAME[hud.vehicle]}</span>
          <span>{MODE_NAME[hud.mode]}</span>
          <span>{hud.speed} mph</span>
          <span>${hud.money}</span>
          <span>{hud.rating.toFixed(2)} rating</span>
          <span>{distanceMeters}m to target</span>
        </div>

        <div className="mini-map">
          <div className="mini-map-inner radar-map">
            <div className="radar-grid" />
            <svg className="map-route" viewBox="0 0 100 100" preserveAspectRatio="none">
              <line x1={50} y1={50} x2={plotX} y2={plotY} />
            </svg>
            <i className="marker player center" />
            <i
              className={`marker target ${hud.hasPassenger ? "dropoff" : "pickup"}`}
              style={{ left: `${plotX}%`, top: `${plotY}%` }}
            />
            {targetFar ? (
              <i className="target-arrow" style={{ transform: `translate(-50%, -50%) rotate(${arrowAngle}deg) translateY(-44px)` }} />
            ) : null}
          </div>
          <p className="mini-map-label">Head {dirLabel} • {distanceMeters}m</p>
        </div>
      </header>

      {isPlane ? (
        <div className="vehicle-controls-top">
          <span className="title">Plane Controls</span>
          <span><kbd>W/S</kbd> Throttle</span>
          <span><kbd>A/D</kbd> Turn</span>
          <span><kbd>Q</kbd> Lift/Climb</span>
          <span><kbd>E</kbd> Descend</span>
        </div>
      ) : null}

      {hud.recentEvent ? <div className="event-toast">{hud.recentEvent}</div> : null}

      <section className="hud-dock">
        <div className="dock-item">
          <p className="label">Objective</p>
          <h2>{hud.objective}</h2>
          <p className="meta">{hud.message}</p>
        </div>

        <div className="dock-item controls">
          <p className="label">Controls</p>
          <p className="meta">WASD/Arrows move</p>
          <p className="meta">1 cab, 2 plane</p>
          <p className="meta">Q takeoff/climb, E descend</p>
          <p className="meta">Stop at pickup to board passenger</p>
        </div>
      </section>

      <div className="hud-footer">FPS {hud.fps}{debugEnabled ? " • DEBUG" : ""}</div>
    </div>
  );
}
