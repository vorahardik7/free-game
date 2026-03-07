import { clamp } from "./math";

export function canPlaneTakeoff(onRunway: boolean, speed: number, rollDistance: number, minSpeed: number, minRollDistance: number): boolean {
  return onRunway && speed >= minSpeed && rollDistance >= minRollDistance;
}

export function computeCrashSeverity(beforeSpeed: number, afterSpeed: number): number {
  if (beforeSpeed <= 0.001) {
    return 0;
  }
  return clamp((beforeSpeed - afterSpeed) / beforeSpeed, 0, 1);
}

export function computeFarePenalty(impactSeverity: number, hasPassenger: boolean): number {
  if (!hasPassenger || impactSeverity < 0.2) {
    return 0;
  }
  return Math.round((impactSeverity - 0.2) * 28);
}

export function shouldPedestrianDodge(distance: number, approachDot: number): boolean {
  return distance < 9 && approachDot > 0.18;
}

export function shouldPedestrianFade(distance: number): boolean {
  return distance < 2.35;
}
