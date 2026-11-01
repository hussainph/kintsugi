import { useId, type CSSProperties } from "react";
import "./kin.css";

export const directions = [
  "seam",
  "shards",
  "orb",
  "portrait",
  "monogram",
] as const;
export type Direction = (typeof directions)[number];
export const states = ["idle", "thinking", "has-something", "listening"] as const;
export type KinState = (typeof states)[number];
export const forms = ["round", "pebble", "tile"] as const;
export type Form = (typeof forms)[number];
export const expressions = ["calm", "attentive", "wry"] as const;
export type Expression = (typeof expressions)[number];

export const directionNames: Record<Direction, string> = {
  seam: "Gold seam",
  shards: "Mended shards",
  orb: "Glazed orb",
  portrait: "Ink portrait",
  monogram: "Mended k",
};
export const stateNames: Record<KinState, string> = {
  idle: "Idle",
  thinking: "Thinking",
  "has-something": "Has something for you",
  listening: "Listening",
};

/** Glazes are the owner's choice. Gold is not: it always means Kin. */
export const glazes = {
  ink: { name: "Ink", body: "oklch(0.25 0.008 70)", hi: "oklch(0.38 0.01 70)", line: "oklch(0.95 0.01 85)" },
  porcelain: { name: "Porcelain", body: "oklch(0.955 0.008 88)", hi: "oklch(0.995 0.003 90)", line: "oklch(0.3 0.01 70)" },
  celadon: { name: "Celadon", body: "oklch(0.79 0.045 165)", hi: "oklch(0.88 0.035 160)", line: "oklch(0.3 0.03 170)" },
  clay: { name: "Raku clay", body: "oklch(0.56 0.075 45)", hi: "oklch(0.66 0.07 52)", line: "oklch(0.96 0.015 80)" },
  indigo: { name: "Indigo", body: "oklch(0.37 0.06 265)", hi: "oklch(0.48 0.06 262)", line: "oklch(0.95 0.01 260)" },
  ash: { name: "Ash", body: "oklch(0.68 0.012 80)", hi: "oklch(0.78 0.01 85)", line: "oklch(0.24 0.01 70)" },
} as const;
export type Glaze = keyof typeof glazes;
export const glazeKeys = Object.keys(glazes) as Glaze[];

export type MarkProps = {
  direction: Direction;
  state?: KinState;
  size?: number;
  glaze?: Glaze;
  form?: Form;
  seed?: number;
  expression?: Expression;
  reducedMotion?: boolean;
  className?: string;
  label?: string;
};

type Pt = readonly [number, number];
const C = 24;
const R = 19.5;

function rng(seed: number) {
  let a = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const onRim = (angle: number, r = R + 2): Pt => [C + Math.cos(angle) * r, C + Math.sin(angle) * r];
const d = (pts: readonly Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");

/**
 * A seam is seeded, so each owner's Kin breaks its own way. Small sizes get an
 * optical simplification: fewer joints and no branch, so the line stays a line.
 */
export function seamFor(seed: number, simple: boolean) {
  const next = rng(seed);
  const start = -Math.PI * 0.85 + next() * Math.PI * 0.5;
  const end = start + Math.PI + (next() - 0.5) * 0.8;
  const a = onRim(start);
  const b = onRim(end);
  const joints = simple ? 2 : 4;
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const len = Math.hypot(nx, ny);
  const pts: Pt[] = [a];
  for (let i = 1; i <= joints; i++) {
    const t = i / (joints + 1) + (next() - 0.5) * 0.08;
    const off = (next() - 0.5) * (simple ? 7 : 10) * (i % 2 ? 1 : -1);
    pts.push([a[0] + (b[0] - a[0]) * t + (nx / len) * off, a[1] + (b[1] - a[1]) * t + (ny / len) * off]);
  }
  pts.push(b);
  let branch: Pt[] | null = null;
  if (!simple && next() > 0.35) {
    const from = pts[2];
    const angle = Math.atan2(from[1] - C, from[0] - C) + (next() > 0.5 ? 0.9 : -0.9);
    const tip = onRim(angle);
    branch = [from, [(from[0] + tip[0]) / 2 + (next() - 0.5) * 4, (from[1] + tip[1]) / 2 + (next() - 0.5) * 4], tip];
  }
  return { main: d(pts), branch: branch && d(branch) };
}

export function formPath(form: Form) {
  if (form === "pebble")
    return "M24.6 4.6 C35.6 4.2 43.6 12.4 43.2 24.2 C42.8 35.4 34.4 43.6 23.4 43.3 C12.2 43 4.7 35 4.8 23.6 C4.9 12.6 13.2 5 24.6 4.6Z";
  if (form === "tile") return "M16 4.5 H32 C39 4.5 43.5 9 43.5 16 V32 C43.5 39 39 43.5 32 43.5 H16 C9 43.5 4.5 39 4.5 32 V16 C4.5 9 9 4.5 16 4.5Z";
  return `M${C} ${C - R} A${R} ${R} 0 1 1 ${C - 0.01} ${C - R}Z`;
}

/** Stroke widths in screen pixels, so a seam reads at 16px and stays fine at 96px. */
function widths(size: number) {
  const core = Math.max(1.3, Math.min(2.6, size * 0.042));
  return { core, glow: core * 2.2, fine: Math.max(1, core * 0.7) };
}

const BEAD: Pt = [38.6, 9.4];

function Bead({ size, reduced }: { size: number; reduced: boolean }) {
  const r = size <= 20 ? 6 : size <= 28 ? 5 : 4.4;
  return (
    <circle
      cx={BEAD[0]}
      cy={BEAD[1]}
      r={r}
      className={reduced ? undefined : "kin-bead"}
      style={{ fill: "var(--kin)", stroke: "var(--background)", strokeWidth: size <= 20 ? 2.4 : 1.8 }}
      data-kin-bead
    />
  );
}

function Ring({ reduced, size }: { reduced: boolean; size: number }) {
  return (
    <circle
      cx={C}
      cy={C}
      r={23.1}
      fill="none"
      vectorEffect="non-scaling-stroke"
      className={reduced ? undefined : "kin-ring"}
      style={{ stroke: "var(--kin)", strokeWidth: size <= 20 ? 1.2 : 1.4, opacity: reduced ? 0.6 : undefined }}
    />
  );
}

/** The gold itself: a soft underlay, a metallic core and (thinking) a travelling glint. */
function Gold({ path, size, state, reduced, gradient, fine = false }: { path: string; size: number; state: KinState; reduced: boolean; gradient: string; fine?: boolean }) {
  const w = widths(size);
  const core = fine ? w.fine : w.core;
  const thinkingStill = state === "thinking" && reduced;
  return (
    <g className={state === "listening" && !reduced ? "kin-seam-pulse" : undefined}>
      <path d={path} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--kin)", strokeWidth: core * 2.2, opacity: 0.22 }} />
      {thinkingStill && (
        <path d={path} fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: `url(#${gradient})`, strokeWidth: core, opacity: 0.35 }} />
      )}
      <path
        d={path}
        fill="none"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        strokeDasharray={thinkingStill ? "55 100" : undefined}
        style={{ stroke: `url(#${gradient})`, strokeWidth: core }}
      />
      {state === "thinking" && !reduced && (
        <path
          d={path}
          fill="none"
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="18 200"
          className="kin-glint"
          style={{ stroke: "var(--kin-hi)", strokeWidth: core * 1.15 }}
        />
      )}
    </g>
  );
}

function Defs({ id, glaze }: { id: string; glaze: Glaze }) {
  const g = glazes[glaze];
  return (
    <defs>
      <radialGradient id={`${id}-body`} cx="34%" cy="28%" r="80%">
        <stop offset="0" stopColor={g.hi} />
        <stop offset="0.65" stopColor={g.body} />
        <stop offset="1" stopColor={g.body} />
      </radialGradient>
      <linearGradient id={`${id}-gold`} gradientUnits="userSpaceOnUse" x1="6" y1="6" x2="42" y2="42">
        <stop offset="0" style={{ stopColor: "var(--kin-hi)" }} />
        <stop offset="0.45" style={{ stopColor: "var(--kin)" }} />
        <stop offset="1" style={{ stopColor: "var(--kin-lo)" }} />
      </linearGradient>
    </defs>
  );
}

function Body({ id, form }: { id: string; form: Form }) {
  return (
    <>
      <path d={formPath(form)} fill={`url(#${id}-body)`} />
      <path d={formPath(form)} fill="none" vectorEffect="non-scaling-stroke" style={{ stroke: "color-mix(in oklch, var(--foreground) 18%, transparent)", strokeWidth: 1 }} />
    </>
  );
}

function SeamMark({ id, size, state, form, seed, reduced }: Required<Pick<MarkProps, "size" | "state" | "glaze" | "form" | "seed">> & { id: string; reduced: boolean }) {
  const seam = seamFor(seed, size <= 24);
  return (
    <>
      <Body id={id} form={form} />
      <clipPath id={`${id}-clip`}>
        <path d={formPath(form)} />
      </clipPath>
      <g clipPath={`url(#${id}-clip)`}>
        <Gold path={seam.main} size={size} state={state} reduced={reduced} gradient={`${id}-gold`} />
        {seam.branch && <Gold path={seam.branch} size={size} state={state === "thinking" ? "idle" : state} reduced={reduced} gradient={`${id}-gold`} fine />}
      </g>
    </>
  );
}

function ShardsMark({ id, size, state, glaze, form, seed, reduced }: Required<Pick<MarkProps, "size" | "state" | "glaze" | "form" | "seed">> & { id: string; reduced: boolean }) {
  const next = rng(seed + 7);
  const hub: Pt = [C + (next() - 0.5) * 8, C + (next() - 0.5) * 8];
  const base = next() * Math.PI * 2;
  const angles = [0, 1, 2].map((i) => base + i * ((Math.PI * 2) / 3) + (next() - 0.5) * 0.7);
  const lines = angles.map((a) => {
    const tip = onRim(a, 30);
    const mid: Pt = [(hub[0] + tip[0]) / 2 + (next() - 0.5) * 5, (hub[1] + tip[1]) / 2 + (next() - 0.5) * 5];
    return [hub, mid, tip] as const;
  });
  const g = glazes[glaze];
  const moving = state === "thinking" && !reduced;
  const gap = reduced && state === "thinking" ? 1.3 : 0;
  return (
    <>
      <clipPath id={`${id}-clip`}>
        <path d={formPath(form)} />
      </clipPath>
      <path d={formPath(form)} style={{ fill: "var(--kin)", opacity: 0.85 }} clipPath={`url(#${id}-clip)`} />
      <g clipPath={`url(#${id}-clip)`}>
        {lines.map((line, i) => {
          const nextLine = lines[(i + 1) % 3];
          const a1 = angles[i];
          let a2 = angles[(i + 1) % 3];
          if (a2 < a1) a2 += Math.PI * 2;
          const arc = Array.from({ length: 8 }, (_, k) => onRim(a1 + ((a2 - a1) * (k + 1)) / 9, 30));
          const shard = d([...line, ...arc, nextLine[2], nextLine[1], nextLine[0]]) + "Z";
          const bis = (a1 + a2) / 2;
          const dx = Math.cos(bis) * 1.6;
          const dy = Math.sin(bis) * 1.6;
          return (
            <g key={i} className={moving ? "kin-drift" : undefined} style={{ "--kin-dx": `${dx}px`, "--kin-dy": `${dy}px`, transform: gap ? `translate(${Math.cos(bis) * gap}px, ${Math.sin(bis) * gap}px)` : undefined } as CSSProperties}>
              <path d={shard} fill={`url(#${id}-body)`} style={{ stroke: `url(#${id}-gold)`, strokeWidth: widths(size).core * (size <= 24 ? 0.9 : 0.75), strokeLinejoin: "round" }} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </g>
      <path d={formPath(form)} fill="none" vectorEffect="non-scaling-stroke" style={{ stroke: `color-mix(in oklch, ${g.body} 70%, var(--foreground) 20%)`, strokeWidth: 1, opacity: 0.5 }} />
    </>
  );
}

function OrbMark({ id, size, state, glaze, reduced }: Required<Pick<MarkProps, "size" | "state" | "glaze">> & { id: string; reduced: boolean }) {
  const w = widths(size);
  const g = glazes[glaze];
  return (
    <>
      <defs>
        <radialGradient id={`${id}-orb`} cx="36%" cy="30%" r="75%">
          <stop offset="0" stopColor={g.hi} />
          <stop offset="0.55" stopColor={g.body} />
          <stop offset="1" stopColor={`color-mix(in oklch, ${g.body} 75%, black)`} />
        </radialGradient>
      </defs>
      <g className={state === "listening" && !reduced ? "kin-breathe" : undefined}>
        <circle cx={C} cy={C} r={R} fill={`url(#${id}-orb)`} />
        <g className={state === "thinking" && !reduced ? "kin-orbit" : undefined}>
          <circle
            cx={C}
            cy={C}
            r={R - 1.2}
            fill="none"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={state === "thinking" && reduced ? "8 8" : "30 70"}
            strokeDashoffset={-8}
            style={{ stroke: `url(#${id}-gold)`, strokeWidth: w.core * 1.1, opacity: state === "idle" ? 0.75 : 1 }}
          />
        </g>
      </g>
    </>
  );
}

function PortraitMark({ id, size, state, expression, reduced }: Required<Pick<MarkProps, "size" | "state" | "glaze" | "expression">> & { id: string; reduced: boolean }) {
  const ink = "oklch(0.22 0.01 70)";
  const w = Math.max(1.2, Math.min(2, size * 0.034));
  const line = { stroke: ink, strokeWidth: w, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  // Thinking glances up and away; it's a still pose, so it needs no motion.
  const look = state === "thinking" ? [1.4, -1.6] : [0, 0];
  const eyes = state === "listening" ? "calm" : state === "has-something" ? "attentive" : expression;
  return (
    <>
      <circle cx={C} cy={C} r={R + 1.5} fill={`url(#${id}-body)`} />
      <g className={state === "listening" && !reduced ? "kin-tilt" : undefined}>
        {/* Face: a hand-drawn line with a mended break at the cheek. */}
        <path d="M30.5 33.6 C28.6 35.6 26.4 36.6 24 36.6 C18.2 36.6 14.6 31.4 14.6 24.6 C14.6 17.4 18.6 12.4 24.4 12.4 C30 12.4 33.6 17 33.6 23.4 C33.6 27 33 29.6 31.8 31.4 Z" fill="oklch(0.985 0.004 90)" />
        <path d="M30.5 33.6 C28.6 35.6 26.4 36.6 24 36.6 C18.2 36.6 14.6 31.4 14.6 24.6 C14.6 17.4 18.6 12.4 24.4 12.4 C30 12.4 33.6 17 33.6 23.4" vectorEffect="non-scaling-stroke" style={line} />
        <path d="M33.6 23.4 C33.6 27 33 29.6 31.8 31.4 L30.5 33.6" fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" style={{ stroke: `url(#${id}-gold)`, strokeWidth: w * 1.25 }} />
        {/* Hair: a single brushed fringe. */}
        <path d="M15.2 21 C16.6 15 20 12.3 24.6 12.3 C28.8 12.3 32 14.8 33.2 19.4 C29.6 18.8 26.2 17.2 23.6 14.8 C21.8 17.6 18.8 19.8 15.2 21Z" style={{ fill: ink }} />
        {state === "thinking" && !reduced && (
          <path d="M33.6 23.4 C33.6 27 33 29.6 31.8 31.4 L30.5 33.6" fill="none" vectorEffect="non-scaling-stroke" pathLength={100} strokeDasharray="18 200" className="kin-glint" style={{ stroke: "var(--kin-hi)", strokeWidth: w * 1.3, strokeLinecap: "round" }} />
        )}
        <g transform={`translate(${look[0]} ${look[1]})`}>
          {eyes === "calm" && (
            <>
              <path d="M18.6 25.4 Q20 26.6 21.4 25.4" vectorEffect="non-scaling-stroke" style={line} />
              <path d="M26 25.4 Q27.4 26.6 28.8 25.4" vectorEffect="non-scaling-stroke" style={line} />
            </>
          )}
          {eyes === "attentive" && (
            <>
              <circle cx={20} cy={25.4} r={1.15} style={{ fill: ink }} />
              <circle cx={27.4} cy={25.4} r={1.15} style={{ fill: ink }} />
            </>
          )}
          {eyes === "wry" && (
            <>
              <circle cx={20} cy={25.6} r={1.1} style={{ fill: ink }} />
              <path d="M26.2 25.6 H28.8" vectorEffect="non-scaling-stroke" style={line} />
              <path d="M25.8 22.2 Q27.4 21.2 29 21.9" vectorEffect="non-scaling-stroke" style={{ ...line, strokeWidth: w * 0.8 }} />
            </>
          )}
        </g>
        {size > 24 && <path d="M22.4 31.4 Q23.8 32 25.2 31.4" vectorEffect="non-scaling-stroke" style={{ ...line, strokeWidth: w * 0.8 }} />}
      </g>
    </>
  );
}

function MonogramMark({ id, size, state, glaze, form, reduced }: Required<Pick<MarkProps, "size" | "state" | "glaze" | "form">> & { id: string; reduced: boolean }) {
  const g = glazes[glaze];
  const w = Math.max(2, Math.min(4.2, size * 0.075));
  return (
    <>
      <Body id={id} form={form} />
      <path d="M19 12.5 V35.5 M30.2 18.6 L19.4 28.2" fill="none" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: g.line, strokeWidth: w }} />
      {/* The leg is the mended piece. */}
      <Gold path="M23.4 24.8 L31 35.5" size={size * 1.6} state={state} reduced={reduced} gradient={`${id}-gold`} />
    </>
  );
}

/** Kin's mark in any direction, state and size. */
export function KinMark({ direction, state = "idle", size = 40, glaze = "ink", form = "round", seed = 417, expression = "calm", reducedMotion = false, className, label }: MarkProps) {
  const id = `kin${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const reduced = reducedMotion;
  const common = { id, size, state, glaze, reduced };
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-kin-mark={direction}
      data-kin-state={state}
      style={{ overflow: "visible", flexShrink: 0 }}
    >
      <Defs id={id} glaze={glaze} />
      {direction === "seam" && <SeamMark {...common} form={form} seed={seed} />}
      {direction === "shards" && <ShardsMark {...common} form={form} seed={seed} />}
      {direction === "orb" && <OrbMark {...common} />}
      {direction === "portrait" && <PortraitMark {...common} expression={expression} />}
      {direction === "monogram" && <MonogramMark {...common} form={form} />}
      {state === "listening" && direction !== "orb" && <Ring reduced={reduced} size={size} />}
      {state === "listening" && direction === "orb" && reduced && <Ring reduced size={size} />}
      {state === "has-something" && <Bead size={size} reduced={reduced} />}
    </svg>
  );
}
