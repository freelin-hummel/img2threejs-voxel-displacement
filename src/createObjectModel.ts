import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: AK-47 Wild Lotus
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createAK47WildLotusModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "AK-47 Wild Lotus";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "fovDegrees": 35.0, "aspect": 1.7778, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 2.5], "note": "Heuristic default; refine by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["wild-lotus-base"] = createSculptMaterial(
    "wild-lotus-base",
    {"id": "wild-lotus-base", "name": "Wild Lotus Teal Painted Metal", "type": "standard", "baseColor": "#2A7A5A", "albedo": {"dominant": "#2A7A5A", "secondary": ["#1E5E42", "#3A8A6A"]}, "roughness": {"base": 0.55, "variation": 0.1, "map": {"type": "independent-procedural", "source": "independent procedural roughness field derived from surface finish observation", "pattern": "mottled-field", "amplitude": 0.1, "resolution": 1024, "independent": true}}, "metalness": {"base": 0.1, "variation": 0.05}, "normal": {"pattern": "stamped-metal-grain", "strength": 0.2, "scale": 16}, "localOverrides": [{"region": "all-painted-surfaces", "description": "Wild Lotus floral pattern applied via projection from de-lit reference"}], "note": "Projection-first route mandatory for this patterned skin.", "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world-scale detail"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "role": "broad color breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.2, "role": "visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "grazing light breakup"}], "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35}, "referencePbr": {"source": "de-lit reference image projection", "method": "projection from de-lit reference crops", "confidence": 0.71, "usable": true, "note": "De-lighted reference used as projection source; confidence raised to 0.71 by dual-view evidence", "maps": {"albedo": {"path": "delight_albedo.png", "confidence": 0.75, "resolution": 2048, "colorSpace": "sRGB", "source": "de-lit reference projection"}, "roughness": {"path": "procedural-roughness-field", "confidence": 0.7, "resolution": 1024, "source": "inferred from surface finish"}, "normal": {"path": "procedural-normal-field", "confidence": 0.65, "resolution": 1024, "source": "stamped-metal grain procedural"}, "ao": {"path": "procedural-ao-field", "confidence": 0.7, "resolution": 1024, "source": "computed from geometry"}, "height": {"path": "procedural-height-field", "confidence": 0.6, "resolution": 1024, "source": "displacement from surface detail"}}}},
    options
  );
  materialMap["dark-metal"] = createSculptMaterial(
    "dark-metal",
    {"id": "dark-metal", "name": "Dark Blued Steel", "type": "standard", "baseColor": "#1A1A1A", "albedo": {"dominant": "#1A1A1A", "secondary": ["#2A2A2A", "#0F0F0F"]}, "roughness": {"base": 0.4, "variation": 0.08, "map": {"type": "independent-procedural", "source": "independent procedural roughness field derived from surface finish observation", "pattern": "mottled-field", "amplitude": 0.08, "resolution": 1024, "independent": true}}, "metalness": {"base": 0.9, "variation": 0.05}, "normal": {"pattern": "machined-metal", "strength": 0.15, "scale": 8}, "localOverrides": [], "note": "Barrel, gas tube, rear sight. Dark parkerized/blued finish.", "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world-scale detail"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "role": "broad color breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.2, "role": "visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "grazing light breakup"}], "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35}, "referencePbr": {"source": "de-lit reference image projection", "method": "projection from de-lit reference crops", "confidence": 0.71, "usable": true, "note": "De-lighted reference used as projection source; confidence raised to 0.71 by dual-view evidence", "maps": {"albedo": {"path": "delight_albedo.png", "confidence": 0.75, "resolution": 2048, "colorSpace": "sRGB", "source": "de-lit reference projection"}, "roughness": {"path": "procedural-roughness-field", "confidence": 0.7, "resolution": 1024, "source": "inferred from surface finish"}, "normal": {"path": "procedural-normal-field", "confidence": 0.65, "resolution": 1024, "source": "stamped-metal grain procedural"}, "ao": {"path": "procedural-ao-field", "confidence": 0.7, "resolution": 1024, "source": "computed from geometry"}, "height": {"path": "procedural-height-field", "confidence": 0.6, "resolution": 1024, "source": "displacement from surface detail"}}}},
    options
  );
  materialMap["gold-accent"] = createSculptMaterial(
    "gold-accent",
    {"id": "gold-accent", "name": "Gold/Bronze Metallic Accent", "type": "standard", "baseColor": "#C8944A", "albedo": {"dominant": "#C8944A", "secondary": ["#B8843A", "#D8A45A"]}, "roughness": {"base": 0.35, "variation": 0.08, "map": {"type": "independent-procedural", "source": "independent procedural roughness field derived from surface finish observation", "pattern": "mottled-field", "amplitude": 0.08, "resolution": 1024, "independent": true}}, "metalness": {"base": 0.75, "variation": 0.1}, "normal": {"pattern": "smooth-metallic", "strength": 0.05, "scale": 4}, "localOverrides": [], "note": "Magazine band, stock band, trigger guard, trigger.", "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world-scale detail"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.4, "role": "broad color breakup"}, {"id": "meso", "frequency": 12.0, "amplitude": 0.2, "role": "visible relief"}, {"id": "micro", "frequency": 56.0, "amplitude": 0.08, "role": "grazing light breakup"}], "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35}, "referencePbr": {"source": "de-lit reference image projection", "method": "projection from de-lit reference crops", "confidence": 0.71, "usable": true, "note": "De-lighted reference used as projection source; confidence raised to 0.71 by dual-view evidence", "maps": {"albedo": {"path": "delight_albedo.png", "confidence": 0.75, "resolution": 2048, "colorSpace": "sRGB", "source": "de-lit reference projection"}, "roughness": {"path": "procedural-roughness-field", "confidence": 0.7, "resolution": 1024, "source": "inferred from surface finish"}, "normal": {"path": "procedural-normal-field", "confidence": 0.65, "resolution": 1024, "source": "stamped-metal grain procedural"}, "ao": {"path": "procedural-ao-field", "confidence": 0.7, "resolution": 1024, "source": "computed from geometry"}, "height": {"path": "procedural-height-field", "confidence": 0.6, "resolution": 1024, "source": "displacement from surface detail"}}}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "AK-47 Wild Lotus__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "AK-47 Wild Lotus", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Root group holding all child components", "geometryDescriptor": {"topologyIntent": "root pivot only", "uvStrategy": "generated procedural coordinates"}, "parent": null, "attachment": null, "dimensions": {"width": 0.88, "height": 0.22, "depth": 0.06, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.6, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": false, "visibility": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1]}, "destruction": {"breakable": false, "fractureGroup": "root"}}, "material": "wild-lotus-base", "evidenceRefs": ["left-view", "right-view"]};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": false, "visibility": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1]}, "destruction": {"breakable": false, "fractureGroup": "root"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["wild-lotus-base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "AK-47 Wild Lotus";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "AK-47 Wild Lotus", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Root group holding all child components", "geometryDescriptor": {"topologyIntent": "root pivot only", "uvStrategy": "generated procedural coordinates"}, "parent": null, "attachment": null, "dimensions": {"width": 0.88, "height": 0.22, "depth": 0.06, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.6, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "detach": false, "visibility": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1]}, "destruction": {"breakable": false, "fractureGroup": "root"}}, "material": "wild-lotus-base", "evidenceRefs": ["left-view", "right-view"]};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1]};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_stock_1 = makeAttachmentEndpoint(null);
  const node_stock_1 = new THREE.Group();
  node_stock_1.name = "Fixed Stock__pivot";
  node_stock_1.scale.set(1, 1, 1);
  if (endpoint_stock_1) {
    node_stock_1.position.copy(endpoint_stock_1.start);
    node_stock_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stock_1.position.set(-0.38, -0.01, 0.0);
    node_stock_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_stock_1.userData.sculptComponent = {"id": "stock", "name": "Fixed Stock", "level": "macro", "role": "stock", "importance": 0.9, "confidence": 0.92, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded triangular profile matching AK fixed stock", "geometryDescriptor": {"topologyIntent": "triangular cross-section extruded along length, slight taper toward butt", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.003, "segments": 2}, "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "receiver-rear", "contactType": "butt-joint", "localStart": [0, 0, 0], "localEnd": [-0.05, 0, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.26, "height": 0.14, "depth": 0.045, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.38, -0.01, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false, "detach": true}, "collider": {"type": "box"}, "destruction": {"breakable": true, "fractureGroup": "stock"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "stock-lily", "type": "decal-area", "description": "Large pink lily flower on stock butt", "placement": "rear-third lateral face", "size": 0.08, "materialEffect": "high-saturation pink", "confidence": 0.95}, {"id": "stock-gold-band", "type": "raised-ridge", "description": "Curved gold accent band", "placement": "diagonal across stock", "size": 0.015, "materialEffect": "metallic gold", "confidence": 0.95}], "evidenceRefs": ["left-view", "right-view"]};
  node_stock_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false, "detach": true}, "collider": {"type": "box"}, "destruction": {"breakable": true, "fractureGroup": "stock"}};
  (nodes["root"] ?? root).add(node_stock_1);
  nodes["stock"] = node_stock_1;
  const mesh_stock_1Geometry = endpoint_stock_1
    ? new THREE.CylinderGeometry(endpoint_stock_1.endRadius, endpoint_stock_1.baseRadius, endpoint_stock_1.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_stock_1) {
    mesh_stock_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stock_1 = new THREE.Mesh(
    mesh_stock_1Geometry,
    materialMap["wild-lotus-base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stock_1.name = "Fixed Stock";
  if (endpoint_stock_1) {
    mesh_stock_1.position.copy(endpoint_stock_1.midpoint);
    mesh_stock_1.quaternion.copy(endpoint_stock_1.quaternion);
  }
  mesh_stock_1.castShadow = options.castShadow ?? true;
  mesh_stock_1.receiveShadow = options.receiveShadow ?? true;
  mesh_stock_1.userData.sculptComponent = {"id": "stock", "name": "Fixed Stock", "level": "macro", "role": "stock", "importance": 0.9, "confidence": 0.92, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded triangular profile matching AK fixed stock", "geometryDescriptor": {"topologyIntent": "triangular cross-section extruded along length, slight taper toward butt", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.003, "segments": 2}, "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "receiver-rear", "contactType": "butt-joint", "localStart": [0, 0, 0], "localEnd": [-0.05, 0, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.26, "height": 0.14, "depth": 0.045, "units": "meters", "confidence": 0.88}, "transform": {"position": [-0.38, -0.01, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false, "detach": true}, "collider": {"type": "box"}, "destruction": {"breakable": true, "fractureGroup": "stock"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "stock-lily", "type": "decal-area", "description": "Large pink lily flower on stock butt", "placement": "rear-third lateral face", "size": 0.08, "materialEffect": "high-saturation pink", "confidence": 0.95}, {"id": "stock-gold-band", "type": "raised-ridge", "description": "Curved gold accent band", "placement": "diagonal across stock", "size": 0.015, "materialEffect": "metallic gold", "confidence": 0.95}], "evidenceRefs": ["left-view", "right-view"]};
  node_stock_1.add(mesh_stock_1);
  meshes["stock"] = mesh_stock_1;
  colliders["stock"] = {"type": "box"};
  destructionGroups["stock"] ??= [];
  destructionGroups["stock"].push(node_stock_1);

  const endpoint_receiver_2 = makeAttachmentEndpoint(null);
  const node_receiver_2 = new THREE.Group();
  node_receiver_2.name = "Stamped Receiver__pivot";
  node_receiver_2.scale.set(1, 1, 1);
  if (endpoint_receiver_2) {
    node_receiver_2.position.copy(endpoint_receiver_2.start);
    node_receiver_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_receiver_2.position.set(-0.08, 0.0, 0.0);
    node_receiver_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_receiver_2.userData.sculptComponent = {"id": "receiver", "name": "Stamped Receiver", "level": "macro", "role": "receiver", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rectangular stamped metal box, AK core", "geometryDescriptor": {"topologyIntent": "rectangular box with dust cover top, trigger guard below", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.002, "segments": 1}, "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": null, "contactType": "core-body", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "overlap": 0, "gapTolerance": 0}, "dimensions": {"width": 0.22, "height": 0.08, "depth": 0.05, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.08, 0.0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "sockets": [{"id": "receiver-rear", "position": [-0.11, 0, 0], "type": "butt-joint"}, {"id": "receiver-front", "position": [0.11, 0, 0], "type": "socket"}, {"id": "mag-well", "position": [-0.02, -0.05, 0], "type": "insert"}, {"id": "grip-socket", "position": [0.02, -0.05, 0], "type": "embed"}], "collider": {"type": "box"}, "destruction": {"breakable": false, "fractureGroup": "receiver"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "receiver-lotus", "type": "decal-area", "description": "Large red lotus flower", "placement": "center-right receiver face", "size": 0.1, "materialEffect": "high-saturation red", "confidence": 0.98}, {"id": "bolt-handle", "type": "raised-ridge", "description": "Charging handle on right side", "placement": "upper-right receiver", "size": 0.02, "materialEffect": "dark metal", "confidence": 0.9}], "evidenceRefs": ["left-view", "right-view"]};
  node_receiver_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "sockets": [{"id": "receiver-rear", "position": [-0.11, 0, 0], "type": "butt-joint"}, {"id": "receiver-front", "position": [0.11, 0, 0], "type": "socket"}, {"id": "mag-well", "position": [-0.02, -0.05, 0], "type": "insert"}, {"id": "grip-socket", "position": [0.02, -0.05, 0], "type": "embed"}], "collider": {"type": "box"}, "destruction": {"breakable": false, "fractureGroup": "receiver"}};
  (nodes["root"] ?? root).add(node_receiver_2);
  nodes["receiver"] = node_receiver_2;
  const mesh_receiver_2Geometry = endpoint_receiver_2
    ? new THREE.CylinderGeometry(endpoint_receiver_2.endRadius, endpoint_receiver_2.baseRadius, endpoint_receiver_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_receiver_2) {
    mesh_receiver_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_receiver_2 = new THREE.Mesh(
    mesh_receiver_2Geometry,
    materialMap["wild-lotus-base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_receiver_2.name = "Stamped Receiver";
  if (endpoint_receiver_2) {
    mesh_receiver_2.position.copy(endpoint_receiver_2.midpoint);
    mesh_receiver_2.quaternion.copy(endpoint_receiver_2.quaternion);
  }
  mesh_receiver_2.castShadow = options.castShadow ?? true;
  mesh_receiver_2.receiveShadow = options.receiveShadow ?? true;
  mesh_receiver_2.userData.sculptComponent = {"id": "receiver", "name": "Stamped Receiver", "level": "macro", "role": "receiver", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rectangular stamped metal box, AK core", "geometryDescriptor": {"topologyIntent": "rectangular box with dust cover top, trigger guard below", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.002, "segments": 1}, "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": null, "contactType": "core-body", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "overlap": 0, "gapTolerance": 0}, "dimensions": {"width": 0.22, "height": 0.08, "depth": 0.05, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.08, 0.0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "sockets": [{"id": "receiver-rear", "position": [-0.11, 0, 0], "type": "butt-joint"}, {"id": "receiver-front", "position": [0.11, 0, 0], "type": "socket"}, {"id": "mag-well", "position": [-0.02, -0.05, 0], "type": "insert"}, {"id": "grip-socket", "position": [0.02, -0.05, 0], "type": "embed"}], "collider": {"type": "box"}, "destruction": {"breakable": false, "fractureGroup": "receiver"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "receiver-lotus", "type": "decal-area", "description": "Large red lotus flower", "placement": "center-right receiver face", "size": 0.1, "materialEffect": "high-saturation red", "confidence": 0.98}, {"id": "bolt-handle", "type": "raised-ridge", "description": "Charging handle on right side", "placement": "upper-right receiver", "size": 0.02, "materialEffect": "dark metal", "confidence": 0.9}], "evidenceRefs": ["left-view", "right-view"]};
  node_receiver_2.add(mesh_receiver_2);
  meshes["receiver"] = mesh_receiver_2;
  colliders["receiver"] = {"type": "box"};
  destructionGroups["receiver"] ??= [];
  destructionGroups["receiver"].push(node_receiver_2);
  const socket_receiver_receiver_rear_0 = new THREE.Object3D();
  socket_receiver_receiver_rear_0.name = "receiver-rear";
  socket_receiver_receiver_rear_0.position.set(-0.11, 0.0, 0.0);
  socket_receiver_receiver_rear_0.rotation.set(0, 0, 0);
  socket_receiver_receiver_rear_0.userData.socket = {"id": "receiver-rear", "position": [-0.11, 0, 0], "type": "butt-joint"};
  node_receiver_2.add(socket_receiver_receiver_rear_0);
  sockets["receiver:receiver-rear"] = socket_receiver_receiver_rear_0;
  const socket_receiver_receiver_front_1 = new THREE.Object3D();
  socket_receiver_receiver_front_1.name = "receiver-front";
  socket_receiver_receiver_front_1.position.set(0.11, 0.0, 0.0);
  socket_receiver_receiver_front_1.rotation.set(0, 0, 0);
  socket_receiver_receiver_front_1.userData.socket = {"id": "receiver-front", "position": [0.11, 0, 0], "type": "socket"};
  node_receiver_2.add(socket_receiver_receiver_front_1);
  sockets["receiver:receiver-front"] = socket_receiver_receiver_front_1;
  const socket_receiver_mag_well_2 = new THREE.Object3D();
  socket_receiver_mag_well_2.name = "mag-well";
  socket_receiver_mag_well_2.position.set(-0.02, -0.05, 0.0);
  socket_receiver_mag_well_2.rotation.set(0, 0, 0);
  socket_receiver_mag_well_2.userData.socket = {"id": "mag-well", "position": [-0.02, -0.05, 0], "type": "insert"};
  node_receiver_2.add(socket_receiver_mag_well_2);
  sockets["receiver:mag-well"] = socket_receiver_mag_well_2;
  const socket_receiver_grip_socket_3 = new THREE.Object3D();
  socket_receiver_grip_socket_3.name = "grip-socket";
  socket_receiver_grip_socket_3.position.set(0.02, -0.05, 0.0);
  socket_receiver_grip_socket_3.rotation.set(0, 0, 0);
  socket_receiver_grip_socket_3.userData.socket = {"id": "grip-socket", "position": [0.02, -0.05, 0], "type": "embed"};
  node_receiver_2.add(socket_receiver_grip_socket_3);
  sockets["receiver:grip-socket"] = socket_receiver_grip_socket_3;

  const attachment_handguard_3 = {"parentSocket": "receiver-front", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.08, 0, 0], "overlap": 0.01, "gapTolerance": 0.002};
  const endpoint_handguard_3 = makeAttachmentEndpoint(attachment_handguard_3);
  const node_handguard_3 = new THREE.Group();
  node_handguard_3.name = "Handguard Assembly__pivot";
  node_handguard_3.scale.set(1, 1, 1);
  if (endpoint_handguard_3) {
    node_handguard_3.position.copy(endpoint_handguard_3.start);
    node_handguard_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_handguard_3.position.set(0.16, 0.0, 0.0);
    node_handguard_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_handguard_3.userData.sculptComponent = {"id": "handguard", "name": "Handguard Assembly", "level": "macro", "role": "handguard", "importance": 0.85, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Upper/lower handguard halves around barrel", "geometryDescriptor": {"topologyIntent": "two half-cylinders around barrel", "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "receiver-front", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.08, 0, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.16, "height": 0.05, "depth": 0.045, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.16, 0.0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "handguard"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "handguard-teal", "type": "surface-finish", "description": "Teal paint with floral pattern", "placement": "entire surface", "size": 0.16, "materialEffect": "teal with pink accents", "confidence": 0.9}], "evidenceRefs": ["left-view", "right-view"]};
  node_handguard_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "handguard"}};
  (nodes["root"] ?? root).add(node_handguard_3);
  nodes["handguard"] = node_handguard_3;
  const mesh_handguard_3Geometry = endpoint_handguard_3
    ? new THREE.CylinderGeometry(endpoint_handguard_3.endRadius, endpoint_handguard_3.baseRadius, endpoint_handguard_3.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_handguard_3) {
    mesh_handguard_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_handguard_3 = new THREE.Mesh(
    mesh_handguard_3Geometry,
    materialMap["wild-lotus-base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_handguard_3.name = "Handguard Assembly";
  if (endpoint_handguard_3) {
    mesh_handguard_3.position.copy(endpoint_handguard_3.midpoint);
    mesh_handguard_3.quaternion.copy(endpoint_handguard_3.quaternion);
  }
  mesh_handguard_3.castShadow = options.castShadow ?? true;
  mesh_handguard_3.receiveShadow = options.receiveShadow ?? true;
  mesh_handguard_3.userData.sculptComponent = {"id": "handguard", "name": "Handguard Assembly", "level": "macro", "role": "handguard", "importance": 0.85, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Upper/lower handguard halves around barrel", "geometryDescriptor": {"topologyIntent": "two half-cylinders around barrel", "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "receiver-front", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.08, 0, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.16, "height": 0.05, "depth": 0.045, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.16, 0.0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "handguard"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "handguard-teal", "type": "surface-finish", "description": "Teal paint with floral pattern", "placement": "entire surface", "size": 0.16, "materialEffect": "teal with pink accents", "confidence": 0.9}], "evidenceRefs": ["left-view", "right-view"]};
  node_handguard_3.add(mesh_handguard_3);
  meshes["handguard"] = mesh_handguard_3;
  colliders["handguard"] = {"type": "cylinder"};
  destructionGroups["handguard"] ??= [];
  destructionGroups["handguard"].push(node_handguard_3);

  const attachment_barrel_4 = {"parentSocket": "receiver-front", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.38, 0, 0], "overlap": 0.01, "gapTolerance": 0.002};
  const endpoint_barrel_4 = makeAttachmentEndpoint(attachment_barrel_4);
  const node_barrel_4 = new THREE.Group();
  node_barrel_4.name = "Barrel__pivot";
  node_barrel_4.scale.set(1, 1, 1);
  if (endpoint_barrel_4) {
    node_barrel_4.position.copy(endpoint_barrel_4.start);
    node_barrel_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_barrel_4.position.set(0.28, -0.005, 0.0);
    node_barrel_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_barrel_4.userData.sculptComponent = {"id": "barrel", "name": "Barrel", "level": "macro", "role": "barrel", "importance": 0.85, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Long cylindrical barrel, dark metal", "geometryDescriptor": {"topologyIntent": "straight cylinder forward of handguard", "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "receiver-front", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.38, 0, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.38, "height": 0.018, "depth": 0.018, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.28, -0.005, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1)", "secondaryAlbedo": "rgba(42, 42, 42, 1)", "materialClass": "metal", "materialClassConfidence": 0.9, "roughness": 0.4, "metalness": 0.9}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "barrel"}}, "material": "dark-metal", "evidenceRefs": ["left-view", "right-view"]};
  node_barrel_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "barrel"}};
  (nodes["root"] ?? root).add(node_barrel_4);
  nodes["barrel"] = node_barrel_4;
  const mesh_barrel_4Geometry = endpoint_barrel_4
    ? new THREE.CylinderGeometry(endpoint_barrel_4.endRadius, endpoint_barrel_4.baseRadius, endpoint_barrel_4.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_barrel_4) {
    mesh_barrel_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_barrel_4 = new THREE.Mesh(
    mesh_barrel_4Geometry,
    materialMap["dark-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_barrel_4.name = "Barrel";
  if (endpoint_barrel_4) {
    mesh_barrel_4.position.copy(endpoint_barrel_4.midpoint);
    mesh_barrel_4.quaternion.copy(endpoint_barrel_4.quaternion);
  }
  mesh_barrel_4.castShadow = options.castShadow ?? true;
  mesh_barrel_4.receiveShadow = options.receiveShadow ?? true;
  mesh_barrel_4.userData.sculptComponent = {"id": "barrel", "name": "Barrel", "level": "macro", "role": "barrel", "importance": 0.85, "confidence": 0.92, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Long cylindrical barrel, dark metal", "geometryDescriptor": {"topologyIntent": "straight cylinder forward of handguard", "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "receiver-front", "contactType": "socket", "localStart": [0, 0, 0], "localEnd": [0.38, 0, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.38, "height": 0.018, "depth": 0.018, "units": "meters", "confidence": 0.9}, "transform": {"position": [0.28, -0.005, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(26, 26, 26, 1)", "secondaryAlbedo": "rgba(42, 42, 42, 1)", "materialClass": "metal", "materialClassConfidence": 0.9, "roughness": 0.4, "metalness": 0.9}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "barrel"}}, "material": "dark-metal", "evidenceRefs": ["left-view", "right-view"]};
  node_barrel_4.add(mesh_barrel_4);
  meshes["barrel"] = mesh_barrel_4;
  colliders["barrel"] = {"type": "cylinder"};
  destructionGroups["barrel"] ??= [];
  destructionGroups["barrel"].push(node_barrel_4);

  const endpoint_magazine_5 = makeAttachmentEndpoint(null);
  const node_magazine_5 = new THREE.Group();
  node_magazine_5.name = "Curved Banana Magazine__pivot";
  node_magazine_5.scale.set(1, 1, 1);
  if (endpoint_magazine_5) {
    node_magazine_5.position.copy(endpoint_magazine_5.start);
    node_magazine_5.rotation.set(0.0, 0.0, -8.0);
  } else {
    node_magazine_5.position.set(-0.02, -0.1, 0.0);
    node_magazine_5.rotation.set(0.0, 0.0, -8.0);
  }
  node_magazine_5.userData.sculptComponent = {"id": "magazine", "name": "Curved Banana Magazine", "level": "macro", "role": "magazine", "importance": 0.9, "confidence": 0.93, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile, iconic AK banana shape", "geometryDescriptor": {"topologyIntent": "curved rectangular cross-section following banana arc", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.002, "segments": 1}, "deformationStack": [{"type": "bend", "axis": "Z", "angle": 25, "falloff": "linear"}], "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "mag-well", "contactType": "insert", "localStart": [0, 0.09, 0], "localEnd": [0, -0.09, 0], "overlap": 0.015, "gapTolerance": 0.002}, "dimensions": {"width": 0.04, "height": 0.18, "depth": 0.025, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.02, -0.1, 0], "rotation": [0, 0, -8], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "detachable", "pivot": {"mode": "top", "localPosition": [0, 0.09, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": true, "rotate": true, "detach": true}, "collider": {"type": "box"}, "destruction": {"breakable": true, "fractureGroup": "magazine"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "mag-gold-band", "type": "raised-ridge", "description": "Curved gold accent stripe", "placement": "center of magazine face", "size": 0.012, "materialEffect": "metallic gold", "confidence": 0.95}, {"id": "mag-witness-holes", "type": "hole-or-socket", "description": "Witness holes for round counting", "placement": "left side vertical row", "size": 0.003, "materialEffect": "dark recess", "confidence": 0.85}, {"id": "mag-flowers", "type": "decal-area", "description": "Small orange and pink accent flowers", "placement": "lower magazine", "size": 0.04, "materialEffect": "orange/pink accents", "confidence": 0.85}], "evidenceRefs": ["left-view", "right-view"]};
  node_magazine_5.userData.actionProfile = {"animationRole": "detachable", "pivot": {"mode": "top", "localPosition": [0, 0.09, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": true, "rotate": true, "detach": true}, "collider": {"type": "box"}, "destruction": {"breakable": true, "fractureGroup": "magazine"}};
  (nodes["root"] ?? root).add(node_magazine_5);
  nodes["magazine"] = node_magazine_5;
  const mesh_magazine_5Geometry = endpoint_magazine_5
    ? new THREE.CylinderGeometry(endpoint_magazine_5.endRadius, endpoint_magazine_5.baseRadius, endpoint_magazine_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  if (!endpoint_magazine_5) {
    mesh_magazine_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_magazine_5 = new THREE.Mesh(
    mesh_magazine_5Geometry,
    materialMap["wild-lotus-base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_magazine_5.name = "Curved Banana Magazine";
  if (endpoint_magazine_5) {
    mesh_magazine_5.position.copy(endpoint_magazine_5.midpoint);
    mesh_magazine_5.quaternion.copy(endpoint_magazine_5.quaternion);
  }
  mesh_magazine_5.castShadow = options.castShadow ?? true;
  mesh_magazine_5.receiveShadow = options.receiveShadow ?? true;
  mesh_magazine_5.userData.sculptComponent = {"id": "magazine", "name": "Curved Banana Magazine", "level": "macro", "role": "magazine", "importance": 0.9, "confidence": 0.93, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Extruded curved profile, iconic AK banana shape", "geometryDescriptor": {"topologyIntent": "curved rectangular cross-section following banana arc", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.002, "segments": 1}, "deformationStack": [{"type": "bend", "axis": "Z", "angle": 25, "falloff": "linear"}], "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "mag-well", "contactType": "insert", "localStart": [0, 0.09, 0], "localEnd": [0, -0.09, 0], "overlap": 0.015, "gapTolerance": 0.002}, "dimensions": {"width": 0.04, "height": 0.18, "depth": 0.025, "units": "meters", "confidence": 0.9}, "transform": {"position": [-0.02, -0.1, 0], "rotation": [0, 0, -8], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "detachable", "pivot": {"mode": "top", "localPosition": [0, 0.09, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": true, "rotate": true, "detach": true}, "collider": {"type": "box"}, "destruction": {"breakable": true, "fractureGroup": "magazine"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "mag-gold-band", "type": "raised-ridge", "description": "Curved gold accent stripe", "placement": "center of magazine face", "size": 0.012, "materialEffect": "metallic gold", "confidence": 0.95}, {"id": "mag-witness-holes", "type": "hole-or-socket", "description": "Witness holes for round counting", "placement": "left side vertical row", "size": 0.003, "materialEffect": "dark recess", "confidence": 0.85}, {"id": "mag-flowers", "type": "decal-area", "description": "Small orange and pink accent flowers", "placement": "lower magazine", "size": 0.04, "materialEffect": "orange/pink accents", "confidence": 0.85}], "evidenceRefs": ["left-view", "right-view"]};
  node_magazine_5.add(mesh_magazine_5);
  meshes["magazine"] = mesh_magazine_5;
  colliders["magazine"] = {"type": "box"};
  destructionGroups["magazine"] ??= [];
  destructionGroups["magazine"].push(node_magazine_5);

  const attachment_grip_6 = {"parentSocket": "grip-socket", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, -0.08, 0], "overlap": 0.01, "gapTolerance": 0.002};
  const endpoint_grip_6 = makeAttachmentEndpoint(attachment_grip_6);
  const node_grip_6 = new THREE.Group();
  node_grip_6.name = "Pistol Grip__pivot";
  node_grip_6.scale.set(1, 1, 1);
  if (endpoint_grip_6) {
    node_grip_6.position.copy(endpoint_grip_6.start);
    node_grip_6.rotation.set(0.0, 0.0, 12.0);
  } else {
    node_grip_6.position.set(0.02, -0.08, 0.0);
    node_grip_6.rotation.set(0.0, 0.0, 12.0);
  }
  node_grip_6.userData.sculptComponent = {"id": "grip", "name": "Pistol Grip", "level": "macro", "role": "grip", "importance": 0.8, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Tapered ergonomic cylinder below receiver", "geometryDescriptor": {"topologyIntent": "tapered cylinder with forward angle", "deformationStack": [{"type": "taper", "startRadius": 0.015, "endRadius": 0.018, "axis": "Y"}], "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "grip-socket", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, -0.08, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.03, "height": 0.08, "depth": 0.03, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.02, -0.08, 0], "rotation": [0, 0, 12], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "grip"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "grip-vines", "type": "linework", "description": "Green vine/leaf pattern", "placement": "entire grip face", "size": 0.06, "materialEffect": "dark green overlay", "confidence": 0.85}], "evidenceRefs": ["left-view", "right-view"]};
  node_grip_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "grip"}};
  (nodes["root"] ?? root).add(node_grip_6);
  nodes["grip"] = node_grip_6;
  const mesh_grip_6Geometry = endpoint_grip_6
    ? new THREE.CylinderGeometry(endpoint_grip_6.endRadius, endpoint_grip_6.baseRadius, endpoint_grip_6.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_grip_6) {
    mesh_grip_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_grip_6 = new THREE.Mesh(
    mesh_grip_6Geometry,
    materialMap["wild-lotus-base"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_6.name = "Pistol Grip";
  if (endpoint_grip_6) {
    mesh_grip_6.position.copy(endpoint_grip_6.midpoint);
    mesh_grip_6.quaternion.copy(endpoint_grip_6.quaternion);
  }
  mesh_grip_6.castShadow = options.castShadow ?? true;
  mesh_grip_6.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_6.userData.sculptComponent = {"id": "grip", "name": "Pistol Grip", "level": "macro", "role": "grip", "importance": 0.8, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Tapered ergonomic cylinder below receiver", "geometryDescriptor": {"topologyIntent": "tapered cylinder with forward angle", "deformationStack": [{"type": "taper", "startRadius": 0.015, "endRadius": 0.018, "axis": "Y"}], "uvStrategy": "generated procedural coordinates"}, "parent": "root", "attachment": {"parentSocket": "grip-socket", "contactType": "embed", "localStart": [0, 0, 0], "localEnd": [0, -0.08, 0], "overlap": 0.01, "gapTolerance": 0.002}, "dimensions": {"width": 0.03, "height": 0.08, "depth": 0.03, "units": "meters", "confidence": 0.88}, "transform": {"position": [0.02, -0.08, 0], "rotation": [0, 0, 12], "scale": [1, 1, 1]}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 122, 90, 1)", "secondaryAlbedo": "rgba(30, 94, 66, 1)", "materialClass": "plastic", "materialClassConfidence": 0.7, "roughness": 0.55, "metalness": 0.1}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0]}, "transformChannels": {"translate": false, "rotate": false}, "collider": {"type": "cylinder"}, "destruction": {"breakable": true, "fractureGroup": "grip"}}, "material": "wild-lotus-base", "localFeatures": [{"id": "grip-vines", "type": "linework", "description": "Green vine/leaf pattern", "placement": "entire grip face", "size": 0.06, "materialEffect": "dark green overlay", "confidence": 0.85}], "evidenceRefs": ["left-view", "right-view"]};
  node_grip_6.add(mesh_grip_6);
  meshes["grip"] = mesh_grip_6;
  colliders["grip"] = {"type": "cylinder"};
  destructionGroups["grip"] ??= [];
  destructionGroups["grip"].push(node_grip_6);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7}, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"]}, "lightingPass": {"exposure": {"value": 1.0, "intent": "Neutral exposure for material readability"}, "toneMapping": {"algorithm": "ACESFilmic", "intent": "Standard filmic response"}, "background": {"color": "#1a1a1a", "intent": "Dark neutral background"}, "contactShadow": {"enabled": true, "bias": 0.02}, "groundShadow": {"enabled": true, "softness": 0.5}}};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createAK47WildLotusLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "AK-47 Wild Lotus look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "key", "direction": [0.3, 0.5, 1.0], "color": "#FFFFFF", "intensity": 1.0, "note": "Primary key light for material readability"}, {"type": "fill", "direction": [-0.5, 0.3, 0.5], "color": "#E8E8F0", "intensity": 0.4, "note": "Fill light for shadow softening"}, {"type": "rim", "direction": [0, 0.2, -1.0], "color": "#FFFFFF", "intensity": 0.6, "note": "Rim light for silhouette edge"}, {"type": "exposure", "value": 1.0, "toneMapping": "ACESFilmic", "note": "Neutral exposure with ACES filmic tone mapping"}, {"type": "shadow", "contactShadow": true, "groundShadow": true, "note": "Contact shadow and ground shadow enabled"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7}, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"]}, "lightingPass": {"exposure": {"value": 1.0, "intent": "Neutral exposure for material readability"}, "toneMapping": {"algorithm": "ACESFilmic", "intent": "Standard filmic response"}, "background": {"color": "#1a1a1a", "intent": "Dark neutral background"}, "contactShadow": {"enabled": true, "bias": 0.02}, "groundShadow": {"enabled": true, "softness": 0.5}}};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createAK47WildLotusEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameAK47WildLotusCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createAK47WildLotusPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureAK47WildLotusRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createAK47WildLotusInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
