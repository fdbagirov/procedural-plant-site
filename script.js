import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

// Сначала браузер показывает тексты и рамку, а тяжёлую 3D-сцену строим уже после первой отрисовки
await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
// Короткая передышка между тяжёлыми шагами построения, чтобы страница не «замирала» надолго
const pause = () => new Promise((resolve) => setTimeout(resolve));

// ---------- Общее ----------

// Предсказуемый «случайный» генератор: растение каждый раз одинаковое
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(7);
const range = (a, b) => a + (b - a) * rand();
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- Цвет в OKLab / OKLCH ----------
// Цвета задаём в OKLCH (светлота, насыщенность, оттенок) — шкале, близкой к тому, как видит глаз.
// Смешиваем в OKLab: так переходы (розовое основание → зелёный лист) не «грязнеют» посередине.

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToOklab(c) {
  const l = Math.cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  const m = Math.cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  const s = Math.cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// Если цвет не помещается в экранную гамму, убавляем насыщенность, а светлоту и оттенок сохраняем
function oklch(L, C, h) {
  const rad = (h * Math.PI) / 180;
  let rgb;
  for (let c = C; c >= 0; c -= 0.002) {
    rgb = oklabToLinear(L, c * Math.cos(rad), c * Math.sin(rad));
    if (rgb.every((v) => v >= 0 && v <= 1)) break;
  }
  return new THREE.Color().setRGB(...rgb.map((v) => Math.min(1, Math.max(0, v))), THREE.LinearSRGBColorSpace);
}

// Цвета для смешивания храним сразу в OKLab (массив [L, a, b]) и переводим в экранные один раз, в самом конце:
// так десятки тысяч вершин листьев раскрашиваются без лишних пересчётов туда-обратно
const lab = (color) => linearToOklab(color);
const mixLab = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const labToLinear = (c) => oklabToLinear(c[0], c[1], c[2]).map((v) => Math.min(1, Math.max(0, v)));
const labToColor = (c) => new THREE.Color().setRGB(...labToLinear(c), THREE.LinearSRGBColorSpace);

const canvas = document.getElementById('scene');
// Телефоны и планшеты: сцена рисуется чуть проще (разрешение, тени, свечение), чтобы видеокарта не захлёбывалась
const LITE = window.matchMedia('(pointer: coarse)').matches;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LITE });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, LITE ? 1.5 : 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#000000');

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const CAMERA_TARGET = new THREE.Vector3(0, 3.25, 0);

// ---------- Свет ----------

// Направления света нужны и для «запечённой» яркости волосков
const KEY_POS = new THREE.Vector3(-4, 9, 6);
const RIM_DIR = new THREE.Vector3(-3, 6, -6).normalize();
const RIM2_DIR = new THREE.Vector3(4, 3, -5).normalize();
const FILL_DIR = new THREE.Vector3(0.5, -0.4, 1).normalize();

// distance = 12: свет гаснет, не доходя до стены — верх стены остаётся чёрным, как в референсе
const key = new THREE.SpotLight('#fff0dc', 620, 12, 0.32, 0.6, 2);
key.position.copy(KEY_POS);
key.target.position.set(0, 3.4, 0);
key.castShadow = true;
key.shadow.mapSize.setScalar(LITE ? 1024 : 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.015;
// Тень от верхнего света только на самом растении, до фона она не долетает
key.shadow.camera.far = 11;
// Жёсткие тени между листьями
key.shadow.radius = 1;
scene.add(key, key.target);

// Пятно на фоне: красное свечение снизу и тень растения справа
const backLight = new THREE.SpotLight('#ffcab4', 210, 0, 0.5, 1, 2);
// Свет сбоку-сверху под острым углом к стене: тень вытягивается и уходит далеко вправо по стене
backLight.position.set(-4.5, 6.5, 5.5);
backLight.target.position.set(0.8, 0.3, -3.5);
backLight.castShadow = true;
// Тень цветка на стене: узнаваемая по форме, но с мягким краем, как в референсе
backLight.shadow.mapSize.set(512, 512);
backLight.shadow.bias = -0.0005;
backLight.shadow.radius = 26;
backLight.shadow.blurSamples = LITE ? 12 : 25;
scene.add(backLight, backLight.target);

const rim = new THREE.DirectionalLight('#ffe6c4', 2.6);
rim.position.copy(RIM_DIR).multiplyScalar(10);
const rim2 = new THREE.DirectionalLight('#ffa888', 1.4);
rim2.position.copy(RIM2_DIR).multiplyScalar(10);
const fill = new THREE.DirectionalLight('#ffd2c8', 0.2);
fill.position.copy(FILL_DIR).multiplyScalar(10);
scene.add(rim, rim2, fill);
scene.add(new THREE.HemisphereLight('#3a1a14', '#0a0000', 0.15));

// ---------- Фон ----------
// Стена — бордовый бархат (img/velvet.webp) с картой нормалей (img/velvet-normal.webp, посчитана из яркости картинки):
// свет честно ложится на ворс. Цвет стены ровный бордовый, а пятна бархата оставлены лишь как лёгкая
// игра светлее/темнее (WALL_DETAIL) — узор почти незаметный. Картинка не бесшовная — повтор зеркальный.

const WALL_W = 60;
const WALL_H = 40;
const WALL_Y = 4;
const WALL_IMAGE_H = 11; // высота одной картинки на стене, в единицах сцены
const WALL_FLAT = new THREE.Color(0.22, 0.013, 0.016); // ровный цвет стены (линейный)
const WALL_DETAIL = 0.35; // насколько заметны пятна бархата: 0 — ровная стена, 1 — как на картинке
const WALL_MEAN_LUM = 0.024; // средняя яркость картинки — чтобы в среднем стена оставалась цвета WALL_FLAT

function wallTexture(path, isColor) {
  const tex = new THREE.TextureLoader().load(path);
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.repeat.set(WALL_W / (WALL_IMAGE_H * (1152 / 2048)), WALL_H / WALL_IMAGE_H);
  // Центр одной картинки — ровно за цветком
  tex.offset.set(
    0.5 - 0.5 * tex.repeat.x,
    0.5 - ((CAMERA_TARGET.y - (WALL_Y - WALL_H / 2)) / WALL_H) * tex.repeat.y
  );
  return tex;
}

const wallMaterial = new THREE.MeshStandardMaterial({
  map: wallTexture('img/velvet.webp', true),
  normalMap: wallTexture('img/velvet-normal.webp', false),
  normalScale: new THREE.Vector2(0.8, 0.8),
  roughness: 0.95,
});
wallMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uWallFlat = { value: WALL_FLAT };
  shader.fragmentShader = 'uniform vec3 uWallFlat;\n' + shader.fragmentShader.replace(
    '#include <map_fragment>',
    `#include <map_fragment>
    float velvetLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    diffuseColor.rgb = uWallFlat * mix(1.0, velvetLum / ${WALL_MEAN_LUM.toFixed(4)}, ${WALL_DETAIL.toFixed(2)});`
  );
};

const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(WALL_W, WALL_H), wallMaterial);
backdrop.position.set(0, WALL_Y, -3.5);
backdrop.receiveShadow = true;
scene.add(backdrop);

// ---------- Волоски ----------

const HAIR_COLOR = new THREE.Color('#e4ead0');
const KEY_DIR_AT_PLANT = KEY_POS.clone().sub(new THREE.Vector3(0, 3, 0)).normalize();

// Яркость волоска по его направлению: линии не освещаются сами, поэтому считаем заранее
function hairBrightness(n) {
  return Math.min(1.1,
    0.1 +
    0.75 * Math.max(0, n.dot(KEY_DIR_AT_PLANT)) +
    0.9 * Math.max(0, n.dot(RIM_DIR)) +
    0.45 * Math.max(0, n.dot(RIM2_DIR)) +
    0.25 * Math.max(0, n.dot(FILL_DIR))
  );
}

const hairMaterial = new THREE.LineBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.38,
  depthWrite: false,
});

// Волосок у корня принимает цвет поверхности, к кончику светлеет —
// так пушок не «забеливает» стебель и листья, а лишь светится на краях
function pushHair(pos, col, root, dir, len, normal, surface) {
  const b = hairBrightness(normal);
  const tip = surface.clone().lerp(HAIR_COLOR, 0.6).multiplyScalar(b);
  const base = surface.clone().multiplyScalar(0.5 + 0.5 * b);
  pos.push(root.x, root.y, root.z, root.x + dir.x * len, root.y + dir.y * len, root.z + dir.z * len);
  col.push(base.r, base.g, base.b, tip.r, tip.g, tip.b);
}

function randomUnit() {
  return new THREE.Vector3(range(-1, 1), range(-1, 1), range(-1, 1)).normalize();
}

// ---------- Стебель ----------

// Итоговая форма стебля (взрослое растение). Во время роста он короче и извивается — см. shapeStem.
const STEM_FINAL = [
  new THREE.Vector3(-0.78, -1.4, 0.1),
  new THREE.Vector3(-0.74, 0.1, 0.06),
  new THREE.Vector3(-0.52, 1.3, 0),
  new THREE.Vector3(-0.16, 2.45, -0.06),
  new THREE.Vector3(0.07, 3.4, 0),
  new THREE.Vector3(0.1, 4.02, 0.03),
];
const stemCurve = new THREE.CatmullRomCurve3(STEM_FINAL.map((p) => p.clone()));
const STEM_TOP = new THREE.Vector3();
const STEM_TOP_DIR = new THREE.Vector3(0, 1, 0);
const STEM_SEG = 260;
const STEM_RAD = 16;
const stemRadius = (t) => 0.056 - 0.012 * t + 0.045 * smooth(0.95, 1, t);
let stemThickness = 1;
// Финальный наклон к зрителю (0…1): только в самом конце роста, чтобы стала видна сердцевина
let endBow = 0;

// Форма стебля на стадии роста g (0…1): длина растёт, а по пути стебель извивается,
// как живой, и к концу роста приходит в итоговую S-образную форму
function shapeStem(g) {
  const grown = smooth(0, 0.85, g);
  const length = lerp(0.45, 1, grown);
  const wiggle = 0.15 * Math.sin(Math.PI * g);
  endBow = smooth(0.05, 1, g);
  const base = STEM_FINAL[0];
  stemCurve.points.forEach((p, i) => {
    const f = STEM_FINAL[i];
    const k = i / (STEM_FINAL.length - 1);
    p.set(
      base.x + (f.x - base.x) * lerp(0.4, 1, grown) + wiggle * k * Math.sin(i * 1.1 + g * 5),
      base.y + (f.y - base.y) * length,
      base.z + (f.z - base.z) + wiggle * 0.7 * k * Math.cos(i * 0.9 + g * 4) + endBow * 0.85 * k * k
    );
  });
  stemCurve.updateArcLengths();
  stemThickness = lerp(0.7, 1, grown);
}

const stemRest = new Float32Array((STEM_SEG + 1) * (STEM_RAD + 1) * 3);
const stemT = [];
const stemIndex = [];
for (let i = 0; i <= STEM_SEG; i++) {
  for (let j = 0; j <= STEM_RAD; j++) stemT.push(i / STEM_SEG);
}
for (let i = 0; i < STEM_SEG; i++) {
  for (let j = 0; j < STEM_RAD; j++) {
    const a = i * (STEM_RAD + 1) + j;
    const b = a + STEM_RAD + 1;
    stemIndex.push(a, b, a + 1, b, b + 1, a + 1);
  }
}
const stemGeo = new THREE.BufferGeometry();
stemGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stemRest.length), 3));
stemGeo.setIndex(stemIndex);

// Координаты на поверхности стебля для рельефа: вдоль × вокруг (вокруг — через cos/sin, чтобы без шва)
const stemSurf = [];
for (let i = 0; i <= STEM_SEG; i++) {
  for (let j = 0; j <= STEM_RAD; j++) {
    const a = (j / STEM_RAD) * Math.PI * 2;
    stemSurf.push((i / STEM_SEG) * 150, Math.cos(a) * 1.5, Math.sin(a) * 1.5);
  }
}
stemGeo.setAttribute('aSurf', new THREE.Float32BufferAttribute(stemSurf, 3));

let stemFrames = null;
const stemP = new THREE.Vector3();
const stemN = new THREE.Vector3();
// Точки оси стебля на каждом сегменте: волоски берут своё место отсюда, а не ищут его на кривой заново
const stemPts = new Float32Array((STEM_SEG + 1) * 3);

// Нормали для света: в каждой вершине — сумма нормалей соседних треугольников, как в computeVertexNormals
// из three.js, но прямо в массивах чисел, без временных векторов — при росте это в разы быстрее
function computeNormals(geo) {
  const pos = geo.attributes.position.array;
  const index = geo.index.array;
  if (!geo.attributes.normal) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  const nor = geo.attributes.normal.array;
  nor.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3;
    const b = index[t + 1] * 3;
    const c = index[t + 2] * 3;
    // (C − B) × (A − B)
    const cbx = pos[c] - pos[b], cby = pos[c + 1] - pos[b + 1], cbz = pos[c + 2] - pos[b + 2];
    const abx = pos[a] - pos[b], aby = pos[a + 1] - pos[b + 1], abz = pos[a + 2] - pos[b + 2];
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    nor[a] += nx; nor[a + 1] += ny; nor[a + 2] += nz;
    nor[b] += nx; nor[b + 1] += ny; nor[b + 2] += nz;
    nor[c] += nx; nor[c + 1] += ny; nor[c + 2] += nz;
  }
  for (let i = 0; i < nor.length; i += 3) {
    const len = Math.sqrt(nor[i] * nor[i] + nor[i + 1] * nor[i + 1] + nor[i + 2] * nor[i + 2]) || 1;
    nor[i] /= len;
    nor[i + 1] /= len;
    nor[i + 2] /= len;
  }
  geo.attributes.normal.needsUpdate = true;
}

// Точки сечения стебля по кругу (cos/sin) — считаем один раз
const STEM_RING_C = new Float64Array(STEM_RAD + 1);
const STEM_RING_S = new Float64Array(STEM_RAD + 1);
for (let j = 0; j <= STEM_RAD; j++) {
  const a = (j / STEM_RAD) * Math.PI * 2;
  STEM_RING_C[j] = Math.cos(a);
  STEM_RING_S[j] = Math.sin(a);
}

// Пересчитывает трубку стебля по текущей кривой (в «покое», без покачивания)
function buildStemMesh() {
  stemFrames = stemCurve.computeFrenetFrames(STEM_SEG, false);
  for (let i = 0; i <= STEM_SEG; i++) {
    const t = i / STEM_SEG;
    stemCurve.getPointAt(t, stemP);
    stemP.toArray(stemPts, i * 3);
    const r = stemRadius(t) * stemThickness;
    const n = stemFrames.normals[i];
    const bn = stemFrames.binormals[i];
    for (let j = 0; j <= STEM_RAD; j++) {
      const c = STEM_RING_C[j];
      const s = STEM_RING_S[j];
      const off = (i * (STEM_RAD + 1) + j) * 3;
      stemRest[off] = stemP.x + (n.x * c + bn.x * s) * r;
      stemRest[off + 1] = stemP.y + (n.y * c + bn.y * s) * r;
      stemRest[off + 2] = stemP.z + (n.z * c + bn.z * s) * r;
    }
  }
  stemGeo.attributes.position.array.set(stemRest);
  computeNormals(stemGeo);
  stemCurve.getPointAt(1, STEM_TOP);
  stemCurve.getTangentAt(1, STEM_TOP_DIR);
}

shapeStem(1);
buildStemMesh();

// Цвет стебля: внизу темнее и зеленее, у розетки светлее
const stemColors = [];
const cStemLow = lab(oklch(0.52, 0.14, 136));
const cStemHigh = lab(oklch(0.66, 0.15, 126));
const stemColorAt = (t) => labToColor(mixLab(cStemLow, cStemHigh, smooth(0.1, 0.95, t)));
for (const t of stemT) {
  const c = stemColorAt(t);
  stemColors.push(c.r, c.g, c.b);
}
stemGeo.setAttribute('color', new THREE.Float32BufferAttribute(stemColors, 3));

// Материал «пушистой мякоти»: обычный PBR + два добавления в шейдер.
// fuzz — светлая кайма там, где поверхность уходит от взгляда (так светится пушок на силуэте),
// glow — слабое собственное свечение цвета, будто свет рассеивается внутри сочного листа.
// bump — процедурная карта нормалей: мелкие бугорки и продольные прожилки. Узор привязан к самой
// поверхности (атрибут aSurf: вдоль × вокруг), поэтому при росте и покачивании он не «плывёт».
const BUMP_GLSL = `
  varying vec3 vSurf;
  uniform float uBump;
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  // Высота рельефа: крупные бугорки + мелкая «кожица» + продольные прожилки
  float bumpHeight(vec3 s) {
    float h = noise3(s) * 0.65 + noise3(s * 2.7) * 0.3 + noise3(s * 7.0) * 0.05;
    h += 0.25 * abs(sin(s.y * 3.0 + noise3(s * 0.8) * 2.0));
    return h;
  }
  // Наклон нормали по производным высоты на экране (как bumpMap в three.js, но без текстуры)
  vec3 bumpNormal(vec3 surfPos, vec3 n, float h) {
    vec3 dpdx = dFdx(surfPos);
    vec3 dpdy = dFdy(surfPos);
    vec3 r1 = cross(dpdy, n);
    vec3 r2 = cross(n, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    return normalize(abs(det) * n - grad);
  }
`;

function fuzzyMaterial(params, fuzz, glow, bump) {
  const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, ...params });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFuzz = { value: fuzz };
    shader.uniforms.uGlow = { value: glow };
    shader.uniforms.uBump = { value: bump };
    shader.vertexShader = 'attribute vec3 aSurf;\nvarying vec3 vSurf;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vSurf = aSurf;`
    );
    shader.fragmentShader = 'uniform float uFuzz;\nuniform float uGlow;\n' + BUMP_GLSL + shader.fragmentShader
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = bumpNormal(-vViewPosition, normal, uBump * bumpHeight(vSurf));`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float facing = abs(dot(normal, normalize(vViewPosition)));
        float fres = pow(1.0 - facing, 2.5);
        totalEmissiveRadiance += uFuzz * fres * mix(vec3(1.0, 0.96, 0.88), diffuseColor.rgb, 0.6);
        totalEmissiveRadiance += uGlow * diffuseColor.rgb;`
      );
  };
  return material;
}

const stem = new THREE.Mesh(
  stemGeo,
  fuzzyMaterial(
    { roughness: 0.6, sheen: 0.5, sheenRoughness: 0.5, sheenColor: oklch(0.9, 0.06, 110) },
    0.3,
    0.05,
    0.004
  )
);
stem.castShadow = true;
stem.receiveShadow = true;
stem.frustumCulled = false;

// Пушок на стебле: место каждого волоска запоминаем (высота, угол), а положение пересчитываем вместе со стеблем
const STEM_HAIRS = 8000;
const stemHairSpots = [];
const stemHairCol = [];
const stemHairT = [];
for (let k = 0; k < STEM_HAIRS; k++) {
  const t = rand();
  stemHairSpots.push({ t, a: rand() * Math.PI * 2, lean: range(0.2, 0.9), jitter: randomUnit(), len: range(0.02, 0.045) });
  stemHairT.push(t, t);
}
const stemHairRest = new Float32Array(STEM_HAIRS * 6);
const stemHairDir = new THREE.Vector3();

// Что у волоска не меняется при росте, считаем один раз: направление вокруг стебля,
// толщину стебля в этом месте и между какими сегментами оси он сидит
for (const h of stemHairSpots) {
  h.ca = Math.cos(h.a);
  h.sa = Math.sin(h.a);
  h.r = stemRadius(h.t) * 0.95;
  h.i = Math.round(h.t * STEM_SEG);
  const fi = h.t * STEM_SEG;
  h.i0 = Math.min(STEM_SEG - 1, Math.floor(fi));
  h.f = fi - h.i0;
}

function buildStemHairs(withColors = false) {
  stemHairSpots.forEach((h, k) => {
    const n = stemFrames.normals[h.i];
    const bn = stemFrames.binormals[h.i];
    const tg = stemFrames.tangents[h.i];
    // Направление от оси наружу
    const nx = n.x * h.ca + bn.x * h.sa;
    const ny = n.y * h.ca + bn.y * h.sa;
    const nz = n.z * h.ca + bn.z * h.sa;
    // Корень: точка оси между двумя соседними сегментами + радиус стебля
    const p0 = h.i0 * 3;
    const r = h.r * stemThickness;
    const px = lerp(stemPts[p0], stemPts[p0 + 3], h.f) + nx * r;
    const py = lerp(stemPts[p0 + 1], stemPts[p0 + 4], h.f) + ny * r;
    const pz = lerp(stemPts[p0 + 2], stemPts[p0 + 5], h.f) + nz * r;
    // Волосок наклонён вдоль стебля и чуть в случайную сторону
    let dx = nx + tg.x * h.lean + h.jitter.x * 0.35;
    let dy = ny + tg.y * h.lean + h.jitter.y * 0.35;
    let dz = nz + tg.z * h.lean + h.jitter.z * 0.35;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const off = k * 6;
    stemHairRest[off] = px;
    stemHairRest[off + 1] = py;
    stemHairRest[off + 2] = pz;
    stemHairRest[off + 3] = px + dx * h.len;
    stemHairRest[off + 4] = py + dy * h.len;
    stemHairRest[off + 5] = pz + dz * h.len;
    if (withColors) {
      stemN.set(nx, ny, nz);
      stemP.set(px, py, pz);
      stemHairDir.set(dx, dy, dz);
      pushHair([], stemHairCol, stemP, stemHairDir, h.len, stemN, stemColorAt(h.t));
    }
  });
}
buildStemHairs(true);

const stemHairGeo = new THREE.BufferGeometry();
stemHairGeo.setAttribute('position', new THREE.BufferAttribute(stemHairRest.slice(), 3));
stemHairGeo.setAttribute('color', new THREE.Float32BufferAttribute(stemHairCol, 3));
const stemHairs = new THREE.LineSegments(stemHairGeo, hairMaterial);
stemHairs.frustumCulled = false;
await pause();

// ---------- Листья ----------

const LEAF_SEG = 30;
const LEAF_RAD = 16;
const LEAF_VERTS = (LEAF_SEG + 1) * (LEAF_RAD + 1);

// Контур листа: широкое основание, самое широкое место на трети длины, острый кончик
function leafWidth(t) {
  if (t < 0.3) return 0.62 + 0.38 * Math.sin((t / 0.3) * Math.PI * 0.5);
  return Math.pow(Math.cos(((t - 0.3) / 0.7) * Math.PI * 0.5), 1.2);
}
const WIDTH_PROFILE = [];
const THICK_PROFILE = [];
for (let i = 0; i <= LEAF_SEG; i++) {
  const t = i / LEAF_SEG;
  WIDTH_PROFILE.push(leafWidth(t));
  THICK_PROFILE.push((1 - 0.7 * t) * Math.sqrt(leafWidth(t)));
}

// Палитра (OKLCH): взрослый лист — в основном глубокий бордовый; зелёный — ближе к кончику,
// а у части листьев и в середине; на самом кончике — капля приглушённого жёлтого
// Палитра хранится в OKLab (см. mixLab)
const PAL = {
  burgundy: lab(oklch(0.29, 0.14, 12)),
  burgundyDeep: lab(oklch(0.19, 0.09, 12)),
  green: lab(oklch(0.54, 0.14, 140)),
  greenInner: lab(oklch(0.62, 0.15, 134)),
  tip: lab(oklch(0.78, 0.12, 100)),
};

// Цвет точки листа (в OKLab): t — от основания к кончику, u/v — положение на сечении (v > 0 — верх)
function leafColor(o, t, u, v) {
  // Откуда начинается зелень: у «зелёных посередине» листьев — раньше
  const from = o.greenMid ? 0.55 : 0.74;
  const top = smooth(-0.6, 0.2, v);
  const greenAmt = smooth(from, from + 0.3, t) * lerp(0.5, 1, top);
  let c = mixLab(PAL.burgundy, PAL.burgundyDeep, (1 - top) * 0.7 + (1 - smooth(0, 0.25, t)) * 0.3);
  c = mixLab(c, mixLab(PAL.green, PAL.greenInner, o.inner), greenAmt);
  // Края листа — бордовые почти до кончика
  c = mixLab(c, PAL.burgundy, Math.pow(Math.abs(u), 10) * 0.7 * (1 - smooth(0.75, 1, t)));
  c = mixLab(c, PAL.tip, smooth(0.85, 0.99, t) * 0.8);
  return c;
}

// Параметры всех листьев. Розетка растёт как в референсе: листья рождаются по одному в центре,
// вырастают и по мере взросления отклоняются наружу. Внешние (f → 1) — самые старые.
const LEAF_COUNT = 64;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const leafList = [];
for (let k = 0; k < LEAF_COUNT; k++) {
  const f = k / (LEAF_COUNT - 1); // 0 — центр розетки, 1 — нижний внешний лист
  const len = (0.5 + 1.3 * Math.pow(f, 0.6)) * range(0.9, 1.08);
  const width = len * lerp(0.13, 0.15, f) * range(0.92, 1.08);
  const azimuth = k * GOLDEN + range(-0.08, 0.08);
  leafList.push({
    f,
    len,
    width,
    thick: width * 0.6,
    cup: 0.4,
    cos: Math.cos(azimuth),
    sin: Math.sin(azimuth),
    r0: 0.03 + 0.15 * f,
    y0: 0.16 * (1 - f) - 0.04,
    red: smooth(0.5, 1, f),
    inner: 1 - smooth(0.15, 0.5, f),
    greenMid: rand() < 0.35,
    shade: range(0.85, 1.05),
    // Взрослый лист: выходит почти горизонтально и загибается вверх, как палец
    openPitch: lerp(1.2, -0.3, Math.pow(f, 0.65)) + range(-0.07, 0.07),
    openBend: lerp(0.2, 1.0, smooth(0.1, 0.7, f)) - 0.2 * smooth(0.9, 1, f) + range(-0.1, 0.1),
    // Момент рождения на шкале роста 0…1: сначала внешние, последними — центральные
    birth: Math.pow(1 - f, 0.6) * 0.8,
    // Текущее состояние (пересчитывается в updateLeaves)
    pitch: 0,
    bend: 0,
    curLen: 0,
    curWidth: 0,
    curThick: 0,
    youth: 1,
  });
}

// Статичные данные: цвета вершин, треугольники, места волосков
const leafPos = new Float32Array(LEAF_COUNT * LEAF_VERTS * 3);
const leafCol = new Float32Array(LEAF_COUNT * LEAF_VERTS * 3);
// Два набора цветов: взрослый лист и молодой (красноватый, как новые листья в центре на референсе)
const leafColAdult = new Float32Array(LEAF_COUNT * LEAF_VERTS * 3);
const leafColYoung = new Float32Array(LEAF_COUNT * LEAF_VERTS * 3);
// Координаты на поверхности листа для рельефа: вдоль реже, поперёк чаще — получаются продольные прожилки
const leafSurf = new Float32Array(LEAF_COUNT * LEAF_VERTS * 3);
// Молодой лист — свежий зелёный с лёгким бордовым у основания; взрослея, он «наливается» бордовым
function youngLeafColor(o, t, u, v) {
  let c = mixLab(PAL.green, PAL.greenInner, 0.4 + 0.6 * o.inner);
  c = mixLab(c, PAL.burgundy, (1 - smooth(0, 0.2, t)) * 0.45 + (1 - smooth(-0.6, 0.2, v)) * 0.2);
  c = mixLab(c, PAL.tip, smooth(0.85, 0.99, t) * 0.8);
  return c;
}
const leafIdx = [];
const leafHairSpots = [];
for (const [n, o] of leafList.entries()) {
  // Листья раскрашиваем порциями по 16 штук
  if (n > 0 && n % 16 === 0) await pause();
  const base = n * LEAF_VERTS;
  for (let i = 0; i <= LEAF_SEG; i++) {
    const t = i / LEAF_SEG;
    for (let j = 0; j <= LEAF_RAD; j++) {
      const a = (j / LEAF_RAD) * Math.PI * 2;
      const u = Math.cos(a);
      const v = Math.sin(a);
      const c = labToLinear(leafColor(o, t, u, v));
      const y = labToLinear(youngLeafColor(o, t, u, v));
      // Затенение у основания: там листья перекрывают друг друга и свет почти не доходит
      const shade = o.shade * lerp(0.3, 1, smooth(0, 0.45, t)) * (v < 0 ? 0.8 : 1);
      const idx = (base + i * (LEAF_RAD + 1) + j) * 3;
      leafColAdult[idx] = c[0] * shade;
      leafColAdult[idx + 1] = c[1] * shade;
      leafColAdult[idx + 2] = c[2] * shade;
      leafColYoung[idx] = y[0] * shade;
      leafColYoung[idx + 1] = y[1] * shade;
      leafColYoung[idx + 2] = y[2] * shade;
      leafSurf[idx] = t * o.len * 10;
      leafSurf[idx + 1] = u * 6;
      leafSurf[idx + 2] = v * 6 + n * 3.7;
    }
  }
  for (let i = 0; i < LEAF_SEG; i++) {
    for (let j = 0; j < LEAF_RAD; j++) {
      const a = base + i * (LEAF_RAD + 1) + j;
      const b = a + LEAF_RAD + 1;
      leafIdx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const hairs = Math.round(260 * o.len);
  for (let k = 0; k < hairs; k++) {
    const i = Math.min(LEAF_SEG - 1, Math.floor(Math.pow(rand(), 0.8) * LEAF_SEG));
    const a = rand() * Math.PI * 2;
    leafHairSpots.push({
      o,
      i,
      u: Math.cos(a),
      v: Math.sin(a),
      len: range(0.012, 0.03),
      jitter: randomUnit(),
      color: labToColor(leafColor(o, i / LEAF_SEG, Math.cos(a), Math.sin(a))),
    });
  }
}
await pause();

const leafHairPos = new Float32Array(leafHairSpots.length * 6);
const leafHairCol = new Float32Array(leafHairSpots.length * 6);

// Средняя линия текущего листа (переиспользуемые массивы, чтобы не создавать мусор каждый кадр)
const spineX = new Float32Array(LEAF_SEG + 1);
const spineY = new Float32Array(LEAF_SEG + 1);
const spineS = new Float32Array(LEAF_SEG + 1);
const spineC = new Float32Array(LEAF_SEG + 1);

function buildSpine(o) {
  let x = 0;
  let y = 0;
  const step = o.curLen / LEAF_SEG;
  for (let i = 0; i <= LEAF_SEG; i++) {
    const th = o.pitch + o.bend * Math.pow(i / LEAF_SEG, 1.6);
    spineX[i] = x;
    spineY[i] = y;
    spineS[i] = Math.sin(th);
    spineC[i] = Math.cos(th);
    x += spineC[i] * step;
    y += spineS[i] * step;
  }
}

// Точка на поверхности листа → out[off..off+2] (в координатах розетки)
function surfInto(o, i, u, v, out, off) {
  const w = o.curWidth * WIDTH_PROFILE[i];
  const thick = o.curThick * THICK_PROFILE[i];
  // Сверху желобок (края приподняты выше середины), снизу выпуклый киль
  const yc = thick * v * (v > 0 ? 0.2 : 1) + o.cup * w * u * u;
  const lx = o.r0 + spineX[i] - spineS[i] * yc;
  const ly = o.y0 + spineY[i] + spineC[i] * yc;
  const lz = w * u;
  out[off] = o.cos * lx + o.sin * lz;
  out[off + 1] = ly;
  out[off + 2] = -o.sin * lx + o.cos * lz;
}

// Точки сечения листа по кругу (cos/sin) — одинаковые для всех листьев, считаем один раз
const RING_U = new Float64Array(LEAF_RAD + 1);
const RING_V = new Float64Array(LEAF_RAD + 1);
for (let j = 0; j <= LEAF_RAD; j++) {
  const a = (j / LEAF_RAD) * Math.PI * 2;
  RING_U[j] = Math.cos(a);
  RING_V[j] = Math.sin(a);
}

const tmp = new Float32Array(9);
const hairN = new THREE.Vector3();
const hairDir = new THREE.Vector3();

// Сколько «времени роста» уходит на то, чтобы лист из зачатка стал взрослым
const LEAF_GROW_TIME = 0.4;

// Пересобирает все листья для стадии роста p (0 — только зачаток, 1 — полная розетка).
// Лист рождается крошечным и торчит вверх в центре; растёт — и по мере взросления
// отклоняется наружу. Молодые листья сильнее загнуты крючком вверх и краснее.
function updateLeaves(p, withHairColors = false) {
  for (const o of leafList) {
    const age = Math.min(1, Math.max(0, (p - o.birth) / LEAF_GROW_TIME));
    const size = age > 0 ? lerp(0.08, 1, smooth(0, 1, age)) : 0.001;
    const spread = smooth(0, 0.4, age);
    o.curLen = o.len * size;
    o.curWidth = o.width * lerp(1.3, 1, size) * size;
    o.curThick = o.thick * lerp(0.8, 1, size) * size;
    o.pitch = lerp(1.35, o.openPitch, spread);
    o.bend = o.openBend + 1.1 * (1 - smooth(0.3, 1, age));
    // В начале роста листья зелёные; к середине роста подросшие листья «наливаются» бордовым,
    // самые молодые в центре дольше остаются зелёными
    // В финале дозаливаем бордовым почти всю розетку, включая молодые листья в центре
    o.youth = 1 - Math.max(smooth(0.15, 0.75, p) * smooth(0.1, 0.8, age), 0.9 * smooth(0.75, 1, p));
  }

  leafList.forEach((o, n) => {
    buildSpine(o);
    const base = n * LEAF_VERTS;
    // Бордовый не смешивается с зелёным (иначе выходит бурый), а «растекается» по листу
    // от основания к кончику: граница front движется по мере взросления листа
    const front = (1 - o.youth) * 1.5 - 0.2;
    for (let i = 0; i <= LEAF_SEG; i++) {
      const w = 1 - smooth(front - 0.25, front + 0.25, i / LEAF_SEG);
      for (let j = 0; j <= LEAF_RAD; j++) {
        const idx = (base + i * (LEAF_RAD + 1) + j) * 3;
        surfInto(o, i, RING_U[j], RING_V[j], leafPos, idx);
        leafCol[idx] = leafColYoung[idx] + (leafColAdult[idx] - leafColYoung[idx]) * w;
        leafCol[idx + 1] = leafColYoung[idx + 1] + (leafColAdult[idx + 1] - leafColYoung[idx + 1]) * w;
        leafCol[idx + 2] = leafColYoung[idx + 2] + (leafColAdult[idx + 2] - leafColYoung[idx + 2]) * w;
      }
    }
  });

  // Волоски: торчат из поверхности и слегка наклонены к кончику
  let current = null;
  leafHairSpots.forEach((h, k) => {
    if (h.o !== current) {
      current = h.o;
      buildSpine(current);
    }
    surfInto(h.o, h.i, h.u, h.v, tmp, 0);
    surfInto(h.o, h.i, 0, 0, tmp, 3);
    surfInto(h.o, h.i + 1, h.u, h.v, tmp, 6);
    hairN.set(tmp[0] - tmp[3], tmp[1] - tmp[4], tmp[2] - tmp[5]).normalize();
    hairDir.set(tmp[6] - tmp[0], tmp[7] - tmp[1], tmp[8] - tmp[2]).normalize()
      .multiplyScalar(0.9).add(hairN).addScaledVector(h.jitter, 0.3).normalize();
    const off = k * 6;
    leafHairPos[off] = tmp[0];
    leafHairPos[off + 1] = tmp[1];
    leafHairPos[off + 2] = tmp[2];
    leafHairPos[off + 3] = tmp[0] + hairDir.x * h.len;
    leafHairPos[off + 4] = tmp[1] + hairDir.y * h.len;
    leafHairPos[off + 5] = tmp[2] + hairDir.z * h.len;
    if (withHairColors) {
      const pos = [];
      const col = [];
      pushHair(pos, col, new THREE.Vector3(), hairDir, h.len, hairN, h.color);
      leafHairCol.set(col, off);
    }
  });
}

const leafGeo = new THREE.BufferGeometry();
leafGeo.setAttribute('position', new THREE.BufferAttribute(leafPos, 3));
leafGeo.setAttribute('color', new THREE.BufferAttribute(leafCol, 3));
leafGeo.setAttribute('aSurf', new THREE.BufferAttribute(leafSurf, 3));
leafGeo.setIndex(leafIdx);

const leafHairGeo = new THREE.BufferGeometry();
leafHairGeo.setAttribute('position', new THREE.BufferAttribute(leafHairPos, 3));
leafHairGeo.setAttribute('color', new THREE.BufferAttribute(leafHairCol, 3));

// Цвет волосков считаем один раз — на полной розетке, где свет падает как на референсе
updateLeaves(1, true);
await pause();

function applyGrowth(p) {
  shapeStem(p);
  buildStemMesh();
  buildStemHairs();
  updateLeaves(p);
  leafGeo.attributes.position.needsUpdate = true;
  leafGeo.attributes.color.needsUpdate = true;
  computeNormals(leafGeo);
  leafHairGeo.attributes.position.needsUpdate = true;
}

const leaves = new THREE.Mesh(
  leafGeo,
  fuzzyMaterial(
    { roughness: 0.7, specularIntensity: 0.35, sheen: 0.15, sheenRoughness: 0.5, sheenColor: oklch(0.6, 0.12, 12) },
    0.18,
    0.1,
    0.003
  )
);
leaves.castShadow = true;
leaves.receiveShadow = true;
leaves.frustumCulled = false;

const leafHairs = new THREE.LineSegments(leafHairGeo, hairMaterial);
leafHairs.frustumCulled = false;

const rosette = new THREE.Group();
const rosetteInner = new THREE.Group();
rosetteInner.add(leaves, leafHairs);
rosette.add(rosetteInner);
rosette.position.copy(STEM_TOP);

// ---------- Рост по скроллу ----------

// Прокрутка вниз — розетка растёт, вверх — «откатывается» назад. Значение плавно догоняет цель.
// Стартовую стадию можно задать в адресе страницы: index.html?grow=1
const growParam = parseFloat(new URLSearchParams(location.search).get('grow'));
let growTarget = Math.min(1, Math.max(0, Number.isNaN(growParam) ? 0.18 : growParam));
let growValue = -1;
window.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // Некоторые мыши присылают прокрутку «строками», а не пикселями — приводим к пикселям
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    growTarget = Math.min(1, Math.max(0, growTarget + delta * 0.0005));
  },
  { passive: false }
);

// Телефон: ведёшь пальцем вверх — цветок растёт, вниз — «откатывается», как при прокрутке страницы.
// Полный рост — примерно полторы высоты экрана пальцем.
let touchY = null;
window.addEventListener('touchstart', (event) => {
  touchY = event.touches[0].clientY;
}, { passive: true });
window.addEventListener(
  'touchmove',
  (event) => {
    if (touchY === null) return;
    event.preventDefault();
    const y = event.touches[0].clientY;
    growTarget = Math.min(1, Math.max(0, growTarget + (touchY - y) / (1.5 * window.innerHeight)));
    touchY = y;
  },
  { passive: false }
);
window.addEventListener('touchend', () => {
  touchY = null;
});

// Плавный скролл: текущая стадия мягко «доезжает» до цели (чем меньше GROW_EASE, тем плавнее и дольше)
const GROW_EASE = 2.2;
function updateGrowth(dt) {
  const next = growValue < 0 ? growTarget : growValue + (growTarget - growValue) * (1 - Math.exp(-dt * GROW_EASE));
  if (Math.abs(next - growValue) > 0.0005) {
    growValue = next;
    applyGrowth(growValue);
  }
}

// ---------- Покачивание ----------

const stemPosAttr = stemGeo.attributes.position;
const stemHairAttr = stemHairGeo.attributes.position;
const UP = new THREE.Vector3(0, 1, 0);
const NO_TURN = new THREE.Quaternion();
const alignQuat = new THREE.Quaternion();
const swayQuat = new THREE.Quaternion();
const swayEuler = new THREE.Euler();

// ---------- Наведение мыши: два слоя ----------
// Слой 1 — цветок: по горизонтали мыши растение поворачивается вокруг своей вертикальной оси в 3D
// (стебель, розетка и тень на стене). Слой 2 — весь плакат с текстами наклоняется как CSS-карточка:
// край под курсором уходит вглубь. Оба слоя плавно «доплывают» до цели.
const FLOWER_TURN = 0.45; // наибольший поворот цветка, радианы (~25°)
// Цветок «тяжёлый»: поворот — пружина с трением. Мягкая пружина = большая масса (медленно разгоняется),
// трение чуть меньше критического — плавно, с лёгким перелётом, без раскачки.
const FLOWER_STIFFNESS = 1.4;
const FLOWER_DAMPING = 2.0;
let flowerSpeed = 0;
const TILT_MAX_DEG = 8; // наибольший наклон плаката по каждой оси, градусы
const TILT_EASE = 2.5;

const plant = new THREE.Group();
plant.add(stem, stemHairs, rosette);
scene.add(plant);

const poster = document.querySelector('.poster');
const hover = { x: 0, y: 0 }; // положение мыши: -1…1 по каждой оси
const tilt = { x: 0, y: 0 };
window.addEventListener('pointermove', (event) => {
  // Палец растит цветок, а поворот и наклон — только от мыши
  if (event.pointerType === 'touch') return;
  hover.x = (event.clientX / window.innerWidth) * 2 - 1;
  hover.y = (event.clientY / window.innerHeight) * 2 - 1;
});
document.addEventListener('pointerleave', () => {
  hover.x = 0;
  hover.y = 0;
});

function stepHover(dt) {
  flowerSpeed += (FLOWER_STIFFNESS * (hover.x * FLOWER_TURN - plant.rotation.y) - FLOWER_DAMPING * flowerSpeed) * dt;
  plant.rotation.y += flowerSpeed * dt;
  const k = 1 - Math.exp(-dt * TILT_EASE);
  tilt.x += (-hover.y * TILT_MAX_DEG - tilt.x) * k;
  tilt.y += (hover.x * TILT_MAX_DEG - tilt.y) * k;
  poster.style.transform = `rotateX(${tilt.x.toFixed(3)}deg) rotateY(${tilt.y.toFixed(3)}deg)`;
}

function sway(time) {
  // Очень медленное покачивание — цветок будто парит в невесомости
  const sx = 0.1 * Math.sin(time * 0.22) + 0.03 * Math.sin(time * 0.53 + 0.7);
  const sz = 0.07 * Math.sin(time * 0.17 + 1.9) + 0.02 * Math.sin(time * 0.61);

  // Стебель гнётся сильнее к верху: смещение растёт как квадрат высоты
  for (let i = 0; i < stemT.length; i++) {
    const k = stemT[i] * stemT[i];
    stemPosAttr.array[i * 3] = stemRest[i * 3] + sx * k;
    stemPosAttr.array[i * 3 + 1] = stemRest[i * 3 + 1];
    stemPosAttr.array[i * 3 + 2] = stemRest[i * 3 + 2] + sz * k;
  }
  stemPosAttr.needsUpdate = true;

  for (let i = 0; i < stemHairT.length; i++) {
    const k = stemHairT[i] * stemHairT[i];
    stemHairAttr.array[i * 3] = stemHairRest[i * 3] + sx * k;
    stemHairAttr.array[i * 3 + 1] = stemHairRest[i * 3 + 1];
    stemHairAttr.array[i * 3 + 2] = stemHairRest[i * 3 + 2] + sz * k;
  }
  stemHairAttr.needsUpdate = true;

  // Розетка сидит на верхушке и наклоняется вслед за кончиком стебля (вполовину — чтобы не заваливалась)
  const stemLen = stemCurve.getLength();
  rosette.position.set(STEM_TOP.x + sx, STEM_TOP.y, STEM_TOP.z + sz);
  alignQuat.setFromUnitVectors(UP, STEM_TOP_DIR).slerp(NO_TURN, 0.5);
  swayQuat.setFromEuler(swayEuler.set((2 * sz) / stemLen + endBow * 0.27, 0.06 * Math.sin(time * 0.12), (-2 * sx) / stemLen));
  rosette.quaternion.multiplyQuaternions(alignQuat, swayQuat);
}

// ---------- Камера ----------
// Камера неподвижна: цветок нельзя вращать, зритель управляет только ростом (колесо мыши).

// ---------- Обработка кадра ----------

// Кадр рисуется в буфер со сглаживанием (samples), иначе тонкие волоски рябят
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: LITE ? 2 : 4 })
);
composer.addPass(new RenderPass(scene, camera));

// Лёгкое свечение светлых мест: кайма пушка и кончики листьев слегка «горят»
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.55, 0.75);
// На телефоне свечение считаем в половинном разрешении: оно мягкое, разницы не видно
if (LITE) {
  const setBloomSize = bloomPass.setSize.bind(bloomPass);
  bloomPass.setSize = (w, h) => setBloomSize(Math.round(w / 2), Math.round(h / 2));
}
composer.addPass(bloomPass);

composer.addPass(new OutputPass());

// Затемнение по углам — уже после тонемаппинга, чтобы цвета не уходили в минус
const vignette = new ShaderPass(VignetteShader);
vignette.uniforms.offset.value = 0.9;
vignette.uniforms.darkness.value = 1.1;
composer.addPass(vignette);
// Зерно — после тонемаппинга, чтобы было равномерным, как на фото
composer.addPass(new FilmPass(0.1, false));

function resize() {
  // Холст — внутри плаката с фиксированными пропорциями, берём его реальный размер
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Камера близко: в кадр по высоте помещается VIEW_H единиц сцены — розетка заполняет ширину плаката.
// По мере роста камера плавно следует за верхушкой стебля, чтобы цветок всегда был в кадре.
const VIEW_H = 5.94;
const CAMERA_DIR = new THREE.Vector3(0.05, 0.08, 1).normalize();
const ROSETTE_IN_FRAME = 0.35; // насколько ниже верхушки стебля смотрит камера (розетка — чуть выше центра)
const cameraLook = CAMERA_TARGET.clone();
let cameraDist = 1;

function frameCamera() {
  const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  cameraDist = VIEW_H / 2 / tan;
  placeCamera();
}

function placeCamera() {
  camera.position.copy(cameraLook).addScaledVector(CAMERA_DIR, cameraDist);
  camera.lookAt(cameraLook);
}

let cameraPlaced = false;
function followFlower(dt) {
  // Не опускаемся так низко, чтобы стало видно начало стебля — он всегда уходит за нижний край
  const minY = STEM_FINAL[0].y + VIEW_H / 2 + 0.6;
  const targetY = Math.max(minY, STEM_TOP.y - ROSETTE_IN_FRAME);
  // В первом кадре сразу ставим камеру на место, дальше — плавно догоняем рост
  cameraLook.y = cameraPlaced ? cameraLook.y + (targetY - cameraLook.y) * (1 - Math.exp(-dt * 3)) : targetY;
  cameraPlaced = true;
  placeCamera();
}

resize();
cameraLook.y = STEM_TOP.y - ROSETTE_IN_FRAME;
frameCamera();
window.addEventListener('resize', () => {
  resize();
  frameCamera();
});

// Шейдеры собираются заранее и, где браузер умеет, параллельно — первый кадр не подвешивает страницу
try {
  await renderer.compileAsync(scene, camera);
} catch {
  // Не получилось — шейдеры соберутся при первой отрисовке, как обычно
}

const clock = new THREE.Clock();
let lastTime = 0;
let shown = false;
renderer.setAnimationLoop(() => {
  const time = clock.getElapsedTime();
  // Шаг не больше 1/30 с: если вкладка «проснулась» после паузы, пружина не улетит
  const dt = Math.min(time - lastTime, 1 / 30);
  lastTime = time;
  updateGrowth(dt);
  followFlower(dt);
  stepHover(dt);
  sway(time);
  composer.render();
  if (!shown) {
    shown = true;
    canvas.classList.add('is-ready');
  }
});
