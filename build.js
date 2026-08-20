// Build the single-file distributable: dist/bopball-fc.html
// Flattens sim.js + ai.js + client.js into one inline <script type="module">
// (each file wrapped in its own scope; only Three.js comes from CDN).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8');

const M3D_EXPORTS = ['Vector3', 'Euler', 'Color', 'DoubleSide', 'Object3D', 'Group', 'Scene', 'Fog',
  'PerspectiveCamera', 'HemisphereLight', 'DirectionalLight', 'MeshLambertMaterial', 'MeshBasicMaterial',
  'PointsMaterial', 'CanvasTexture', 'BufferAttribute', 'BufferGeometry', 'SphereGeometry', 'PlaneGeometry',
  'CircleGeometry', 'BoxGeometry', 'CylinderGeometry', 'ConeGeometry', 'CapsuleGeometry', 'TorusGeometry',
  'Mesh', 'InstancedMesh', 'Points', 'WebGLRenderer'];
const SIM_EXPORTS = ['DT', 'TICK_RATE', 'TUNE', 'ARCHETYPES', 'TRAIT_POINTS', 'STAT_KEYS',
  'rnd', 'gauss', 'NEUTRAL_INPUT', 'statsFrom', 'maxSpeed', 'makeMatch', 'step', 'snapshot', 'matchHash',
  'livePassThreat'];
const AI_EXPORTS = ['DIFFICULTY', 'TIER_ORDER', 'effectiveProfile', 'makeBrain', 'aiInputs'];

function stripModule(src) {
  return src
    .split('\n')
    .filter(l => !l.trim().startsWith('import '))
    .join('\n')
    .replace(/^export\s+/gm, '');
}

const m3dBody = stripModule(read('mini3d.js'));
const simBody = stripModule(read('sim.js'));
const aiBody = stripModule(read('ai.js'));
const clientBody = stripModule(read('client.js'));

const combined = `
const __M3D = (() => {
${m3dBody}
return { ${M3D_EXPORTS.join(', ')} };
})();
const __SIM = (() => {
${simBody}
return { ${SIM_EXPORTS.join(', ')} };
})();
const __AI = (() => {
const { TUNE, TICK_RATE, rnd, gauss, maxSpeed } = __SIM;
${aiBody}
return { ${AI_EXPORTS.join(', ')} };
})();
(() => {
const THREE = __M3D;
const { ${SIM_EXPORTS.join(', ')} } = __SIM;
const { ${AI_EXPORTS.join(', ')} } = __AI;
${clientBody}
})();
`;

let html = read('index.html');
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, '');
html = html.replace('<script type="module" src="./client.js"></script>',
  `<script type="module">\n${combined}\n</script>`);
html = html.replace('<title>BOPBALL FC</title>',
  '<title>BOPBALL FC</title>\n<!-- Single-file build. Fully self-contained — double-click to play, no internet needed. For online multiplayer run: node server.js -->');

fs.mkdirSync(path.join(DIR, 'dist'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'dist', 'bopball-fc.html'), html);
console.log('built dist/bopball-fc.html', (html.length / 1024).toFixed(0) + 'KB');
