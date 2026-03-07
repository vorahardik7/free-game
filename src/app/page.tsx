"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { INITIAL_HUD_STATE } from "@/game/hud-state";
import { GameRuntime } from "@/game/runtime";
import type { HudSnapshot } from "@/game/types";

const MUSIC_FILES = [
  "Naruto - Konohamaru's Theme - ssj5Bardock (128k).mp3",
  "Naruto OST 2 - Afternoon of Konoha - ostdelta1 (128k).mp3",
  "Naruto OST 2 - Alone - ostdelta1 (128k).mp3",
  "Naruto OST 2 - Daylight of Konoha - ostdelta1 (128k).mp3",
  "Naruto OST 2 - Fooling Mode - ostdelta1 (128k).mp3",
  "Naruto Shippuden Unreleased OST - Konoha Peace 2 - Alex Nguyen (128k).mp3",
];

function trackLabel(fileName: string): string {
  return fileName.replace(" (128k).mp3", "").replace("Naruto OST 2 - ", "");
}

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD_STATE);
  const [gameStarted, setGameStarted] = useState(false);
  const [trackIndex, setTrackIndex] = useState(0);
  const [musicOn, setMusicOn] = useState(false);
  const [volume, setVolume] = useState(0.48);

  const debugEnabled = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("debug") === "1";
  }, []);

  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!gameStarted) return;
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
  }, [debugEnabled, gameStarted]);

  useEffect(() => {
    if (!audioRef.current || !gameStarted) return;
    if (musicOn) {
      void audioRef.current.play().catch(() => undefined);
    } else {
      audioRef.current.pause();
    }
  }, [gameStarted, musicOn, trackIndex]);

  const toggleMusic = (): void => {
    if (!audioRef.current) return;
    if (musicOn) {
      audioRef.current.pause();
      setMusicOn(false);
    } else {
      void audioRef.current.play().then(() => setMusicOn(true)).catch(() => undefined);
    }
  };

  const nextTrack = (): void => {
    setTrackIndex((prev) => (prev + 1) % MUSIC_FILES.length);
    setMusicOn(true);
  };

  const startGame = (): void => {
    const initial = Math.floor(Math.random() * MUSIC_FILES.length);
    setTrackIndex(initial);
    setGameStarted(true);
    setMusicOn(true);
  };

  const collisionClass = hud.collisionPulse > 0.15 ? "is-colliding" : "";
  const serviceLabel = hud.serviceState === "boarding" ? "Boarding" : hud.serviceState === "in-ride" ? "Fare Running" : "Searching";
  const targetX = hud.hasPassenger ? hud.dropoffX : hud.pickupX;
  const targetZ = hud.hasPassenger ? hud.dropoffZ : hud.pickupZ;
  const worldDx = targetX - hud.playerX;
  const worldDz = targetZ - hud.playerZ;
  const distanceMeters = Math.round(hud.targetDistance * 3.4);
  const dirLabel = cardinalFromVector(worldDx, worldDz);

  // Minimap calculations - world-space positions mapped to minimap
  const gridHalf = 9;
  const tileSize = 24;
  const worldSpan = (gridHalf * 2 + 1) * tileSize;
  const worldMin = -gridHalf * tileSize - tileSize / 2;
  const toMapPct = (worldVal: number): number => ((worldVal - worldMin) / worldSpan) * 100;
  const playerMapX = toMapPct(hud.playerX);
  const playerMapY = toMapPct(hud.playerZ);
  const targetMapX = toMapPct(targetX);
  const targetMapY = toMapPct(targetZ);

  // Compass arrow: angle from player heading to target
  const local = rotate(worldDx, worldDz, -hud.heading);
  const compassAngle = Math.atan2(local.x, local.z) * (180 / Math.PI);

  if (!gameStarted) {
    return (
      <div className="start-screen">
        <div className="start-content">
          <h1 className="start-title">Golden Hour Rides</h1>
          <p className="start-subtitle">Coastal Cab + Air Service</p>

          <div className="controls-grid">
            <div className="control-card">
              <h3>City Cab</h3>
              <div className="control-row"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <span>Drive</span></div>
              <div className="control-row"><kbd>Shift</kbd> <span>Boost</span></div>
            </div>
            <div className="control-card">
              <h3>Sky Hopper</h3>
              <div className="control-row"><kbd>W</kbd><kbd>S</kbd> <span>Throttle</span></div>
              <div className="control-row"><kbd>A</kbd><kbd>D</kbd> <span>Turn</span></div>
              <div className="control-row"><kbd>Q</kbd> <span>Climb</span></div>
              <div className="control-row"><kbd>E</kbd> <span>Descend</span></div>
            </div>
            <div className="control-card">
              <h3>Switch Vehicle</h3>
              <div className="control-row"><kbd>1</kbd> <span>City Cab</span></div>
              <div className="control-row"><kbd>2</kbd> <span>Sky Hopper</span></div>
            </div>
          </div>

          <p className="start-goal">Pick up passengers and deliver them to earn money</p>

          <button className="start-button" onClick={startGame}>
            Start Game
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`game-shell ${collisionClass}`}>
      <audio
        ref={audioRef}
        src={`/music/${encodeURIComponent(MUSIC_FILES[trackIndex] ?? "")}`}
        preload="auto"
        onEnded={() => setTrackIndex((prev) => (prev + 1) % MUSIC_FILES.length)}
      />
      <div className="canvas-host" ref={mountRef} />

      <header className="hud-top-shell">
        <div className="stat-cards">
          <div className="stat-card money">
            <span className="stat-value">${hud.money}</span>
            <span className="stat-label">Money</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{hud.speed}</span>
            <span className="stat-label">mph</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{distanceMeters}m</span>
            <span className="stat-label">to {hud.objective}</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{hud.rating.toFixed(1)}</span>
            <span className="stat-label">Rating</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{hud.rides}</span>
            <span className="stat-label">Rides</span>
          </div>
        </div>

        <div className="right-hud-stack">
          <div className="mini-map">
            <div className="mini-map-inner" style={hud.minimapDataUrl ? { backgroundImage: `url(${hud.minimapDataUrl})`, backgroundSize: "cover" } : undefined}>
              <svg className="map-route" viewBox="0 0 100 100" preserveAspectRatio="none">
                <line x1={playerMapX} y1={playerMapY} x2={targetMapX} y2={targetMapY} />
              </svg>
              <i className="marker player" style={{ left: `${playerMapX}%`, top: `${playerMapY}%` }} />
              <i
                className={`marker target ${hud.hasPassenger ? "dropoff" : "pickup"}`}
                style={{ left: `${targetMapX}%`, top: `${targetMapY}%` }}
              />
            </div>
          </div>
          <div className="music-widget">
            <p className="music-title">Lofi Radio</p>
            <p className="music-track">{trackLabel(MUSIC_FILES[trackIndex] ?? "")}</p>
            <div className="music-controls">
              <button type="button" onClick={toggleMusic}>{musicOn ? "Pause" : "Play"}</button>
              <button type="button" onClick={nextTrack}>Next</button>
            </div>
            <input
              className="music-volume"
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(event) => setVolume(Number(event.target.value) / 100)}
              aria-label="Music volume"
            />
          </div>
        </div>
      </header>

      {/* Compass Arrow */}
      <div className="compass-widget">
        <div className="compass-ring">
          <svg viewBox="0 0 80 80" className="compass-arrow-svg">
            <polygon
              points="40,10 32,50 40,44 48,50"
              fill={hud.hasPassenger ? "#fb7185" : "#2dd4bf"}
              stroke="rgba(255,255,255,0.3)"
              strokeWidth="1"
              transform={`rotate(${compassAngle}, 40, 40)`}
            />
          </svg>
        </div>
        <div className="compass-info">
          <span className="compass-dist">{distanceMeters}m</span>
          <span className="compass-dir">{dirLabel}</span>
          <span className={`compass-state ${hud.hasPassenger ? "dropoff" : "pickup"}`}>{hud.objective}</span>
        </div>
      </div>

      {hud.serviceState !== "searching" ? (
        <div className="service-pill">
          <span className="service-badge">{serviceLabel}</span>
        </div>
      ) : null}

      {hud.recentEvent ? <div className="event-toast">{hud.recentEvent}</div> : null}

      <section className="hud-dock">
        <div className="dock-item">
          <p className="label">Objective</p>
          <h2>{hud.objective}</h2>
          <p className="meta">{hud.message}</p>
        </div>
      </section>

      <div className="hud-footer">FPS {hud.fps}{debugEnabled ? " • DEBUG" : ""}</div>
    </div>
  );
}
