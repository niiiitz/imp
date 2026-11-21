import {
  COFFIN_MESH_3D,
  projectAndDrawMesh3D,
} from './lowPoly3d';
import {
  CANVAS_H,
  CANVAS_W,
  lerpRgb,
  rgbToCss,
  splitIntoBalancedLines,
  type RgbTuple,
  type SceneRenderContext,
} from './types';

type MonsterKind = 'dracula' | 'mummy' | 'frankenstein' | 'death' | 'werewolf';
type SubWeaponKind = 'axe' | 'knife' | 'cross' | 'holy_water';
type BossPhase = 'banter' | 'throwing' | 'imploding' | 'spawning';

interface MonsterDefinition {
  kind: MonsterKind;
  name: string;
  accentRgb: RgbTuple;
  exchanges: [string, string][]; // [monsterLine, heroRetort]
}

const MONSTER_ROSTER: MonsterDefinition[] = [
  {
    kind: 'dracula',
    name: 'COUNT DRACULA',
    accentRgb: [220, 38, 38],
    exchanges: [
      ['What is a listener? A miserable little pile of secrets!', 'Enough talk! Have at you!'],
      ['Die, silence! You do not belong in this hall!', 'My stereo feeds on justice, Count!'],
      ['Behold my cathedral symphony of eternal night!', 'Your castle acoustics are ridiculous!'],
      ['Your whip cannot silence my midnight organ!', 'Let us see how you handle a sub-weapon!'],
    ],
  },
  {
    kind: 'mummy',
    name: 'THE MUMMY',
    accentRgb: [217, 119, 6],
    exchanges: [
      ['Three thousand years asleep... and NOW you drop the bass?!', 'Stay wrapped up, dusty!'],
      ['Unravel my curse and feel the sands of time!', 'You are just an angry roll of linen!'],
      ['Pharaoh’s tomb was never nearly this loud!', 'Consider this an overdue wake-up call!'],
      ['My sarcophagus trembles with ancient wrath!', 'Back into the crypt with you!'],
    ],
  },
  {
    kind: 'frankenstein',
    name: 'FRANKENSTEIN',
    accentRgb: [34, 197, 94],
    exchanges: [
      ['FIRE BAD... BUT THIS RHYTHM... VERY GOOD!!', 'Easy there, bolts-for-brains!'],
      ['LIGHTNING MAKES MY NECK BOLTS TINGLE!', 'Hold still—I have a shock of my own!'],
      ['THE DOCTOR WIRED ME FOR MAXIMUM VOLUME!', 'Shame he forgot to wire your reflexes!'],
      ['STOMP! STOMP! SHAKE THE CATHEDRAL STONE!', 'Time to pull your plug, monster!'],
    ],
  },
  {
    kind: 'death',
    name: 'DEATH',
    accentRgb: [168, 85, 247],
    exchanges: [
      ['Ah, the hunter arrives... right on the downbeat.', 'Not today, Grim—this track is not over!'],
      ['All playlists eventually fade into silence...', 'Not while my whip still cracks!'],
      ['My scythe harvests every stray tempo!', 'Take your cloak and float back to the abyss!'],
      ['Even your finest bassline belongs to the void!', 'Let us put that theory to the test!'],
    ],
  },
  {
    kind: 'werewolf',
    name: 'WEREWOLF',
    accentRgb: [245, 158, 11],
    exchanges: [
      ['AWOOOOO!! The blood moon demands MAX VOLUME!', 'Down, boy—sit and stay!'],
      ['My claws shred faster than any solo!', 'Hope you like silver and holy water!'],
      ['You reek of garlic and 16-bit nostalgia!', 'And you smell like wet crypt fur!'],
      ['No silver bullet can silence this howl!', 'Good thing I brought an axe instead!'],
    ],
  },
];

const SUB_WEAPONS: SubWeaponKind[] = ['axe', 'knife', 'cross', 'holy_water'];

interface MedusaHeadEntity {
  active: boolean;
  x: number;
  baseY: number;
  dir: 1 | -1;
  speed: number;
  phase: number;
  amp: number;
}

interface SwarmBatEntity {
  angle: number;
  radialSpeed: number;
  z: number; // 1.0 (far nave) -> 0.04 (right in front of camera)
  wingPhase: number;
  speedZ: number;
}

interface RoostBatEntity {
  mode: 'perched' | 'swooping';
  perchU: number;
  targetU: number;
  flightT: number;
  flightDur: number;
  dipDepth: number;
  waitTimer: number;
  wingPhase: number;
  scale: number;
}

/**
 * Evaluates a perch coordinate `(x, y)` along the upper pointed cathedral vault arches
 * (left arch `u ∈ [0, 0.5]`, right arch `u ∈ [0.5, 1.0]`).
 */
function getArchPerchPoint(u: number): [number, number] {
  const cx = CANVAS_W * 0.5;
  const clamped = Math.max(0.06, Math.min(0.94, u));
  if (clamped < 0.5) {
    const t = clamped * 2;
    const inv = 1 - t;
    const x = inv * inv * 54 + 2 * inv * t * (cx * 0.55) + t * t * cx;
    const y = inv * inv * 88 + 2 * inv * t * 6 + t * t * 14;
    return [x, y];
  } else {
    const t = (clamped - 0.5) * 2;
    const inv = 1 - t;
    const x = inv * inv * cx + 2 * inv * t * (CANVAS_W - cx * 0.55) + t * t * (CANVAS_W - 54);
    const y = inv * inv * 14 + 2 * inv * t * 6 + t * t * 88;
    return [x, y];
  }
}

// Perch slots along the top gothic arches (avoiding the upper-right Boss Portrait bay)
const ARCH_PERCH_SLOTS = [0.10, 0.16, 0.23, 0.30, 0.37, 0.43, 0.56, 0.62, 0.68, 0.74];

function createInitialRoostBats(): RoostBatEntity[] {
  return ARCH_PERCH_SLOTS.map((u, idx) => ({
    mode: 'perched',
    perchU: u,
    targetU: u,
    flightT: 0,
    flightDur: 1.5,
    dipDepth: 72 + (idx % 3) * 18,
    waitTimer: 1.2 + (idx * 1.15) % 6.5,
    wingPhase: idx * 1.7,
    scale: 0.64 + (idx % 3) * 0.1,
  }));
}

const sanctumState = {
  initialized: false,
  lastTimeSec: -1,
  lastTrackKey: '',
  bossIndex: 0,
  weaponIndex: 0,
  phase: 'banter' as BossPhase,
  phaseTimer: 0,
  bossElapsed: 0,
  speaker: 'monster' as 'monster' | 'hero',
  banterPairIdx: 0,
  banterTurnTimer: 0,
  exchangeCount: 0,
  lastLyricSeen: '',
  linesSpokenInTurn: 0,
  turnLines: [] as string[],
  lastLyricChangeAt: -1,
  lyricGapSec: 0,
  lineReveal: 1,
  throwAnimT: 0,
  holyFlameTimer: 0,
  medusaCooldown: 6.5,
  medusas: [
    { active: false, x: 0, baseY: 140, dir: -1 as 1 | -1, speed: 78, phase: 0, amp: 28 },
    { active: false, x: 0, baseY: 175, dir: 1 as 1 | -1, speed: 70, phase: 2.2, amp: 24 },
  ] as MedusaHeadEntity[],
  roostBats: createInitialRoostBats(),
  roostSeed: 1,
  swarmActiveUntil: -10,
  lastSwarmAt: -18,
  swarmBats: [] as SwarmBatEntity[],
};

function resetSanctumState(trackKey: string): void {
  sanctumState.initialized = true;
  sanctumState.lastTrackKey = trackKey;
  sanctumState.bossIndex = 0;
  sanctumState.weaponIndex = 0;
  sanctumState.phase = 'banter';
  sanctumState.phaseTimer = 0;
  sanctumState.bossElapsed = 0;
  sanctumState.speaker = 'monster';
  sanctumState.banterPairIdx = 0;
  sanctumState.banterTurnTimer = 0;
  sanctumState.exchangeCount = 0;
  sanctumState.lastLyricSeen = '';
  sanctumState.linesSpokenInTurn = 0;
  sanctumState.turnLines = [];
  sanctumState.lastLyricChangeAt = -1;
  sanctumState.lyricGapSec = 0;
  sanctumState.lineReveal = 0.2;
  sanctumState.throwAnimT = 0;
  sanctumState.holyFlameTimer = 0;
  sanctumState.medusaCooldown = 5.5;
  for (const m of sanctumState.medusas) m.active = false;
  sanctumState.roostBats = createInitialRoostBats();
  sanctumState.roostSeed = 1;
  sanctumState.swarmActiveUntil = -10;
  sanctumState.lastSwarmAt = -14;
  sanctumState.swarmBats = [];
}

function triggerBatCameraSwarm(timeSec: number): void {
  sanctumState.lastSwarmAt = timeSec;
  sanctumState.swarmActiveUntil = timeSec + 3.1;
  sanctumState.swarmBats = [];
  // Big dramatic bass-drop colony rush (52 bats bursting out of the rafters toward the viewer!)
  const count = 52;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + ((i * 1.618) % 0.7);
    sanctumState.swarmBats.push({
      angle,
      radialSpeed: 0.62 + (i % 6) * 0.14,
      z: 0.72 + (i % 11) * 0.11,
      wingPhase: i * 1.07,
      speedZ: 0.48 + (i % 5) * 0.11,
    });
  }
  // Scatter perched arch bats into swooping arcs as the drop hits!
  for (let i = 0; i < sanctumState.roostBats.length; i++) {
    const rb = sanctumState.roostBats[i];
    if (rb.mode === 'perched') {
      rb.mode = 'swooping';
      rb.flightT = 0;
      rb.flightDur = 1.35 + (i % 4) * 0.22;
      rb.dipDepth = 82 + (i % 3) * 24;
      rb.targetU = ARCH_PERCH_SLOTS[(i + 4) % ARCH_PERCH_SLOTS.length];
    }
  }
}

/**
 * Draws a crisp 16-bit dark-fantasy Buff Barbarian Hero (loincloth, spiked fur pauldrons,
 * muscular bare chest with subtle chest hair, animated cape, coiled leather whip & throw pose).
 */
function drawBarbarianHero(
  ctx: CanvasRenderingContext2D,
  x: number,
  footY: number,
  timeSec: number,
  beat: number,
  midEnergy: number,
  throwT: number, // 0..1 when tossing a sub-weapon
  isSpeaking: boolean,
  palette: RgbTuple[],
): void {
  ctx.save();
  ctx.translate(x, footY);

  const breath = Math.sin(timeSec * 3.1) * 1.5;
  const throwRecoil = throwT > 0 ? Math.sin(Math.min(1, throwT * 1.8) * Math.PI) : 0;
  const capeColor = lerpRgb(palette[5], [185, 28, 28], 0.55);
  const armorHighlight = lerpRgb(palette[6], [245, 198, 108], 0.55);
  const steelColor = lerpRgb(palette[7], [226, 232, 240], 0.6);
  const skinBase = '#e3a577';
  const skinShade = '#b9784c';
  const hairBrown = '#3b1c0a';

  // Subtle heroic aura when speaking
  if (isSpeaking) {
    const auraGrad = ctx.createRadialGradient(0, -34, 4, 0, -34, 46);
    auraGrad.addColorStop(0, rgbToCss(palette[6], 0.30 + beat * 0.14));
    auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = auraGrad;
    ctx.beginPath();
    ctx.arc(0, -34, 46, 0, Math.PI * 2);
    ctx.fill();
  }

  // 1. Flowing Barbarian Cape billowing to the left
  const capeFlutter = Math.sin(timeSec * 5.2) * (4.5 + midEnergy * 4) + throwRecoil * 8;
  ctx.fillStyle = rgbToCss(capeColor, 0.94);
  ctx.strokeStyle = '#090b12';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-6, -49 + breath);
  ctx.quadraticCurveTo(-22 - capeFlutter * 0.5, -30, -30 - capeFlutter, -5);
  ctx.lineTo(-15 - capeFlutter * 0.5, -2);
  ctx.lineTo(-5, -18);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 2. Muscular Bare Barbarian Thighs & Fur-Cuffed Leather Boots
  ctx.fillStyle = skinBase;
  ctx.strokeStyle = '#451a03';
  ctx.lineWidth = 1.25;
  // Back muscular leg
  ctx.beginPath();
  ctx.moveTo(-6, -24 + breath * 0.4);
  ctx.lineTo(-14, -10);
  ctx.lineTo(-15, -7);
  ctx.lineTo(-6, -7);
  ctx.lineTo(-4, -11);
  ctx.lineTo(1, -22 + breath * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Front muscular leg
  ctx.beginPath();
  ctx.moveTo(2, -24 + breath * 0.4);
  ctx.lineTo(12, -11);
  ctx.lineTo(15, -7);
  ctx.lineTo(6, -7);
  ctx.lineTo(4, -11);
  ctx.lineTo(-2, -22 + breath * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Subtle quad shading + barbarian leg hair ticks
  ctx.strokeStyle = skinShade;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-9, -18);
  ctx.lineTo(-11, -11);
  ctx.moveTo(6, -18);
  ctx.lineTo(9, -11);
  ctx.stroke();
  ctx.strokeStyle = hairBrown;
  ctx.lineWidth = 0.85;
  ctx.beginPath();
  ctx.moveTo(-11, -14);
  ctx.lineTo(-12.5, -12.5);
  ctx.moveTo(9, -14);
  ctx.lineTo(10.5, -12.5);
  ctx.stroke();

  // Heavy Fur-Cuffed Leather Barbarian Boots
  ctx.fillStyle = '#5c280b';
  ctx.strokeStyle = '#1c0f07';
  ctx.lineWidth = 1.2;
  ctx.fillRect(-16, -9, 10, 9);
  ctx.strokeRect(-16, -9, 10, 9);
  ctx.fillRect(6, -9, 10, 9);
  ctx.strokeRect(6, -9, 10, 9);
  // Shaggy wolf-fur boot cuffs
  ctx.fillStyle = '#cbb793';
  ctx.beginPath();
  ctx.roundRect(-16.5, -11.5, 11, 3.5, 1.5);
  ctx.roundRect(5.5, -11.5, 11, 3.5, 1.5);
  ctx.fill();

  // 3. Buff Broad-Shouldered Bare Chest, Sculpted Abs & Subtle Chest Hair!
  ctx.fillStyle = skinBase;
  ctx.strokeStyle = '#451a03';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(-12, -47 + breath);
  ctx.lineTo(12, -47 + breath);
  ctx.lineTo(9, -35 + breath * 0.7);
  ctx.lineTo(7, -23 + breath * 0.5);
  ctx.lineTo(-7, -23 + breath * 0.5);
  ctx.lineTo(-9, -35 + breath * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Sculpted Pectoral & 6-Pack Ab Shading
  ctx.strokeStyle = skinShade;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  // Pec underside curves
  ctx.moveTo(-8, -38 + breath);
  ctx.quadraticCurveTo(-4, -36 + breath, -0.5, -38.5 + breath);
  ctx.moveTo(0.5, -38.5 + breath);
  ctx.quadraticCurveTo(4.5, -36 + breath, 8.5, -38 + breath);
  // Sternum & ab midline
  ctx.moveTo(0, -41 + breath);
  ctx.lineTo(0, -27 + breath * 0.5);
  // Ab horizontal notches
  ctx.moveTo(-4, -33 + breath * 0.7);
  ctx.lineTo(4, -33 + breath * 0.7);
  ctx.moveTo(-3.5, -29.5 + breath * 0.6);
  ctx.lineTo(3.5, -29.5 + breath * 0.6);
  ctx.stroke();

  // Classic hairy barbarian chest hair tufts & happy trail!
  ctx.strokeStyle = hairBrown;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  // Left & right pec tufts
  ctx.moveTo(-5, -42 + breath);
  ctx.lineTo(-3, -40 + breath);
  ctx.moveTo(-2, -41.5 + breath);
  ctx.lineTo(-0.5, -39.5 + breath);
  ctx.moveTo(1.5, -42 + breath);
  ctx.lineTo(3.5, -40 + breath);
  ctx.moveTo(4.5, -41 + breath);
  ctx.lineTo(6, -39.5 + breath);
  ctx.moveTo(-3, -39.5 + breath);
  ctx.lineTo(-1, -38 + breath);
  ctx.moveTo(1, -39.5 + breath);
  ctx.lineTo(3, -38 + breath);
  // Subtle belly hair trail
  ctx.moveTo(-1, -32 + breath * 0.6);
  ctx.lineTo(1, -30.5 + breath * 0.6);
  ctx.moveTo(0.5, -29 + breath * 0.5);
  ctx.lineTo(-0.5, -27.2 + breath * 0.5);
  ctx.stroke();

  // Single Diagonal Studded Leather Harness Strap (keeps buff chest clearly visible)
  ctx.strokeStyle = '#6b3410';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-10, -46 + breath);
  ctx.lineTo(7, -25 + breath * 0.5);
  ctx.stroke();
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.arc(-2, -36 + breath * 0.8, 2.0, 0, Math.PI * 2);
  ctx.fill();

  // 4. Fur-Trimmed Leather Loincloth & Ornate Bronze Barbarian Belt
  // Shaggy wolf-fur hip pelt
  ctx.fillStyle = '#cbb793';
  ctx.strokeStyle = '#5c3d1e';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-10, -25 + breath * 0.5);
  ctx.lineTo(10, -25 + breath * 0.5);
  ctx.lineTo(11, -18 + breath * 0.3);
  ctx.lineTo(6, -20 + breath * 0.3);
  ctx.lineTo(3, -17 + breath * 0.3);
  ctx.lineTo(-3, -17 + breath * 0.3);
  ctx.lineTo(-6, -20 + breath * 0.3);
  ctx.lineTo(-11, -18 + breath * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Center leather loincloth flap hanging down between thighs
  ctx.fillStyle = '#78350f';
  ctx.strokeStyle = '#291205';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-5, -23 + breath * 0.5);
  ctx.lineTo(5, -23 + breath * 0.5);
  ctx.lineTo(4, -12);
  ctx.lineTo(0, -10);
  ctx.lineTo(-4, -12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Thick Barbarian Belt + Golden Medallion Buckle
  ctx.fillStyle = '#92400e';
  ctx.fillRect(-9.5, -26.5 + breath * 0.5, 19, 4.5);
  ctx.fillStyle = '#facc15';
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.arc(0, -24.2 + breath * 0.5, 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 5. Heavy Spiked & Fur-Lined Barbarian Pauldrons
  for (const side of [-1, 1]) {
    const px = side * 11.5;
    const py = -45.5 + breath;
    // Fur under-trim
    ctx.fillStyle = '#cbb793';
    ctx.beginPath();
    ctx.arc(px, py + 1.5, 7.2, 0, Math.PI * 2);
    ctx.fill();
    // Forged bronze/iron dome pauldron
    ctx.fillStyle = '#78350f';
    ctx.strokeStyle = rgbToCss(armorHighlight, 0.92);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(px, py, 6.4, Math.PI * 0.95, Math.PI * 2.15);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Iconic barbarian shoulder spike
    ctx.fillStyle = rgbToCss(steelColor, 0.96);
    ctx.beginPath();
    ctx.moveTo(px + side * 2, py - 5);
    ctx.lineTo(px + side * 6.5, py - 11.5);
    ctx.lineTo(px + side * 5.5, py - 3);
    ctx.closePath();
    ctx.fill();
  }

  // 6. Head, Wild Barbarian Mane & Crimson Headband (facing right toward Boss Portrait)
  const headY = -56 + breath;
  // Wild flowing barbarian back hair
  ctx.fillStyle = hairBrown;
  ctx.beginPath();
  ctx.moveTo(-6, headY - 5);
  ctx.lineTo(-17 - capeFlutter * 0.25, headY + 1);
  ctx.lineTo(-14 - capeFlutter * 0.2, headY + 8);
  ctx.lineTo(-9, headY + 11);
  ctx.lineTo(-3, headY + 4);
  ctx.closePath();
  ctx.fill();

  // Rugged chiseled face
  ctx.fillStyle = skinBase;
  ctx.strokeStyle = '#451a03';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(-5.5, headY - 6, 12.5, 13, 3.8);
  ctx.fill();
  ctx.stroke();

  // Determined brow, eye & slight barbarian stubble/jawline
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(2, headY - 2, 2.6, 2);
  ctx.fillStyle = 'rgba(59, 28, 10, 0.32)';
  ctx.fillRect(1, headY + 3, 5.5, 3);

  // Iconic Crimson Headband + Fluttering Tail
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(-6, headY - 5, 13.5, 3);
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(-6, headY - 3.5);
  ctx.quadraticCurveTo(
    -15,
    headY - 5 + Math.sin(timeSec * 7) * 2.5,
    -21,
    headY - 1 + Math.cos(timeSec * 6) * 2.5,
  );
  ctx.stroke();

  // 7. Off-Hand Muscular Bicep on Hip + Throwing / Whip Arm with Leather Bracer
  // Left muscular bicep resting heroically near belt
  ctx.strokeStyle = skinBase;
  ctx.lineWidth = 5.0;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-11, -42 + breath);
  ctx.lineTo(-15, -33 + breath * 0.7);
  ctx.lineTo(-10, -25 + breath * 0.5);
  ctx.stroke();
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 5.2;
  ctx.beginPath();
  ctx.moveTo(-14, -30 + breath * 0.6);
  ctx.lineTo(-11, -26 + breath * 0.5);
  ctx.stroke();

  // Right muscular throwing/whip arm
  const armAngle =
    throwRecoil > 0.05
      ? -0.95 + throwRecoil * 1.15
      : 0.28 + Math.sin(timeSec * 3.1) * 0.08 - beat * 0.22;
  const shoulderX = 10;
  const shoulderY = -42 + breath;
  const handX = shoulderX + Math.cos(armAngle) * 16;
  const handY = shoulderY + Math.sin(armAngle) * 16;

  // Muscular bare bicep + forearm
  ctx.strokeStyle = skinBase;
  ctx.lineWidth = 5.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(shoulderX, shoulderY);
  ctx.lineTo(handX, handY);
  ctx.stroke();

  // Studded leather wrist bracer
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 5.4;
  ctx.beginPath();
  ctx.moveTo(shoulderX + (handX - shoulderX) * 0.52, shoulderY + (handY - shoulderY) * 0.52);
  ctx.lineTo(handX, handY);
  ctx.stroke();

  // Whip Handle
  ctx.strokeStyle = '#5c280b';
  ctx.lineWidth = 2.8;
  ctx.beginPath();
  ctx.moveTo(handX, handY);
  ctx.lineTo(handX + 6, handY + 2);
  ctx.stroke();

  // Animated Chain-Whip Tail (sways in idle; snaps forward & sparks on strong beats!)
  const whipCrack = throwRecoil > 0.1 ? 0 : Math.max(0, (beat - 0.48) * 1.9);
  const whipStartX = handX + 5;
  const whipStartY = handY + 2;
  const segs = 10;
  ctx.strokeStyle = rgbToCss(armorHighlight, 0.92);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(whipStartX, whipStartY);
  let tipX = whipStartX;
  let tipY = whipStartY;
  for (let i = 1; i <= segs; i++) {
    const u = i / segs;
    const reachX = whipStartX + u * (16 + whipCrack * 28);
    const droopY =
      whipStartY +
      Math.sin(u * Math.PI * 0.85) * (18 * (1 - whipCrack * 0.72)) +
      Math.sin(timeSec * 6.5 - u * 4.2) * (3.5 + beat * 3.2) * u;
    tipX = reachX;
    tipY = droopY;
    ctx.lineTo(tipX, tipY);
  }
  ctx.stroke();

  // Morning-Star Whip Tip + Beat Spark
  ctx.fillStyle = rgbToCss(steelColor, 0.98);
  ctx.beginPath();
  ctx.arc(tipX, tipY, 2.5, 0, Math.PI * 2);
  ctx.fill();
  if (whipCrack > 0.25) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(254, 240, 138, 0.9)';
    ctx.lineWidth = 1.4;
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2 + timeSec * 9;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(a) * (6 + whipCrack * 7), tipY + Math.sin(a) * (6 + whipCrack * 7));
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Draws one of the 5 distinct procedural 16-bit dark-fantasy Monster Boss portraits
 * inside a centered local coordinate space (-44..+44 x -44..+44), facing LEFT toward the Hero!
 */
function drawMonsterPortraitArt(
  ctx: CanvasRenderingContext2D,
  kind: MonsterKind,
  timeSec: number,
  beat: number,
  subBass: number,
  palette: RgbTuple[],
): void {
  const bob = Math.sin(timeSec * 2.6) * 1.8;

  // Dramatic gothic portrait backdrop gradient
  const bg = ctx.createRadialGradient(0, -6, 6, 0, 0, 56);
  if (kind === 'dracula') {
    bg.addColorStop(0, 'rgba(127, 29, 29, 0.92)');
    bg.addColorStop(0.65, 'rgba(24, 10, 22, 0.96)');
    bg.addColorStop(1, '#06050b');
  } else if (kind === 'mummy') {
    bg.addColorStop(0, 'rgba(146, 64, 14, 0.88)');
    bg.addColorStop(0.65, 'rgba(28, 19, 10, 0.96)');
    bg.addColorStop(1, '#080604');
  } else if (kind === 'frankenstein') {
    bg.addColorStop(0, 'rgba(21, 94, 117, 0.88)');
    bg.addColorStop(0.65, 'rgba(11, 27, 26, 0.96)');
    bg.addColorStop(1, '#040a0a');
  } else if (kind === 'death') {
    bg.addColorStop(0, 'rgba(88, 28, 135, 0.9)');
    bg.addColorStop(0.65, 'rgba(14, 10, 32, 0.96)');
    bg.addColorStop(1, '#04030c');
  } else {
    bg.addColorStop(0, 'rgba(153, 27, 27, 0.85)');
    bg.addColorStop(0.65, 'rgba(15, 23, 42, 0.96)');
    bg.addColorStop(1, '#05070e');
  }
  ctx.fillStyle = bg;
  ctx.fillRect(-46, -46, 92, 92);

  ctx.save();
  ctx.translate(0, bob);

  if (kind === 'dracula') {
    // Crimson-lined towering upturned Dracula collar
    ctx.fillStyle = '#090910';
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-34, 46);
    ctx.lineTo(-28, -14);
    ctx.lineTo(-10, 4);
    ctx.lineTo(14, 4);
    ctx.lineTo(30, -18);
    ctx.lineTo(36, 46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Inner crimson collar lining
    ctx.fillStyle = '#991b1b';
    ctx.beginPath();
    ctx.moveTo(-24, -10);
    ctx.lineTo(-10, 8);
    ctx.lineTo(14, 8);
    ctx.lineTo(26, -13);
    ctx.lineTo(22, 26);
    ctx.lineTo(-20, 26);
    ctx.closePath();
    ctx.fill();

    // Aristocratic white cravat & ruby brooch
    ctx.fillStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.moveTo(-7, 22);
    ctx.lineTo(5, 22);
    ctx.lineTo(2, 44);
    ctx.lineTo(-5, 44);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(-1, 26, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Pale vampiric face (3/4 view facing left)
    ctx.fillStyle = '#e2e8f0';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-16, -20);
    ctx.lineTo(16, -22);
    ctx.lineTo(18, 8);
    ctx.lineTo(2, 22);
    ctx.lineTo(-14, 14);
    ctx.lineTo(-18, -2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Widow's peak slicked-back black hair
    ctx.fillStyle = '#09090f';
    ctx.beginPath();
    ctx.moveTo(-18, -10);
    ctx.quadraticCurveTo(-18, -35, 2, -35);
    ctx.quadraticCurveTo(22, -34, 21, -8);
    ctx.lineTo(14, -14);
    ctx.lineTo(-2, -16);
    ctx.lineTo(-7, -10); // Widow's peak point
    ctx.lineTo(-12, -16);
    ctx.closePath();
    ctx.fill();

    // Glowing ruby vampire eyes + stern brows
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-14, -7);
    ctx.lineTo(-5, -4);
    ctx.moveTo(0, -4);
    ctx.lineTo(10, -7);
    ctx.stroke();

    ctx.fillStyle = `rgba(248, 113, 113, ${(0.8 + beat * 0.2).toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(-9, -2, 3.2, 1.8, 0, 0, Math.PI * 2);
    ctx.ellipse(4, -2, 3.4, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();

    // Sinister smirk + twin white fangs
    ctx.strokeStyle = '#450a0a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-10, 10);
    ctx.quadraticCurveTo(-2, 13, 6, 9);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-8, 10);
    ctx.lineTo(-6.5, 15.5);
    ctx.lineTo(-5, 10.5);
    ctx.moveTo(1, 10.5);
    ctx.lineTo(2.5, 15.5);
    ctx.lineTo(4, 10);
    ctx.fill();
  } else if (kind === 'mummy') {
    // Ancient Egyptian gold & lapis collar
    ctx.fillStyle = '#b45309';
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-34, 46);
    ctx.quadraticCurveTo(0, 16, 34, 46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 44, 24, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();

    // Bandaged cranium & jaw silhouette
    ctx.fillStyle = '#d6c7a9';
    ctx.strokeStyle = '#574632';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(-19, -31, 38, 52, 15);
    ctx.fill();
    ctx.stroke();

    // Layered diagonal linen bandage strips
    ctx.strokeStyle = '#6b573e';
    ctx.lineWidth = 1.6;
    const wraps: [number, number, number, number][] = [
      [-18, -22, 18, -16],
      [-19, -13, 19, -19],
      [-19, 3, 19, 8],
      [-18, 13, 18, 8],
      [-14, 18, 16, 22],
    ];
    for (const [x1, y1, x2, y2] of wraps) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Dark recessed eye slit between bandages + blazing amber eyes
    ctx.fillStyle = '#140c06';
    ctx.beginPath();
    ctx.roundRect(-16, -9, 30, 10, 3);
    ctx.fill();

    const eyeGlow = 0.72 + beat * 0.28;
    ctx.fillStyle = `rgba(251, 191, 36, ${eyeGlow.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(-8, -4, 3.2, 0, Math.PI * 2);
    ctx.arc(5, -4, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fef9c3';
    ctx.fillRect(-9, -5, 2, 2);
    ctx.fillRect(4, -5, 2, 2);

    // Trailing loose fluttering bandage strip on the right
    const flutter = Math.sin(timeSec * 4.8) * 4;
    ctx.fillStyle = '#cbb996';
    ctx.strokeStyle = '#574632';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(18, -14);
    ctx.quadraticCurveTo(30, -10 + flutter, 38, -2 + flutter * 1.2);
    ctx.lineTo(36, 5 + flutter * 1.2);
    ctx.quadraticCurveTo(28, -3 + flutter, 18, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (kind === 'frankenstein') {
    // Broad tattered coat shoulders
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-38, 46);
    ctx.lineTo(-30, 22);
    ctx.lineTo(30, 22);
    ctx.lineTo(38, 46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Thick neck + twin metallic neck bolts!
    ctx.fillStyle = '#4d7c5d';
    ctx.fillRect(-12, 12, 24, 16);
    ctx.fillStyle = '#94a3b8';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.2;
    ctx.fillRect(-23, 15, 11, 6);
    ctx.strokeRect(-23, 15, 11, 6);
    ctx.fillRect(12, 15, 11, 6);
    ctx.strokeRect(12, 15, 11, 6);

    // Iconic flat-topped rectangular skull
    ctx.fillStyle = '#659672';
    ctx.strokeStyle = '#143321';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-20, -30);
    ctx.lineTo(20, -30);
    ctx.lineTo(21, 8);
    ctx.lineTo(13, 18);
    ctx.lineTo(-15, 18);
    ctx.lineTo(-21, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Jagged black flat-top hair
    ctx.fillStyle = '#090c10';
    ctx.beginPath();
    ctx.moveTo(-21, -20);
    ctx.lineTo(-21, -33);
    ctx.lineTo(21, -33);
    ctx.lineTo(21, -18);
    ctx.lineTo(13, -24);
    ctx.lineTo(6, -19);
    ctx.lineTo(-2, -24);
    ctx.lineTo(-10, -19);
    ctx.lineTo(-16, -24);
    ctx.closePath();
    ctx.fill();

    // Forehead scar & stitches
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-12, -14);
    ctx.lineTo(8, -16);
    for (let sx = -10; sx <= 6; sx += 4) {
      ctx.moveTo(sx, -17.5);
      ctx.lineTo(sx, -12.5);
    }
    ctx.stroke();

    // Heavy brow ridge & intense glowing eyes
    ctx.fillStyle = '#1e3a29';
    ctx.fillRect(-17, -8, 30, 5);
    ctx.fillStyle = '#fef08a';
    ctx.fillRect(-12, -3, 5, 3.2);
    ctx.fillRect(2, -3, 5, 3.2);

    // Grim jaw clamp mouth
    ctx.strokeStyle = '#143321';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, 10);
    ctx.lineTo(8, 10);
    ctx.stroke();

    // Crackling lightning arcs off the neck bolts on beats!
    if (beat > 0.32 || subBass > 0.45) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#7dd3fc';
      ctx.lineWidth = 1.6;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 22, 18);
        ctx.lineTo(side * 31, 10 + Math.sin(timeSec * 33 + side) * 5);
        ctx.lineTo(side * 38, 2 + Math.cos(timeSec * 29) * 6);
        ctx.stroke();
      }
      ctx.restore();
    }
  } else if (kind === 'death') {
    // Gleaming curved Silver Scythe behind the hood
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(26, 44);
    ctx.lineTo(14, -36);
    ctx.stroke();
    ctx.fillStyle = '#cbd5e1';
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(14, -36);
    ctx.quadraticCurveTo(-24, -44, -38, -14);
    ctx.quadraticCurveTo(-18, -28, 14, -24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Deep tattered obsidian cowl/hood
    ctx.fillStyle = '#0c0a1d';
    ctx.strokeStyle = '#7e22ce';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-34, 46);
    ctx.quadraticCurveTo(-30, -28, 0, -34);
    ctx.quadraticCurveTo(30, -28, 34, 46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Shadowed hood interior
    ctx.fillStyle = '#030208';
    ctx.beginPath();
    ctx.ellipse(-2, -4, 19, 24, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ivory Grim Skull Face
    ctx.fillStyle = '#e2e8f0';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(-2, -10, 14, Math.PI * 0.9, Math.PI * 2.1);
    ctx.lineTo(9, 10);
    ctx.lineTo(4, 16);
    ctx.lineTo(-9, 16);
    ctx.lineTo(-14, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Hollow eye sockets + flaring spectral violet/cyan pinpricks
    ctx.fillStyle = '#090910';
    ctx.beginPath();
    ctx.ellipse(-8, -6, 4.4, 5, 0, 0, Math.PI * 2);
    ctx.ellipse(4, -6, 4.4, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    const pinR = 1.8 + beat * 1.4;
    ctx.fillStyle = rgbToCss(palette[7], 0.96);
    ctx.beginPath();
    ctx.arc(-8, -6, pinR, 0, Math.PI * 2);
    ctx.arc(4, -6, pinR, 0, Math.PI * 2);
    ctx.fill();

    // Nasal cavity & skeletal teeth
    ctx.fillStyle = '#090910';
    ctx.beginPath();
    ctx.moveTo(-2, -1);
    ctx.lineTo(-4.5, 4);
    ctx.lineTo(0.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.2;
    for (let tx = -7; tx <= 3; tx += 3.3) {
      ctx.beginPath();
      ctx.moveTo(tx, 9);
      ctx.lineTo(tx, 15);
      ctx.stroke();
    }
  } else {
    // WEREWOLF: Blood moon behind + snarling lupine profile facing left
    ctx.fillStyle = 'rgba(220, 38, 38, 0.55)';
    ctx.beginPath();
    ctx.arc(14, -18, 20, 0, Math.PI * 2);
    ctx.fill();

    // Jagged wolf fur ruff & shoulders
    ctx.fillStyle = '#3f3632';
    ctx.strokeStyle = '#1c1917';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-30, 46);
    ctx.lineTo(-22, 16);
    ctx.lineTo(-10, 2);
    ctx.lineTo(24, -10);
    ctx.lineTo(34, 16);
    ctx.lineTo(36, 46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Wolf head, pointed ears & elongated snarling snout facing LEFT
    ctx.fillStyle = '#574b44';
    ctx.strokeStyle = '#1c1917';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(16, -20);
    ctx.lineTo(18, -38); // Back ear
    ctx.lineTo(4, -24);
    ctx.lineTo(-2, -37); // Front ear
    ctx.lineTo(-10, -18);
    ctx.lineTo(-32, -4); // Snout tip
    ctx.lineTo(-30, 4);
    ctx.lineTo(-14, 6);
    ctx.lineTo(-26, 15); // Open lower jaw
    ctx.lineTo(-18, 21);
    ctx.lineTo(14, 18);
    ctx.lineTo(24, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Dark nose & feral glowing amber eye
    ctx.fillStyle = '#09090b';
    ctx.beginPath();
    ctx.arc(-30, -3, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(250, 204, 21, ${(0.82 + beat * 0.18).toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(-12, -11);
    ctx.lineTo(-4, -13);
    ctx.lineTo(-6, -8);
    ctx.closePath();
    ctx.fill();

    // Bared sharp white wolf fangs
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(-26, 4);
    ctx.lineTo(-24, 10.5);
    ctx.lineTo(-21, 5);
    ctx.moveTo(-19, 5);
    ctx.lineTo(-17, 9.5);
    ctx.lineTo(-15, 5.5);
    ctx.moveTo(-22, 14);
    ctx.lineTo(-20, 9.5);
    ctx.lineTo(-18, 14.5);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Draws one of the 4 iconic classic gothic sub-weapons in flight across the cathedral nave!
 */
function drawSubWeaponProjectile(
  ctx: CanvasRenderingContext2D,
  weapon: SubWeaponKind,
  x: number,
  y: number,
  angle: number,
  u: number,
  palette: RgbTuple[],
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1.26, 1.26);

  if (weapon === 'axe') {
    // Glowing motion arc smear + spinning double-bit battleaxe
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgbToCss(palette[7], 0.45);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 13, angle - 1.4, angle);
    ctx.stroke();
    ctx.restore();

    ctx.rotate(angle);
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(0, 14);
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-2, -11);
    ctx.quadraticCurveTo(-15, -14, -15, -2);
    ctx.quadraticCurveTo(-15, 4, -2, 1);
    ctx.moveTo(2, -11);
    ctx.quadraticCurveTo(15, -14, 15, -2);
    ctx.quadraticCurveTo(15, 4, 2, 1);
    ctx.fill();
    ctx.stroke();
  } else if (weapon === 'knife') {
    // Fast metallic afterimage streak + gleaming throwing dagger
    ctx.rotate(angle);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const trailGrad = ctx.createLinearGradient(-46, 0, 12, 0);
    trailGrad.addColorStop(0, 'rgba(125, 211, 252, 0)');
    trailGrad.addColorStop(1, 'rgba(248, 250, 252, 0.85)');
    ctx.strokeStyle = trailGrad;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-46, 0);
    ctx.lineTo(12, 0);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(-6, -5.5, 2.5, 11);
    ctx.fillStyle = '#78350f';
    ctx.fillRect(-13, -2, 7, 4);
  } else if (weapon === 'cross') {
    // Radiant spinning golden-cyan Boomerang Cross!
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 22);
    glow.addColorStop(0, 'rgba(254, 240, 138, 0.85)');
    glow.addColorStop(0.55, 'rgba(56, 189, 248, 0.42)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.rotate(angle);
    ctx.fillStyle = '#fef08a';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(-3.5, -14, 7, 28, 2);
    ctx.roundRect(-14, -3.5, 28, 7, 2);
    ctx.fill();
    ctx.stroke();
  } else {
    // Holy Water Vial — glowing cyan-gold glass flask tumbling in arc
    ctx.rotate(angle);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(0, 2, 2, 0, 2, 18);
    glow.addColorStop(0, 'rgba(125, 211, 252, 0.85)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 2, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(56, 189, 248, 0.88)';
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 4, 7.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e0f2fe';
    ctx.fillRect(-3, -9, 6, 7);
    ctx.strokeRect(-3, -9, 6, 7);
    ctx.fillStyle = '#d97706';
    ctx.fillRect(-2.5, -12, 5, 3.5);
  }

  void u;
  ctx.restore();
}

/**
 * Draws a classic Castlevania sine-wave Medusa Head with writhing snake locks!
 */
function drawMedusaHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: 1 | -1,
  timeSec: number,
  palette: RgbTuple[],
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir, 1);

  // Trailing writhing serpent locks behind the head
  ctx.strokeStyle = rgbToCss(palette[5], 0.9);
  ctx.lineWidth = 2.0;
  for (let s = 0; s < 5; s++) {
    const sy = -7 + s * 3.5;
    const wave = Math.sin(timeSec * 12 + s * 1.4) * 4.5;
    ctx.beginPath();
    ctx.moveTo(-4, sy);
    ctx.quadraticCurveTo(-13, sy + wave, -22, sy - wave * 0.7);
    ctx.stroke();
  }

  // Sculpted stone/emerald gorgon head
  ctx.fillStyle = rgbToCss(lerpRgb(palette[4], [134, 239, 172], 0.4), 0.94);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Fierce glowing eye facing forward
  ctx.fillStyle = '#fef08a';
  ctx.beginPath();
  ctx.arc(4.2, -1.8, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(4.2, -2.5, 1.4, 1.4);

  // Small bat-wing ear crest
  ctx.fillStyle = rgbToCss(palette[6], 0.85);
  ctx.beginPath();
  ctx.moveTo(-2, -8);
  ctx.lineTo(-9, -15 + Math.sin(timeSec * 14) * 2.5);
  ctx.lineTo(3, -9);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * Draws a crisp flapping gothic bat silhouette at arbitrary 3D depth scale.
 */
function drawGothicBat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  flapPhase: number,
  fillCss: string,
  strokeCss: string,
): void {
  const wingY = Math.sin(flapPhase) * 7.5 * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = fillCss;
  ctx.strokeStyle = strokeCss;
  ctx.lineWidth = Math.max(1.0, 1.2 * scale);

  ctx.beginPath();
  ctx.moveTo(0, -2.5 * scale);
  ctx.lineTo(4 * scale, -5.5 * scale + wingY * 0.45);
  ctx.lineTo(13 * scale, -2 * scale + wingY);
  ctx.lineTo(8 * scale, 3 * scale + wingY * 0.4);
  ctx.lineTo(4 * scale, 1.5 * scale);
  ctx.lineTo(0, 4.5 * scale);
  ctx.lineTo(-4 * scale, 1.5 * scale);
  ctx.lineTo(-8 * scale, 3 * scale + wingY * 0.4);
  ctx.lineTo(-13 * scale, -2 * scale + wingY);
  ctx.lineTo(-4 * scale, -5.5 * scale + wingY * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (scale >= 0.85) {
    ctx.fillStyle = '#f87171';
    ctx.fillRect(-1.8 * scale, -1 * scale, 1.1 * scale, 1.1 * scale);
    ctx.fillRect(0.8 * scale, -1 * scale, 1.1 * scale, 1.1 * scale);
  }
  ctx.restore();
}

/**
 * Draws a cathedral bat hanging upside-down by its claws from the upper vaulted stone arch,
 * folded wings tucked snug, subtly swaying and glinting red eyes on beats.
 */
function drawPerchedUpsideDownBat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  timeSec: number,
  beat: number,
  seed: number,
  palette: RgbTuple[],
): void {
  const sway = Math.sin(timeSec * 2.2 + seed) * 0.08;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(sway);

  // Tiny claws gripping the stone arch
  ctx.strokeStyle = rgbToCss(palette[6], 0.72);
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(-1.5 * scale, 0);
  ctx.lineTo(-1.5 * scale, 3 * scale);
  ctx.moveTo(1.5 * scale, 0);
  ctx.lineTo(1.5 * scale, 3 * scale);
  ctx.stroke();

  // Folded dark teardrop bat cloak hanging upside down
  ctx.fillStyle = '#090c17';
  ctx.strokeStyle = rgbToCss(palette[5], 0.74);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(0, 2.5 * scale);
  ctx.quadraticCurveTo(6.5 * scale, 6.5 * scale, 4.5 * scale, 14.5 * scale);
  ctx.lineTo(2.5 * scale, 17.5 * scale); // Left upside-down ear
  ctx.lineTo(0.8 * scale, 15 * scale);
  ctx.lineTo(-0.8 * scale, 15 * scale);
  ctx.lineTo(-2.5 * scale, 17.5 * scale); // Right upside-down ear
  ctx.lineTo(-4.5 * scale, 14.5 * scale);
  ctx.quadraticCurveTo(-6.5 * scale, 6.5 * scale, 0, 2.5 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Wing-fold crease
  ctx.strokeStyle = rgbToCss(palette[4], 0.45);
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(0, 4 * scale);
  ctx.lineTo(0, 12.5 * scale);
  ctx.stroke();

  // Blinking crimson eyes near the hanging head (glint brighter on beats!)
  const blink = ((Math.floor(timeSec * 1.4 + seed * 3) % 7) !== 0);
  if (blink) {
    ctx.fillStyle = beat > 0.45 ? '#fca5a5' : '#ef4444';
    ctx.fillRect(-2.1 * scale, 12.2 * scale, 1.3 * scale, 1.3 * scale);
    ctx.fillRect(0.9 * scale, 12.2 * scale, 1.3 * scale, 1.3 * scale);
  }
  ctx.restore();
}

/**
 * Mode 8 (Wave 2): 16-Bit Dark Fantasy Sanctum (Crisp 1280×720 Gothic Cathedral Boss Stage)
 * - Full interior gothic cathedral with perspective tiled stone floor, vaulted arches,
 *   16-band spectral pipe-organ EQ columns, flickering braziers, backlit album-art stained-glass
 *   rose window, and the levitating 3D Coffin (`COFFIN_MESH_3D`) over the central altar.
 * - Left stone platform: Animated whip-wielding Barbarian / Vampire Hunter Hero.
 * - Upper-right ornate frame: 5 rotating classic gothic monster boss portraits
 *   (Dracula, Mummy, Frankenstein, Death, Werewolf) facing the Hero.
 * - Bottom 16-bit JRPG dialogue box exchanges live synced lyrics (call-and-response!) or each
 *   monster's campy gothic banter with the Hero before the Hero throws a cycling sub-weapon
 *   (Axe, Knife, Cross, Holy Water) to black-swirl implode the portrait into the next monster!
 * - Ambient sine-wave Medusa heads + music-reactive bats & periodic 3D camera-rush bat swarms.
 */
export function renderSanctumOdysseyScene(s: SceneRenderContext): void {
  const {
    ctx,
    timeSec,
    dt,
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
    trackTitle,
    cropTopY,
    cropBottomY,
    cropLeftX,
    cropRightX,
  } = s;

  const safeDt = dt > 0 ? Math.min(0.06, dt) : 0;
  const cx = CANVAS_W * 0.5;
  const vLeft = cropLeftX ?? 0;
  const vRight = cropRightX ?? CANVAS_W;
  const floorY = 236;

  // Reset state on track change or backward seek
  if (
    !sanctumState.initialized ||
    trackTitle !== sanctumState.lastTrackKey ||
    (sanctumState.lastTimeSec >= 0 && timeSec < sanctumState.lastTimeSec - 2.0)
  ) {
    resetSanctumState(trackTitle);
  }
  sanctumState.lastTimeSec = timeSec;

  const cleanLyric = (activeLyric || '').trim();
  const hasActiveLyric = cleanLyric.length > 0;
  const currentMonster = MONSTER_ROSTER[sanctumState.bossIndex % MONSTER_ROSTER.length];
  const currentWeapon = SUB_WEAPONS[sanctumState.weaponIndex % SUB_WEAPONS.length];

  // =========================================================================
  // 0. Step Boss Duel State Machine, Medusa Heads & Bat Camera-Swarm
  // =========================================================================
  if (safeDt > 0) {
    sanctumState.lineReveal = Math.min(1, sanctumState.lineReveal + safeDt * 2.2);
    if (sanctumState.holyFlameTimer > 0) {
      sanctumState.holyFlameTimer = Math.max(0, sanctumState.holyFlameTimer - safeDt);
    }

    if (sanctumState.phase === 'banter') {
      sanctumState.bossElapsed += safeDt;
      sanctumState.throwAnimT = 0;

      if (hasActiveLyric) {
        if (cleanLyric !== sanctumState.lastLyricSeen) {
          const gapSinceLast =
            sanctumState.lastLyricChangeAt >= 0 ? timeSec - sanctumState.lastLyricChangeAt : 0;
          const detectedSectionBreak =
            sanctumState.linesSpokenInTurn >= 2 &&
            (sanctumState.lyricGapSec >= 1.4 || gapSinceLast >= 5.2);
          const hitWallOfTextStanzaCap = sanctumState.linesSpokenInTurn >= 4;

          if (detectedSectionBreak || hitWallOfTextStanzaCap) {
            sanctumState.speaker = sanctumState.speaker === 'monster' ? 'hero' : 'monster';
            sanctumState.linesSpokenInTurn = 1;
            sanctumState.turnLines = [cleanLyric];
            sanctumState.exchangeCount++;
          } else {
            sanctumState.linesSpokenInTurn++;
            sanctumState.turnLines.push(cleanLyric);
            if (sanctumState.turnLines.length > 3) {
              sanctumState.turnLines.shift();
            }
          }
          sanctumState.lastLyricSeen = cleanLyric;
          sanctumState.lastLyricChangeAt = timeSec;
          sanctumState.lyricGapSec = 0;
          sanctumState.lineReveal = 0.08;
        }
      } else {
        sanctumState.lyricGapSec += safeDt;
        sanctumState.banterTurnTimer += safeDt;
        if (sanctumState.banterTurnTimer >= 4.8) {
          sanctumState.banterTurnTimer = 0;
          if (sanctumState.speaker === 'monster') {
            sanctumState.speaker = 'hero';
          } else {
            sanctumState.speaker = 'monster';
            sanctumState.banterPairIdx =
              (sanctumState.banterPairIdx + 1) % currentMonster.exchanges.length;
          }
          sanctumState.exchangeCount++;
          sanctumState.lineReveal = 0.06;
        }
      }

      // After each side delivers a full verse/stanza exchange (or 4 banter turns / ~26s), Hero throws a sub-weapon!
      const neededExchanges = hasActiveLyric ? 2 : 4;
      if (
        (sanctumState.exchangeCount >= neededExchanges && sanctumState.bossElapsed >= 14.0) ||
        sanctumState.bossElapsed >= 26.0
      ) {
        sanctumState.phase = 'throwing';
        sanctumState.phaseTimer = 0;
        sanctumState.speaker = 'hero';
        sanctumState.lineReveal = 1;
      }
    } else if (sanctumState.phase === 'throwing') {
      sanctumState.phaseTimer += safeDt;
      sanctumState.throwAnimT = Math.min(1, sanctumState.phaseTimer / 0.65);
      const flightDur = currentWeapon === 'knife' ? 0.78 : 1.15;
      if (sanctumState.phaseTimer >= flightDur) {
        sanctumState.phase = 'imploding';
        sanctumState.phaseTimer = 0;
        if (currentWeapon === 'holy_water') {
          sanctumState.holyFlameTimer = 1.2;
        }
      }
    } else if (sanctumState.phase === 'imploding') {
      sanctumState.phaseTimer += safeDt;
      sanctumState.throwAnimT = Math.max(0, sanctumState.throwAnimT - safeDt * 2.5);
      if (sanctumState.phaseTimer >= 1.05) {
        sanctumState.bossIndex = (sanctumState.bossIndex + 1) % MONSTER_ROSTER.length;
        sanctumState.weaponIndex = (sanctumState.weaponIndex + 1) % SUB_WEAPONS.length;
        sanctumState.exchangeCount = 0;
        sanctumState.bossElapsed = 0;
        sanctumState.banterPairIdx = 0;
        sanctumState.banterTurnTimer = 0;
        sanctumState.linesSpokenInTurn = 0;
        sanctumState.turnLines = [];
        sanctumState.speaker = 'monster';
        sanctumState.lineReveal = 0.05;
        sanctumState.phase = 'spawning';
        sanctumState.phaseTimer = 0;
      }
    } else if (sanctumState.phase === 'spawning') {
      sanctumState.phaseTimer += safeDt;
      if (sanctumState.phaseTimer >= 0.58) {
        sanctumState.phase = 'banter';
        sanctumState.phaseTimer = 0;
      }
    }

    // Step Medusa Heads
    sanctumState.medusaCooldown -= safeDt;
    if (sanctumState.medusaCooldown <= 0) {
      const slot = sanctumState.medusas.find((m) => !m.active);
      if (slot) {
        slot.active = true;
        slot.dir = ((Math.floor(timeSec * 3) & 1) === 0 ? -1 : 1) as 1 | -1;
        slot.x = slot.dir < 0 ? CANVAS_W + 28 : -28;
        slot.baseY = 112 + ((Math.floor(timeSec * 17) % 5) * 18);
        slot.speed = 68 + (Math.floor(timeSec * 7) % 3) * 14;
        slot.phase = timeSec * 2.3;
        slot.amp = 22 + (Math.floor(timeSec * 11) % 3) * 6;
      }
      sanctumState.medusaCooldown = 8.5 + (Math.floor(timeSec * 5) % 4) * 1.6;
    }
    for (const m of sanctumState.medusas) {
      if (!m.active) continue;
      m.x += m.dir * m.speed * safeDt;
      if (m.x < -46 || m.x > CANVAS_W + 46) {
        m.active = false;
      }
    }

    // Step roosting arch bats: hang upside-down on top arch, swoop in a U-arc to a new perch!
    for (let i = 0; i < sanctumState.roostBats.length; i++) {
      const rb = sanctumState.roostBats[i];
      if (rb.mode === 'perched') {
        rb.waitTimer -= safeDt * (1 + (beat > 0.65 ? 0.8 : 0));
        if (rb.waitTimer <= 0) {
          sanctumState.roostSeed = (sanctumState.roostSeed * 1664525 + 1013904223) >>> 0;
          const nextSlot = ARCH_PERCH_SLOTS[sanctumState.roostSeed % ARCH_PERCH_SLOTS.length];
          rb.targetU = Math.abs(nextSlot - rb.perchU) < 0.05
            ? ARCH_PERCH_SLOTS[(sanctumState.roostSeed + 3) % ARCH_PERCH_SLOTS.length]
            : nextSlot;
          rb.mode = 'swooping';
          rb.flightT = 0;
          rb.flightDur = 1.45 + ((sanctumState.roostSeed >> 4) % 4) * 0.25;
          rb.dipDepth = 64 + ((sanctumState.roostSeed >> 8) % 4) * 18;
        }
      } else {
        rb.flightT += safeDt / rb.flightDur;
        rb.wingPhase += (16 + beat * 8) * safeDt;
        if (rb.flightT >= 1.0) {
          rb.perchU = rb.targetU;
          rb.mode = 'perched';
          rb.flightT = 0;
          sanctumState.roostSeed = (sanctumState.roostSeed * 1664525 + 1013904223) >>> 0;
          rb.waitTimer = 2.8 + ((sanctumState.roostSeed >> 6) % 7) * 0.9;
        }
      }
    }

    // Trigger & step 3D Bat Camera-Rush Swarm on bass drops or periodic gothic crescendo
    if (
      timeSec > sanctumState.swarmActiveUntil &&
      timeSec - sanctumState.lastSwarmAt > 14.0 &&
      (drop > 0.30 || (subBass > 0.72 && beat > 0.76) || timeSec - sanctumState.lastSwarmAt > 25.0)
    ) {
      triggerBatCameraSwarm(timeSec);
    }
    if (timeSec <= sanctumState.swarmActiveUntil) {
      for (const b of sanctumState.swarmBats) {
        b.z -= b.speedZ * (1 + subBass * 0.5) * safeDt;
        b.wingPhase += (19 + beat * 9) * safeDt;
        if (b.z <= 0.03) {
          b.z = 1.12;
        }
      }
    }
  }

  // =========================================================================
  // 1. Cathedral Abyss Backdrop & Nave Radial Glow (True #000000 OLED Floor)
  // =========================================================================
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const naveGlow = ctx.createRadialGradient(cx, 128, 12, cx, 142, 310);
  naveGlow.addColorStop(0, rgbToCss(palette[4], 0.32 + subBass * 0.14 + drop * 0.1));
  naveGlow.addColorStop(0.52, rgbToCss(palette[1], 0.24));
  naveGlow.addColorStop(1, '#000000');
  ctx.fillStyle = naveGlow;
  ctx.fillRect(0, 0, CANVAS_W, floorY + 8);

  // =========================================================================
  // 2. 16-Band Spectral Pipe-Organ EQ Columns Flanking the Cathedral Nave
  // =========================================================================
  const organBaseY = floorY;
  for (let i = 0; i < 16; i++) {
    const isLeft = i < 8;
    const rank = isLeft ? i : i - 8; // 0..7 inner-to-outer
    const bandEnergy = sb[i];
    const pipeX = isLeft ? cx - 64 - rank * 19 : cx + 64 + rank * 19;
    const basePipeH = 92 + (7 - rank) * 11;
    const activeGlowH = Math.round(bandEnergy * (basePipeH - 18));
    const pipeW = 10;

    // Metallic dark brass/iron organ pipe cylinder
    const pipeGrad = ctx.createLinearGradient(pipeX - pipeW * 0.5, 0, pipeX + pipeW * 0.5, 0);
    pipeGrad.addColorStop(0, '#0b0e18');
    pipeGrad.addColorStop(0.45, rgbToCss(palette[2], 0.72));
    pipeGrad.addColorStop(1, '#05070e');
    ctx.fillStyle = pipeGrad;
    ctx.fillRect(pipeX - pipeW * 0.5, organBaseY - basePipeH, pipeW, basePipeH);

    // Spectral EQ vent glow rising inside each pipe
    if (activeGlowH > 2) {
      const ventGrad = ctx.createLinearGradient(0, organBaseY, 0, organBaseY - activeGlowH - 14);
      ventGrad.addColorStop(0, rgbToCss(palette[4], 0.72));
      ventGrad.addColorStop(0.65, rgbToCss(palette[6], 0.85));
      ventGrad.addColorStop(1, rgbToCss(palette[7], 0.96));
      ctx.fillStyle = ventGrad;
      ctx.fillRect(pipeX - 2.5, organBaseY - activeGlowH - 8, 5, activeGlowH);
    }

    // Pipe crown bevel & mouth slit
    ctx.strokeStyle = rgbToCss(palette[5], 0.45 + bandEnergy * 0.45);
    ctx.lineWidth = 1.0;
    ctx.strokeRect(pipeX - pipeW * 0.5, organBaseY - basePipeH, pipeW, basePipeH);
    ctx.fillStyle = rgbToCss(palette[7], 0.35 + bandEnergy * 0.55);
    ctx.fillRect(pipeX - pipeW * 0.5 + 1, organBaseY - 22, pipeW - 2, 2.5);
  }

  // =========================================================================
  // 3. Grand Backlit Album-Art Stained-Glass Rose Window + Volumetric God-Rays
  // =========================================================================
  const roseX = cx;
  const roseY = Math.max(66, cropTopY + 46);
  const roseR = 44;

  // Soft angled cathedral god-rays streaming down from the rose window
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rayAlpha = 0.08 + subBass * 0.07 + beat * 0.05;
  for (let r = -1; r <= 1; r++) {
    const rayGrad = ctx.createLinearGradient(roseX + r * 20, roseY, roseX + r * 68, floorY + 40);
    rayGrad.addColorStop(0, rgbToCss(palette[5 + Math.abs(r)], rayAlpha * 1.4));
    rayGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = rayGrad;
    ctx.beginPath();
    ctx.moveTo(roseX + r * 14 - 16, roseY + 8);
    ctx.lineTo(roseX + r * 14 + 16, roseY + 8);
    ctx.lineTo(roseX + r * 72 + 44, floorY + 36);
    ctx.lineTo(roseX + r * 72 - 44, floorY + 36);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Outer carved gothic stone rose surround
  ctx.save();
  ctx.translate(roseX, roseY);
  ctx.strokeStyle = rgbToCss(palette[6], 0.72 + beat * 0.22);
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.arc(0, 0, roseR + 3, 0, Math.PI * 2);
  ctx.stroke();

  // Clipped rotating album-art stained glass
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, roseR, 0, Math.PI * 2);
  ctx.clip();
  ctx.rotate(timeSec * 0.1);
  if (artReady && artCanvas) {
    ctx.globalAlpha = 0.86;
    ctx.drawImage(artCanvas, -roseR, -roseR, roseR * 2, roseR * 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgbToCss(palette[4], 0.16);
    ctx.fillRect(-roseR, -roseR, roseR * 2, roseR * 2);
  } else {
    const rg = ctx.createRadialGradient(0, 0, 4, 0, 0, roseR);
    rg.addColorStop(0, rgbToCss(palette[7], 0.85));
    rg.addColorStop(0.55, rgbToCss(palette[4], 0.72));
    rg.addColorStop(1, '#090d16');
    ctx.fillStyle = rg;
    ctx.fillRect(-roseR, -roseR, roseR * 2, roseR * 2);
  }

  // Crisp gothic stained-glass lead-came spokes & inner trefoil ring
  ctx.strokeStyle = 'rgba(4, 6, 16, 0.84)';
  ctx.lineWidth = 1.6;
  for (let sp = 0; sp < 12; sp++) {
    const ang = (sp / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(ang) * roseR, Math.sin(ang) * roseR);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, roseR * 0.56, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  // =========================================================================
  // 4. Vaulted Pointed Gothic Stone Arches, Pillars & Flickering Braziers
  // =========================================================================
  const pillarXs = [54, 164, CANVAS_W - 164, CANVAS_W - 54];
  for (let p = 0; p < pillarXs.length; p++) {
    const px = pillarXs[p];
    const pw = p === 0 || p === 3 ? 28 : 20;
    const pGrad = ctx.createLinearGradient(px - pw * 0.5, 0, px + pw * 0.5, 0);
    pGrad.addColorStop(0, '#070912');
    pGrad.addColorStop(0.5, '#131829');
    pGrad.addColorStop(1, '#05070e');
    ctx.fillStyle = pGrad;
    ctx.strokeStyle = rgbToCss(palette[3], 0.52);
    ctx.lineWidth = 1.2;
    ctx.fillRect(px - pw * 0.5, 14, pw, floorY - 14);
    ctx.strokeRect(px - pw * 0.5, 14, pw, floorY - 14);

    // Carved gothic pillar capital & plinth
    ctx.fillStyle = '#1b2238';
    ctx.fillRect(px - pw * 0.5 - 4, 24, pw + 8, 7);
    ctx.fillRect(px - pw * 0.5 - 5, floorY - 9, pw + 10, 9);
  }

  // Pointed Gothic Vault Ribbing overhead
  ctx.strokeStyle = rgbToCss(palette[4], 0.55);
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(54, 88);
  ctx.quadraticCurveTo(cx * 0.55, 6, cx, 14);
  ctx.quadraticCurveTo(CANVAS_W - cx * 0.55, 6, CANVAS_W - 54, 88);
  ctx.stroke();

  ctx.strokeStyle = rgbToCss(palette[5], 0.36);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(164, 96);
  ctx.quadraticCurveTo(cx * 0.72, 18, cx, 22);
  ctx.quadraticCurveTo(CANVAS_W - cx * 0.72, 18, CANVAS_W - 164, 96);
  ctx.stroke();

  // =========================================================================
  // 5. Perspective Tiled Gothic Stone Nave Floor (`y = floorY .. CANVAS_H`)
  // =========================================================================
  const floorGrad = ctx.createLinearGradient(0, floorY, 0, CANVAS_H);
  floorGrad.addColorStop(0, rgbToCss(palette[1], 0.55));
  floorGrad.addColorStop(0.45, '#0b0e19');
  floorGrad.addColorStop(1, '#030408');
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, floorY, CANVAS_W, CANVAS_H - floorY);

  const vpY = 148;
  ctx.strokeStyle = rgbToCss(palette[4], 0.34);
  ctx.lineWidth = 1.1;
  // Perspective radial tile seams converging toward the nave altar
  for (let col = -8; col <= 8; col++) {
    const botX = cx + col * 58;
    const tFloor = (floorY - vpY) / (CANVAS_H - vpY);
    const topX = cx + (botX - cx) * tFloor;
    ctx.beginPath();
    ctx.moveTo(topX, floorY);
    ctx.lineTo(botX, CANVAS_H);
    ctx.stroke();
  }
  // Horizontal perspective stone slab rows
  for (let row = 0; row <= 6; row++) {
    const u = Math.pow(row / 6, 1.55);
    const ry = floorY + u * (CANVAS_H - floorY);
    ctx.strokeStyle = rgbToCss(palette[3], 0.25 + u * 0.25);
    ctx.beginPath();
    ctx.moveTo(0, ry);
    ctx.lineTo(CANVAS_W, ry);
    ctx.stroke();
  }

  // Subtle glowing runic floor circle etched beneath the central coffin altar
  ctx.save();
  ctx.translate(cx, floorY + 26);
  ctx.scale(1, 0.28);
  ctx.strokeStyle = rgbToCss(palette[5], 0.42 + subBass * 0.35);
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(0, 0, 74 + subBass * 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // =========================================================================
  // 6. Standing Gothic Braziers + Flickering Flames & Rising Embers
  // =========================================================================
  const brazierXs = [164, CANVAS_W - 164];
  ctx.save();
  for (let b = 0; b < brazierXs.length; b++) {
    const bx = brazierXs[b];
    const by = floorY + 4;
    // Wrought-iron tripod & fire bowl
    ctx.fillStyle = '#1e2436';
    ctx.strokeStyle = rgbToCss(palette[5], 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(bx - 12, by - 36);
    ctx.lineTo(bx + 12, by - 36);
    ctx.lineTo(bx + 7, by - 26);
    ctx.lineTo(bx - 7, by - 26);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(bx - 2.5, by - 26, 5, 26);
    ctx.fillRect(bx - 9, by - 3, 18, 4);

    // Animated flame glow (`lighter`)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const flicker = 0.86 + Math.sin(timeSec * 12 + b * 2.4) * 0.1 + Math.cos(timeSec * 19 + b) * 0.06;
    const glowR = (30 + sb[(b * 5) & 15] * 14 + beat * 6) * flicker;
    const fGrad = ctx.createRadialGradient(bx, by - 42, 2, bx, by - 42, glowR);
    fGrad.addColorStop(0, '#ffffff');
    fGrad.addColorStop(0.28, 'rgba(253, 224, 71, 0.85)');
    fGrad.addColorStop(0.62, 'rgba(249, 115, 22, 0.36)');
    fGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = fGrad;
    ctx.beginPath();
    ctx.arc(bx, by - 42, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Rising Fire Embers drifting upward through the nave
  ctx.globalCompositeOperation = 'lighter';
  for (let e = 0; e < 22; e++) {
    const ex = 48 + ((e * 53 + Math.sin(timeSec * 1.5 + e) * 14) % (CANVAS_W - 96));
    const ey = floorY + 12 - ((timeSec * (20 + (e % 5) * 6) + e * 21) % (floorY - 18));
    ctx.fillStyle = (e & 1) === 0 ? 'rgba(251, 146, 60, 0.72)' : rgbToCss(palette[7], 0.65);
    ctx.fillRect(ex, ey, 2, 2);
  }
  ctx.restore();

  // =========================================================================
  // 7. Central Stepped Altar & Levitating 3D Coffin (`COFFIN_MESH_3D`)
  // =========================================================================
  ctx.fillStyle = '#090d1a';
  ctx.strokeStyle = rgbToCss(palette[5], 0.72);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 58, floorY + 8);
  ctx.lineTo(cx - 44, floorY - 12);
  ctx.lineTo(cx + 44, floorY - 12);
  ctx.lineTo(cx + 58, floorY + 8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const coffinX = cx;
  const coffinY = 160 + Math.sin(timeSec * 1.2) * 4.5;

  // Counter-rotating arcane summoning rings behind the 3D Coffin
  ctx.save();
  ctx.translate(coffinX, coffinY);
  for (let ring = 0; ring < 2; ring++) {
    const rr = 44 + ring * 14 + subBass * 6;
    ctx.save();
    ctx.rotate(timeSec * (ring === 0 ? 0.36 : -0.26));
    ctx.strokeStyle = rgbToCss(palette[5 + ring], 0.48 + beat * 0.16);
    ctx.lineWidth = 1.3;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // Strictly monotonic Y-rotation so the 3D coffin rotates smoothly & majestically
  projectAndDrawMesh3D(ctx, COFFIN_MESH_3D, {
    cx: coffinX,
    cy: coffinY,
    scale: 42 + subBass * 4,
    rx: Math.sin(timeSec * 0.32) * 0.14,
    ry: timeSec * 0.36,
    rz: Math.cos(timeSec * 0.26) * 0.08,
    palette,
    alphaBoost: 0.94,
  });

  // =========================================================================
  // 8. Roosting Cathedral Arch Bats (Upside-Down Perches -> Swooping Arcs) & Medusa Heads
  // =========================================================================
  for (let i = 0; i < sanctumState.roostBats.length; i++) {
    const rb = sanctumState.roostBats[i];
    if (rb.mode === 'perched') {
      const [px, py] = getArchPerchPoint(rb.perchU);
      drawPerchedUpsideDownBat(ctx, px, py, rb.scale, timeSec, beat, i * 1.9, palette);
    } else {
      const [sx, sy] = getArchPerchPoint(rb.perchU);
      const [ex, ey] = getArchPerchPoint(rb.targetU);
      const t = Math.max(0, Math.min(1, rb.flightT));
      // Smooth ease-in-out horizontal glide + graceful downward U-arc dive & climb back to perch
      const easeT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const bx = sx + (ex - sx) * easeT;
      const by = sy + (ey - sy) * easeT + Math.sin(t * Math.PI) * rb.dipDepth;
      drawGothicBat(
        ctx,
        bx,
        by,
        rb.scale * (0.95 + Math.sin(t * Math.PI) * 0.25),
        rb.wingPhase,
        '#090c17',
        rgbToCss(palette[6], 0.8),
      );
    }
  }

  for (const m of sanctumState.medusas) {
    if (!m.active) continue;
    const my = m.baseY + Math.sin(m.x * 0.036 + m.phase) * m.amp;
    drawMedusaHead(ctx, m.x, my, m.dir, timeSec, palette);
  }

  // =========================================================================
  // 9. Left Stone Platform + Animated Whip-Wielding Barbarian Hero
  // =========================================================================
  const platW = 90;
  const platX = Math.max(vLeft + 24, 42);
  const platY = 252;
  const heroX = platX + platW * 0.5;
  const heroY = platY;

  // Carved gothic stone ledge + supporting corbel arch
  ctx.save();
  ctx.fillStyle = '#14192b';
  ctx.strokeStyle = rgbToCss(palette[5], 0.78);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(platX, platY, platW, 14, 3);
  ctx.fill();
  ctx.stroke();

  // Top highlight slab bevel
  ctx.fillStyle = rgbToCss(palette[6], 0.35);
  ctx.fillRect(platX + 2, platY + 1, platW - 4, 3);

  // Under-platform gothic stone masonry column
  ctx.fillStyle = '#0c101d';
  ctx.strokeStyle = rgbToCss(palette[3], 0.55);
  ctx.beginPath();
  ctx.moveTo(platX + 10, platY + 14);
  ctx.lineTo(platX + platW - 10, platY + 14);
  ctx.lineTo(platX + platW - 18, platY + 38);
  ctx.lineTo(platX + 18, platY + 38);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawBarbarianHero(
    ctx,
    heroX,
    heroY,
    timeSec,
    beat,
    midEnergy,
    sanctumState.throwAnimT,
    sanctumState.speaker === 'hero',
    palette,
  );

  // =========================================================================
  // 10. Upper-Right Ornate Monster Boss Portrait Frame (Facing Left Duel!)
  // =========================================================================
  const bossSize = 90;
  const bossHalf = bossSize * 0.5;
  const bossCx = Math.min(vRight - bossHalf - 22, 548);
  const bossCy = Math.max(cropTopY + bossHalf + 18, 76);

  ctx.save();
  ctx.translate(bossCx, bossCy);

  // Calculate implosion / spawn swirl transform
  let portraitScale = 1;
  let portraitRot = 0;
  let swirlProgress = 0;
  if (sanctumState.phase === 'imploding') {
    swirlProgress = Math.min(1, sanctumState.phaseTimer / 1.05);
    portraitScale = Math.max(0, 1 - Math.pow(swirlProgress, 1.35));
    portraitRot = swirlProgress * swirlProgress * Math.PI * 3.8;
  } else if (sanctumState.phase === 'spawning') {
    const sp = Math.min(1, sanctumState.phaseTimer / 0.58);
    portraitScale = Math.pow(sp, 0.75);
    portraitRot = (1 - sp) * -Math.PI * 2.2;
  }

  // Speaker glow halo around the ornate portrait frame
  if (sanctumState.phase === 'banter' && sanctumState.speaker === 'monster') {
    const halo = ctx.createRadialGradient(0, 0, bossHalf * 0.7, 0, 0, bossHalf + 20);
    halo.addColorStop(0, rgbToCss(currentMonster.accentRgb, 0.34 + beat * 0.16));
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, bossHalf + 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ornate gothic frame backdrop (stays anchored while portrait swirls inside!)
  ctx.fillStyle = '#05060c';
  ctx.beginPath();
  ctx.roundRect(-bossHalf - 4, -bossHalf - 4, bossSize + 8, bossSize + 8, 8);
  ctx.fill();

  // Clipped Portrait Interior
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-bossHalf, -bossHalf, bossSize, bossSize, 5);
  ctx.clip();

  if (portraitScale > 0.02) {
    ctx.save();
    ctx.rotate(portraitRot);
    ctx.scale(portraitScale, portraitScale);
    drawMonsterPortraitArt(ctx, currentMonster.kind, timeSec, beat, subBass, palette);
    ctx.restore();
  }

  // Black Vortex Swirl Implosion Effect on Sub-Weapon Hit!
  if (sanctumState.phase === 'imploding') {
    const p = swirlProgress;
    // Pitch-black singularity core growing then collapsing
    const coreR = Math.sin(p * Math.PI) * 34;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2, coreR), 0, Math.PI * 2);
    ctx.fill();

    // Twisting gothic vortex spiral arms
    for (let arm = 0; arm < 6; arm++) {
      const baseA = (arm / 6) * Math.PI * 2 + p * Math.PI * 5;
      ctx.strokeStyle =
        (arm & 1) === 0
          ? rgbToCss(currentMonster.accentRgb, (1 - p * 0.65) * 0.92)
          : rgbToCss(palette[7], (1 - p * 0.7) * 0.85);
      ctx.lineWidth = 2.2 * (1 - p * 0.5);
      ctx.beginPath();
      for (let st = 0; st <= 10; st++) {
        const u = st / 10;
        const rad = (1 - u) * (bossHalf * 1.15) * (1 - p * 0.35);
        const ang = baseA + u * 2.6;
        const vx = Math.cos(ang) * rad;
        const vy = Math.sin(ang) * rad;
        if (st === 0) ctx.moveTo(vx, vy);
        else ctx.lineTo(vx, vy);
      }
      ctx.stroke();
    }

    // Brief white impact flash at the start of implosion
    if (p < 0.22) {
      ctx.fillStyle = `rgba(255, 255, 255, ${((1 - p / 0.22) * 0.78).toFixed(2)})`;
      ctx.fillRect(-bossHalf, -bossHalf, bossSize, bossSize);
    }
  }

  // Holy Water rising sacred blue-gold flames on impact!
  if (sanctumState.holyFlameTimer > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const intensity = Math.min(1, sanctumState.holyFlameTimer);
    for (let fl = 0; fl < 5; fl++) {
      const fx = -32 + fl * 16 + Math.sin(timeSec * 18 + fl) * 3;
      const fh = (26 + Math.sin(timeSec * 22 + fl * 1.7) * 14) * intensity;
      const fg = ctx.createLinearGradient(fx, bossHalf, fx, bossHalf - fh);
      fg.addColorStop(0, 'rgba(56, 189, 248, 0.92)');
      fg.addColorStop(0.55, 'rgba(250, 204, 21, 0.75)');
      fg.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(fx - 9, bossHalf);
      ctx.quadraticCurveTo(fx, bossHalf - fh * 1.25, fx + 9, bossHalf);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore(); // end portrait clip

  // Ornate Double Gold-Filigree Boss Frame Border + Corner Rivets
  ctx.strokeStyle =
    sanctumState.speaker === 'monster' && sanctumState.phase === 'banter'
      ? rgbToCss(currentMonster.accentRgb, 0.96)
      : rgbToCss(palette[6], 0.85);
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.roundRect(-bossHalf - 2, -bossHalf - 2, bossSize + 4, bossSize + 4, 6);
  ctx.stroke();

  ctx.strokeStyle = rgbToCss(palette[7], 0.45);
  ctx.lineWidth = 1.0;
  ctx.strokeRect(-bossHalf + 1, -bossHalf + 1, bossSize - 2, bossSize - 2);

  for (const [rx, ry] of [
    [-bossHalf - 2, -bossHalf - 2],
    [bossHalf + 2, -bossHalf - 2],
    [-bossHalf - 2, bossHalf + 2],
    [bossHalf + 2, bossHalf + 2],
  ]) {
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(rx, ry, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Boss Nameplate Bar directly beneath the portrait
  const plateW = bossSize + 10;
  ctx.fillStyle = 'rgba(8, 10, 22, 0.94)';
  ctx.strokeStyle = rgbToCss(currentMonster.accentRgb, 0.9);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.roundRect(-plateW * 0.5, bossHalf + 6, plateW, 16, 4);
  ctx.fill();
  ctx.stroke();

  ctx.font = '800 8.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(currentMonster.name, 0, bossHalf + 14.2);

  ctx.restore();

  // =========================================================================
  // 11. Flying Iconic Sub-Weapon Projectile (Hero -> Boss Portrait!)
  // =========================================================================
  if (sanctumState.phase === 'throwing') {
    const flightDur = currentWeapon === 'knife' ? 0.78 : 1.15;
    const u = Math.max(0, Math.min(1, sanctumState.phaseTimer / flightDur));
    const startX = heroX + 18;
    const startY = heroY - 38;
    const endX = bossCx;
    const endY = bossCy;

    const px = startX + (endX - startX) * u;
    let py = startY + (endY - startY) * u;
    let ang = 0;

    if (currentWeapon === 'axe') {
      // Classic Castlevania high parabolic arc + spinning battleaxe!
      py -= Math.sin(u * Math.PI) * 92;
      ang = u * Math.PI * 7.5;
    } else if (currentWeapon === 'knife') {
      // Blistering straight throw aimed directly at the portrait
      ang = Math.atan2(endY - startY, endX - startX);
    } else if (currentWeapon === 'cross') {
      // Gentle boomerang arc + radiant spinning cross
      py -= Math.sin(u * Math.PI) * 34;
      ang = u * Math.PI * 9.0;
    } else {
      // Lobbed Holy Water flask arc
      py -= Math.sin(u * Math.PI) * 76;
      ang = u * Math.PI * 5.2;
    }

    drawSubWeaponProjectile(ctx, currentWeapon, px, py, ang, u, palette);
  }

  // =========================================================================
  // 12. Periodic 3D Bat Camera-Rush Swarm Flying Straight Toward Viewer!
  // =========================================================================
  if (timeSec <= sanctumState.swarmActiveUntil) {
    const swarmRem = sanctumState.swarmActiveUntil - timeSec;
    const swarmFade = Math.min(1, swarmRem * 1.35, (3.1 - swarmRem) * 2.2);
    for (const b of sanctumState.swarmBats) {
      const invZ = 1 / Math.max(0.055, b.z);
      const spread = (1 - Math.min(1, b.z)) * 275 * b.radialSpeed;
      const sx = cx + Math.cos(b.angle) * spread * 1.48;
      const sy = 136 + Math.sin(b.angle) * spread * 0.96;
      if (sx < -80 || sx > CANVAS_W + 80 || sy < -80 || sy > CANVAS_H + 80) continue;
      const sc = Math.min(3.8, 0.36 + invZ * 0.25);
      drawGothicBat(
        ctx,
        sx,
        sy,
        sc,
        b.wingPhase,
        `rgba(5, 7, 15, ${(0.93 * swarmFade).toFixed(2)})`,
        rgbToCss(palette[6], 0.75 * swarmFade),
      );
    }
  }

  // =========================================================================
  // 13. Dual Alternating 16-Bit RPG Speech Boxes (Multi-Line Stanza Blocks):
  //     - Monster Box: Upper-Right beneath Boss Portrait (with pointer up to Portrait)
  //     - Hero Box:    Lower-Left aligned with Barbarian Hero (with pointer up to Hero)
  // =========================================================================
  const isHeroSpeaker = sanctumState.speaker === 'hero';
  const maxLineChars = isHeroSpeaker ? 36 : 31;

  // Build up to 3 lines for the active speaker's RPG stanza block:
  // Previous lines in this stanza render slightly muted above the crisp active typewriter line!
  const renderedRows: { text: string; active: boolean }[] = [];
  if (hasActiveLyric && sanctumState.turnLines.length > 0) {
    const history = sanctumState.turnLines;
    const prevLines = history.slice(0, -1);
    const activeRaw = history[history.length - 1];
    const visibleChars = Math.max(1, Math.ceil(activeRaw.length * sanctumState.lineReveal));
    const activeWrapped = splitIntoBalancedLines(activeRaw.slice(0, visibleChars), maxLineChars);
    const prevSlots = Math.max(0, 3 - activeWrapped.length);
    for (const pl of prevLines.slice(-prevSlots)) {
      const trimmedPrev =
        pl.length > maxLineChars + 2 ? `${pl.slice(0, maxLineChars).trim()}…` : pl;
      renderedRows.push({ text: trimmedPrev, active: false });
    }
    for (const al of activeWrapped) {
      renderedRows.push({ text: al, active: true });
    }
  } else {
    const pair =
      currentMonster.exchanges[sanctumState.banterPairIdx % currentMonster.exchanges.length];
    const displayText = hasActiveLyric
      ? cleanLyric
      : sanctumState.speaker === 'monster'
        ? pair[0]
        : pair[1];
    const visibleChars = Math.max(1, Math.ceil(displayText.length * sanctumState.lineReveal));
    const wrapped = splitIntoBalancedLines(displayText.slice(0, visibleChars), maxLineChars);
    for (const wl of wrapped) {
      renderedRows.push({ text: wl, active: true });
    }
  }

  const longestLine = Math.max(...renderedRows.map((r) => r.text.length), 14);
  const boxH = renderedRows.length * 15.5 + 24;

  let boxW: number;
  let boxX: number;
  let boxY: number;
  let tailTipX: number;
  let tailTipY: number;
  let tailBaseX: number;

  if (isHeroSpeaker) {
    // Lower-Left Dialogue Box aligned directly beneath/beside the Barbarian Hero
    boxW = Math.min(338, Math.max(224, Math.round(longestLine * 7.0 + 36)));
    boxX = Math.max(vLeft + 16, Math.min(cx - 42, platX - 6));
    boxY = Math.min(CANVAS_H - boxH - 10, cropBottomY - boxH - 8);
    tailBaseX = Math.max(boxX + 26, Math.min(boxX + boxW - 26, heroX + 6));
    tailTipX = heroX + 2;
    tailTipY = boxY - 12;
  } else {
    // Upper-Right Dialogue Box aligned directly beneath the Monster Boss Portrait (clear of 3D Coffin!)
    boxW = Math.min(276, Math.max(204, Math.round(longestLine * 6.9 + 34)));
    boxX = Math.max(cx + 34, Math.min(vRight - boxW - 14, bossCx + bossHalf + 10 - boxW));
    boxY = Math.min(
      Math.max(bossCy + bossHalf + 30, 152),
      cropBottomY - boxH - 14,
    );
    tailBaseX = Math.max(boxX + 26, Math.min(boxX + boxW - 26, bossCx));
    tailTipX = bossCx;
    tailTipY = boxY - 11;
  }

  const speakerAccent: RgbTuple = isHeroSpeaker ? [56, 189, 248] : currentMonster.accentRgb;
  const speakerLabel = isHeroSpeaker
    ? hasActiveLyric
      ? '♪ BARBARIAN HERO'
      : 'BARBARIAN HERO'
    : hasActiveLyric
      ? `♪ ${currentMonster.name}`
      : currentMonster.name;

  ctx.save();
  const dlgGrad = ctx.createLinearGradient(boxX, boxY, boxX, boxY + boxH);
  dlgGrad.addColorStop(0, 'rgba(13, 19, 44, 0.94)');
  dlgGrad.addColorStop(1, 'rgba(4, 6, 16, 0.97)');
  ctx.fillStyle = dlgGrad;
  ctx.strokeStyle = rgbToCss(speakerAccent, 0.95);
  ctx.lineWidth = 2.0;

  // Main rounded RPG dialogue box
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  // Speech-bubble pointer triangle pointing toward Hero or Monster Portrait
  ctx.beginPath();
  ctx.moveTo(tailBaseX - 7, boxY + 1);
  ctx.lineTo(tailTipX, tailTipY);
  ctx.lineTo(tailBaseX + 7, boxY + 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Seam cover so pointer blends seamlessly into the box interior
  ctx.fillStyle = 'rgba(12, 18, 40, 0.96)';
  ctx.fillRect(tailBaseX - 6, boxY, 12, 3.5);

  // Inner filigree trim
  ctx.strokeStyle = rgbToCss(palette[6], 0.42);
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.roundRect(boxX + 3, boxY + 3, boxW - 6, boxH - 6, 4);
  ctx.stroke();

  // Speaker Name Tab (bottom-left for Hero, bottom-right for Monster)
  ctx.font = '800 8px "JetBrains Mono", monospace';
  const tabW = Math.max(88, speakerLabel.length * 5.7 + 16);
  const tabX = isHeroSpeaker ? boxX + 10 : boxX + boxW - tabW - 10;
  const tabY = boxY + boxH - 8;
  ctx.fillStyle = 'rgba(7, 10, 22, 0.97)';
  ctx.strokeStyle = rgbToCss(speakerAccent, 0.95);
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.roundRect(tabX, tabY, tabW, 14, 4);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rgbToCss(lerpRgb(speakerAccent, [255, 255, 255], 0.42), 0.98);
  ctx.fillText(speakerLabel, tabX + tabW * 0.5, tabY + 7.2);

  // Dialogue text lines (stacked multi-line stanza block)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < renderedRows.length; i++) {
    const row = renderedRows[i];
    ctx.font = row.active
      ? '700 11.5px "JetBrains Mono", Georgia, serif'
      : '600 10.5px "JetBrains Mono", Georgia, serif';
    ctx.fillStyle = row.active ? '#f8fafc' : 'rgba(203, 213, 225, 0.62)';
    ctx.fillText(row.text, boxX + boxW * 0.5, boxY + 16 + i * 15.5);
  }
  ctx.restore();

  // =========================================================================
  // 14. Top-Left SoundCloud Timed Comment Pill (Clear of Boss Portrait & Dialogue)
  // =========================================================================
  if (activeComment && activeComment.username && activeComment.body) {
    const cleanBody = activeComment.body.trim();
    const displayBody = `“${cleanBody.slice(0, 34)}${cleanBody.length > 34 ? '…' : ''}”`;
    const pillW = Math.min(248, Math.max(172, Math.round(displayBody.length * 5.8 + 48)));
    const pillH = 34;
    const px = Math.max(vLeft + 14, 16);
    const py = Math.max(cropTopY + 14, 18);

    ctx.save();
    ctx.fillStyle = 'rgba(8, 10, 22, 0.92)';
    ctx.strokeStyle = rgbToCss(palette[7], 0.9);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(px, py, pillW, pillH, 8);
    ctx.fill();
    ctx.stroke();

    let tx = px + 10;
    if (commentAvatarImg) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(px + 18, py + pillH * 0.5, 10, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(commentAvatarImg, px + 8, py + pillH * 0.5 - 10, 20, 20);
      ctx.restore();
      tx = px + 34;
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '800 8.5px "JetBrains Mono", monospace';
    ctx.fillStyle = rgbToCss(palette[6], 0.98);
    ctx.fillText(`@${activeComment.username}`, tx, py + 11);
    ctx.font = '700 9.5px sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(displayBody, tx, py + 23);
    ctx.restore();
  }

  // =========================================================================
  // 15. Classic 16-Bit RPG Battle Swirl Transition (`trans > 0.01`)
  // =========================================================================
  if (trans > 0.01) {
    const p = 1 - trans; // 0 -> 1 opening outward into the cathedral
    const wave = Math.sin(trans * Math.PI);
    const cy = CANVAS_H * 0.5;
    const maxR = Math.hypot(cx, cy) + 24;
    const blades = 12;
    const spin = trans * Math.PI * 2.4;

    ctx.save();
    ctx.translate(cx, cy);
    // Rotating gothic vortex iris blades that unwind outward to reveal the cathedral
    const innerHoleR = Math.pow(p, 1.15) * maxR;
    for (let i = 0; i < blades; i++) {
      const a0 = spin + (i / blades) * Math.PI * 2;
      const bladeSpan = ((Math.PI * 2) / blades) * Math.min(1, trans * 1.18);
      ctx.fillStyle =
        (i & 1) === 0
          ? `rgba(4, 5, 12, ${(0.88 * Math.min(1, trans * 1.3)).toFixed(2)})`
          : rgbToCss(palette[4], 0.42 * wave);
      ctx.beginPath();
      ctx.arc(0, 0, maxR, a0, a0 + bladeSpan);
      ctx.arc(0, 0, Math.max(1, innerHoleR), a0 + bladeSpan + 0.28 * trans, a0 + 0.28 * trans, true);
      ctx.closePath();
      ctx.fill();
    }

    // Glowing arcane swirl rim + initial encounter flash
    ctx.strokeStyle = rgbToCss(palette[6], 0.78 * wave);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(4, innerHoleR), 0, Math.PI * 2);
    ctx.stroke();

    if (trans > 0.80) {
      const flashA = ((trans - 0.80) / 0.20) * 0.45;
      ctx.fillStyle = `rgba(255, 255, 255, ${flashA.toFixed(2)})`;
      ctx.fillRect(-cx, -cy, CANVAS_W, CANVAS_H);
    }
    ctx.restore();
  }
}
