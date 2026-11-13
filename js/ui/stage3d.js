// The 3D preview: the fixed Essential backer plus the generated face bodies, in the design frame (z out of
// the face). Click a body to select its element. Rendering only runs while the 3D stage is showing.

import * as THREE from 'three';
import { OrbitControls } from '../../vendor/three/addons/controls/OrbitControls.js';
import { state, on, currentSize, getBuild, colorHex, select } from '../state.js';
import { loadBacker } from '../geometry/backer.js';
import { extrudeMultiPolygon } from '../geometry/extrude.js';
import { faceTriangles } from '../geometry/face.js';
import { safeRect } from './stage2d.js';
import { BACKER_THICKNESS } from '../data/sizes.js';

let host, renderer, scene, camera, controls, grid = null, group = null, active = false, builtVersion = -1, builtSize = '', backerGeo = null, backerFor = '';
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
let fitPending = true;

function cssVar(name, fallback) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }

function draw() { if (renderer && active) renderer.render(scene, camera); }

/**
 * Centre the view on the part of the stage the panels leave clear (the planner's framing rule), by shifting the
 * projection rather than the camera, so orbiting still turns about the plate. Returns the host and clear rects.
 */
function frameOffset() {
  const hr = host.getBoundingClientRect();
  if (!hr.width || !hr.height) return null;
  const s = safeRect(hr);
  const cx = s.left + s.width / 2 - hr.left, cy = s.top + s.height / 2 - hr.top;
  camera.setViewOffset(hr.width, hr.height, hr.width / 2 - cx, hr.height / 2 - cy, hr.width, hr.height);
  return { hr, s };
}

function fitCamera() {
  const size = currentSize();
  const d = Math.hypot(size.w, size.h);
  const dir = new THREE.Vector3(-0.25, -0.9, 0.8).normalize();
  controls.target.set(0, 0, 2);
  let dist = d * 1.23;
  const f = frameOffset();
  if (f) {
    // move in or out until the plate's corners fill the clear area, with a margin
    const pts = [];
    for (const x of [-size.w / 2, size.w / 2]) for (const y of [-size.h / 2, size.h / 2]) for (const z of [-4.2, 8]) pts.push(new THREE.Vector3(x, y, z));
    const sx = f.s.left - f.hr.left, sy = f.s.top - f.hr.top, cx = sx + f.s.width / 2, cy = sy + f.s.height / 2;
    for (let k = 0; k < 3; k++) {
      camera.position.copy(dir).multiplyScalar(dist).add(controls.target);
      camera.lookAt(controls.target); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      let need = 0;
      for (const p of pts) {
        const v = p.clone().project(camera);
        const px = (v.x + 1) / 2 * f.hr.width, py = (1 - v.y) / 2 * f.hr.height;
        need = Math.max(need, Math.abs(px - cx) / (f.s.width / 2 * 0.92), Math.abs(py - cy) / (f.s.height / 2 * 0.92));
      }
      if (!Number.isFinite(need) || need <= 0) break;
      dist *= need;
    }
  }
  camera.position.copy(dir).multiplyScalar(dist).add(controls.target);
  controls.update();
  fitPending = false;
}

async function rebuild() {
  if (!active) return;
  const size = currentSize();
  const b = getBuild(size.id);
  if (b.version === builtVersion && size.id === builtSize && group) { updateSelection(); draw(); return; }
  builtVersion = b.version; builtSize = size.id;
  if (group) { scene.remove(group); group.traverse(o => { if (o.geometry && o !== backerGeo) o.geometry.dispose?.(); if (o.material) o.material.dispose?.(); }); }
  group = new THREE.Group();
  scene.add(group);
  // face bodies
  for (const body of faceTriangles(b.built, extrudeMultiPolygon)) {
    if (!body.tris.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(body.tris instanceof Float32Array ? body.tris : new Float32Array(body.tris), 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colorHex(body.color), roughness: 0.6, metalness: 0.05 }));
    m.userData = { elementId: body.elementId, kind: body.kind };
    group.add(m);
  }
  // backer (async load, cached per size)
  if (backerFor !== size.id) {
    try {
      const bk = await loadBacker(size.id);
      if (size.id !== currentSize().id) return;
      backerGeo?.dispose();
      backerGeo = new THREE.BufferGeometry();
      backerGeo.setAttribute('position', new THREE.Float32BufferAttribute(bk.positions, 3));
      backerGeo.setIndex(new THREE.BufferAttribute(bk.indices, 1));
      backerGeo.computeVertexNormals();
      backerFor = size.id;
    } catch (e) { console.warn(e); }
  }
  if (backerGeo && group) {
    const m = new THREE.Mesh(backerGeo, new THREE.MeshStandardMaterial({ color: colorHex('backer'), roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide }));
    m.userData = { backer: true };
    group.add(m);
  }
  if (fitPending) fitCamera();
  updateSelection();
  draw();
}

function updateSelection() {
  if (!group) return;
  group.traverse(o => {
    if (!o.isMesh || o.userData.backer) return;
    const sel = o.userData.elementId && o.userData.elementId === state.selectedId;
    o.material.emissive = new THREE.Color(sel ? cssVar('--sel', '#0E6A86') : '#000000');
    o.material.emissiveIntensity = sel ? 0.35 : 0;
  });
}

function resize() {
  if (!host || !renderer) return;
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  frameOffset();
  camera.updateProjectionMatrix();
  draw();
}

/** The stage is transparent so the page's --sky shows through (the planner's Day/Night stage); the floor grid takes --grid. */
function applyTheme() {
  if (!grid) return;
  const m = cssVar('--grid', 'rgba(92,72,196,.2)').match(/rgba?\(([^)]+)\)/);
  const [r, g, b, a = 1] = m ? m[1].split(',').map(Number) : [92, 72, 196, 0.2];
  grid.material.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  grid.material.opacity = Math.min(1, a * 1.6);
  draw();
}

export function setActive3d(on) {
  active = on;
  if (on) { applyTheme(); resize(); rebuild(); }
}

export function initStage3d(el) {
  host = el;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  host.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.addEventListener('change', draw);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-120, -200, 260); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(200, 100, 120); scene.add(fill);
  grid = new THREE.GridHelper(600, 60, 0xffffff, 0xffffff);
  grid.rotation.x = Math.PI / 2; grid.position.z = -BACKER_THICKNESS - 0.2; grid.material.transparent = true; grid.material.depthWrite = false;
  scene.add(grid);

  renderer.domElement.addEventListener('pointerdown', ev => { ev.target.__down = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener('pointerup', ev => {
    const d = ev.target.__down; if (!d || Math.hypot(ev.clientX - d[0], ev.clientY - d[1]) > 4 || !group) return;
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(group.children, false)[0];
    select(hit?.object.userData.elementId || null);
  });
  new ResizeObserver(resize).observe(host);
  on('design', () => rebuild());
  on('select', () => { updateSelection(); draw(); });
  on('size', () => { fitPending = true; rebuild(); });
  on('theme', () => applyTheme());
}

export function fit3d() { fitCamera(); draw(); }
