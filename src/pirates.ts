/*
 * Copyright (c) 2026 ThorVG project. All rights reserved.
 * MIT License. TypeScript port of thorvg-pirates.cpp on top of @thorvg/webcanvas.
 */
import type { Canvas, Matrix, Paint, Picture, Scene, Shape, Text, ThorVGNamespace } from '@thorvg/webcanvas';
import { playSound } from './sound';

export const WIDTH = 1600;
export const HEIGHT = 1024;

const FONT_NAME = '04B_30__';

const worldLeft = -0.125;
const worldRight = 1.125;
const playerLeft = -0.05;
const playerRight = 1.05;
const distantSeaLevel = 0.73 - (0.73 - 2.0 / 3.0) * 0.30;
const shipWaterline = 152.0;
const sunRadiusRatio = 0.09;
const tau = 6.283185307;

type Stop = readonly [offset: number, r: number, g: number, b: number, a: number];

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const u8 = (value: number) => clamp(Math.trunc(value), 0, 255);
const randomRange = (minimum: number, maximum: number) => minimum + Math.random() * (maximum - minimum);
const randomInt = (minimum: number, maximum: number) => minimum + Math.floor(Math.random() * (maximum - minimum + 1));
const mat = (e11: number, e12: number, e13: number, e21: number, e22: number, e23: number): Matrix =>
  ({ e11, e12, e13, e21, e22, e23, e31: 0, e32: 0, e33: 1 });

// Stable noise keeps the glints irregular without flickering between frames.
function noise(seed: number) {
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 0x7feb352d);
  seed ^= seed >>> 15;
  seed = Math.imul(seed, 0x846ca68b);
  seed ^= seed >>> 16;
  return (seed & 0xffff) / 65535.0;
}

const pirateShip = `
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="170" viewBox="0 0 180 170">
  <path d="M28 132 L20 117 L49 117 L54 130 M130 130 L136 111 L158 111 L155 132" fill="#49303e"/>
  <path d="M12 130 Q87 140 168 126 L149 151 Q91 165 39 151 Z" fill="#53333c"/>
  <path d="M16 134 Q88 144 163 131" fill="none" stroke="#d79a66" stroke-width="4"/>
  <path d="M43 147 L140 147" stroke="#9a5b49" stroke-width="2"/>
  <g fill="#efba79"><circle cx="62" cy="146" r="3"/><circle cx="85" cy="148" r="3"/><circle cx="108" cy="147" r="3"/><circle cx="131" cy="144" r="3"/></g>
</svg>`;

const skull = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="170">
<path d="M96 7 L108 12 M96 12 L108 7" stroke="#fff0d2" stroke-width="2"/>
<circle cx="102" cy="7" r="3.5" fill="#fff0d2"/>
<circle cx="101" cy="6.5" r="0.8" fill="#302733"/><circle cx="104" cy="6.5" r="0.8" fill="#302733"/>
</svg>`;

interface WaterSample { height: number; slope: number; }
interface Point { x: number; y: number; }

interface ScorePopup { text: Text; x: number; y: number; birth: number; active: boolean; }
interface SeaLayer { level: number; amplitude: number; frequency: number; speed: number; phase: number; shape: Shape | null; }
interface Impact { position: number; birth: number; strength: number; sampleTime: number; amplitude: number; }
interface Droplet { shape: Shape; x: number; y: number; vx: number; vy: number; birth: number; lifetime: number; active: boolean; }
interface Debris extends Droplet { spin: number; }
interface Star { shape: Shape; phase: number; speed: number; brightness: number; }
interface Cloud { scene: Scene; shape: Shape; x: number; y: number; width: number; height: number; speed: number; delay: number; }
interface Crate { scene: Scene; position: number; active: boolean; }

interface Cannonball {
  shape: Shape | null;
  speedLines: Shape | null;
  speedLineCount: number;
  speedLineOffsets: number[];
  speedLineLengths: number[];
  x: number; y: number; vx: number; vy: number;
  active: boolean;
  submerged: boolean;
  enemyShot: boolean;
  sinkTime: number;
}

interface Vessel {
  position: number;
  enemy: boolean;
  phase: number;
  patrolCenter: number;
  patrolRadius: number;
  patrolSpeed: number;
  hitStart: number;
  health: number;
  patrolStart: number;
  sinkStart: number; sinkY: number; sinkAngle: number;
  ship: Scene | null;
  rig: Scene | null;
  sail: Shape | null;
  sailFolds: Shape | null;
  sailHighlights: Shape | null;
  flag: Shape | null;
  emblem: Picture | null;
  cannon: Shape | null;
  nextAttack: number; attackCharge: number; aimOffset: number;
  attackCharging: boolean;
  fire: Scene | null;
  flames: Shape[];
  flameCores: Shape[];
  flamePositions: Point[];
  flameCount: number;
  reflection: Paint | null;
  reflectionTime: number;
  recoilStart: number; recoilDirection: number;
  waterAngle: number; waterAngleTime: number;
  // webcanvas has no transform getter, so the matrices that gameplay reads back are tracked here.
  shipMatrix: Matrix;
  rigMatrix: Matrix;
}

function makeVessel(position: number, enemy: boolean, phase: number,
  patrolCenter = 0.0, patrolRadius = 0.0, patrolSpeed = 0.0): Vessel {
  return {
    position, enemy, phase, patrolCenter, patrolRadius, patrolSpeed,
    hitStart: -10.0, health: 3, patrolStart: 0.0, sinkStart: 0.0, sinkY: 0.0, sinkAngle: 0.0,
    ship: null, rig: null, sail: null, sailFolds: null, sailHighlights: null, flag: null, emblem: null, cannon: null,
    nextAttack: 0.0, attackCharge: 0.0, aimOffset: 0.0, attackCharging: false,
    fire: null, flames: [], flameCores: [], flamePositions: [], flameCount: 0,
    reflection: null, reflectionTime: -1.0,
    recoilStart: -10.0, recoilDirection: 1.0, waterAngle: 0.0, waterAngleTime: -1.0,
    shipMatrix: mat(1, 0, 0, 0, 1, 0), rigMatrix: mat(1, 0, 0, 0, 1, 0),
  };
}

const initialVessels = () => [
  makeVessel(0.75, false, 0.0),
  makeVessel(0.12, true, 0.8, 0.12, 0.03, 0.65),
  makeVessel(0.25, true, 1.6, 0.25, 0.025, -0.50),
  makeVessel(0.38, true, 2.4, 0.38, 0.03, 0.40),
];

const makeCannonball = (): Cannonball => ({
  shape: null, speedLines: null, speedLineCount: 3, speedLineOffsets: [], speedLineLengths: [],
  x: 0, y: 0, vx: 0, vy: 0, active: false, submerged: false, enemyShot: false, sinkTime: 0,
});

const makeImpact = (position = 0.0, birth = 0.0, strength = 0.0): Impact =>
  ({ position, birth, strength, sampleTime: -1.0, amplitude: 0.0 });

export class ThorPirates {
  private readonly size = { w: WIDTH, h: HEIGHT };

  private screen!: Scene;
  private screenShakeTime = 0.0;
  private world!: Scene;
  private cameraZoom = 1.0;
  private cameraX = 0.5;
  private cameraY = 0.5;

  private gameOver!: Scene;
  private restartRequested = false;
  private spaceHeld = false;
  private fontLoaded = false;
  private gameStart = 0;
  private scoreText!: Text;
  private score = 0;
  private scorePopups: ScorePopup[] = [];
  private nextScorePopup = 0;

  private sea!: Shape;
  private seaLayers: SeaLayer[] = [
    { level: 0.73, amplitude: 0.010, frequency: 4.5, speed: 0.85, phase: 0.6, shape: null },
    { level: 0.80, amplitude: 0.018, frequency: 3.2, speed: 0.70, phase: 1.3, shape: null },
    { level: 0.87, amplitude: 0.022, frequency: 2.3, speed: 0.55, phase: 2.0, shape: null },
  ];
  private sun!: Shape;
  private sunGlow!: Shape;
  private sunClip!: Shape;
  private sunReflections: (Shape | null)[] = [null, null, null, null];

  private impacts: Impact[] = [];
  private nextImpact = 0;
  private droplets: Droplet[] = [];
  private nextDroplet = 0;
  private debris: Debris[] = [];
  private nextDebris = 0;

  private cannonballs: Cannonball[] = [];
  private nextCannonball = 0;
  private cannon!: Shape;
  private aimGuide!: Shape;
  private cannonAngle = 35.0;
  private aimingUp = false;
  private aimingDown = false;
  private charging = false;
  private chargeGauge!: Scene;
  private chargeFill!: Shape;
  private reloadLabel!: Text;
  private chargeStart = 0.0;
  private reloadReady = 0.0;

  private vessels: Vessel[] = initialVessels();
  private fleet!: Scene;
  private reflectionLayer!: Scene;
  private reflectionClip!: Shape;
  private nextEnemySpawn = 20000;
  private crateLayer!: Scene;
  private crates: Crate[] = [];

  private stars: Star[] = [];
  private clouds: Cloud[] = [];

  private lastFrame = 0;
  private movingLeft = false;
  private movingRight = false;
  // Monotonic game clock in seconds; stands in for std::chrono::steady_clock.
  private clock = 0.0;

  constructor(private readonly TVG: ThorVGNamespace, private readonly canvas: Canvas,
    private readonly GPU: boolean, private readonly fontData: Uint8Array) {}

  private linear(x1: number, y1: number, x2: number, y2: number, stops: readonly Stop[]) {
    const gradient = new this.TVG.LinearGradient(x1, y1, x2, y2);
    for (const [offset, r, g, b, a] of stops) gradient.addStop(offset, [r, g, b, a]);
    return gradient;
  }

  private radial(cx: number, cy: number, r: number, fx: number, fy: number, fr: number, stops: readonly Stop[]) {
    const gradient = new this.TVG.RadialGradient(cx, cy, r, fx, fy, fr);
    for (const [offset, red, g, b, a] of stops) gradient.addStop(offset, [red, g, b, a]);
    return gradient;
  }

  /** Stereo position of a world-space x coordinate as seen through the camera. */
  private panAt(x: number) {
    return 1.4 * (x / this.size.w - this.cameraX) * this.cameraZoom;
  }

  private updateCamera(dt: number) {
    let targetZoom = 0.8;
    let targetX = 0.5, targetY = 0.5;
    const player = this.vessels[0];
    if (player.health > 0) {
      let nearestDistance = 2.0;
      let enemyPosition = player.position;
      for (const vessel of this.vessels) {
        if (!vessel.enemy || vessel.health === 0 || vessel.position < worldLeft || vessel.position > worldRight) continue;
        const distance = Math.abs(vessel.position - player.position);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          enemyPosition = vessel.position;
        }
      }
      const proximity = clamp((0.75 - nearestDistance) / 0.5625, 0.0, 1.0);
      const blend = proximity * proximity * (3.0 - 2.0 * proximity);
      targetZoom += 0.50 * blend;
      targetX += ((player.position + enemyPosition) * 0.5 - 0.5) * blend;
      targetY += 0.10 * blend;
    }
    const smoothing = 1.0 - Math.exp(-2.5 * Math.min(dt, 0.1));
    this.cameraZoom += (targetZoom - this.cameraZoom) * smoothing;
    this.cameraX += (targetX - this.cameraX) * smoothing;
    this.cameraY += (targetY - this.cameraY) * smoothing;
    // Clamp the viewport within the world so zooming never exposes empty edges.
    const halfView = 0.5 / this.cameraZoom;
    this.cameraX = clamp(this.cameraX, worldLeft + halfView, worldRight - halfView);
    this.cameraY = clamp(this.cameraY, worldLeft + halfView, worldRight - halfView);
    this.world.transform(mat(this.cameraZoom, 0.0, this.size.w * (0.5 - this.cameraX * this.cameraZoom),
      0.0, this.cameraZoom, this.size.h * (0.5 - this.cameraY * this.cameraZoom)));
  }

  private updateScreenShake(dt: number) {
    if (this.screenShakeTime <= 0.0) return;
    this.screenShakeTime = Math.max(0.0, this.screenShakeTime - dt);
    const age = 0.45 - this.screenShakeTime;
    const fade = this.screenShakeTime / 0.45;
    const envelope = fade * fade;
    const amplitude = this.size.h * 0.007 * envelope;
    const x = amplitude * Math.sin(age * 83.0);
    const y = amplitude * 0.7 * Math.sin(age * 107.0 + 0.8);
    // A small overscan keeps screen edges covered even at the widest camera zoom.
    const zoom = 1.0 + 0.025 * envelope;
    this.screen.transform(mat(zoom, 0, x + this.size.w * (1.0 - zoom) * 0.5,
      0, zoom, y + this.size.h * (1.0 - zoom) * 0.5));
  }

  private createFloatingLabel(x: number, y: number, time: number) {
    const popup = this.scorePopups[this.nextScorePopup];
    this.nextScorePopup = (this.nextScorePopup + 1) % 24;
    popup.x = x;
    popup.y = y - this.size.h * 0.02;
    popup.birth = time;
    popup.active = true;
    popup.text.translate(popup.x, popup.y);
    popup.text.opacity(255);
    return popup.text;
  }

  private showScorePopup(points: number, x: number, y: number, time: number) {
    const text = this.createFloatingLabel(x, y, time);
    text.text(points === 100 ? '+100' : '+30');
    text.fontSize(points === 100 ? 25.0 : 20.0);
    text.fill(255, points === 100 ? 208 : 239, points === 100 ? 110 : 205);
  }

  private updateScorePopups(time: number) {
    for (const popup of this.scorePopups) {
      if (!popup.active) continue;
      const age = Math.max(0.0, time - popup.birth);
      if (age >= 1.2) {
        popup.active = false;
        popup.text.opacity(0);
        continue;
      }
      popup.text.translate(popup.x, popup.y - this.size.h * 0.045 * age);
      popup.text.opacity(u8(255.0 * Math.min(1.0, (1.2 - age) / 0.7)));
    }
  }

  private addScore(points: number) {
    this.score += points;
    this.scoreText.text(`Score: ${this.score}`);
  }

  private updateSunReflections(time: number) {
    if (!this.GPU) return;

    const width = this.size.w;
    const height = this.size.h;
    // Share wave samples across all glints instead of evaluating waves per endpoint.
    const sampleCount = 96;
    const sampleStep = (worldRight - worldLeft) / sampleCount;
    const heights = new Float64Array(sampleCount + 1);
    const slopes = new Float64Array(sampleCount + 1);
    const water: WaterSample = { height: 0, slope: 0 };
    const surface = (u: number) => {
      const position = clamp((u - worldLeft) / sampleStep, 0.0, sampleCount);
      const i = Math.min(Math.trunc(position), sampleCount - 1);
      const t = position - i;
      const c = sampleStep * slopes[i];
      const d = 3.0 * (heights[i + 1] - heights[i]) - sampleStep * (2.0 * slopes[i] + slopes[i + 1]);
      const e = 2.0 * (heights[i] - heights[i + 1]) + sampleStep * (slopes[i] + slopes[i + 1]);
      water.height = heights[i] + t * (c + t * (d + t * e));
      water.slope = (c + t * (2.0 * d + 3.0 * t * e)) / sampleStep;
      return water;
    };
    for (let layer = 1; layer < 4; ++layer) {
      const shape = this.sunReflections[layer]!;
      shape.reset();
      const level = this.seaLayers[layer - 1].level;
      const end = layer < 3 ? this.seaLayers[layer].level : worldRight;
      for (let i = 0; i <= sampleCount; ++i) {
        const sample = this.layerSample(this.seaLayers[layer - 1], worldLeft + sampleStep * i, time);
        heights[i] = sample.height;
        slopes[i] = sample.slope;
      }
      const rows = layer === 3 ? 70 : 32;
      for (let row = 0; row < rows; ++row) {
        const seed = 1 + layer * 10000 + row * 37;
        const offset = (end - level) * (row + noise(seed)) / rows;
        const distance = clamp((level + offset - distantSeaLevel) / 0.4, 0.0, 1.0);
        const phase = noise(seed + 1) * 6.2831853;
        const spread = (height * sunRadiusRatio / width) * (0.95 + distance * 2.05);
        const center = 0.5 + 0.004 * Math.sin(time * 0.9 + phase);
        const fragments = row % 2 === 0 ? 7 : 5;
        for (let fragment = 0; fragment < fragments; ++fragment) {
          const scattered = fragment >= 3;
          const key = seed + fragment * 101;
          const lateral = noise(key + 2) * 2.0 - 1.0;
          const edge = lateral * lateral;
          const edgeSpread = 1.0 + edge * (noise(key + 7) * 1.4 - 0.45);
          const half = (0.0015 + noise(key + 3) * 0.010) * (0.7 + distance)
            * (0.8 + 0.2 * Math.sin(time * 1.6 + phase + fragment))
            * (scattered ? 0.7 : 1.0);
          const x = scattered
            ? worldLeft + 0.025 + (worldRight - worldLeft - 0.05)
              * ((((row + fragment) % 4) + noise(key + 2)) / 4.0)
              + 0.002 * Math.sin(time * 0.8 + phase + fragment)
            : center + lateral * Math.max(0.0, spread - half) * edgeSpread;
          const irregularOffset = Math.max(0.0, offset
            + (end - level) / rows * (noise(key + 8) - 0.5)
              * (scattered ? 1.0 : 3.0 * edge));
          const left = (x - half) * width;
          const right = (x + half) * width;
          const waveFollow = 0.65;
          const leftWater = surface(x - half);
          const leftY = height * (level + irregularOffset + waveFollow * (leftWater.height - level));
          const leftSlope = leftWater.slope;
          const rightWater = surface(x + half);
          const rightY = height * (level + irregularOffset + waveFollow * (rightWater.height - level));
          const rightSlope = rightWater.slope;
          const tangentScale = height * waveFollow * (2.0 * half / 3.0);
          const controlLeftY = leftY + leftSlope * tangentScale;
          const controlRightY = rightY - rightSlope * tangentScale;
          const third = (right - left) / 3.0;
          const thickness = height * (0.00025 + 0.00065 * noise(key + 4))
            * (0.7 + distance * 0.6) * (scattered ? 0.4 : 1.0);
          shape.moveTo(left, leftY);
          shape.cubicTo(left + third, controlLeftY - thickness,
            right - third, controlRightY - thickness, right, rightY);
          shape.cubicTo(right - third, controlRightY + thickness,
            left + third, controlLeftY + thickness, left, leftY);
          shape.close();
        }
      }
    }
  }

  private createSunReflection(layer: number) {
    const shape = new this.TVG.Shape();
    this.sunReflections[layer] = shape;
    shape.fill(250, 218, 184);
    const reflection = new this.TVG.Scene();
    reflection.add(shape);
    reflection.blend(this.TVG.BlendMethod.SoftLight);
    if (this.GPU) reflection.gaussianBlur(1.5, 0, 0, 20);
    return reflection;
  }

  private shatter(x: number, y: number, time: number, count = 32) {
    for (let i = 0; i < count; ++i) {
      const piece = this.debris[this.nextDebris];
      this.nextDebris = (this.nextDebris + 1) % 256;
      piece.x = x;
      piece.y = y;
      piece.vx = randomRange(-0.10, 0.10) * this.size.w;
      piece.vy = randomRange(-0.22, 0.035) * this.size.h;
      piece.birth = time;
      piece.lifetime = randomRange(0.7, 1.4);
      piece.spin = randomRange(-12.0, 12.0);
      piece.active = true;
      const length = randomRange(3.0, 8.0) * this.size.h / 1280.0;
      piece.shape.reset();
      piece.shape.moveTo(-length, -length * 0.3);
      piece.shape.lineTo(length, -length * 0.15);
      piece.shape.lineTo(length * 0.4, length * 0.5);
      piece.shape.close();
      if (i % 3 === 0) piece.shape.fill(65, 35, 40);
      else if (i % 3 === 1) piece.shape.fill(75, 50, 35);
      else piece.shape.fill(35, 35, 45);
      piece.shape.transform(mat(1, 0, x, 0, 1, y));
      piece.shape.opacity(255);
    }
  }

  private updateDebris(time: number) {
    for (const piece of this.debris) {
      if (!piece.active) continue;
      const age = time - piece.birth;
      const x = piece.x + piece.vx * age;
      const y = piece.y + piece.vy * age + this.size.h * 0.25 * age * age;
      if (age >= piece.lifetime || y > this.size.h * worldRight || x < this.size.w * worldLeft - 20.0 || x > this.size.w * worldRight + 20.0) {
        piece.active = false;
        piece.shape.opacity(0);
        continue;
      }
      const c = Math.cos(age * piece.spin);
      const s = Math.sin(age * piece.spin);
      piece.shape.transform(mat(c, -s, x, s, c, y));
      piece.shape.opacity(u8(255.0 * (1.0 - age / piece.lifetime)));
    }
  }

  private hitEnemy(fromX: number, fromY: number, toX: number, toY: number, targetEnemies: boolean) {
    let hitTime = 2.0;
    let hitIndex = -1;
    this.vessels.forEach((vessel, index) => {
      if (vessel.enemy !== targetEnemies || vessel.health === 0) return;
      const m = vessel.shipMatrix;
      const determinant = m.e11 * m.e22 - m.e12 * m.e21;
      if (Math.abs(determinant) < 0.000001) return;
      const local = (x: number, y: number): Point => {
        x -= m.e13;
        y -= m.e23;
        return { x: (m.e22 * x - m.e12 * y) / determinant, y: (-m.e21 * x + m.e11 * y) / determinant };
      };
      const start = local(fromX, fromY);
      const end = local(toX, toY);
      const radius = this.size.h * 0.0105 * 0.8 / Math.hypot(m.e11, m.e21);
      // Sweep through separate hull, sail and mast bounds to avoid tunneling.
      const box = (a: Point, b: Point, left: number, top: number, right: number, bottom: number) => {
        let entry = 0.0, exit = 1.0;
        const slab = (origin: number, delta: number, low: number, high: number) => {
          if (Math.abs(delta) < 0.000001) return origin >= low && origin <= high;
          let near = (low - origin) / delta;
          let far = (high - origin) / delta;
          if (near > far) [near, far] = [far, near];
          entry = Math.max(entry, near);
          exit = Math.min(exit, far);
          return entry <= exit;
        };
        if (slab(a.x, b.x - a.x, left - radius, right + radius) &&
          slab(a.y, b.y - a.y, top - radius, bottom + radius)) {
          if (entry < hitTime) {
            hitTime = entry;
            hitIndex = index;
          }
        }
      };
      box(start, end, 20.0, 127.0, 162.0, 154.0);
      const rig = vessel.rigMatrix;
      const rigStart = { x: start.x - rig.e12 * start.y - rig.e13, y: start.y };
      const rigEnd = { x: end.x - rig.e12 * end.y - rig.e13, y: end.y };
      box(rigStart, rigEnd, 46.0, 51.0, 130.0, 99.0);
      box(rigStart, rigEnd, 84.5, 3.0, 89.5, 132.0);
    });
    return { hit: hitTime <= 1.0, hitTime, hitIndex };
  }

  private splash(x: number, y: number, time: number, strength: number) {
    const power = clamp(strength / 0.022, 0.7, 1.4);
    const riseScale = 2.0;  // Height is proportional to launch speed squared.
    for (let i = 0; i < 120; ++i) {
      const drop = this.droplets[this.nextDroplet];
      this.nextDroplet = (this.nextDroplet + 1) % 1152;
      drop.x = x + randomRange(-0.001, 0.001) * this.size.w;
      drop.y = y - this.size.h * 0.004;
      const spread = (i + randomRange(0.0, 1.0)) / 120.0;
      // Sample a radial fan around the upward direction, rather than independent X/Y speeds.
      const angle = (spread * 2.0 - 1.0) * 1.134464;
      const speed = this.size.h * 0.23 * power * riseScale * Math.sqrt(randomRange(0.16, 1.0));
      drop.vx = Math.sin(angle) * speed * 0.5;
      drop.vy = -Math.cos(angle) * speed;
      drop.birth = time;
      drop.lifetime = -2.0 * drop.vy / (this.size.h * 0.65) + 0.2;
      drop.active = true;
      const radius = randomRange(0.75, 1.75) * this.size.h / 1280.0;
      drop.shape.reset();
      drop.shape.appendCircle(0.0, 0.0, radius, radius * 3.0);
      drop.shape.translate(drop.x, drop.y);
      drop.shape.opacity(255);
    }
  }

  private updateDroplets(time: number) {
    const gravity = this.size.h * 0.65;
    for (const drop of this.droplets) {
      if (!drop.active) continue;
      const age = time - drop.birth;
      const x = drop.x + drop.vx * age;
      const y = drop.y + drop.vy * age + 0.5 * gravity * age * age;
      if (age >= drop.lifetime || x < this.size.w * worldLeft - 10.0 || x > this.size.w * worldRight + 10.0 ||
        (drop.vy + gravity * age > 0.0 && y >= this.size.h * this.sailingSurface(x / this.size.w, time).height)) {
        drop.active = false;
        drop.shape.opacity(0);
      } else {
        drop.shape.translate(x, y);
        const fade = clamp((age / drop.lifetime - 0.7) / 0.3, 0.0, 1.0);
        drop.shape.opacity(u8(255.0 * (1.0 - fade)));
      }
    }
  }

  private impactSample(u: number, time: number): WaterSample {
    const result = { height: 0.0, slope: 0.0 };
    for (const impact of this.impacts) {
      const age = time - impact.birth;
      if (impact.strength === 0.0 || age <= 0.0 || age >= 4.0) continue;
      if (impact.sampleTime !== time) {
        const fade = 1.0 - age / 4.0;
        impact.amplitude = impact.strength * Math.min(age / 0.08, 1.0) *
          fade * fade * Math.exp(-age * 0.6);
        impact.sampleTime = time;
      }
      for (const direction of [-1.0, 1.0]) {
        const z = (u - impact.position - direction * age * 0.13) / 0.035;
        if (Math.abs(z) > 4.0) continue;
        const envelope = impact.amplitude * Math.exp(-z * z);
        result.height += envelope * Math.cos(3.0 * z);
        result.slope += envelope * (-2.0 * z * Math.cos(3.0 * z)
          - 3.0 * Math.sin(3.0 * z)) / 0.035;
      }
    }
    return result;
  }

  private surfaceSample(u: number, time: number): WaterSample {
    return {
      height: distantSeaLevel + 0.006 * (Math.sin(tau * 9.0 * u - time * 1.0)
        + 0.35 * Math.sin(tau * 15.0 * u + time * 0.7)),
      slope: 0.006 * tau * (9.0 * Math.cos(tau * 9.0 * u - time * 1.0)
        + 5.25 * Math.cos(tau * 15.0 * u + time * 0.7)),
    };
  }

  private layerSample(layer: SeaLayer, u: number, time: number): WaterSample {
    const frequency = tau * layer.frequency;
    const a = frequency * u - time * layer.speed + layer.phase;
    const b = frequency * 1.8 * u + time * layer.speed * 0.7;
    const ripple = layer === this.seaLayers[0] ? this.impactSample(u, time) : { height: 0.0, slope: 0.0 };
    return {
      height: layer.level + layer.amplitude * (Math.sin(a) + 0.25 * Math.sin(b)) + ripple.height,
      slope: layer.amplitude * frequency * (Math.cos(a) + 0.45 * Math.cos(b)) + ripple.slope,
    };
  }

  private sailingSurface(u: number, time: number) {
    return this.layerSample(this.seaLayers[0], u, time);
  }

  private aimCannon() {
    const angle = this.cannonAngle * 0.01745329252;
    this.cannon.reset();
    this.cannon.moveTo(38.0, 127.0);
    this.cannon.lineTo(38.0 - 27.0 * Math.cos(angle), 127.0 - 27.0 * Math.sin(angle));
  }

  private randomizeSpeedLines(ball: Cannonball) {
    ball.speedLineCount = randomInt(3, 6);
    for (let i = 0; i < ball.speedLineCount; ++i) {
      ball.speedLineOffsets[i] = randomRange(-0.95, 0.95);
      ball.speedLineLengths[i] = randomRange(0.4, 1.0);
    }
  }

  private speedGradient(start: number) {
    return this.linear(start, 0.0, 0.0, 0.0, [
      [0.0, 255, 255, 255, 0],
      [0.65, 255, 255, 255, 150],
      [1.0, 255, 255, 255, 230],
    ]);
  }

  private updateSpeedLines(ball: Cannonball) {
    const speedLines = ball.speedLines!;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (!ball.active || ball.submerged || speed < 40.0) {
      speedLines.opacity(0);
      return;
    }
    const radius = this.size.h * 0.0105 * 0.8;
    const length = clamp(speed * 0.09, radius * 2.0, radius * 9.0) * 1.5;
    const c = ball.vx / speed;
    const s = ball.vy / speed;
    const lookback = length / speed;
    const curve = c * this.size.h * 0.25 * lookback * lookback;
    speedLines.reset();
    for (let i = 0; i < ball.speedLineCount; ++i) {
      const offset = ball.speedLineOffsets[i] * radius;
      const front = -Math.sqrt(radius * radius - offset * offset) - radius * 0.15;
      const lineLength = length * ball.speedLineLengths[i];
      const tail = front - lineLength;
      const lineCurve = curve * ball.speedLineLengths[i] * ball.speedLineLengths[i];
      speedLines.moveTo(front, offset);
      speedLines.cubicTo(front - lineLength * 0.3, offset,
        tail + lineLength * 0.3, offset + lineCurve * 0.4, tail, offset + lineCurve);
    }
    // Gradients are immutable once built in webcanvas; replace the stroke fill instead.
    speedLines.stroke({ gradient: this.speedGradient(-radius * 1.3 - length) });
    speedLines.transform(mat(c, -s, ball.x, s, c, ball.y));
    speedLines.opacity(220);
  }

  private positionCannonball(ball: Cannonball) {
    const dx = this.size.w * 0.5 - ball.x;
    const dy = this.size.h * distantSeaLevel - ball.y;
    const distance = Math.hypot(dx, dy);
    const c = distance > 0.001 ? dx / distance : 1.0;
    const s = distance > 0.001 ? dy / distance : 0.0;
    ball.shape!.transform(mat(c, -s, ball.x, s, c, ball.y));
    this.updateSpeedLines(ball);
  }

  private updateChargeGauge() {
    if (this.vessels[0].health === 0) {
      this.charging = false;
      this.chargeGauge.opacity(0);
      return;
    }
    const now = this.clock;
    const reloading = now < this.reloadReady;
    this.reloadLabel.opacity(reloading ? 255 : 0);
    this.chargeGauge.opacity((this.charging || reloading) ? 255 : 0);
    if (!this.charging && !reloading) return;
    const seconds = now - this.chargeStart;
    const progress = reloading
      ? clamp(1.0 - (this.reloadReady - now) / 3.0, 0.0, 1.0)
      : clamp(seconds * 1.5 / 4.0, 0.0, 1.0);
    this.chargeFill.reset();
    if (progress > 0.0) this.chargeFill.appendRect(3.0, 3.0, 114.0 * progress, 8.0, { rx: 2.0, ry: 2.0 });
    if (reloading) this.chargeFill.fill(125, 180, 225);
    else this.chargeFill.fill(255, u8(210.0 - 110.0 * progress), 75);
    const transform = this.vessels[0].shipMatrix;
    const scale = this.size.w * 0.08 / 120.0;
    const x = transform.e11 * 87.0 + transform.e12 * -30.0 + transform.e13;
    const y = transform.e21 * 87.0 + transform.e22 * -30.0 + transform.e23;
    this.chargeGauge.transform(mat(scale, 0.0, x - 60.0 * scale, 0.0, scale, y - 14.0 * scale));
  }

  private playerLaunch(charge: number, ball: { x: number; y: number; vx: number; vy: number }) {
    const transform = this.vessels[0].shipMatrix;
    const angle = this.cannonAngle * 0.01745329252;
    const dx = -Math.cos(angle);
    const dy = -Math.sin(angle);
    const muzzleX = 38.0 + 27.0 * dx;
    const muzzleY = 127.0 + 27.0 * dy;
    ball.x = transform.e11 * muzzleX + transform.e12 * muzzleY + transform.e13;
    ball.y = transform.e21 * muzzleX + transform.e22 * muzzleY + transform.e23;
    const worldX = transform.e11 * dx + transform.e12 * dy;
    const worldY = transform.e21 * dx + transform.e22 * dy;
    // Range at a fixed angle is proportional to speed squared, hence charge time.
    const speed = Math.sqrt(0.135 * this.size.w * this.size.h * Math.max(charge, 0.0));
    const scale = speed / Math.hypot(worldX, worldY);
    ball.vx = worldX * scale;
    ball.vy = worldY * scale;
  }

  private updateAimGuide() {
    const now = this.clock;
    this.aimGuide.reset();
    if (this.vessels[0].health === 0 || now < this.reloadReady) {
      this.aimGuide.opacity(0);
      return;
    }
    const charge = this.charging ? now - this.chargeStart : 1.0;
    const preview = { x: 0, y: 0, vx: 0, vy: 0 };
    this.playerLaunch(charge, preview);
    const gravity = this.size.h * 0.5;
    const spacing = this.size.w * 0.006;
    let distance = 0.0;
    let nextDot = spacing;
    let previousX = preview.x, previousY = preview.y;
    let dots = 0;
    for (let step = 1; step <= 100 && dots < 9; ++step) {
      const t = step * 0.004;
      const x = preview.x + preview.vx * t;
      const y = preview.y + preview.vy * t + 0.5 * gravity * t * t;
      distance += Math.hypot(x - previousX, y - previousY);
      if (distance >= nextDot) {
        const radius = this.size.h * 0.0015;
        this.aimGuide.appendCircle(x, y, radius, radius);
        nextDot += spacing;
        ++dots;
      }
      previousX = x;
      previousY = y;
    }
    this.aimGuide.opacity(190);
  }

  private launch(ball: Cannonball, enemyShot: boolean) {
    ball.active = true;
    this.randomizeSpeedLines(ball);
    ball.enemyShot = enemyShot;
    ball.submerged = false;
    ball.sinkTime = 0.0;
    this.positionCannonball(ball);
    ball.shape!.opacity(255);
  }

  private fire(charge: number) {
    if (this.vessels[0].health === 0) return;
    const now = this.clock;
    if (now < this.reloadReady) return;
    this.reloadReady = now + 3.0;
    const ball = this.cannonballs[this.nextCannonball];
    this.nextCannonball = (this.nextCannonball + 1) % 32;
    this.playerLaunch(charge, ball);
    this.vessels[0].recoilStart = this.lastFrame * 0.001;
    this.vessels[0].recoilDirection = ball.vx < 0.0 ? 1.0 : -1.0;
    this.launch(ball, false);
    playSound('cannon', 1.0, this.panAt(ball.x));
  }

  private updateCannonballs(dt: number, time: number) {
    const gravity = this.size.h * 0.5;
    for (const ball of this.cannonballs) {
      if (!ball.active) continue;
      const previousX = ball.x;
      const previousY = ball.y;
      if (ball.submerged) {
        const drag = Math.exp(-3.0 * dt);
        const terminalSpeed = this.size.h * 0.075;
        ball.x += ball.vx * (1.0 - drag) / 3.0;
        ball.y += terminalSpeed * dt + (ball.vy - terminalSpeed) * (1.0 - drag) / 3.0;
        ball.vx *= drag;
        ball.vy = terminalSpeed + (ball.vy - terminalSpeed) * drag;
        ball.sinkTime += dt;
        ball.shape!.opacity(u8(255.0 * Math.max(0.0, 1.0 - ball.sinkTime / 3.0)));
      } else {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt + 0.5 * gravity * dt * dt;
        ball.vy += gravity * dt;
      }
      const { hit, hitTime, hitIndex } = ball.submerged
        ? { hit: false, hitTime: 2.0, hitIndex: -1 }
        : this.hitEnemy(previousX, previousY, ball.x, ball.y, !ball.enemyShot);
      if (hit) {
        const target = this.vessels[hitIndex];
        const hitX = previousX + (ball.x - previousX) * hitTime;
        const hitY = previousY + (ball.y - previousY) * hitTime;
        if (target.enemy) {
          this.addScore(30);
          this.showScorePopup(30, hitX, hitY, time);
        }
        else this.screenShakeTime = 0.45;
        target.hitStart = time;
        if (target.flameCount < 7) {
          target.flamePositions[target.flameCount++] = { x: randomRange(35.0, 145.0), y: randomRange(118.0, 130.0) };
        }
        if (--target.health === 0) {
          if (target.enemy && randomRange(0.0, 1.0) < 0.5) this.spawnCrate(target.position);
          target.sinkStart = time;
          const m = target.shipMatrix;
          target.sinkY = m.e21 * 90.0 + m.e22 * shipWaterline + m.e23;
          target.sinkAngle = Math.atan2(m.e21, m.e11);
          playSound('sink', 1.0, this.panAt(hitX));
          if (!target.enemy) playSound('gameover', 0.8);
        } else {
          playSound('hit', target.enemy ? 0.8 : 1.0, this.panAt(hitX));
        }
        this.updateFlames(target, time);
        this.shatter(hitX, hitY, time, target.enemy && target.health === 0 ? 160 : 32);
        ball.active = false;
        ball.shape!.opacity(0);
        ball.speedLines!.opacity(0);
        continue;
      }
      const u = ball.x / this.size.w;
      const surface = this.size.h * this.sailingSurface(u, time).height;
      if (!ball.submerged && u >= worldLeft && u <= worldRight && ball.vy > 0.0 && ball.y >= surface) {
        const strength = 0.022 * clamp(ball.vy / (this.size.h * 0.25), 0.6, 1.5);
        this.impacts[this.nextImpact] = makeImpact(u, time, strength);
        this.nextImpact = (this.nextImpact + 1) % 16;
        this.splash(ball.x, surface, time, strength);
        playSound('splash', clamp(strength / 0.03, 0.4, 1.0), this.panAt(ball.x));
        ball.submerged = true;
        ball.vx *= 0.3;
        ball.vy *= 0.3;
      }
      if (ball.x < this.size.w * worldLeft - 16.0 || ball.x > this.size.w * worldRight + 16.0 ||
        ball.y > this.size.h * worldRight + 16.0 || ball.sinkTime >= 3.0) {
        ball.active = false;
        ball.shape!.opacity(0);
        ball.speedLines!.opacity(0);
      } else {
        this.positionCannonball(ball);
      }
    }
  }

  private updateFlames(vessel: Vessel, time: number) {
    vessel.fire!.opacity(vessel.flameCount > 0 ? 255 : 0);
    for (let i = 0; i < vessel.flameCount; ++i) {
      const phase = time * 11.0 + i * 1.7 + vessel.phase;
      const x = vessel.flamePositions[i].x;
      const height = 40.0 + 11.0 * Math.sin(phase) + 6.0 * Math.sin(phase * 1.73);
      const sway = 7.0 * Math.sin(phase * 0.8);
      const flame = (shape: Shape, width: number, h: number, drift: number) => {
        shape.reset();
        shape.moveTo(x - width, 131.0);
        shape.cubicTo(x - width * 1.4, 131.0 - h * 0.35,
          x + drift - width * 0.4, 131.0 - h * 0.65, x + drift, 131.0 - h);
        shape.cubicTo(x + drift + width * 0.2, 131.0 - h * 0.65,
          x + width * 1.5, 131.0 - h * 0.3, x + width, 131.0);
        shape.cubicTo(x + width * 0.5, 136.0, x - width * 0.5, 136.0, x - width, 131.0);
        shape.close();
        shape.translate(0.0, vessel.flamePositions[i].y - 131.0);
      };
      flame(vessel.flames[i], 12.0, height, sway);
      flame(vessel.flameCores[i], 6.0, height * 0.65, sway * 0.5);
    }
  }

  private updateReflections(time: number) {
    // Reuse reflected geometry between snapshots; movement stays frame-smooth.
    // (The clip path itself is traced together with the front sea layer in waves().)
    for (const vessel of this.vessels) {
      if (!vessel.ship) continue;
      if (!vessel.reflection || time - vessel.reflectionTime >= 0.1) {
        this.dropReflection(vessel);
        vessel.reflection = vessel.ship.duplicate<Scene>();
        this.reflectionLayer.add(vessel.reflection);
        vessel.reflectionTime = time;
      }
      const m = vessel.shipMatrix;
      const waterY = this.size.h * this.sailingSurface(vessel.position, time).height;
      const shear = 0.035 * Math.sin(time * 2.7 + vessel.phase);
      const offset = this.size.w * 0.0015 * Math.sin(time * 3.4 + vessel.phase);
      const compression = 0.55;
      vessel.reflection.transform(mat(
        m.e11 + shear * m.e21, m.e12 + shear * m.e22,
        m.e13 + shear * (m.e23 - waterY) + offset,
        -compression * m.e21, -compression * m.e22,
        waterY + compression * (waterY - m.e23)));
      const fade = vessel.health > 0 ? 1.0
        : Math.max(0.0, 1.0 - (time - vessel.sinkStart) / 1.5);
      vessel.reflection.opacity(u8(128.0 * fade));
    }
  }

  private dropReflection(vessel: Vessel) {
    if (!vessel.reflection) return;
    this.reflectionLayer.remove(vessel.reflection);
    // Snapshots are replaced ten times a second; free them eagerly rather than waiting for GC.
    vessel.reflection.dispose();
    vessel.reflection = null;
  }

  private spawnCrate(position: number) {
    let slot = this.crates.find((crate) => !crate.active);
    if (!slot) {
      slot = { scene: new this.TVG.Scene(), position, active: true };
      this.crates.push(slot);
      const box = new this.TVG.Shape();
      box.appendRect(-12.0, -12.0, 24.0, 24.0, { rx: 1.5, ry: 1.5 });
      box.fill(this.linear(-12.0, -12.0, 12.0, 12.0, [[0, 205, 146, 79, 255], [1, 100, 59, 35, 255]]));
      box.stroke({ width: 2.0, color: [65, 41, 30] });
      slot.scene.add(box);
      const braces = new this.TVG.Shape();
      braces.fill(0, 0, 0, 0);
      braces.appendRect(-9.0, -9.0, 18.0, 18.0);
      braces.moveTo(-9.0, -9.0);
      braces.lineTo(9.0, 9.0);
      braces.moveTo(9.0, -9.0);
      braces.lineTo(-9.0, 9.0);
      braces.stroke({ width: 2.0, color: [235, 182, 111] });
      slot.scene.add(braces);
      this.crateLayer.add(slot.scene);
    }
    slot.position = position;
    slot.active = true;
    slot.scene.opacity(255);
  }

  private updateCrates(dt: number, time: number) {
    const player = this.vessels[0];
    for (const crate of this.crates) {
      if (!crate.active) continue;
      if (player.health > 0) {
        const distance = player.position - crate.position;
        const travel = Math.min(Math.abs(distance), 0.045 * dt);
        crate.position += Math.sign(distance) * travel;
        if (Math.abs(player.position - crate.position) < 0.05) {
          if (player.health < 7) {
            const m = player.shipMatrix;
            const label = this.createFloatingLabel(m.e11 * 90.0 + m.e13, m.e21 * 90.0 + m.e23, time);
            label.text('+1 HP');
            label.fontSize(18.0);
            label.fill(255, 255, 195);
          }
          playSound('pickup', 0.8);
          player.health = Math.min(player.health + 1, 7);
          if (player.flameCount > 0) {
            --player.flameCount;
            player.flames[player.flameCount].reset();
            player.flameCores[player.flameCount].reset();
          }
          this.updateFlames(player, time);
          crate.active = false;
          crate.scene.opacity(0);
          continue;
        }
      }
      const water = this.sailingSurface(crate.position, time);
      const angle = Math.atan(this.size.h * water.slope / this.size.w) + 0.06 * Math.sin(time * 3.0);
      const scale = 2.0 * this.size.h / 1280.0;
      const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
      crate.scene.transform(mat(c, -s, crate.position * this.size.w,
        s, c, water.height * this.size.h + 4.0 * scale));
    }
  }

  private createVessel(vessel: Vessel) {
    const TVG = this.TVG;
    vessel.health = vessel.enemy ? 3 : 7;
    const enemyColors = [
      { r: 209, g: 65, b: 60 }, { r: 43, g: 43, b: 50 }, { r: 39, g: 57, b: 106 },
      { r: 123, g: 62, b: 160 }, { r: 227, g: 116, b: 39 },
    ];
    const color = enemyColors[vessel.enemy ? randomInt(0, 4) : 0];
    const ship = vessel.ship = new TVG.Scene();
    const rig = vessel.rig = new TVG.Scene();
    const mast = new TVG.Shape();
    mast.moveTo(87.0, 132.0);
    mast.lineTo(87.0, 3.0);
    mast.moveTo(43.0, 48.0);
    mast.lineTo(132.0, 48.0);
    mast.moveTo(44.0, 101.0);
    mast.lineTo(131.0, 101.0);
    if (vessel.enemy) mast.stroke({ width: 5.0, color: [u8(color.r * 0.8), u8(color.g * 0.8), u8(color.b * 0.8)] });
    else mast.stroke({ width: 5.0, color: [75, 48, 55] });
    rig.add(mast);
    const mastLight = new TVG.Shape();
    mastLight.moveTo(85.8, 131.0);
    mastLight.lineTo(85.8, 3.0);
    mastLight.moveTo(43.0, 46.8);
    mastLight.lineTo(132.0, 46.8);
    mastLight.moveTo(44.0, 99.8);
    mastLight.lineTo(131.0, 99.8);
    mastLight.stroke({ width: 1.2, color: [255, 180, 120, 125] });
    rig.add(mastLight);
    const sail = vessel.sail = new TVG.Shape();
    const creamStops: Stop[] = [
      [0.0, 162, 116, 85, 255],
      [0.25, 245, 212, 165, 255],
      [0.46, 255, 237, 195, 255],
      [0.72, 220, 175, 131, 255],
      [1.0, 145, 102, 85, 255],
    ];
    const offsets = [0.0, 0.25, 0.46, 0.72, 1.0];
    const shades = [0.50, 1.0, 1.0, 0.82, 0.43];
    const enemyStops: Stop[] = offsets.map((offset, i) => {
      const channel = (base: number, light: number) =>
        u8(i === 2 ? base + (light - base) * 0.28 : base * shades[i]);
      return [offset, channel(color.r, 255), channel(color.g, 224), channel(color.b, 195), 255];
    });
    sail.fill(this.linear(48.0, 52.0, 130.0, 96.0, vessel.enemy ? enemyStops : creamStops));
    rig.add(sail);
    vessel.sailFolds = new TVG.Shape();
    vessel.sailFolds.fill(0, 0, 0, 0);
    if (vessel.enemy) vessel.sailFolds.stroke({ width: 1.5, color: [u8(color.r * 0.3), u8(color.g * 0.3), u8(color.b * 0.3), 90] });
    else vessel.sailFolds.stroke({ width: 1.5, color: [65, 30, 40, 75] });
    rig.add(vessel.sailFolds);
    vessel.sailHighlights = new TVG.Shape();
    vessel.sailHighlights.fill(0, 0, 0, 0);
    vessel.sailHighlights.stroke({ width: 0.9, color: [255, 232, 180, 100] });
    rig.add(vessel.sailHighlights);
    const flag = vessel.flag = new TVG.Shape();
    flag.fill(48, 39, 51);
    rig.add(flag);
    const emblem = vessel.emblem = new TVG.Picture();
    emblem.load(skull, { type: 'svg' });
    rig.add(emblem);
    ship.add(rig);
    const hull = new TVG.Picture();
    hull.load(pirateShip, { type: 'svg' });
    ship.add(hull);
    if (vessel.enemy) {
      vessel.cannon = new TVG.Shape();
      vessel.cannon.moveTo(138.0, 127.0);
      vessel.cannon.lineTo(161.0, 111.0);
      vessel.cannon.stroke({ width: 9.0, color: [45, 43, 55] });
      ship.add(vessel.cannon);
      vessel.nextAttack = randomRange(1.0, 3.0);
    }
    vessel.fire = new TVG.Scene();
    vessel.fire.blend(TVG.BlendMethod.Add);
    for (let i = 0; i < 7; ++i) {
      const outer = new TVG.Shape();
      outer.fill(this.linear(0.0, 135.0, 0.0, 72.0, [
        [0.0, 255, 190, 45, 245],
        [0.45, 255, 100, 15, 235],
        [1.0, 220, 40, 15, 100],
      ]));
      vessel.flames[i] = outer;
      vessel.fire.add(outer);
      const core = new TVG.Shape();
      core.fill(255, 235, 145, 235);
      vessel.flameCores[i] = core;
      vessel.fire.add(core);
    }
    vessel.fire.opacity(0);
    ship.add(vessel.fire);
    this.fleet.add(ship);
  }

  private spawnEnemy(time: number) {
    let index = this.vessels.findIndex((vessel, i) => i > 0 && vessel.health === 0 && vessel.ship === null);
    if (index < 0) index = this.vessels.length;
    const slot = makeVessel(worldLeft - 0.08, true, randomRange(0.0, tau),
      randomRange(0.12, 0.44), randomRange(0.02, 0.035), randomRange(0.4, 0.7));
    this.vessels[index] = slot;
    slot.patrolStart = time + (slot.patrolCenter - worldLeft + 0.08) / 0.045;
    this.createVessel(slot);
    slot.nextAttack += slot.patrolStart;
  }

  private updateEnemyAttacks(time: number) {
    const player = this.vessels[0];
    if (player.health === 0) return;
    const playerTransform = player.shipMatrix;
    const playerX = playerTransform.e11 * 90.0 + playerTransform.e12 * 78.0 + playerTransform.e13;
    const playerY = playerTransform.e21 * 90.0 + playerTransform.e22 * 78.0 + playerTransform.e23;
    const playerVelocity = (Number(this.movingRight) - Number(this.movingLeft)) * this.size.w * 0.105;
    const gravity = this.size.h * 0.5;
    for (const vessel of this.vessels) {
      if (!vessel.enemy || vessel.health === 0 || time < vessel.patrolStart) continue;
      if (!vessel.attackCharging) {
        if (time < vessel.nextAttack) continue;
        vessel.attackCharging = true;
        vessel.attackCharge = randomRange(2.8, 4.0);
        vessel.nextAttack = time + vessel.attackCharge;
        // A third of the shots track the player; the rest deliberately aim wide.
        vessel.aimOffset = randomRange(0.0, 1.0) < 0.33 ? 0.0 :
          randomRange(0.16, 0.27) * this.size.w * (randomRange(0.0, 1.0) < 0.5 ? -1.0 : 1.0);
      }
      const m = vessel.shipMatrix;
      const baseX = m.e11 * 138.0 + m.e12 * 127.0 + m.e13;
      const baseY = m.e21 * 138.0 + m.e22 * 127.0 + m.e23;
      const shipScale = Math.hypot(m.e11, m.e21);
      const speed = Math.sqrt(0.135 * this.size.w * this.size.h * vessel.attackCharge);
      let vx = 0.0, vy = 0.0, flight = 0.0;
      let muzzleX = baseX, muzzleY = baseY;
      for (let iteration = 0; iteration < 4; ++iteration) {
        const targetX = clamp(playerX + playerVelocity * flight,
          this.size.w * playerLeft, this.size.w * playerRight) + vessel.aimOffset;
        const dx = targetX - muzzleX;
        const distance = Math.max(Math.abs(dx), 1.0);
        const dy = playerY - muzzleY;
        const speed2 = speed * speed;
        const discriminant = speed2 * speed2 - gravity * (gravity * distance * distance - 2.0 * dy * speed2);
        const angle = discriminant >= 0.0
          ? clamp(Math.atan((speed2 - Math.sqrt(discriminant)) / (gravity * distance)),
            0.174532925, 1.396263402) : 0.785398163;
        vx = (dx < 0.0 ? -1.0 : 1.0) * speed * Math.cos(angle);
        vy = -speed * Math.sin(angle);
        flight = distance / Math.abs(vx);
        muzzleX = baseX + vx / speed * 27.0 * shipScale;
        muzzleY = baseY + vy / speed * 27.0 * shipScale;
      }
      const localX = (m.e11 * vx + m.e21 * vy) / (shipScale * speed);
      const localY = (m.e12 * vx + m.e22 * vy) / (shipScale * speed);
      vessel.cannon!.reset();
      vessel.cannon!.moveTo(138.0, 127.0);
      vessel.cannon!.lineTo(138.0 + localX * 27.0, 127.0 + localY * 27.0);
      if (time < vessel.nextAttack) continue;
      const ball = this.cannonballs[this.nextCannonball];
      this.nextCannonball = (this.nextCannonball + 1) % 32;
      ball.x = muzzleX;
      ball.y = muzzleY;
      ball.vx = vx;
      ball.vy = vy;
      this.launch(ball, true);
      playSound('cannon', 0.6, this.panAt(ball.x));
      vessel.recoilStart = time;
      vessel.recoilDirection = vx < 0.0 ? 1.0 : -1.0;
      vessel.attackCharging = false;
      vessel.nextAttack = time + 3.0;
    }
  }

  private twinkle(time: number) {
    for (const star of this.stars) {
      const shimmer = 0.65 + 0.35 * Math.sin(time * star.speed + star.phase);
      star.shape.opacity(u8(star.brightness * shimmer));
    }
  }

  private placeCloud(cloud: Cloud) {
    cloud.scene.transform(mat(this.size.w * cloud.width / 1000.0, 0.0, this.size.w * cloud.x,
      0.0, this.size.h * cloud.height / 100.0, this.size.h * cloud.y));
  }

  private shapeCloud(cloud: Cloud, altitude: number) {
    const w = 1000.0;
    const h = 100.0;
    const shape = cloud.shape;
    shape.reset();
    shape.moveTo(0.0, h * 0.65);
    shape.cubicTo(w * 0.08, h * 0.35, w * 0.13, h * 0.50, w * 0.22, h * 0.30);
    shape.cubicTo(w * 0.31, -h * 0.15, w * 0.41, h * 0.05, w * 0.49, h * 0.25);
    shape.cubicTo(w * 0.62, h * 0.02, w * 0.72, h * 0.42, w * 0.80, h * 0.40);
    shape.cubicTo(w * 0.89, h * 0.42, w * 0.95, h * 0.65, w, h * 0.70);
    const lobes = 3;
    let previousX = w;
    let previousY = h * 0.70;
    for (let i = 1; i <= lobes; ++i) {
      const t = i / lobes;
      const x = w * (1.0 - t);
      const y = h * (0.70 - 0.05 * t + 0.10 * Math.sin(3.141592654 * t));
      const bulge = h * (0.025 + 0.065 * altitude) * randomRange(0.9, 1.1);
      const span = previousX - x;
      shape.cubicTo(previousX - span * 0.33, previousY + bulge,
        x + span * 0.33, y + bulge, x, y);
      previousX = x;
      previousY = y;
    }
    shape.close();
  }

  private spawnCloud(cloud: Cloud, initial: boolean) {
    cloud.width = randomRange(0.18, 0.36);
    cloud.y = randomRange(0.12, 0.48);
    const altitude = (0.48 - cloud.y) / (0.48 - 0.12);
    cloud.height = 0.035 + 0.105 * altitude;
    cloud.speed = 0.008 + 0.010 * altitude;
    this.shapeCloud(cloud, altitude);
    cloud.x = initial ? randomRange(worldLeft - cloud.width, worldRight - 0.05) : worldLeft - cloud.width - 0.025;
    cloud.delay = initial ? 0.0 : randomRange(1.0, 7.0);
    cloud.scene.opacity(initial ? 255 : 0);
    this.placeCloud(cloud);
  }

  // Traces one wave crest as cubic segments into every given shape, left to right.
  private traceWave(shapes: Shape[], sample: (u: number) => WaterSample) {
    const segments = 96;
    const span = worldRight - worldLeft;
    const left = this.size.w * worldLeft;
    const step = this.size.w * span / segments;
    const first = sample(worldLeft);
    let previousY = this.size.h * first.height;
    let previousTangent = this.size.h * first.slope * span / segments;
    for (const shape of shapes) shape.moveTo(left, previousY);
    for (let i = 1; i <= segments; ++i) {
      const x = left + step * i;
      const water = sample(worldLeft + span * i / segments);
      const y = this.size.h * water.height;
      const slope = this.size.h * water.slope * span / segments;
      const cx1 = x - step * (2.0 / 3.0);
      const cy1 = previousY + previousTangent / 3.0;
      const cx2 = x - step / 3.0;
      const cy2 = y - slope / 3.0;
      for (const shape of shapes) shape.cubicTo(cx1, cy1, cx2, cy2, x, y);
      previousY = y;
      previousTangent = slope;
    }
  }

  private waves(time: number) {
    const size = this.size;
    const width = size.w;
    const baseline = size.h * distantSeaLevel;
    const left = width * worldLeft;
    const right = width * worldRight;
    const bottom = size.h * worldRight;
    this.sea.reset();
    this.sunClip.reset();
    this.traceWave([this.sea, this.sunClip], (u) => this.surfaceSample(u, time));
    this.sea.lineTo(right, bottom);
    this.sea.lineTo(left, bottom);
    this.sea.close();
    this.reflectionClip.reset();
    for (const layer of this.seaLayers) {
      const shape = layer.shape!;
      shape.reset();
      // Ship reflections are clipped by the front sea layer, so both share one trace.
      const shapes = layer === this.seaLayers[0] ? [shape, this.reflectionClip] : [shape];
      this.traceWave(shapes, (u) => this.layerSample(layer, u, time));
      for (const target of shapes) {
        target.lineTo(right, bottom);
        target.lineTo(left, bottom);
        target.close();
      }
    }
    this.sunClip.lineTo(right, size.h * worldLeft);
    this.sunClip.lineTo(left, size.h * worldLeft);
    this.sunClip.close();

    // Pulse the sun from the original size to 1.25 times it.
    const pulse = 0.5 - 0.5 * Math.cos(time * 1.047197551);
    const radius = size.h * sunRadiusRatio * (1.0 + 0.25 * pulse);
    const haloRadius = radius * (2.5 + 0.50 * pulse);
    this.sunGlow.opacity(u8(155 + 100 * pulse));
    this.sun.reset();
    this.sun.appendCircle(size.w * 0.5, baseline, radius, radius);
    this.sun.fill(this.sunlight(baseline, radius));
    this.sunGlow.reset();
    this.sunGlow.appendCircle(size.w * 0.5, baseline, haloRadius, haloRadius);
    this.sunGlow.fill(this.sunHalo(baseline, haloRadius));

    for (const vessel of this.vessels) {
      const ship = vessel.ship;
      if (!ship) continue;
      if (vessel.health === 0) {
        const age = Math.max(0.0, time - vessel.sinkStart);
        if (age >= 3.0) {
          if (vessel.enemy) {
            this.addScore(100);
            this.showScorePopup(100, width * vessel.position,
              size.h * this.sailingSurface(vessel.position, time).height, time);
          }
          this.fleet.remove(ship);
          vessel.ship = null;
          this.dropReflection(vessel);
          vessel.rig = null;
          vessel.sail = null;
          vessel.sailFolds = null;
          vessel.sailHighlights = null;
          vessel.flag = null;
          vessel.emblem = null;
          vessel.cannon = null;
          vessel.fire = null;
          vessel.flames = [];
          vessel.flameCores = [];
          continue;
        }
        this.updateFlames(vessel, time);
        const progress = age / 3.0;
        const angle = vessel.sinkAngle + progress * 0.65;
        const scale = width * 0.10 / 180.0;
        const c = Math.cos(angle) * scale;
        const s = Math.sin(angle) * scale;
        const y = vessel.sinkY + size.h * (0.02 * age + 0.025 * age * age);
        vessel.shipMatrix = mat(c, -s, width * vessel.position - c * 90.0 + s * shipWaterline,
          s, c, y - s * 90.0 - c * shipWaterline);
        ship.transform(vessel.shipMatrix);
        ship.opacity(u8(255.0 * (1.0 - progress * progress)));
        continue;
      }
      this.updateFlames(vessel, time);
      const sail = vessel.sail!;
      const flag = vessel.flag!;
      const sailFolds = vessel.sailFolds!;
      const sailHighlights = vessel.sailHighlights!;
      const gust = Math.sin(time * 2.4 + vessel.phase);
      const flutter = Math.sin(time * 7.0 + vessel.phase);
      const shear = 0.018 * gust;
      vessel.rigMatrix = mat(1.0, shear, -132.0 * shear, 0.0, 1.0, 0.0);
      vessel.rig!.transform(vessel.rigMatrix);
      sail.reset();
      sail.moveTo(48.0, 51.0);
      sail.cubicTo(70.0, 55.0 + gust * 4.0, 105.0, 55.0 - gust * 3.0, 127.0, 51.0);
      sail.cubicTo(118.0 + gust * 5.0, 66.0, 120.0 + gust * 7.0, 83.0, 130.0, 98.0);
      sail.cubicTo(104.0, 92.0 + gust * 5.0, 72.0, 96.0 - gust * 4.0, 46.0, 99.0);
      sail.cubicTo(55.0 + gust * 6.0, 83.0, 56.0 + gust * 5.0, 66.0, 48.0, 51.0);
      sail.close();
      sailFolds.reset();
      sailHighlights.reset();
      for (let i = 0; i < 4; ++i) {
        const x = 62.0 + 16.0 * i;
        const bend = 3.0 + gust * 3.0 + Math.sin(time * 2.4 + i * 0.8 + vessel.phase);
        const top = 58.0 + gust * 1.5;
        const bottom = 90.0 + gust * 2.0;
        sailFolds.moveTo(x, top);
        sailFolds.cubicTo(x + bend, 67.0, x + bend, 81.0, x - 1.0, bottom);
        sailHighlights.moveTo(x - 1.4, top);
        sailHighlights.cubicTo(x + bend - 1.4, 67.0,
          x + bend - 1.4, 81.0, x - 2.4, bottom);
      }
      flag.reset();
      flag.moveTo(89.0, 3.0);
      flag.cubicTo(100.0, -2.0 + flutter * 2.0, 112.0, 3.0 - flutter * 3.0, 124.0, 6.0 + flutter * 4.0);
      flag.lineTo(117.0, 11.0 + flutter * 4.0);
      flag.lineTo(123.0, 18.0 + flutter * 4.0);
      flag.cubicTo(111.0, 15.0 - flutter * 3.0, 100.0, 10.0 + flutter * 2.0, 89.0, 15.0);
      flag.close();
      vessel.emblem!.translate(0.0, flutter * 1.2);
      const u = vessel.position;
      const hitAge = time - vessel.hitStart;
      const shake = (hitAge >= 0.0 && hitAge < 1.2)
        ? 2.4 * Math.sin(hitAge * 32.0) * Math.exp(-hitAge * 4.0) : 0.0;
      const recoilAge = time - vessel.recoilStart;
      const recoil = (recoilAge >= 0.0 && recoilAge < 0.6)
        ? 3.5 * vessel.recoilDirection * Math.sin(recoilAge * 28.0) * Math.exp(-recoilAge * 8.0) : 0.0;
      const water = this.sailingSurface(u, time);
      const targetAngle = Math.atan(size.h * water.slope / width);
      if (vessel.waterAngleTime < 0.0) {
        vessel.waterAngle = targetAngle;
      } else {
        const dt = Math.max(0.0, time - vessel.waterAngleTime);
        const response = 1.0 - Math.exp(-7.0 * dt);
        const change = (targetAngle - vessel.waterAngle) * response;
        // Water drag smooths wave-following rotation; combat impulses stay separate.
        const maxChange = 0.90 * dt;
        vessel.waterAngle += clamp(change, -maxChange, maxChange);
      }
      vessel.waterAngleTime = time;
      const angle = vessel.waterAngle + shake * 0.15 + recoil * 0.06;
      const scale = width * 0.10 / 180.0;
      const c = Math.cos(angle) * scale;
      const s = Math.sin(angle) * scale;
      vessel.shipMatrix = mat(c, -s, width * u - c * 90.0 + s * shipWaterline + shake * width * 0.003 + recoil * width * 0.0025,
        s, c, size.h * water.height - s * 90.0 - c * shipWaterline);
      ship.transform(vessel.shipMatrix);
    }
  }

  private sunlight(y: number, radius: number) {
    return this.linear(0.0, y - radius, 0.0, y + radius, [
      [0.0, 255, 235, 170, 255],
      [0.5, 255, 165, 85, 255],
      [1.0, 240, 95, 65, 255],
    ]);
  }

  private sunHalo(y: number, radius: number) {
    return this.radial(this.size.w * 0.5, y, radius, this.size.w * 0.5, y, 0.0, [
      [0.0, 255, 225, 150, 150],
      [0.36, 255, 205, 115, 125],
      [0.50, 255, 175, 90, 75],
      [0.72, 255, 145, 80, 25],
      [1.0, 255, 135, 75, 0],
    ]);
  }

  content() {
    const TVG = this.TVG;
    const size = this.size;
    const world = this.world = new TVG.Scene();
    this.screen = new TVG.Scene();
    this.canvas.add(this.screen);
    this.screen.add(world);
    const background = new TVG.Shape();
    background.appendRect(size.w * worldLeft, size.h * worldLeft, size.w * 1.25, size.h * 1.25);
    background.fill(this.linear(0.0, 0.0, 0.0, size.h, [
      [0.0, 69, 54, 99, 255],
      [0.35, 173, 78, 101, 255],
      [distantSeaLevel, 255, 175, 62, 255],
      [1.0, 237, 112, 67, 255],
    ]));
    world.add(background);

    this.stars = [];
    for (let i = 0; i < 45; ++i) {
      const x = size.w * randomRange(0.025, 0.975);
      const altitude = randomRange(0.025, 0.23);
      const radius = randomRange(0.8, 1.7) * size.h / 1280.0;
      const shape = new TVG.Shape();
      shape.appendCircle(x, size.h * altitude, radius, radius);
      shape.fill(255, 240, 215);
      this.stars.push({
        shape,
        phase: randomRange(0.0, tau),
        speed: randomRange(0.8, 2.2),
        brightness: randomRange(170.0, 245.0) * (1.0 - altitude * 2.0),
      });
      world.add(shape);
    }
    this.twinkle(0.0);

    const y = size.h * distantSeaLevel;
    const radius = size.h * sunRadiusRatio;
    this.sun = new TVG.Shape();
    this.sun.appendCircle(size.w * 0.5, y, radius, radius);
    this.sun.fill(this.sunlight(y, radius));
    const blurredSun = new TVG.Scene();
    blurredSun.add(this.sun);
    if (this.GPU) blurredSun.gaussianBlur(5.0, 0, 0, 20);

    const visibleSun = new TVG.Scene();
    const glowRadius = radius * 2.5;
    this.sunGlow = new TVG.Shape();
    this.sunGlow.appendCircle(size.w * 0.5, y, glowRadius, glowRadius);
    this.sunGlow.fill(this.sunHalo(y, glowRadius));
    visibleSun.add(this.sunGlow);
    visibleSun.add(blurredSun);
    this.sunClip = new TVG.Shape();
    this.sunClip.fill(255, 255, 255);
    visibleSun.clip(this.sunClip);
    world.add(visibleSun);

    // Static vector brush strokes and coastal silhouettes are built only once.
    const scenery = new TVG.Scene();
    scenery.transform(mat(size.w, 0, 0, 0, size.h, 0));
    for (let i = 0; i < 24; ++i) {
      const x = randomRange(worldLeft, 1.0);
      const y = randomRange(0.26, 0.65);
      const length = randomRange(0.07, 0.26);
      const thickness = randomRange(0.002, 0.007);
      const streak = new TVG.Shape();
      streak.moveTo(x, y);
      streak.cubicTo(x + length * .25, y - thickness,
        x + length * .40, y + thickness, x + length * .57, y - thickness);
      streak.lineTo(x + length * .70, y - thickness * .5);
      streak.lineTo(x + length, y);
      streak.cubicTo(x + length * .65, y + thickness,
        x + length * .3, y + thickness * .7, x, y);
      streak.close();
      streak.fill(255, 153, 65, 75 + i % 4 * 20);
      scenery.add(streak);
    }
    const ridgeColors = [[185, 99, 104], [132, 78, 106], [85, 63, 94]];
    for (let depth = 0; depth < 3; ++depth) {
      const ridge = new TVG.Shape();
      const base = distantSeaLevel + 0.025;
      ridge.moveTo(worldLeft, base);
      for (let i = 0; i <= 40; ++i) {
        const x = worldLeft + 1.25 * i / 40.0;
        // Leave open water around the sun; taller headlands frame the sides.
        const edge = Math.pow(Math.min(1.0, Math.abs(x - .5) * 2.0), 3.0);
        const height = (.018 + edge * (.10 + depth * .028))
          * (.65 + .35 * Math.sin(i * 1.7 + depth * 2.1));
        ridge.lineTo(x, distantSeaLevel + depth * .014 - height);
      }
      ridge.lineTo(worldRight, base);
      ridge.close();
      ridge.fill(ridgeColors[depth][0], ridgeColors[depth][1], ridgeColors[depth][2]);
      scenery.add(ridge);
    }
    world.add(scenery);

    this.clouds = [];
    for (let i = 0; i < 5; ++i) {
      const shape = new TVG.Shape();
      shape.fill(this.linear(0.0, 0.0, 0.0, 100.0, [
        [0.0, 255, 160, 69, 235],
        [0.16, 175, 84, 106, 240],
        [1.0, 112, 66, 100, 225],
      ]));
      const cloud: Cloud = { scene: new TVG.Scene(), shape, x: 0, y: 0, width: 0, height: 0, speed: 0, delay: 0 };
      cloud.scene.add(shape);
      this.spawnCloud(cloud, true);
      world.add(cloud.scene);
      this.clouds.push(cloud);
    }

    // The native build inserts the distant sea below the crate layer afterwards;
    // webcanvas only appends, so it is simply created in its final z-order here.
    this.sea = new TVG.Shape();
    this.sea.fill(this.linear(0.0, y, 0.0, size.h, [
      [0.0, 65, 47, 85, 235],
      [1.0, 10, 23, 49, 255],
    ]));
    world.add(this.sea);

    this.crateLayer = new TVG.Scene();
    world.add(this.crateLayer);
    this.fleet = new TVG.Scene();
    world.add(this.fleet);
    for (const vessel of this.vessels) this.createVessel(vessel);

    this.cannon = new TVG.Shape();
    this.aimCannon();
    this.cannon.stroke({ width: 9.0, color: [45, 43, 55] });
    this.vessels[0].ship!.add(this.cannon);
    this.aimGuide = new TVG.Shape();
    this.aimGuide.fill(255, 255, 255);
    world.add(this.aimGuide);
    this.cannonballs = [];
    for (let i = 0; i < 32; ++i) {
      const ball = makeCannonball();
      const shape = ball.shape = new TVG.Shape();
      const radius = size.h * 0.0105 * 0.8;
      const speedLines = ball.speedLines = new TVG.Shape();
      speedLines.fill(0, 0, 0, 0);
      speedLines.stroke({ width: Math.max(1.0, size.h * 0.0012), gradient: this.speedGradient(-radius * 10.0) });
      speedLines.opacity(0);
      world.add(speedLines);
      shape.appendCircle(0.0, 0.0, radius, radius);
      shape.fill(this.radial(radius * 0.45, 0.0, radius * 1.5, radius * 0.45, 0.0, 0.0, [
        [0.0, 255, 237, 185, 255],
        [0.12, 245, 183, 105, 255],
        [0.30, 177, 106, 66, 255],
        [0.53, 85, 60, 65, 255],
        [0.78, 38, 35, 52, 255],
        [1.0, 15, 19, 31, 255],
      ]));
      shape.opacity(0);
      world.add(shape);
      this.cannonballs.push(ball);
    }

    this.seaLayers.forEach((layer, index) => {
      layer.shape = new TVG.Shape();
      const depthRatio = clamp((layer.level - 0.73) / 0.14, 0.0, 1.0);
      layer.shape.fill(this.linear(0.0, size.h * (layer.level - layer.amplitude * 1.25), 0.0, size.h, [
        [0.0, u8(166 - 55 * depthRatio), u8(110 - 35 * depthRatio), u8(128 - 20 * depthRatio), 175],
        [0.18, u8(85 - 35 * depthRatio), u8(65 - 24 * depthRatio), u8(103 - 24 * depthRatio), 190],
        [0.55, 31, 31, 64, 210],
        [1.0, 8, 19, 42, 230],
      ]));
      world.add(layer.shape);
      world.add(this.createSunReflection(1 + index));
    });

    this.reflectionLayer = new TVG.Scene();
    this.reflectionClip = new TVG.Shape();
    this.reflectionLayer.clip(this.reflectionClip);
    this.reflectionLayer.blend(TVG.BlendMethod.Multiply);
    world.add(this.reflectionLayer);

    this.droplets = [];
    for (let i = 0; i < 1152; ++i) {
      const shape = new TVG.Shape();
      shape.fill(255, 255, 255);
      shape.opacity(0);
      world.add(shape);
      this.droplets.push({ shape, x: 0, y: 0, vx: 0, vy: 0, birth: 0, lifetime: 0, active: false });
    }

    this.debris = [];
    for (let i = 0; i < 256; ++i) {
      const shape = new TVG.Shape();
      shape.opacity(0);
      world.add(shape);
      this.debris.push({ shape, x: 0, y: 0, vx: 0, vy: 0, birth: 0, lifetime: 0, spin: 0, active: false });
    }

    this.chargeGauge = new TVG.Scene();
    const gaugeBackground = new TVG.Shape();
    gaugeBackground.appendRect(0.0, 0.0, 120.0, 14.0, { rx: 4.0, ry: 4.0 });
    gaugeBackground.fill(30, 25, 45, 230);
    gaugeBackground.stroke({ width: 1.0, color: [255, 220, 170, 220] });
    this.chargeGauge.add(gaugeBackground);
    this.chargeFill = new TVG.Shape();
    this.chargeGauge.add(this.chargeFill);
    this.chargeGauge.opacity(0);
    world.add(this.chargeGauge);

    if (!this.fontLoaded) {
      TVG.Font.load(FONT_NAME, this.fontData, { type: 'ttf' });
      this.fontLoaded = true;
    }
    const label = (fontSize: number, content: string | null, alignX: number, alignY: number) => {
      const text = new TVG.Text();
      text.font(FONT_NAME);
      if (fontSize > 0) text.fontSize(fontSize);
      if (content !== null) text.text(content);
      text.fill(255, 240, 215);
      text.align(alignX, alignY);
      return text;
    };
    this.reloadLabel = label(10.0, 'reloading', 0.5, 1.0);
    this.reloadLabel.translate(60.0, -4.0);
    this.reloadLabel.opacity(0);
    this.chargeGauge.add(this.reloadLabel);

    this.scorePopups = [];
    for (let i = 0; i < 24; ++i) {
      const text = new TVG.Text();
      text.font(FONT_NAME);
      text.align(0.5, 1.0);
      text.opacity(0);
      world.add(text);
      this.scorePopups.push({ text, x: 0, y: 0, birth: 0, active: false });
    }
    this.scoreText = label(18.0, null, 0.5, 0.0);
    this.scoreText.translate(size.w * 0.5, 16.0);
    this.addScore(0);
    this.screen.add(this.scoreText);

    const keyGuide = label(14.0,
      'LEFT / RIGHT: Move ship\nUP / DOWN: Adjust cannon angle\nSPACE: Hold to charge, release to fire', 1.0, 1.0);
    keyGuide.translate(size.w - 20.0, size.h - 20.0);
    this.screen.add(keyGuide);

    this.gameOver = new TVG.Scene();
    const shade = new TVG.Shape();
    shade.appendRect(0, 0, size.w, size.h);
    shade.fill(12, 10, 24, 125);
    this.gameOver.add(shade);
    const title = label(size.h * 0.065, 'Game Over', 0.5, 0.5);
    title.fill(255, 235, 207);
    title.translate(size.w * 0.5, size.h * 0.5);
    this.gameOver.add(title);
    const hint = label(size.h * 0.018, 'Press SPACE to restart', 0.5, 0.5);
    hint.fill(255, 235, 207);
    hint.translate(size.w * 0.5, size.h * 0.58);
    this.gameOver.add(hint);
    this.gameOver.opacity(0);
    this.screen.add(this.gameOver);

    this.waves(0.0);
    this.updateSunReflections(0.0);
    this.updateReflections(0.0);
    this.updateAimGuide();
  }

  private resetGame() {
    this.canvas.remove();
    this.vessels = initialVessels();
    this.crates = [];
    this.nextScorePopup = 0;
    this.impacts = [];
    this.nextImpact = this.nextCannonball = this.nextDroplet = this.nextDebris = 0;
    this.score = 0;
    this.nextEnemySpawn = 20000;
    this.lastFrame = 0;
    this.screenShakeTime = 0.0;
    this.cameraZoom = 1.0;
    this.cameraX = this.cameraY = 0.5;
    this.cannonAngle = 35.0;
    this.movingLeft = this.movingRight = this.aimingUp = this.aimingDown = this.charging = false;
    this.chargeStart = this.reloadReady = 0.0;
    this.restartRequested = false;
    this.content();
  }

  /** Returns true when the key is one the game consumes. */
  keydown(key: string) {
    if (key === 'Space') {
      if (this.spaceHeld) return true;
      this.spaceHeld = true;
      if (this.vessels[0].health === 0) {
        this.restartRequested = true;
        return true;
      }
    }
    const handled = key === 'Space' || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
    if (this.vessels[0].health === 0) return handled;
    if (key === 'ArrowLeft') this.movingLeft = true;
    if (key === 'ArrowRight') this.movingRight = true;
    if (key === 'ArrowUp') this.aimingUp = true;
    if (key === 'ArrowDown') this.aimingDown = true;
    if (key === 'Space' && !this.charging && this.clock >= this.reloadReady) {
      this.charging = true;
      this.chargeStart = this.clock;
    }
    return handled;
  }

  keyup(key: string) {
    if (key === 'Space') this.spaceHeld = false;
    if (key === 'ArrowLeft') this.movingLeft = false;
    if (key === 'ArrowRight') this.movingRight = false;
    if (key === 'ArrowUp') this.aimingUp = false;
    if (key === 'ArrowDown') this.aimingDown = false;
    if (key === 'Space' && this.charging) {
      this.charging = false;
      this.fire(this.clock - this.chargeStart);
    }
    return key === 'Space' || key.startsWith('Arrow');
  }

  /** Losing focus swallows keyup events; drop held keys without firing a half-charged shot. */
  releaseKeys() {
    this.spaceHeld = this.movingLeft = this.movingRight = this.aimingUp = this.aimingDown = this.charging = false;
  }

  /** Advances the game to `elapsed` milliseconds. Returns false when the frame is skipped. */
  update(elapsed: number) {
    this.clock = elapsed * 0.001;
    if (this.restartRequested) {
      this.gameStart = elapsed;
      this.resetGame();
      return true;
    }
    elapsed -= this.gameStart;
    // Cap the simulation near 60Hz like the native build, with slack for rAF jitter.
    if (elapsed - this.lastFrame < 12) return false;
    const dt = Math.min((elapsed - this.lastFrame) * 0.001, 0.05);
    const cloudDt = (elapsed - this.lastFrame) * 0.001;
    this.lastFrame = elapsed;
    const time = elapsed * 0.001;
    const aimDirection = Number(this.aimingUp) - Number(this.aimingDown);
    if (aimDirection !== 0 && this.vessels[0].health > 0) {
      this.cannonAngle = clamp(this.cannonAngle + aimDirection * 40.0 * dt, 10.0, 80.0);
      this.aimCannon();
    }
    const direction = Number(this.movingRight) - Number(this.movingLeft);
    const player = this.vessels[0];
    const moveSpeed = 0.12 * 0.70 * 1.25;
    if (player.health > 0) player.position = clamp(player.position + direction * moveSpeed * dt, playerLeft, playerRight);
    while (elapsed >= this.nextEnemySpawn) {
      this.spawnEnemy(this.nextEnemySpawn * 0.001);
      this.nextEnemySpawn += 20000;
    }
    for (const vessel of this.vessels) {
      if (!vessel.enemy || vessel.health === 0) continue;
      if (time < vessel.patrolStart) {
        vessel.position = vessel.patrolCenter - (vessel.patrolStart - time) * 0.045;
      } else {
        vessel.position = vessel.patrolCenter + vessel.patrolRadius *
          Math.sin((time - vessel.patrolStart) * vessel.patrolSpeed);
      }
    }
    this.waves(time);
    this.updateSunReflections(time);
    this.updateReflections(time);
    this.updateChargeGauge();
    this.updateAimGuide();
    this.updateCannonballs(cloudDt, time);
    if (this.vessels[0].health === 0) {
      this.gameOver.opacity(255);
      this.movingLeft = this.movingRight = this.aimingUp = this.aimingDown = this.charging = false;
      this.chargeGauge.opacity(0);
      this.aimGuide.opacity(0);
    }
    this.updateCrates(cloudDt, time);
    this.updateEnemyAttacks(time);
    this.updateDroplets(time);
    this.updateDebris(time);
    this.twinkle(time);
    for (const cloud of this.clouds) {
      let travelTime = cloudDt;
      if (cloud.delay > 0.0) {
        const waiting = Math.min(cloud.delay, travelTime);
        cloud.delay -= waiting;
        travelTime -= waiting;
        if (cloud.delay > 0.0) continue;
        cloud.scene.opacity(255);
      }
      cloud.x += cloud.speed * travelTime;
      if (cloud.x > worldRight + 0.025) this.spawnCloud(cloud, false);
      else this.placeCloud(cloud);
    }
    this.updateScorePopups(time);
    this.updateCamera(cloudDt);
    this.updateScreenShake(cloudDt);
    return true;
  }
}
