import {
  drawPerspectiveGridFloor,
  projectAndDrawMesh3D,
  STARFISH_MESH_3D,
  type LowPolyFace,
  type LowPolyMesh,
  type Vec3,
} from './lowPoly3d';
import {
  CANVAS_H,
  CANVAS_W,
  drawMicroPartyCommentPill,
  rgbToCss,
  type RgbTuple,
  type SceneRenderContext,
} from './types';

let lastCrabRaveTriggerAt = -20;
let crabRaveUntil = -10;
let lastAudioIntegrateAt = -1;
let schoolSwimDist = 0;
let crabGroovePhase = 0;
const smoothedCrabStand: [number, number, number, number, number] = [0, 0, 0, 0, 0];

interface DispatchedLyricBubble {
  id: number;
  text: string;
  baseX: number;
  wobblePhase: number;
  spawnAt: number;
  duration: number;
}

let lastQueuedLyricLine = '';
let nextLyricBubbleSeq = 0;
let activeLyricBubbles: DispatchedLyricBubble[] = [];

const RIDGE_PEAKS: [number, number][] = [
  [0, 14],
  [74, 34],
  [148, 18],
  [234, 38],
  [320, 22],
  [412, 36],
  [504, 19],
  [578, 32],
  [CANVAS_W, 14],
];

/** Pre-built 3D faceted carapace shell mesh (8 rim verts + 6 dorsal crown verts + crown peak + ventral keel). */
const CRAB_CARAPACE_MESH_3D: LowPolyMesh = (() => {
  const verts: Vec3[] = [];
  // 0..7: octagonal perimeter rim
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    verts.push([Math.cos(a) * 1.15, Math.sin(a) * 0.62, 0.0]);
  }
  // 8..13: raised hexagonal dorsal crown ring
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    verts.push([Math.cos(a) * 0.56, Math.sin(a) * 0.30, 0.44]);
  }
  // 14: dorsal central peak, 15: subtle translucent underside keel
  verts.push([0, -0.04, 0.60]);
  verts.push([0, 0.04, -0.28]);

  const faces: LowPolyFace[] = [];
  // Crown peak fan
  for (let i = 0; i < 6; i++) {
    const c0 = 8 + i;
    const c1 = 8 + ((i + 1) % 6);
    faces.push({
      indices: [14, c0, c1],
      palIdx: i % 2 === 0 ? 5 : 4,
      alpha: 0.62,
      wirePalIdx: 7,
      wireAlpha: 0.88,
    });
  }
  // Bevel skirt from 8-gon rim up to 6-gon dorsal crown
  const rimToCrown = [0, 1, 2, 2, 3, 4, 5, 5];
  for (let i = 0; i < 8; i++) {
    const r0 = i;
    const r1 = (i + 1) % 8;
    const c0 = 8 + rimToCrown[i];
    const c1 = 8 + rimToCrown[r1];
    if (c0 === c1) {
      faces.push({
        indices: [r0, r1, c0],
        palIdx: 3 + (i % 3),
        alpha: 0.48,
        wirePalIdx: 7,
        wireAlpha: 0.82,
      });
    } else {
      faces.push({
        indices: [r0, r1, c1, c0],
        palIdx: 3 + (i % 3),
        alpha: 0.52,
        wirePalIdx: 7,
        wireAlpha: 0.84,
      });
    }
    // Translucent underside glass facets
    faces.push({
      indices: [15, r1, r0],
      palIdx: 2,
      alpha: 0.36,
      wirePalIdx: 6,
      wireAlpha: 0.45,
    });
  }
  return { verts, faces };
})();

/** Draws a Bryce-3D raytraced chrome/bioluminescent sphere with an off-center specular core and hairline rim. */
function drawBryceOrb(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  palette: RgbTuple[],
  coreIdx = 7,
  midIdx = 5,
  rimAlpha = 0.82,
  alphaScale = 1,
): void {
  const grad = ctx.createRadialGradient(
    cx - r * 0.34,
    cy - r * 0.34,
    Math.max(0.4, r * 0.08),
    cx,
    cy,
    r,
  );
  grad.addColorStop(0, rgbToCss(palette[coreIdx], 0.96 * alphaScale));
  grad.addColorStop(0.46, rgbToCss(palette[midIdx], 0.82 * alphaScale));
  grad.addColorStop(0.84, rgbToCss(palette[2], 0.88 * alphaScale));
  grad.addColorStop(1, '#000000');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (rimAlpha > 0.02) {
    ctx.strokeStyle = rgbToCss(palette[7], rimAlpha * alphaScale);
    ctx.lineWidth = 0.75;
    ctx.stroke();
  }
}

/** Draws a 2-facet beveled 3D crystal segment between (x0,y0) and (x1,y1) with lit/shaded halves + specular spine. */
function drawBeveledCrystalSegment(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  halfW0: number,
  halfW1: number,
  litColor: RgbTuple,
  darkColor: RgbTuple,
  wireColor: RgbTuple,
  litAlpha = 0.56,
  darkAlpha = 0.34,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  const lx0 = x0 + nx * halfW0;
  const ly0 = y0 + ny * halfW0;
  const rx0 = x0 - nx * halfW0;
  const ry0 = y0 - ny * halfW0;
  const lx1 = x1 + nx * halfW1;
  const ly1 = y1 + ny * halfW1;
  const rx1 = x1 - nx * halfW1;
  const ry1 = y1 - ny * halfW1;

  // Lit upper/left crystal facet
  ctx.fillStyle = rgbToCss(litColor, litAlpha);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(lx0, ly0);
  ctx.lineTo(lx1, ly1);
  ctx.lineTo(x1, y1);
  ctx.closePath();
  ctx.fill();

  // Shaded lower/right crystal facet
  ctx.fillStyle = rgbToCss(darkColor, darkAlpha);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(rx1, ry1);
  ctx.lineTo(rx0, ry0);
  ctx.closePath();
  ctx.fill();

  // Crisp perimeter wireframe + central specular bevel spine
  ctx.strokeStyle = rgbToCss(wireColor, 0.84);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(lx0, ly0);
  ctx.lineTo(lx1, ly1);
  ctx.lineTo(rx1, ry1);
  ctx.lineTo(rx0, ry0);
  ctx.closePath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Builds a 3D 6-sided conical squid mantle + 2 undulating diamond fins mesh. */
function buildBryceSquidMesh(finFlutter: number): LowPolyMesh {
  const verts: Vec3[] = [
    [0, -1.65, 0], // 0: Spearhead apex tip
  ];
  // 1..6: Upper mantle ring (mid-body swell)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    verts.push([Math.cos(a) * 0.56, -0.52, Math.sin(a) * 0.44]);
  }
  // 7..12: Mantle collar rim
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    verts.push([Math.cos(a) * 0.42, 0.46, Math.sin(a) * 0.34]);
  }
  // 13..14: Lateral undulating diamond fin wingtips
  verts.push([-1.28, -0.78, finFlutter]);
  verts.push([1.28, -0.78, -finFlutter]);

  const faces: LowPolyFace[] = [];
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    const m0 = 1 + i;
    const m1 = 1 + next;
    const c0 = 7 + i;
    const c1 = 7 + next;

    // Nose cone facet
    faces.push({
      indices: [0, m0, m1],
      palIdx: 4 + (i % 3),
      alpha: 0.44,
      wirePalIdx: 7,
      wireAlpha: 0.86,
    });
    // Barrel collar facet (more translucent so bioluminescent siphon glows inside)
    faces.push({
      indices: [m0, c0, c1, m1],
      palIdx: 3 + (i % 3),
      alpha: 0.34,
      wirePalIdx: 7,
      wireAlpha: 0.82,
    });
  }
  // Lateral diamond fins (anchored along vertices 1/4 = left/right flanks)
  faces.push({
    indices: [0, 4, 13],
    palIdx: 6,
    alpha: 0.48,
    wirePalIdx: 7,
    wireAlpha: 0.90,
  });
  faces.push({
    indices: [4, 10, 13],
    palIdx: 5,
    alpha: 0.38,
    wirePalIdx: 7,
    wireAlpha: 0.86,
  });
  faces.push({
    indices: [0, 14, 1],
    palIdx: 6,
    alpha: 0.48,
    wirePalIdx: 7,
    wireAlpha: 0.90,
  });
  faces.push({
    indices: [1, 14, 7],
    palIdx: 5,
    alpha: 0.38,
    wirePalIdx: 7,
    wireAlpha: 0.86,
  });

  return { verts, faces };
}

/** Builds an articulated 4-sided diamond-ring 3D seahorse spine & tubular snout mesh. */
function buildBryceSeahorseMesh(): LowPolyMesh {
  // Spine control rings: [cx, cy, widthRadius, zDepthRadius]
  const bodyRings: [number, number, number, number][] = [
    [-0.08, -1.16, 0.24, 0.22], // 0: Crown crest
    [0.06, -0.92, 0.28, 0.26],  // 1: Head
    [-0.14, -0.54, 0.22, 0.20], // 2: Neck
    [-0.32, 0.0, 0.38, 0.32],   // 3: Arched chest
    [-0.18, 0.54, 0.28, 0.24],  // 4: Lower belly
    [0.10, 0.96, 0.17, 0.16],   // 5: Tail upper curl
    [0.42, 1.06, 0.11, 0.11],   // 6: Tail inner curl
    [0.24, 0.78, 0.07, 0.07],   // 7: Tail tip
  ];

  const verts: Vec3[] = [];
  for (const [cx, cy, wr, zr] of bodyRings) {
    verts.push([cx - wr, cy, 0]);
    verts.push([cx, cy, -zr]);
    verts.push([cx + wr, cy, 0]);
    verts.push([cx, cy, zr]);
  }
  // Tubular snout branching forward from the head ring (mid + flared tip rings)
  const snoutRings: [number, number, number, number][] = [
    [0.34, -0.90, 0.10, 0.10], // ring 8
    [0.64, -0.88, 0.13, 0.12], // ring 9 (flared snout tip)
  ];
  for (const [cx, cy, yr, zr] of snoutRings) {
    verts.push([cx, cy - yr, 0]);
    verts.push([cx, cy, -zr]);
    verts.push([cx, cy + yr, 0]);
    verts.push([cx, cy, zr]);
  }

  const faces: LowPolyFace[] = [];
  // Torso & curled tail 4-sided diamond armor plates
  for (let r = 0; r < bodyRings.length - 1; r++) {
    const base0 = r * 4;
    const base1 = (r + 1) * 4;
    for (let s = 0; s < 4; s++) {
      const sNext = (s + 1) & 3;
      faces.push({
        indices: [base0 + s, base0 + sNext, base1 + sNext, base1 + s],
        palIdx: 3 + ((r + s) & 3),
        alpha: s === 1 || s === 2 ? 0.62 : 0.40,
        wirePalIdx: 7,
        wireAlpha: 0.84,
      });
    }
  }
  // Connect Head ring (ring 1) -> Snout Mid (ring 8) -> Snout Tip (ring 9)
  const snoutChain = [1, 8, 9];
  for (let i = 0; i < snoutChain.length - 1; i++) {
    const base0 = snoutChain[i] * 4;
    const base1 = snoutChain[i + 1] * 4;
    for (let s = 0; s < 4; s++) {
      const sNext = (s + 1) & 3;
      faces.push({
        indices: [base0 + s, base0 + sNext, base1 + sNext, base1 + s],
        palIdx: 5 + (s & 1),
        alpha: 0.56,
        wirePalIdx: 7,
        wireAlpha: 0.88,
      });
    }
  }
  return { verts, faces };
}

const SEAHORSE_MESH_3D = buildBryceSeahorseMesh();

/**
 * Mode 13: Reef 3D [Bryce-3D Supersampled Abyss]
 * - Full 1280×720 High-DPI Canvas2D vector supersampling matching Trapper's crisp crystalline look
 * - Deep OLED ocean contrast, horizon raster shimmer, monotonic Bryce checkerboard seabed & caustic beams
 * - Bioluminescent 3D Squid, Crystalline 3D Seahorses, Tumbling 3D Starfish & Crab Rave 3D Reef Crabs
 * - Bespoke Rising Crystal Bubble Lyric Cascade & timed comment overlay
 */
export function renderReef3dScene(s: SceneRenderContext): void {
  const {
    ctx: mainCtx,
    timeSec,
    dt,
    bpm,
    rms,
    peak,
    beat,
    subBass,
    midEnergy,
    highEnergy,
    drop,
    trans,
    sb,
    palette,
    artCanvas,
    artReady,
    activeLyric,
    activeComment,
    commentAvatarImg,
    cropTopY,
    cropBottomY,
  } = s;

  // Handle track seek / restart
  if (timeSec < lastCrabRaveTriggerAt - 5) {
    lastCrabRaveTriggerAt = -20;
    crabRaveUntil = -10;
  }
  if (lastAudioIntegrateAt < 0 || timeSec < lastAudioIntegrateAt - 2) {
    lastAudioIntegrateAt = timeSec;
    lastQueuedLyricLine = '';
    activeLyricBubbles = [];
  }
  const frameDt = Math.max(0, Math.min(0.1, dt || timeSec - lastAudioIntegrateAt));
  lastAudioIntegrateAt = timeSec;

  // Combined 0..1 music loudness/amplitude envelope driving distant fish school & crab reactivity
  const audioAmp = Math.min(
    1,
    rms * 0.85 + peak * 0.3 + midEnergy * 0.45 + subBass * 0.35 + highEnergy * 0.2,
  );

  // Trigger ~3.5s Crab Rave on beat drops (with an 11s cooldown so it's a special drop event)
  if (
    (drop > 0.42 || (drop > 0.26 && beat > 0.8 && subBass > 0.7)) &&
    timeSec - lastCrabRaveTriggerAt > 11.0
  ) {
    lastCrabRaveTriggerAt = timeSec;
    crabRaveUntil = timeSec + 3.5;
  }
  const crabRaveActive = timeSec < crabRaveUntil;
  const tempoHz = Math.max(1.2, Math.min(3.2, (bpm || 120) / 60));

  // Integrate continuous music-reactive distance/phase so speed changes never cause position jumps
  schoolSwimDist +=
    frameDt * (24 + audioAmp * 96 + beat * 38 + (crabRaveActive ? 52 : 0));
  crabGroovePhase +=
    frameDt *
    tempoHz *
    Math.PI *
    2 *
    (crabRaveActive ? 1.55 + subBass * 0.45 : 0.45 + audioAmp * 0.85 + beat * 0.35);

  const ctx = mainCtx;
  const horizonY = CANVAS_H * 0.58;
  const surfaceY = Math.max(20, cropTopY + 10);

  // Smooth 0..1 envelope for Crab Rave so lights fan out and fold back smoothly without popping
  const raveRemaining = crabRaveUntil - timeSec;
  const raveElapsed = timeSec - lastCrabRaveTriggerAt;
  const raveFanProgress = crabRaveActive
    ? Math.min(1, Math.min(raveElapsed / 0.45, raveRemaining / 0.55))
    : 0;

  // 1. Deep-Abyss OLED Backdrop, Horizon Shimmer & Caustic Rays
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const waterGrad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  waterGrad.addColorStop(0, rgbToCss(palette[4], 0.30));
  waterGrad.addColorStop(0.42, rgbToCss(palette[2], 0.20));
  waterGrad.addColorStop(0.8, rgbToCss(palette[1], 0.12));
  waterGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Ultra-fine Amiga/Bryce caustic raster horizon lines above the ridge
  for (let b = 0; b < 10; b++) {
    const bandAmp = sb[b & 15];
    const phase = timeSec * 1.45 + b * 0.44;
    const ry = horizonY - 82 + b * 7.6 + Math.sin(phase) * (5 + subBass * 8);
    const barW = CANVAS_W * Math.min(0.96, 0.28 + bandAmp * 0.54);
    const barX = (CANVAS_W - barW) * 0.5;
    ctx.fillStyle = rgbToCss(palette[2 + (b % 5)], 0.20 + bandAmp * 0.28);
    ctx.fillRect(barX, ry, barW, 0.85);
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const numRays = 7;
  for (let r = 0; r < numRays; r++) {
    const topX =
      58 +
      (r / (numRays - 1)) * (CANVAS_W - 116) +
      Math.sin(timeSec * 0.32 + r * 1.1) * 18;
    const baseSwayX = topX + Math.sin(timeSec * 0.48 + r * 0.85) * 44 - 8;

    const subRayOffsets = raveFanProgress > 0.01 ? [-1, 0, 1] : [0];
    for (const subDir of subRayOffsets) {
      const isSideFan = subDir !== 0;
      const fanAlphaScale = isSideFan ? raveFanProgress * 0.85 : 1.0;
      const raveSweep =
        raveFanProgress *
        Math.sin(timeSec * tempoHz * Math.PI + r * 0.7 + subDir) *
        28;
      const fanSpreadX = subDir * (56 * raveFanProgress) + raveSweep;

      const botX = baseSwayX + fanSpreadX;
      const topW = isSideFan ? 7 : 12;
      const botW = isSideFan ? 22 + raveFanProgress * 12 : 34;

      const rayColor = isSideFan
        ? palette[5 + ((r + (subDir > 0 ? 1 : 0)) & 2)]
        : palette[6];
      const baseAlpha = 0.20 * fanAlphaScale;

      const rayGrad = ctx.createLinearGradient(
        topX,
        surfaceY,
        botX,
        horizonY + 52,
      );
      rayGrad.addColorStop(0, rgbToCss(rayColor, baseAlpha));
      rayGrad.addColorStop(0.55, rgbToCss(palette[4 + (r & 1)], baseAlpha * 0.45));
      rayGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = rayGrad;
      ctx.beginPath();
      ctx.moveTo(topX - topW * 0.5, surfaceY);
      ctx.lineTo(topX + topW * 0.5, surfaceY);
      ctx.lineTo(botX + botW * 0.5, horizonY + 52);
      ctx.lineTo(botX - botW * 0.5, horizonY + 52);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Smooth Bryce ocean surface wave ribbon with dual-stroke neon glow
  const waveCols = 36;
  const colW = CANVAS_W / waveCols;
  ctx.beginPath();
  for (let c = 0; c <= waveCols; c++) {
    const x = c * colW;
    const wy =
      surfaceY +
      Math.sin(x * 0.02 + timeSec * 0.68) * 3.5 +
      Math.cos(x * 0.045 - timeSec * 0.85) * 2.0;
    if (c === 0) ctx.moveTo(0, wy);
    else ctx.lineTo(x, wy);
  }
  ctx.strokeStyle = rgbToCss(palette[5], 0.38);
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.strokeStyle = rgbToCss(palette[7], 0.82);
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.restore();

  // 2. Triangulated 3D Horizon Reef Ridge & Smooth Bryce-3D Checkerboard Seabed
  for (let i = 0; i < RIDGE_PEAKS.length - 1; i++) {
    const [x0, h0] = RIDGE_PEAKS[i];
    const [x1, h1] = RIDGE_PEAKS[i + 1];
    const midX = (x0 + x1) * 0.5;
    const peakY = horizonY - Math.max(h0, h1) - 4;
    const y0 = horizonY - h0;
    const y1 = horizonY - h1;

    ctx.strokeStyle = rgbToCss(palette[5], 0.55);
    ctx.lineWidth = 0.8;

    // Lit left slope facet
    ctx.fillStyle = rgbToCss(palette[3], 0.42);
    ctx.beginPath();
    ctx.moveTo(x0, horizonY);
    ctx.lineTo(x0, y0);
    ctx.lineTo(midX, peakY);
    ctx.lineTo(midX, horizonY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Shaded right slope facet
    ctx.fillStyle = rgbToCss(palette[1], 0.68);
    ctx.beginPath();
    ctx.moveTo(midX, horizonY);
    ctx.lineTo(midX, peakY);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1, horizonY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // 2b. Distant Low-Poly Background School of Fish (Audio-Reactive Speed & Population!)
  //     Quiet passages show ~10 slow-drifting distant low-poly fish; loud/high-amplitude sections
  //     swell up to 34 fast-darting fish across two counter-flowing background shoals.
  const maxSchoolFish = 34;
  const targetFishCount = Math.min(
    maxSchoolFish,
    9 + audioAmp * 20 + beat * 3 + (crabRaveActive ? 5 : 0),
  );
  const spanW = CANVAS_W + 96;
  ctx.save();
  for (let f = 0; f < maxSchoolFish; f++) {
    const fadeIn = Math.max(0, Math.min(1, targetFishCount - f));
    if (fadeIn <= 0.02) continue;

    // Split into a primary left-to-right upper-mid shoal and a deeper right-to-left shoal
    const dir = (f & 3) === 0 ? -1 : 1;
    const depthLayer = (f % 5) / 4; // 0 = farthest/smallest, 1 = mid-distance
    const speedMult = 0.62 + depthLayer * 0.48 + ((f * 7) % 5) * 0.07;
    const bandVal = sb[f & 15];

    const rawX = (f * 73 + schoolSwimDist * speedMult) % spanW;
    const fx = Math.round((dir > 0 ? rawX - 48 : CANVAS_W + 48 - rawX) * 0.5) * 2;
    const baseSchoolY =
      surfaceY + 26 + ((f * 41) % Math.max(36, Math.floor(horizonY - surfaceY - 58)));
    const schoolWaveY =
      Math.sin(schoolSwimDist * 0.022 + f * 0.65) * (4 + audioAmp * 8) +
      Math.cos(timeSec * 2.4 + f) * (bandVal * 4.5);
    const fy = Math.round((baseSchoolY + schoolWaveY) * 0.5) * 2;

    // Deliberately coarse 3-polygon low-poly distant fish silhouette (quantized to 2px grid)
    const fScale = (0.58 + depthLayer * 0.45 + bandVal * 0.15) * (0.7 + fadeIn * 0.3);
    const bodyL = Math.round(7.5 * fScale);
    const bodyH = Math.max(2, Math.round(3.2 * fScale));
    const tailWag = Math.round(
      Math.sin(schoolSwimDist * 0.16 + f * 1.7) * (1.2 + audioAmp * 1.8),
    );
    const fishAlpha = (0.22 + depthLayer * 0.28 + audioAmp * 0.14) * fadeIn;
    const bodyPal = palette[3 + (f % 3)];
    const bellyPal = palette[1 + (f % 2)];

    // Dorsal triangle facet
    ctx.fillStyle = rgbToCss(bodyPal, fishAlpha);
    ctx.beginPath();
    ctx.moveTo(fx + dir * bodyL, fy);
    ctx.lineTo(fx - dir * (bodyL * 0.25), fy - bodyH);
    ctx.lineTo(fx - dir * bodyL, fy);
    ctx.closePath();
    ctx.fill();

    // Ventral triangle facet
    ctx.fillStyle = rgbToCss(bellyPal, fishAlpha * 0.85);
    ctx.beginPath();
    ctx.moveTo(fx + dir * bodyL, fy);
    ctx.lineTo(fx - dir * bodyL, fy);
    ctx.lineTo(fx - dir * (bodyL * 0.25), fy + bodyH);
    ctx.closePath();
    ctx.fill();

    // Low-poly forked tail triangle
    ctx.fillStyle = rgbToCss(palette[4 + (f & 1)], fishAlpha * 0.78);
    ctx.beginPath();
    ctx.moveTo(fx - dir * (bodyL * 0.85), fy);
    ctx.lineTo(fx - dir * (bodyL * 1.55), fy - bodyH * 0.9 + tailWag);
    ctx.lineTo(fx - dir * (bodyL * 1.55), fy + bodyH * 0.9 + tailWag);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  drawPerspectiveGridFloor(
    ctx,
    horizonY,
    CANVAS_H,
    timeSec * 0.28,
    0,
    palette,
    true,
    0.76,
    0,
    0.28,
  );

  // Subtle Drifting Seabed Caustic Rings over the Floor
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let r = 0; r < 3; r++) {
    const d0 = (r + 0.5) / 3;
    const ry = horizonY + 12 + d0 * (CANVAS_H - horizonY - 20);
    for (let c = 0; c < 8; c++) {
      const cxCell =
        ((c + 0.5) / 8) * CANVAS_W +
        Math.sin(timeSec * 0.45 + r * 1.3 + c * 0.9) * 12;
      const cellR = 14 + d0 * 16;
      ctx.strokeStyle = rgbToCss(palette[5 + (r & 1)], 0.14 + sb[(c + r) & 15] * 0.12);
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.ellipse(cxCell, ry, cellR, cellR * 0.28, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // 3. Beveled Bryce-3D Crystalline Relic Medallion on the Horizon
  const tabletX = CANVAS_W * 0.5;
  const tabletY = horizonY - 26 + Math.sin(timeSec * 0.55) * 3;
  const tabletR = 39 + beat * 3;
  const innerR = tabletR * 0.78;

  // Ground shadow beneath the horizon medallion
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.beginPath();
  ctx.ellipse(tabletX, horizonY + 20, tabletR * 1.15, tabletR * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(tabletX, tabletY);
  ctx.rotate(Math.sin(timeSec * 0.25) * 0.04);

  const outerOct: [number, number][] = [];
  const innerOct: [number, number][] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    outerOct.push([Math.cos(a) * tabletR, Math.sin(a) * tabletR]);
    innerOct.push([Math.cos(a) * innerR, Math.sin(a) * innerR]);
  }
  for (let k = 0; k < 8; k++) {
    const kn = (k + 1) & 7;
    const isTopLit = k >= 4 && k <= 6;
    ctx.fillStyle = rgbToCss(
      palette[isTopLit ? 5 : 2 + (k % 3)],
      isTopLit ? 0.72 : 0.46,
    );
    ctx.strokeStyle = rgbToCss(palette[crabRaveActive ? 7 : 6], 0.88);
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    ctx.moveTo(outerOct[k][0], outerOct[k][1]);
    ctx.lineTo(outerOct[kn][0], outerOct[kn][1]);
    ctx.lineTo(innerOct[kn][0], innerOct[kn][1]);
    ctx.lineTo(innerOct[k][0], innerOct[k][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.save();
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    if (k === 0) ctx.moveTo(innerOct[k][0], innerOct[k][1]);
    else ctx.lineTo(innerOct[k][0], innerOct[k][1]);
  }
  ctx.closePath();
  ctx.clip();

  if (artReady && artCanvas) {
    ctx.globalAlpha = 0.86 + beat * 0.12;
    ctx.drawImage(artCanvas, -innerR, -innerR, innerR * 2, innerR * 2);
    ctx.globalAlpha = 1;
  } else {
    drawBryceOrb(ctx, 0, 0, innerR, palette, 6, 4, 0);
  }
  // Diagonal glass sheen across the medallion crystal face
  const sheenGrad = ctx.createLinearGradient(-innerR, -innerR, innerR, innerR);
  sheenGrad.addColorStop(0, rgbToCss(palette[7], 0.24));
  sheenGrad.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
  sheenGrad.addColorStop(1, rgbToCss(palette[3], 0.16));
  ctx.fillStyle = sheenGrad;
  ctx.fillRect(-innerR, -innerR, innerR * 2, innerR * 2);
  ctx.restore();
  ctx.restore();

  // 4. Crystalline 3D Staghorn Coral & Translucent Kelp Ribbons
  const drawCrystalCoral = (
    baseX: number,
    baseY: number,
    dir: number,
    palSlot: number,
  ) => {
    const branches = 5;
    for (let b = 0; b < branches; b++) {
      const ang =
        -Math.PI * 0.5 +
        (b - 2) * 0.31 +
        Math.sin(timeSec * 0.75 + b) * 0.06 * dir;
      const len = 38 + (b % 3) * 14 + sb[(b * 3) & 15] * 14;
      const tipX = baseX + Math.cos(ang) * len;
      const tipY = baseY + Math.sin(ang) * len;
      drawBeveledCrystalSegment(
        ctx,
        baseX,
        baseY,
        tipX,
        tipY,
        4.6,
        1.4,
        palette[Math.min(7, palSlot + 1)],
        palette[Math.max(1, palSlot - 1)],
        palette[7],
        0.52,
        0.36,
      );
      drawBryceOrb(ctx, tipX, tipY, 2.8, palette, 7, palSlot, 0, 0.85);
    }
  };
  drawCrystalCoral(88, horizonY + 32, 1, 3);
  drawCrystalCoral(552, horizonY + 36, -1, 4);
  drawCrystalCoral(172, horizonY + 10, 1, 2);
  drawCrystalCoral(468, horizonY + 12, -1, 5);

  for (const kBaseX of [38, 128, 512, 602]) {
    let kx = kBaseX;
    let ky = horizonY + 22;
    for (let sIdx = 0; sIdx < 4; sIdx++) {
      const nextX =
        kBaseX + Math.sin(timeSec * 0.65 + sIdx * 0.7 + kBaseX * 0.02) * (6 + sIdx * 3);
      const nextY = ky - 22;
      drawBeveledCrystalSegment(
        ctx,
        kx,
        ky,
        nextX,
        nextY,
        4.2 - sIdx * 0.4,
        3.2 - sIdx * 0.4,
        palette[4 + (sIdx & 1)],
        palette[2 + (sIdx & 1)],
        palette[6],
        0.40,
        0.28,
      );
      kx = nextX;
      ky = nextY;
    }
  }

  // 5. Bioluminescent Bryce-3D Patrolling Squids
  const drawBryceSquid = (
    homeX: number,
    homeY: number,
    rangeX: number,
    rangeY: number,
    speedX: number,
    speedY: number,
    scale: number,
    phase: number,
  ) => {
    const jetSurge = Math.pow(Math.max(0, Math.sin(timeSec * 1.45 + phase)), 2) * 0.25;
    const tX = timeSec * speedX + phase + jetSurge;
    const tY = timeSec * speedY + phase * 1.3;
    const curX = homeX + Math.sin(tX) * rangeX;
    const curY = homeY + Math.cos(tY) * rangeY;
    const vx = Math.cos(tX) * speedX * rangeX;
    const vy = -Math.sin(tY) * speedY * rangeY;
    // Align spearhead mantle (-Y in local mesh space) along velocity direction
    const swimAngle = Math.atan2(vy, vx) + Math.PI * 0.5;
    const finFlutter = Math.sin(timeSec * 3.8 + phase) * 0.26;
    const squidMesh = buildBryceSquidMesh(finFlutter);

    ctx.save();
    ctx.translate(curX, curY);
    ctx.rotate(swimAngle);
    ctx.scale(scale, scale);

    // 6 trailing sinusoidal tentacles + 2 longer feeding tentacles with faceted clubs
    const numArms = 8;
    for (let a = 0; a < numArms; a++) {
      const isFeedingClub = a === 2 || a === 5;
      const spreadFrac = (a / (numArms - 1)) * 2 - 1;
      const rootX = spreadFrac * 8.5;
      const rootY = 10.5;
      const armLen = isFeedingClub ? 32 : 22 + (a & 1) * 4;
      const segs = 8;

      ctx.beginPath();
      ctx.moveTo(rootX, rootY);
      let tipX = rootX;
      let tipY = rootY;
      for (let sg = 1; sg <= segs; sg++) {
        const u = sg / segs;
        const whip =
          Math.sin(timeSec * 4.4 - u * 3.2 + a * 0.75 + phase) * (2.6 + u * 5.2);
        tipX = rootX + spreadFrac * u * 6.5 + whip;
        tipY = rootY + u * armLen;
        ctx.lineTo(tipX, tipY);
      }
      ctx.strokeStyle = rgbToCss(palette[5], 0.36);
      ctx.lineWidth = isFeedingClub ? 2.5 : 2.0;
      ctx.stroke();
      ctx.strokeStyle = rgbToCss(palette[7], isFeedingClub ? 0.88 : 0.72);
      ctx.lineWidth = 0.78;
      ctx.stroke();

      if (isFeedingClub) {
        ctx.fillStyle = rgbToCss(palette[6], 0.44);
        ctx.strokeStyle = rgbToCss(palette[7], 0.88);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY - 2.5);
        ctx.lineTo(tipX + 2.8, tipY + 1.5);
        ctx.lineTo(tipX, tipY + 6.2);
        ctx.lineTo(tipX - 2.8, tipY + 1.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // Raytraced bioluminescent internal siphon core visible through translucent mantle facets
    drawBryceOrb(ctx, 0, 1.5, 11, palette, 7, 5, 0, 0.72 + beat * 0.24);

    // Painter-sorted semi-translucent 3D spearhead mantle & lateral diamond fins
    projectAndDrawMesh3D(ctx, squidMesh, {
      cx: 0,
      cy: 0,
      scale: 22,
      rx: 0.20,
      ry: timeSec * 0.85 + phase,
      rz: 0,
      palette,
      snapStep: 0,
      wireLineWidth: 0.85,
      alphaBoost: 1.0,
    });

    // Two crisp radial-gradient chrome/neon eyes flanking the mantle collar
    drawBryceOrb(ctx, -6.2, 8.5, 2.8, palette, 7, 4, 0.85);
    drawBryceOrb(ctx, 6.2, 8.5, 2.8, palette, 7, 4, 0.85);

    ctx.restore();
  };

  drawBryceSquid(206, horizonY - 68, 72, 22, 0.36, 0.54, 0.96, 0.4);
  drawBryceSquid(446, horizonY - 80, 68, 24, 0.31, 0.49, 0.84, 3.1);

  // 6. Patrolling Bryce-3D Crystalline Seahorses
  const drawBryceSeahorse = (
    homeX: number,
    homeY: number,
    rangeX: number,
    rangeY: number,
    speedX: number,
    speedY: number,
    scale: number,
    phase: number,
  ) => {
    const thetaX = timeSec * speedX + phase;
    const thetaY = timeSec * speedY + phase * 1.6;
    const curX = homeX + Math.sin(thetaX) * rangeX;
    const curY = homeY + Math.sin(thetaY) * rangeY;
    const vx = Math.cos(thetaX) * speedX * rangeX;
    const vy = Math.cos(thetaY) * speedY * rangeY;
    const facing = vx >= 0 ? 1 : -1;
    const pitch = Math.max(-0.22, Math.min(0.22, (vy / 18) * 0.12));
    const finFlutter = Math.sin(timeSec * 8.5 + phase) * 4.2;

    ctx.save();
    ctx.translate(curX, curY);
    ctx.scale(facing * scale, scale);
    ctx.rotate(pitch);

    // Subtle bioluminescent chest core behind translucent 3D body plates
    const chestGrad = ctx.createRadialGradient(-4, -2, 2, -4, -2, 26);
    chestGrad.addColorStop(0, rgbToCss(palette[6], 0.36));
    chestGrad.addColorStop(0.55, rgbToCss(palette[4], 0.14));
    chestGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = chestGrad;
    ctx.beginPath();
    ctx.arc(-4, -2, 26, 0, Math.PI * 2);
    ctx.fill();

    // Ray-finned fluttering dorsal fan behind the arched chest
    ctx.fillStyle = rgbToCss(palette[6], 0.32);
    ctx.strokeStyle = rgbToCss(palette[7], 0.85);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-9, -9);
    ctx.lineTo(-24, -14 + finFlutter);
    ctx.lineTo(-22, 8 - finFlutter);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.lineWidth = 0.7;
    ctx.strokeStyle = rgbToCss(palette[7], 0.72);
    for (let r = 0; r < 5; r++) {
      const f = r / 4;
      ctx.beginPath();
      ctx.moveTo(-8.5, -8 + f * 17);
      ctx.lineTo(-23 + f * 1.5, -13 + finFlutter + f * (21 - finFlutter * 2));
      ctx.stroke();
    }

    // Crystalline coronet crown spikes
    ctx.fillStyle = rgbToCss(palette[6], 0.52);
    ctx.strokeStyle = rgbToCss(palette[7], 0.88);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-7, -28);
    ctx.lineTo(-3, -36);
    ctx.lineTo(1, -29);
    ctx.lineTo(5, -35);
    ctx.lineTo(6, -27);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // True 3D 4-sided diamond-ring articulated spine mesh
    projectAndDrawMesh3D(ctx, SEAHORSE_MESH_3D, {
      cx: 0,
      cy: 0,
      scale: 24,
      rx: 0.12,
      ry: 0.24 + Math.sin(thetaX) * 0.26,
      rz: 0,
      palette,
      snapStep: 0,
      wireLineWidth: 0.85,
      alphaBoost: 1.0,
    });

    // Chrome specular eye sphere
    drawBryceOrb(ctx, 2.2, -23.5, 2.6, palette, 7, 4, 0.86);
    ctx.restore();
  };

  drawBryceSeahorse(148, horizonY - 46, 62, 26, 0.34, 0.58, 1.0, 0.0);
  drawBryceSeahorse(492, horizonY - 38, 66, 28, 0.31, 0.52, 0.96, 2.4);
  drawBryceSeahorse(296, horizonY - 82, 78, 20, 0.26, 0.46, 0.72, 4.5);

  // 7. Tumbling 5-Pointed 3D Crystalline Starfish (`STARFISH_MESH_3D`)
  const drawBryceStarfish = (cx: number, cy: number, scale: number, rx: number, ry: number, rz: number) => {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.56)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + scale * 0.85, scale * 0.9, scale * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();

    drawBryceOrb(ctx, cx, cy, scale * 0.52, palette, 7, 5, 0, 0.48);

    projectAndDrawMesh3D(ctx, STARFISH_MESH_3D, {
      cx,
      cy,
      scale,
      rx,
      ry,
      rz,
      palette,
      snapStep: 0,
      wireLineWidth: 0.85,
      alphaBoost: 0.72,
    });
  };

  drawBryceStarfish(
    224 + Math.sin(timeSec * 0.45) * 18,
    horizonY + 52,
    22 + beat * 4,
    0.88 + Math.sin(timeSec * 0.6) * 0.18,
    timeSec * 0.48,
    timeSec * 0.35,
  );
  drawBryceStarfish(
    418 + Math.cos(timeSec * 0.42) * 18,
    horizonY + 66,
    19 + subBass * 4,
    0.92,
    -timeSec * 0.44,
    -timeSec * 0.32,
  );

  // 8. Articulated Bryce-3D Chrome & Crystal Reef Crabs (5-Crab Formation, Music-Reactive!)
  //    3 Iconic Moves with C1-Continuous Damped Transitions (zero phase jumps!):
  //    (A) Low Crab-Walk Scuttle, (B) High-Stilt Leg Extension + Overhead Claw Pumping,
  //    and (C) Beat-Drop "Crab Rave" Mode with High Jumps, Body Light Strobing & Electric Claws!
  const smoothstep01 = (t: number) => {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  };
  const raveBlend = smoothstep01(raveFanProgress);

  const drawBryceCrab = (
    crabIdx: number,
    baseX: number,
    baseY: number,
    scale: number,
    seed: number,
  ) => {
    const crabBand = sb[(Math.floor(seed * 3) + 2) & 15];
    const musicDrive = Math.min(1.35, 0.35 + audioAmp * 0.85 + crabBand * 0.35);

    // 1. Target "Stand High on Extended Stilt-Legs & Claw Pump" envelope (smoothly damped per crab so it never jerks!)
    //    Uses strictly monotonic `timeSec` for the cycle clock so audio fluctuations never jump the cycle phase,
    //    and smoothly hands off to full jumping Rave Party mode (`1 - raveBlend`) when a beat-drop Crab Rave hits.
    const normalCycle = (timeSec + seed * 1.15) % 9.0;
    const cycleWindow =
      normalCycle < 3.0
        ? smoothstep01(Math.min(normalCycle / 0.65, (3.0 - normalCycle) / 0.65))
        : 0;
    const energyStandTarget =
      audioAmp > 0.58 ? Math.min(0.9, (audioAmp - 0.58) * 2.2) : 0;
    const rawStandTarget =
      Math.max(cycleWindow * Math.min(1, 0.5 + audioAmp * 0.85), energyStandTarget) *
      (1 - raveBlend);

    const dampRate = Math.min(1, frameDt * 5.5);
    smoothedCrabStand[crabIdx] +=
      (rawStandTarget - smoothedCrabStand[crabIdx]) * dampRate;
    const standBlend = smoothedCrabStand[crabIdx];

    // 2. Unified Continuous Position & Bounce Kinematics (single integrated `crabGroovePhase` clock — never teleports!)
    const walkSpan =
      (28 * (0.45 + musicDrive * 0.72) * (1 - standBlend * 0.68)) * (1 - raveBlend) +
      44 * raveBlend;
    const scuttleX = baseX + Math.sin(crabGroovePhase * 0.38 + seed) * walkSpan;

    // Stilt-leg elevation + beat squat vs. chaotic high-flying Crab Rave jumping!
    const standPumpSquat =
      Math.abs(Math.sin(crabGroovePhase * 0.5 + seed * 0.2)) *
      (3.5 + subBass * 4.5 + beat * 3.0);
    const standLift = standBlend * (20 - standPumpSquat);

    const normalBounce =
      (1 - standBlend) *
      (Math.abs(Math.sin(crabGroovePhase * 0.5 + seed)) * (1.8 + audioAmp * 5.0) +
        beat * (2.2 + subBass * 4.0) +
        crabBand * 2.2);
    const raveJump =
      Math.abs(Math.sin(crabGroovePhase * 0.82 + seed * 0.35)) *
        (24 + subBass * 18 + beat * 10) +
      Math.abs(Math.cos(crabGroovePhase * 1.64 + seed)) * (6 + highEnergy * 8);
    const totalLift = standLift + normalBounce * (1 - raveBlend) + raveJump * raveBlend;
    const bounceY = baseY - totalLift * scale;

    const normalTilt =
      Math.sin(crabGroovePhase * 0.5 + seed) *
      (0.04 + audioAmp * 0.07) *
      (0.5 + standBlend * 0.5);
    const raveTilt =
      Math.sin(crabGroovePhase * 0.82 + seed * 0.5) * 0.26 +
      Math.cos(crabGroovePhase * 1.64 + seed) * 0.09;
    const bodyTilt = normalTilt * (1 - raveBlend) + raveTilt * raveBlend;

    const pumpActive = Math.max(raveBlend, standBlend, audioAmp * 0.42);
    const clawSnap =
      (0.22 +
        Math.abs(Math.sin(crabGroovePhase * (1.2 + raveBlend * 0.8) + seed)) *
          (0.5 + audioAmp * 0.4 + raveBlend * 0.35)) *
      Math.max(0.35, pumpActive);

    // High-speed 12 Hz neon body strobe index during Crab Rave (evoking classic reef3d body light strobing!)
    const strobeTick = Math.floor(timeSec * 13.5 + seed * 1.9);
    const isRaveStrobe = raveBlend > 0.12;
    const strobePalIdx = 4 + (strobeTick & 3);
    const raveFlash = isRaveStrobe ? 0.5 + 0.5 * Math.sin(timeSec * 28 + seed * 2.3) : 0;

    // Ground shadow anchored on the seabed (shrinks as the crab jumps high off the floor!)
    const shadowScale = Math.max(0.48, 1 - totalLift * 0.012);
    ctx.fillStyle = `rgba(0, 0, 0, ${(0.68 * shadowScale).toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(
      scuttleX,
      baseY + 18 * scale,
      34 * scale * shadowScale,
      8.5 * scale * shadowScale,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    ctx.save();
    ctx.translate(scuttleX, bounceY);
    ctx.rotate(bodyTilt);
    ctx.scale(scale, scale);

    // Pulsing neon rave body-strobe aura behind the crab during Crab Rave
    if (raveBlend > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const auraR = 34 + raveFlash * 12 + beat * 8;
      const auraGrad = ctx.createRadialGradient(0, -2, 3, 0, -2, auraR);
      auraGrad.addColorStop(
        0,
        rgbToCss(palette[7], (0.42 + raveFlash * 0.38) * raveBlend),
      );
      auraGrad.addColorStop(
        0.5,
        rgbToCss(palette[strobePalIdx], (0.28 + raveFlash * 0.24) * raveBlend),
      );
      auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = auraGrad;
      ctx.beginPath();
      ctx.arc(0, -2, auraR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 6 Articulated 2-segment beveled 3D crystal legs (3 per side)
    const legLit = palette[isRaveStrobe ? 5 + (strobeTick & 2) : standBlend > 0.4 ? 6 : 5];
    const legDark = palette[isRaveStrobe ? 3 + ((strobeTick + 1) & 3) : standBlend > 0.4 ? 4 : 3];
    const legWire = palette[isRaveStrobe && (strobeTick & 1) === 0 ? 6 : 7];
    for (const side of [-1, 1]) {
      for (let leg = 0; leg < 3; leg++) {
        const stepOsc = Math.sin(
          crabGroovePhase * (1.35 + raveBlend * 1.15) + leg * 1.4 + side,
        );
        const stepAmp =
          (2.2 + musicDrive * 3.2) * (1 - standBlend * 0.82) * (1 - raveBlend) +
          (8.5 + subBass * 4.5) * raveBlend;
        const step = stepOsc * stepAmp;
        const lx0 = side * (16 + leg * 4);
        const ly0 = 2 + leg * 3;
        const kneeX = side * (30 + leg * 6 - standBlend * 5.5 + raveBlend * 2.5);
        const kneeY = -6 + leg * 3 + standLift * 0.22 - raveBlend * 3.5 + step * 0.65;
        const footX = side * (39 + leg * 7 - standBlend * 8.5 + raveBlend * 4.0);
        const footY = 14 + leg * 2 + standLift + step;

        drawBeveledCrystalSegment(ctx, lx0, ly0, kneeX, kneeY, 2.5, 2.0, legLit, legDark, legWire);
        drawBeveledCrystalSegment(ctx, kneeX, kneeY, footX, footY, 2.0, 0.6, legLit, legDark, legWire);
      }
    }

    // Raytraced chrome core beneath the translucent 3D faceted carapace dome (strobes rapidly during Crab Rave!)
    ctx.save();
    ctx.scale(1.38, 0.84);
    drawBryceOrb(
      ctx,
      0,
      -2,
      18 + raveBlend * 3.5,
      palette,
      7,
      isRaveStrobe ? strobePalIdx : 5,
      0,
      0.72 + raveBlend * 0.26,
    );
    ctx.restore();

    // Rotate palette slots across the 3D carapace facets during Crab Rave for full-body neon strobing
    const carapacePalette = isRaveStrobe
      ? [
          palette[0],
          palette[2 + (strobeTick & 1)],
          palette[3 + (strobeTick & 3)],
          palette[4 + ((strobeTick + 1) & 3)],
          palette[5 + ((strobeTick + 2) & 2)],
          palette[6 + (strobeTick & 1)],
          palette[7],
          palette[7],
        ]
      : palette;

    projectAndDrawMesh3D(ctx, CRAB_CARAPACE_MESH_3D, {
      cx: 0,
      cy: 0,
      scale: 22 + raveBlend * (raveFlash * 2.2),
      rx: 0.46 - standBlend * 0.08 + raveBlend * Math.sin(crabGroovePhase + seed) * 0.12,
      ry: Math.cos(crabGroovePhase * (0.25 + raveBlend * 0.35) + seed) * (0.16 + audioAmp * 0.12 + raveBlend * 0.16),
      rz: 0,
      palette: carapacePalette,
      snapStep: 0,
      wireLineWidth: 0.88 + raveBlend * 0.22,
      alphaBoost: 1.0 + raveBlend * 0.32,
    });

    // Slender vector eye stalks topped with chrome specular spheres
    ctx.strokeStyle = rgbToCss(palette[isRaveStrobe ? 7 : 6], 0.92);
    ctx.lineWidth = 1.0;
    for (const ex of [-7.5, 7.5]) {
      const eyeBounce = raveBlend * Math.sin(crabGroovePhase * 1.5 + ex) * 2.2;
      ctx.beginPath();
      ctx.moveTo(ex, -11);
      ctx.lineTo(ex * 1.08, -18.5 - standBlend * 1.5 - eyeBounce);
      ctx.stroke();
      drawBryceOrb(
        ctx,
        ex * 1.08,
        -19.5 - standBlend * 1.5 - eyeBounce,
        2.8 + raveBlend * 0.6,
        palette,
        7,
        isRaveStrobe ? strobePalIdx : 5,
        0.88,
      );
    }

    // Articulated Arms + Snapping Beveled 3D Pincer Claws (with smooth vertical overhead "Claw Pumping"!)
    const tipPositions: [number, number][] = [];
    for (const side of [-1, 1]) {
      const pumpWave = Math.sin(
        crabGroovePhase * (1 + raveBlend * 0.5) + side * (0.45 * (1 - raveBlend)) + seed * 0.3,
      );
      const pumpReachY =
        pumpActive *
        (8 +
          raveBlend * 6 +
          (0.5 + 0.5 * pumpWave) * (9 + audioAmp * 8 + beat * 6 + crabBand * 4 + raveBlend * 7));
      const shoulderX = side * 17;
      const shoulderY = -7;
      const wristX = side * (20 + standBlend * 2 + raveBlend * 3 - pumpActive * pumpWave * 2.2);
      const wristY = -8 - pumpReachY;

      drawBeveledCrystalSegment(
        ctx,
        shoulderX,
        shoulderY,
        wristX,
        wristY,
        2.8,
        2.2,
        legLit,
        legDark,
        palette[7],
        0.62 + raveBlend * 0.2,
        0.38 + raveBlend * 0.15,
      );

      ctx.save();
      ctx.translate(wristX, wristY);
      const raveLift =
        side *
        (-0.32 -
          pumpActive * (0.82 + Math.sin(crabGroovePhase * (1 + raveBlend * 0.5) + side) * (0.24 + raveBlend * 0.18)) -
          (1 - pumpActive) * (beat * 0.22 + crabBand * 0.18));
      ctx.rotate(raveLift);

      const upTipX = side * 19;
      const upTipY = -12 - clawSnap * 9;
      const loTipX = side * 20;
      const loTipY = -4 + clawSnap * 7;
      const clawLit = palette[isRaveStrobe ? 6 + (strobeTick & 1) : standBlend > 0.5 ? 7 : 6];
      const clawDark = palette[isRaveStrobe ? strobePalIdx : 4];
      drawBeveledCrystalSegment(
        ctx,
        0,
        0,
        upTipX,
        upTipY,
        4.2,
        1.1,
        clawLit,
        clawDark,
        palette[7],
        0.68 + raveBlend * 0.22,
        0.42 + raveBlend * 0.18,
      );
      drawBeveledCrystalSegment(
        ctx,
        0,
        2,
        loTipX,
        loTipY,
        3.4,
        0.9,
        palette[isRaveStrobe ? strobePalIdx : standBlend > 0.5 ? 6 : 5],
        palette[3],
        palette[7],
        0.60 + raveBlend * 0.22,
        0.38 + raveBlend * 0.16,
      );

      const cosL = Math.cos(raveLift);
      const sinL = Math.sin(raveLift);
      tipPositions.push([
        wristX + upTipX * cosL - upTipY * sinL,
        wristY + upTipX * sinL + upTipY * cosL,
      ]);
      ctx.restore();
    }

    // Dual-bolt crackling neon lightning arcs between overhead pincer tips during Crab Rave
    if (raveBlend > 0.05 && tipPositions.length === 2) {
      const [pL, pR] = tipPositions;
      for (let bolt = 0; bolt < 2; bolt++) {
        ctx.beginPath();
        ctx.moveTo(pL[0], pL[1]);
        for (let sg = 1; sg < 7; sg++) {
          const u = sg / 7;
          const archY = -Math.sin(u * Math.PI) * (10 + sb[(sg + bolt * 3) & 15] * 15);
          const jitter =
            Math.sin(timeSec * (42 + bolt * 17) + sg * 3.1 + seed) * (4.5 + bolt * 2.5);
          ctx.lineTo(
            pL[0] + (pR[0] - pL[0]) * u,
            pL[1] + (pR[1] - pL[1]) * u + archY + jitter,
          );
        }
        ctx.lineTo(pR[0], pR[1]);
        ctx.strokeStyle = rgbToCss(
          palette[bolt === 0 ? strobePalIdx : 6],
          (bolt === 0 ? 0.58 : 0.42) * raveBlend,
        );
        ctx.lineWidth = bolt === 0 ? 3.2 : 2.0;
        ctx.stroke();
        ctx.strokeStyle = rgbToCss(palette[7], (bolt === 0 ? 0.96 : 0.78) * raveBlend);
        ctx.lineWidth = bolt === 0 ? 1.0 : 0.7;
        ctx.stroke();
      }
    }

    ctx.restore();
  };

  // Render 5 Reef Crabs in a depth-layered V-formation (back-to-front so foreground crabs overlap cleanly)
  const safeCrabY = Math.min(CANVAS_H - 34, cropBottomY - 24);
  drawBryceCrab(0, CANVAS_W * 0.11, safeCrabY - 38, 0.56, 1.05);
  drawBryceCrab(1, CANVAS_W * 0.89, safeCrabY - 36, 0.58, 5.25);
  drawBryceCrab(2, CANVAS_W * 0.26, safeCrabY - 20, 0.74, 2.1);
  drawBryceCrab(3, CANVAS_W * 0.74, safeCrabY - 18, 0.76, 4.2);
  drawBryceCrab(4, CANVAS_W * 0.5, safeCrabY, 1.02, 0);

  // 9. High-DPI Rising Crystalline Bubble Lyric Cascade (Sequential One-Shot Word Dispatch!)
  //    Each lyric line queues its words into fresh one-shot bubbles that release sequentially
  //    from the bottom in strict word order, rise once to the surface, and are never reused.
  const normalizedLyric = (activeLyric || '').trim().toUpperCase();
  if (!normalizedLyric) {
    lastQueuedLyricLine = '';
  } else if (normalizedLyric !== lastQueuedLyricLine) {
    lastQueuedLyricLine = normalizedLyric;
    const rawTokens = normalizedLyric.split(/\s+/).filter(Boolean);
    // Group single-character articles/pronouns with their following word so every bubble feels substantial,
    // while keeping each main word in its own sequentially dispatched bubble.
    const sequentialWords: string[] = [];
    for (let i = 0; i < rawTokens.length; i++) {
      if (rawTokens[i].length <= 1 && i + 1 < rawTokens.length) {
        sequentialWords.push(`${rawTokens[i]} ${rawTokens[i + 1]}`);
        i++;
      } else {
        sequentialWords.push(rawTokens[i]);
      }
    }

    // Stagger sequential word release (~0.30s apart, compressed slightly on long lines so all words release in time)
    const dispatchStep = Math.max(
      0.18,
      Math.min(0.34, 2.1 / Math.max(1, sequentialWords.length)),
    );
    for (let w = 0; w < sequentialWords.length; w++) {
      const seq = nextLyricBubbleSeq++;
      // Golden-ratio horizontal distribution across [0.16..0.84] of canvas width so consecutive bubbles
      // can appear anywhere horizontally without stacking on top of the immediately preceding bubble.
      const goldenU = (seq * 0.61803398875 + 0.19) % 1;
      const baseX = CANVAS_W * (0.16 + goldenU * 0.68);
      activeLyricBubbles.push({
        id: seq,
        text: sequentialWords[w],
        baseX,
        wobblePhase: seq * 1.73,
        spawnAt: timeSec + w * dispatchStep,
        duration: 4.1,
      });
    }
  }

  // Prune completed one-shot lyric bubbles that have finished rising to the top
  activeLyricBubbles = activeLyricBubbles.filter(
    (b) => timeSec < b.spawnAt + b.duration,
  );

  ctx.save();
  ctx.font = 'bold 11px "JetBrains Mono", "Fira Code", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const topLimitY = Math.max(36, cropTopY + 22);
  const botStartY = cropBottomY - 22;
  const travelSpanY = Math.max(60, botStartY - topLimitY);

  // 9a. Ambient non-lyric background water bubbles
  const numAmbientBubbles = 10;
  for (let b = 0; b < numAmbientBubbles; b++) {
    const cycle = (timeSec * 0.28 + b * (1 / numAmbientBubbles)) % 1;
    const by = botStartY - cycle * travelSpanY;
    const spreadX = ((b * 97 + 40) % (CANVAS_W - 80)) + 40;
    const bx = spreadX + Math.sin(timeSec * 1.4 + b * 1.3) * 12;
    const r = 6 + (b % 4) * 3;

    const bGrad = ctx.createRadialGradient(
      bx - r * 0.32,
      by - r * 0.28,
      Math.max(0.5, r * 0.08),
      bx,
      by,
      r,
    );
    bGrad.addColorStop(0, rgbToCss(palette[7], 0.38));
    bGrad.addColorStop(0.58, rgbToCss(palette[2], 0.26));
    bGrad.addColorStop(1, rgbToCss(palette[1], 0.14));

    ctx.fillStyle = bGrad;
    ctx.strokeStyle = rgbToCss(palette[5], 0.56);
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = bx + Math.cos(a) * r;
      const py = by + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    drawBryceOrb(ctx, bx - r * 0.44, by - r * 0.36, 1.3, palette, 7, 6, 0, 0.88);
  }

  // 9b. Sequentially dispatched one-shot lyric word bubbles
  for (let i = 0; i < activeLyricBubbles.length; i++) {
    const lb = activeLyricBubbles[i];
    if (timeSec < lb.spawnAt) continue; // Waiting for its sequential release slot!

    const progress = (timeSec - lb.spawnAt) / lb.duration;
    if (progress < 0 || progress >= 1) continue;

    // Smooth fade-in as the bubble releases at the bottom & gentle dissolve at the top surface
    const envAlpha =
      progress < 0.09
        ? progress / 0.09
        : progress > 0.86
          ? Math.max(0, (1 - progress) / 0.14)
          : 1;
    // Slight pop-scale on initial release
    const scalePop = progress < 0.08 ? 0.72 + (progress / 0.08) * 0.28 : 1;

    const by = botStartY - progress * travelSpanY;
    const bx =
      lb.baseX + Math.sin((timeSec - lb.spawnAt) * 1.65 + lb.wobblePhase) * 13;

    const r = Math.max(22, Math.min(54, lb.text.length * 3.8 + 13)) * scalePop;
    const ry = r * 0.62;

    const bGrad = ctx.createRadialGradient(
      bx - r * 0.32,
      by - ry * 0.28,
      Math.max(0.5, r * 0.08),
      bx,
      by,
      r,
    );
    bGrad.addColorStop(0, rgbToCss(palette[7], 0.24 * envAlpha));
    bGrad.addColorStop(0.58, rgbToCss(palette[2], 0.68 * envAlpha));
    bGrad.addColorStop(1, rgbToCss(palette[1], 0.78 * envAlpha));

    ctx.fillStyle = bGrad;
    ctx.strokeStyle = rgbToCss(palette[6], 0.92 * envAlpha);
    ctx.lineWidth = 0.95;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = bx + Math.cos(a) * r;
      const py = by + Math.sin(a) * ry;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Inner crystal bevel octagon
    ctx.strokeStyle = rgbToCss(palette[7], 0.36 * envAlpha);
    ctx.lineWidth = 0.65;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = bx + Math.cos(a) * r * 0.78;
      const py = by + Math.sin(a) * ry * 0.78;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();

    // Crisp specular crystal glint
    drawBryceOrb(
      ctx,
      bx - r * 0.44,
      by - ry * 0.36,
      2.1 * scalePop,
      palette,
      7,
      6,
      0,
      0.92 * envAlpha,
    );

    ctx.fillStyle = rgbToCss(palette[3], 0.85 * envAlpha);
    ctx.fillText(lb.text, bx + 0.8, by + 0.8);
    ctx.fillStyle = rgbToCss(palette[7], 0.98 * envAlpha);
    ctx.fillText(lb.text, bx, by);
  }
  ctx.restore();

  // 10. SoundCloud Timed Comment Pill
  drawMicroPartyCommentPill(
    ctx,
    activeComment,
    commentAvatarImg,
    palette,
    timeSec,
    beat,
    cropBottomY,
    false,
  );

  // 11. Caustic Prism Wipe Transition (`trans > 0.01`)
  if (trans > 0.01) {
    const wave = Math.sin(trans * Math.PI);
    const p = 1 - trans; // 0 -> 1 sweeping left to right
    const sweepX = p * (CANVAS_W + 240) - 120;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Three chromatic angled underwater caustic prism shafts sweeping across the reef
    for (let band = 0; band < 3; band++) {
      const bx = sweepX + (band - 1) * 34;
      const bw = 54 + band * 12;
      const grad = ctx.createLinearGradient(bx - bw, 0, bx + bw, 0);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(0.5, rgbToCss(palette[5 + band], 0.44 * wave));
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(bx - bw + 44, 0);
      ctx.lineTo(bx + bw + 44, 0);
      ctx.lineTo(bx + bw - 44, CANVAS_H);
      ctx.lineTo(bx - bw - 44, CANVAS_H);
      ctx.closePath();
      ctx.fill();
    }

    // Trailing pearlescent caustic bubbles stirred up by the prism wave
    for (let b = 0; b < 18; b++) {
      const bx = sweepX - 18 - (b * 13) % 95 + Math.sin(timeSec * 8 + b) * 6;
      const by = ((b * 47 + 22) % (CANVAS_H - 36)) + 18 - p * 34;
      const br = 2.5 + (b % 4) * 1.6;
      ctx.strokeStyle = rgbToCss(palette[7], 0.65 * wave);
      ctx.fillStyle = rgbToCss(palette[6], 0.22 * wave);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}
