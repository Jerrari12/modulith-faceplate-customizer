// The face builder: turns a design plus a plate size into printable bodies.
//
// A design is a stack of elements applied in order to a face slab that sits on the fixed Essential backer.
// Everything is 2.5D "layers" (a polygon between two z levels, in one colour) except grips, meshes and solid
// blocks ("solids"), which are triangle bodies because they can have undercuts, slopes and stacking. Later elements
// win: a raise carves whatever it overlaps in its z range before being added; a cut carves from (face top - depth)
// upwards. Nothing ever goes below z = 0 - that is the backer, where the clips and compliant mechanisms live.
//
// The face slab can be switched off (design.face.enabled === false): then the bare backer is the clean slate, its
// front plane is z = 0, everything stands on it, and nothing can be cut. Symmetry (design.symmetry === 'x') gives
// every placed element a mirror twin about the plate's centre line.
//
// Frame: plate centre at the origin, x right, y up, z out of the face (toward the viewer). Units: mm.

import * as P from './polys.js';
import { generatePattern, patternDefaults, PATTERNS } from './patterns.js';
import { transformTriangles } from './extrude.js';
import { unpackMesh, flatten } from './meshio.js';
import { rasterizeTriangles, traceMask } from '../checks/trace.js';
import { SOLID_SHAPES, SOLID_EDGES, solidBody, placeSolid, mirrorSolid } from './solids.js';
import { FONTS, TEXT_LIMITS, textOutline } from './text.js';
import { imageTones, IMAGE_LIMITS } from './image.js';
import { FILL_OPTIONS, applyFill } from './fill.js';
import { HEIGHT_MAPS, SEEDED_MAPS, textureDefaults, cleanTextureParams } from './heightmaps.js';
import { textureBodies, SURFACE_GRIDS } from './surface.js';
import { b64ToBytes } from './image.js';
import { tidyEdges, EDGE_MODES } from './edges.js';
import { gripShape, GRIP_ENDS, HOOD_STYLES } from './grips.js';
import { CORNER_HOOD } from './cornerhood.js';
import { PATH_FORMS, PATH_LIMITS, pathOutline, pathTaper, pathEdge, taperBody } from './path.js';
import { clipSolidToPlate, clampTrisToPlate } from './clip.js';
import { offsetPoly } from './offset.js';

export { SOLID_SHAPES };

export const FACE_LIMITS = { minThickness: 0.4, maxThickness: 4, maxRaise: 30, maxCut: 4 };

export const ANCHORS = [
  ['c', 'Centre'], ['t', 'Top edge'], ['b', 'Bottom edge'], ['l', 'Left edge'], ['r', 'Right edge'],
  ['tl', 'Top-left'], ['tr', 'Top-right'], ['bl', 'Bottom-left'], ['br', 'Bottom-right'],
];

export function anchorPoint(anchor, W, H) {
  const x = anchor?.includes('l') ? -W / 2 : anchor?.includes('r') ? W / 2 : 0;
  const y = anchor?.includes('t') ? H / 2 : anchor?.includes('b') ? -H / 2 : 0;
  return [x, y];
}

// raise stands on the face, cut goes into it, inlay sets it into the face flush in its own colour (a multicolour
// print that works face down or face up)
const opParam = { key: 'op', label: 'Operation', type: 'select', options: [['raise', 'Raise'], ['cut', 'Cut'], ['inlay', 'Inlay']], default: 'raise', help: 'Inlay sets it into the face, flush, in its own colour: a multicolour print that works face down or face up.' };
const heightParam = { key: 'height', label: 'Stands out', type: 'number', min: 0.2, max: FACE_LIMITS.maxRaise, step: 0.1, unit: 'mm', default: 1, showIf: { op: 'raise' }, help: 'How far it rises from the face.' };
const depthParam = { key: 'depth', label: 'Depth', type: 'number', min: 0.2, max: FACE_LIMITS.maxCut, step: 0.1, unit: 'mm', default: 0.6, showIf: { op: ['cut', 'inlay'] }, help: 'How far into the face it goes: the depth of a cut, or the thickness of an inlay. Never into the backer.' };
const colorParam = { key: 'color', label: 'Colour', type: 'color', default: 'c2', showIf: { op: ['raise', 'inlay'] } };
const placeParams = [
  { key: 'anchor', label: 'Anchor', type: 'select', options: ANCHORS, default: 'c' },
  { key: 'x', label: 'Offset X', type: 'number', min: -400, max: 400, step: 0.25, unit: 'mm', default: 0 },
  { key: 'y', label: 'Offset Y', type: 'number', min: -200, max: 200, step: 0.25, unit: 'mm', default: 0 },
  { key: 'rotation', label: 'Rotation', type: 'number', min: -180, max: 180, step: 1, unit: 'deg', default: 0 },
];

// a grip, block or shape can sit flush with the top or bottom edge on every size: its outer side in line with the
// plate's, Offset X sliding it along; the anchor, Offset Y (and a grip's rotation) then stop applying
const FLUSH_EDGES = [['', 'No edge'], ['t', 'The top edge'], ['b', 'The bottom edge']];
const flushParam = { key: 'flush', label: 'Flush with', type: 'select', options: FLUSH_EDGES, default: '', help: 'Sits it right on that edge of the plate on every size, its outer side in line with the plate\'s. Offset X slides it along the edge.' };
const notFlush = p => ({ ...p, showIf: { ...(p.showIf || {}), flush: '' } });
const flushPlaceParams = turns => [flushParam, ...placeParams.map(p => (p.key === 'anchor' || p.key === 'y' || (p.key === 'rotation' && !turns) ? notFlush(p) : p))];
const FLUSHABLE = new Set(['grip', 'solid', 'shape']);

const textOpParam = { ...opParam, default: 'inlay' };

// a flat element's fill: solid, its outline alone, or a texture inside a solid border
const fillParams = [
  { key: 'fill', label: 'Fill', type: 'select', options: FILL_OPTIONS, default: 'solid' },
  { key: 'border', label: 'Border', type: 'number', min: 0, max: 20, step: 0.1, unit: 'mm', default: 0.8, showIf: { fill: FILL_OPTIONS.map(([k]) => k).filter(k => k !== 'solid') }, help: 'A solid rim of the outline round the texture, so the shape still reads. An outline is this rim alone.' },
];

/** The operation a new flat element starts with: inlay on a face-down design with its face on (a raise would leave
 *  the face hanging off the bed), raise otherwise. */
export const flushOp = design => (design.mode !== 'up' && design.face?.enabled !== false ? 'inlay' : 'raise');
/** A new pattern's operation: cut on a face-down design with its face on (grooves like the Essential and Chevron
 *  plates, in one filament; a raise would fail at once), raise otherwise. */
export const patternOp = design => (flushOp(design) === 'inlay' ? 'cut' : 'raise');

export const SHAPES = [['rect', 'Rectangle'], ['roundrect', 'Rounded rectangle'], ['circle', 'Circle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['hexagon', 'Hexagon'], ['star', 'Star']];
export const GRIP_STYLES = [['bar', 'Bar (flat pull)'], ['wedge', 'Wedge (45° undercut both sides)'], ['ledge', 'Ledge (45° undercut one side)'], ['dome', 'Dome (half round)'], ['lip', 'Lip pull (angled ends)'], ['arch', 'Arch pull (bridge on two legs, no supports)'], ['classicpro', 'Classic Pro (the series\' grip)'], ['classic', 'Classic (the series\' grip)'], ['edgelabel', 'EdgeLabel (the series\' corner grip)']];
const NOT_CORNER = ['bar', 'wedge', 'ledge', 'dome', 'lip', 'arch', 'classicpro', 'classic'];   // styles placed by the usual controls
const SHAPED = ['bar', 'wedge', 'ledge', 'dome', 'lip', 'arch'];   // styles whose sizes are set here (the series' are fixed)
const NOT_ARCH = ['bar', 'wedge', 'ledge', 'dome', 'lip'];

// what a drawing, a combine or an outline is built as: raised, cut or inlaid, and raised it can lean in (a taper) and
// have a chamfered or rounded top edge (path.js sideProfile)
const shapedParams = [
  opParam, heightParam,
  { key: 'taper', label: 'Taper angle', type: 'number', min: 0, max: PATH_LIMITS.maxTaper, step: 0.5, unit: 'deg', default: 0, showIf: { op: 'raise' }, help: 'Leans every side in as it rises, like a tapered extrude in Fusion. 0 keeps the sides straight up. Where the sides meet before the full height they meet in a ridge. It prints face up.' },
  { key: 'edge', label: 'Top edges', type: 'select', options: SOLID_EDGES, default: 'square', showIf: { op: 'raise' }, help: 'A 45° chamfer or a rounded top edge, as a block has, on a straight or a tapered side. It prints face up.' },
  { key: 'edgeSize', label: 'Edge size', type: 'number', min: 0.2, max: 20, step: 0.1, unit: 'mm', default: 1, showIf: { op: 'raise', edge: ['chamfer', 'round'] }, help: 'How far down the side the chamfer or the round reaches (for a round, its radius). It is kept under the height.' },
  depthParam, colorParam,
];
export const COMBINE_OPS = [['join', 'Join'], ['cut', 'Cut away'], ['common', 'Overlap']];
export const OFFSET_BANDS = [['ring', 'A band round it'], ['shape', 'The grown shape']];

export const ELEMENT_DEFS = {
  pattern: {
    label: 'Pattern', icon: 'pattern',
    params: [
      { key: 'pattern', label: 'Pattern', type: 'select', options: Object.entries(PATTERNS).map(([k, v]) => [k, v.label]), default: 'stripes' },
      { key: 'invert', adv: true, label: 'Invert (use the gaps)', type: 'bool', default: false },
      { key: 'edges', adv: true, label: 'Thin bits at the edges', type: 'select', options: EDGE_MODES, default: 'tidy', help: 'Where the pattern meets the plate edge or a screw hole, it can be cut down to slivers too thin to print. Tidy takes them away, Thicken widens them to 0.8 mm, Keep leaves the pattern exactly as drawn.' },
      opParam, heightParam, depthParam, colorParam,
    ],
    patternParams: true,
  },
  shape: {
    label: 'Shape', icon: 'shape',
    params: [
      { key: 'shape', label: 'Shape', type: 'select', options: SHAPES, default: 'rect' },
      { key: 'w', label: 'Width', type: 'number', min: 0.5, max: 400, step: 0.25, unit: 'mm', default: 30 },
      { key: 'h', label: 'Height', type: 'number', min: 0.5, max: 200, step: 0.25, unit: 'mm', default: 20 },
      { key: 'r', label: 'Corner radius', type: 'number', min: 0, max: 100, step: 0.25, unit: 'mm', default: 3, showIf: { shape: 'roundrect' } },
      { key: 'inner', label: 'Inner radius', type: 'number', min: 0.1, max: 1, step: 0.05, unit: 'x', default: 0.45, showIf: { shape: 'star' } },
      { key: 'points', label: 'Points', type: 'number', min: 3, max: 12, step: 1, unit: '', default: 5, showIf: { shape: 'star' } },
      ...flushPlaceParams(true),
      opParam, heightParam, depthParam, colorParam, ...fillParams,
    ],
  },
  text: {
    label: 'Text', icon: 'text',
    params: [
      { key: 'text', label: 'Text', type: 'textarea', default: 'Label', maxLength: TEXT_LIMITS.maxChars, help: 'Enter starts a new line.' },
      { key: 'font', label: 'Font', type: 'select', options: FONTS.map(f => [f.id, f.label]), default: FONTS[0].id },
      { key: 'size', label: 'Letter height', type: 'number', min: TEXT_LIMITS.minSize, max: TEXT_LIMITS.maxSize, step: 0.5, unit: 'mm', default: 10, help: 'The height of a capital letter.' },
      { key: 'spacing', adv: true, label: 'Letter spacing', type: 'number', min: -5, max: 20, step: 0.1, unit: 'mm', default: 0 },
      { key: 'lineGap', adv: true, label: 'Line spacing', type: 'number', min: 1, max: 4, step: 0.05, unit: 'x', default: 1.6, help: 'Baseline to baseline, as a multiple of the letter height.' },
      { key: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['centre', 'Centre'], ['right', 'Right']], default: 'centre' },
      { key: 'bend', adv: true, label: 'Arc', type: 'number', min: -360, max: 360, step: 5, unit: 'deg', default: 0, help: 'Bends the line round a circle: positive arches it up, negative dips it down, 360 closes a ring.' },
      ...placeParams,
      textOpParam, heightParam, depthParam, colorParam, ...fillParams,
    ],
  },
  image: {
    label: 'Image', icon: 'image',
    params: [
      { key: 'width', label: 'Width', type: 'number', min: 0.5, max: IMAGE_LIMITS.maxWidth, step: 0.5, unit: 'mm', default: 40, help: 'The picture is scaled to this width; its height follows.' },
      { key: 'steps', label: 'Tones', type: 'number', min: 1, max: IMAGE_LIMITS.maxSteps, step: 1, unit: '', default: 2, help: 'How many tones the picture is split into above its pale background. One makes a silhouette.' },
      { key: 'balance', adv: true, label: 'Balance', type: 'number', min: -0.4, max: 0.4, step: 0.02, unit: '', default: 0, help: 'Moves every tone boundary: up takes more of the picture as dark, down less.' },
      { key: 'invert', label: 'Invert (light is high)', type: 'bool', default: false },
      { key: 'smooth', adv: true, label: 'Smoothing', type: 'number', min: 0, max: IMAGE_LIMITS.maxSmooth, step: 0.1, unit: 'mm', default: 0.3, help: 'Softens the picture before it is split, so edges come out smooth and noise goes.' },
      { key: 'minPiece', adv: true, label: 'Remove pieces smaller than', type: 'number', min: 0, max: IMAGE_LIMITS.maxPiece, step: 0.1, unit: 'mm', default: 1, help: 'Specks and pin holes smaller than about this across are left out.' },
      ...placeParams,
      opParam,
      { ...heightParam, label: 'Step height', default: 0.6, help: 'Each tone stands this much above the one before it.' },
      { ...depthParam, help: 'A cut goes this much deeper for each tone; an inlay is this thick throughout. Never into the backer.' },
      { key: 'stepColors', label: 'Tone colours', type: 'colors', default: [], showIf: { op: ['raise', 'inlay'] } },
    ],
  },
  surface: {
    label: '3D texture', icon: 'surface',
    params: [
      { key: 'map', label: 'Texture', type: 'select', options: HEIGHT_MAPS, default: 'crystal' },
      { key: 'region', label: 'Area', type: 'select', options: [['face', 'Whole face'], ['shape', 'A shape'], ['element', 'An element']], default: 'face', help: 'What the texture covers: the whole face, a shape of its own, or the outline of another element (letters, a shape, art).' },
      { key: 'target', label: 'Element', type: 'target', default: '', showIf: { region: 'element' } },
      { key: 'shape', label: 'Shape', type: 'select', options: [['rect', 'Rectangle'], ['roundrect', 'Rounded rectangle'], ['ellipse', 'Ellipse']], default: 'roundrect', showIf: { region: 'shape' } },
      { key: 'w', label: 'Width', type: 'number', min: 2, max: 400, step: 0.5, unit: 'mm', default: 50, showIf: { region: 'shape' } },
      { key: 'h', label: 'Height', type: 'number', min: 2, max: 200, step: 0.5, unit: 'mm', default: 30, showIf: { region: 'shape' } },
      { key: 'r', label: 'Corner radius', type: 'number', min: 0, max: 100, step: 0.25, unit: 'mm', default: 4, showIf: { region: 'shape', shape: 'roundrect' } },
      ...placeParams.map(p => ({ ...p, showIf: { region: 'shape' } })),
      { key: 'scale', label: 'Feature size', type: 'number', min: 0.5, max: 60, step: 0.1, unit: 'mm', default: 4, help: 'How big one cell, bump or repeat of the texture is.' },
      { key: 'depth', label: 'Texture height', type: 'number', min: 0.1, max: 5, step: 0.05, unit: 'mm', default: 0.6, help: 'From the lowest to the highest point of the texture itself, above its base.' },
      { key: 'base', label: 'Base thickness', type: 'number', min: 0, max: 10, step: 0.05, unit: 'mm', default: 0.4, help: 'A solid layer under the texture, standing on the face. At 0 the texture starts right on the face.' },
      { key: 'angle', adv: true, label: 'Turn the texture', type: 'number', min: -180, max: 180, step: 1, unit: 'deg', default: 0 },
      { key: 'seed', adv: true, label: 'Seed', type: 'number', min: 0, max: 9999, step: 1, unit: '', default: 1, showIf: { map: SEEDED_MAPS } },
      { key: 'fit', label: 'Picture', type: 'select', options: [['stretch', 'Stretch over the area'], ['tile', 'Repeat it']], default: 'stretch', showIf: { map: 'picture' } },
      { key: 'invert', adv: true, label: 'Invert (high is low)', type: 'bool', default: false },
      { key: 'detail', adv: true, label: 'Detail', type: 'select', options: [['fine', 'Fine'], ['normal', 'Normal'], ['coarse', 'Coarse']], default: 'normal', help: 'The mesh grid: fine is 0.25 mm and makes bigger files, coarse 0.6 mm. A big area gets a coarser grid to stay quick, in the preview and the download alike.' },
      { key: 'terrace', label: 'Terraces', type: 'number', min: 0, max: 2, step: 0.05, unit: 'mm', default: 0, help: 'Flat steps this high, like contour lines on a map. 0.2 mm matches a 0.2 mm layer, so every step prints crisp. 0 keeps the slopes smooth.' },
      { key: 'edge', label: 'Edge', type: 'select', options: [['none', 'None'], ['border', 'Flat border'], ['rim', 'Raised rim']], default: 'none', help: 'A flat band round the texture at its base, or a rim at its top, so it stops cleanly at its outline.' },
      { key: 'edgeW', label: 'Edge width', type: 'number', min: 0.4, max: 20, step: 0.1, unit: 'mm', default: 2, showIf: { edge: ['border', 'rim'] } },
      { key: 'color', label: 'Colour', type: 'color', default: 'c2' },
      { key: 'cellColors', label: 'Cell colours', type: 'colors', default: [] },
      { key: 'colorMode', label: 'Colour by', type: 'select', options: [['random', 'Random'], ['height', 'Height']], default: 'random' },
      { key: 'tipOn', label: 'Tip colour', type: 'bool', default: false, help: 'Print the peaks in a second filament.' },
      { key: 'tipColor', label: 'Tips in', type: 'color', default: 'c3', showIf: { tipOn: true } },
      { key: 'tipAt', label: 'Tips from', type: 'number', min: 10, max: 90, step: 1, unit: '%', default: 70, showIf: { tipOn: true }, help: 'Above this share of the texture height the peaks print in the tip colour.' },
    ],
  },
  // a drawing made with the pen on the 2D stage (path.js): its points live in el.pts, not here
  path: {
    label: 'Drawing', icon: 'pencil-simple',
    params: [
      { key: 'form', label: 'Make it', type: 'select', options: PATH_FORMS, default: 'fill', help: 'Filled: the whole shape. Wall: a band of the thickness below, inside the drawn outline. Line: along the points without closing, as thick as below.' },
      { key: 'thick', label: 'Thickness', type: 'number', min: PATH_LIMITS.minThick, max: PATH_LIMITS.maxThick, step: 0.1, unit: 'mm', default: 2, showIf: { form: ['wall', 'line'] }, help: 'How thick the wall or the line is. Two perimeters of a 0.4 mm nozzle need 0.8 mm.' },
      { key: 'ends', label: 'Ends', type: 'select', options: [['round', 'Round'], ['flat', 'Flat']], default: 'round', showIf: { form: 'line' } },
      ...placeParams,
      ...shapedParams,
    ],
  },
  // a combine: the outlines of other flat elements (its pieces, in el.parts) joined, the first cut by the rest, or
  // where they all overlap; the pieces stop printing on their own
  combine: {
    label: 'Combine', icon: 'stack',
    params: [
      { key: 'operation', label: 'Combine by', type: 'select', options: COMBINE_OPS, default: 'cut', help: 'Join: all the pieces as one. Cut away: the first piece, with every other piece cut out of it. Overlap: only where all the pieces overlap.' },
      ...shapedParams,
    ],
  },
  // an outline: another element's outline grown or shrunk, as a band round it or as the grown shape; that element
  // still prints, and the outline follows it
  offset: {
    label: 'Outline', icon: 'circle',
    params: [
      { key: 'source', label: 'Follows', type: 'target', default: '' },
      { key: 'band', label: 'Make it', type: 'select', options: OFFSET_BANDS, default: 'ring', help: 'A band round it: the strip between its outline and the grown one (inside it, for a negative distance), a border or a halo. The grown shape: its outline moved out or in, filled.' },
      { key: 'distance', label: 'Distance', type: 'number', min: -20, max: 20, step: 0.1, unit: 'mm', default: 2, help: 'How far out the outline moves; a negative distance moves it in. Corners come out round, as a nozzle draws them.' },
      ...shapedParams,
    ],
  },
  svg: {
    label: 'SVG art', icon: 'svg',
    params: [
      { key: 'width', label: 'Art width', type: 'number', min: 1, max: 400, step: 0.25, unit: 'mm', default: 40 },
      ...placeParams,
      ...fillParams,
    ],
    groups: true,
  },
  grip: {
    label: 'Grip', icon: 'grip',
    params: [
      { key: 'style', label: 'Style', type: 'select', options: GRIP_STYLES, default: 'wedge' },
      { key: 'corner', label: 'Corner', type: 'select', options: [['right', 'Top right'], ['left', 'Top left']], default: 'right', showIf: { style: 'edgelabel' }, help: 'EdgeLabel\'s hood sits in a top corner, as the series ships it (top right; top left mirrors it).' },
      { key: 'pairs', label: 'Second hood on 3W and 4W', type: 'bool', default: true, showIf: { style: 'edgelabel' }, help: 'As the series ships it: one hood per 2W counted from the corner, so 3W and 4W plates get a second 176 mm along.' },
      { key: 'fullWidth', label: 'Full width', type: 'bool', default: false, showIf: { style: NOT_CORNER }, help: 'Runs it the whole width of the plate on every size, its ends at the plate\'s sides. The Classic grips ship this way.' },
      { key: 'length', label: 'Length', type: 'number', min: 5, max: 400, step: 0.5, unit: 'mm', default: 50, showIf: { fullWidth: false, style: NOT_CORNER } },
      { key: 'depth', label: 'Width', type: 'number', min: 2, max: 40, step: 0.25, unit: 'mm', default: 10, showIf: { style: SHAPED }, help: 'Across the grip, seen from the front: how far it reaches down the face.' },
      { key: 'height', label: 'Stands out', type: 'number', min: 1, max: FACE_LIMITS.maxRaise, step: 0.25, unit: 'mm', default: 6, showIf: { style: SHAPED }, help: 'How far the grip rises from the face.' },
      { key: 'accentStrip', label: 'Accent strip', type: 'bool', default: true, showIf: { style: HOOD_STYLES }, help: 'The 2 mm strip set into the bar, as the series ships it, printed here in its own colour. Off leaves the bar plain.' },
      { key: 'accentColor', label: 'Accent colour', type: 'color', default: 'c3', showIf: { style: HOOD_STYLES, accentStrip: true } },
      { key: 'undercut', label: 'Undercut', type: 'number', min: 0, max: 20, step: 0.25, unit: 'mm', default: 2, showIf: { style: ['wedge', 'ledge', 'lip'] }, help: 'How far the top overhangs each undercut side: on a lip pull, the finger pocket under the lip. Keep it at or below the height for a 45° slope.' },
      { key: 'chamfer', adv: true, label: 'Top chamfer', type: 'number', min: 0, max: 8, step: 0.25, unit: 'mm', default: 0.5, showIf: { style: ['bar', 'wedge', 'ledge', 'lip', 'arch'] }, help: 'A 45° chamfer on the top edges: crisp to print, kind to fingers. On a lip pull, the lip\'s edge; on an arch, the bar\'s ends.' },
      { key: 'flip', adv: true, label: 'Undercut faces up', type: 'bool', default: false, showIf: { style: 'ledge' } },
      { key: 'lipEdge', adv: true, label: 'Lip thickness', type: 'number', min: 0.4, max: 10, step: 0.25, unit: 'mm', default: 3, showIf: { style: 'lip' }, help: 'The straight edge your fingers pull on, at the bottom of the lip.' },
      { key: 'legs', adv: true, label: 'Leg width', type: 'number', min: 2, max: 40, step: 0.25, unit: 'mm', default: 6, showIf: { style: 'arch' }, help: 'Each leg along the length, where the arch stands on the face.' },
      { key: 'bar', adv: true, label: 'Bar thickness', type: 'number', min: 1.5, max: 20, step: 0.25, unit: 'mm', default: 4, showIf: { style: 'arch' }, help: 'The bar over the arch. The arch rises at 45° to meet it, so a wide, low arch leaves a flat bridge under the bar; keep that short.' },
      { key: 'ends', label: 'Ends', type: 'select', options: GRIP_ENDS, default: 'square', showIf: { style: NOT_ARCH }, help: 'Seen from the front: square, angled or rounded in toward the long sides (on a lip pull or a ledge, toward the undercut side).' },
      { key: 'endTaper', adv: true, label: 'End taper', type: 'number', min: 0, max: 60, step: 0.25, unit: 'mm', default: 8, showIf: { style: NOT_ARCH, ends: ['angled', 'round'] }, help: 'How much shorter it is along the side the ends come in toward, at each end.' },
      { key: 'lean', adv: true, label: 'Ends lean in', type: 'number', min: 0, max: 45, step: 1, unit: 'deg', default: 0, showIf: { style: NOT_ARCH }, help: 'The ends slope in as they rise, so the front is shorter than the base. Leaning in never overhangs.' },
      // (a full-width grip runs side to side on every size, so nothing slides it along: no Offset X)
      ...flushPlaceParams(false).map(p => ({ ...p, showIf: { ...(p.showIf || {}), style: NOT_CORNER, ...(p.key === 'x' ? { fullWidth: false } : {}) } })),
      { key: 'color', label: 'Colour', type: 'color', default: 'c2' },
    ],
  },
  solid: {
    label: 'Solid', icon: 'solid',
    params: [
      { key: 'shape', label: 'Shape', type: 'select', options: SOLID_SHAPES, default: 'box' },
      { key: 'w', label: 'Width', type: 'number', min: 1, max: 400, step: 0.25, unit: 'mm', default: 30 },
      { key: 'h', label: 'Height', type: 'number', min: 1, max: 200, step: 0.25, unit: 'mm', default: 10 },
      { key: 'out', label: 'Stands out', type: 'number', min: 0.4, max: FACE_LIMITS.maxRaise, step: 0.25, unit: 'mm', default: 6, help: 'How far it rises from the face, or from the block it sits on.' },
      { key: 'corner', adv: true, label: 'Corner radius', type: 'number', min: 0, max: 100, step: 0.25, unit: 'mm', default: 2, showIf: { shape: ['box', 'taper', 'pyramid'] } },
      { key: 'edge', label: 'Top edges', type: 'select', options: SOLID_EDGES, default: 'chamfer', showIf: { shape: ['box', 'cylinder', 'taper'] } },
      { key: 'edgeSize', adv: true, label: 'Edge size', type: 'number', min: 0.2, max: 20, step: 0.1, unit: 'mm', default: 1, showIf: { shape: ['box', 'cylinder', 'taper'], edge: ['chamfer', 'round'] } },
      { key: 'taper', label: 'Top-to-base ratio', type: 'number', min: 0.05, max: 1.5, step: 0.05, unit: 'x', default: 0.6, showIf: { shape: 'taper' }, help: 'How big the top is next to the base, both ways. 1 keeps the sides straight; over 1 they overhang.' },
      ...flushPlaceParams(true),
      { key: 'stackOn', label: 'Sits on', type: 'stack', default: '' },
      { key: 'lift', adv: true, label: 'Lift', type: 'number', min: 0, max: 30, step: 0.1, unit: 'mm', default: 0, help: 'Raises it off what it sits on. Anything lifted needs support under it.' },
      { key: 'color', label: 'Colour', type: 'color', default: 'c2' },
    ],
  },
  mesh: {
    label: 'Mesh', icon: 'mesh',
    params: [
      { key: 'width', label: 'Width', type: 'number', min: 1, max: 400, step: 0.25, unit: 'mm', default: 40, help: 'The sculpt is scaled uniformly to this width across the plate.' },
      { key: 'up', label: 'Up axis in the file', type: 'select', options: [['z', 'Z up (Blender, Fusion)'], ['y', 'Y up (Nomad Sculpt, most sculpting apps)'], ['x', 'X up'], ['-z', 'Z down'], ['-y', 'Y down'], ['-x', 'X down']], default: 'y' },
      { key: 'mirror', adv: true, label: 'Mirror left-right', type: 'bool', default: false },
      ...placeParams,
      { key: 'base', label: 'Face under it', type: 'select', options: [['on', 'Kept'], ['in', 'Replaced']], default: 'on', help: 'Kept: the sculpt stands on top of the face. Replaced: its bottom goes down to the backer and the face slab under it is taken out, so the sculpt is the face there.' },
      { key: 'color', label: 'Colour', type: 'color', default: 'c2' },
    ],
    mesh: true,
  },
};

/** How the plate is pulled: 'pair' (the two M3 screws of a bolt-on handle), 'knob' (one centre hole) or 'none'. */
export function handleMount(design) {
  // `holes: false` (the switch before the knob option) still means no holes, so older code and files keep working
  const m = design.handles?.mount;
  if (m === 'knob' || m === 'none') return m;
  return design.handles?.holes === false ? 'none' : 'pair';
}

/** The through-holes the mount puts in the face: [{ x, y, d }]. A knob hole sits on the handle line, centred. */
export function mountHoles(design, size) {
  const m = handleMount(design);
  if (m === 'pair') return size.holes;
  if (m === 'knob') {
    const y = size.holes.reduce((s, h) => s + h.y, 0) / size.holes.length;
    return [{ x: 0, y, d: Math.max(2, Math.min(10, Number(design.handles?.knobD) || 3.2)) }];
  }
  return [];
}

export const faceOn = design => design.face?.enabled !== false;

const PLACED = new Set(['shape', 'svg', 'grip', 'mesh', 'solid', 'text', 'image', 'path']);

/** The kinds built from an outline with the shaped settings (a drawing, a combine, an outline). */
export const SHAPED_KINDS = new Set(['path', 'combine', 'offset']);
/** Whether one of those is built as a body (raised with a taper or a shaped top edge) rather than as flat relief. */
export const isShapedBody = el => SHAPED_KINDS.has(el.kind) && el.op === 'raise' && (pathTaper(el) > 0 || pathEdge(el).size > 0);

/** The edge an element sits flush with ('t' or 'b'), or '' when it is placed by its anchor. */
export const flushEdge = el => (FLUSHABLE.has(el.kind) && (el.flush === 't' || el.flush === 'b') ? el.flush : '');

/** An element's turn in degrees: a grip flush with an edge lies along it, its flush side to the edge. */
export function elementTurn(el) {
  const f = flushEdge(el);
  if (f && el.kind === 'grip') return f === 'b' ? 180 : 0;
  return el.rotation || 0;
}

/** How far an element reaches below and above its centre, turned as it is: [y0, y1]. */
function spanY(el) {
  if (el.kind === 'grip') { const d = HOOD_STYLES.includes(el.style) ? 27 : Math.max(1, Number(el.depth) || 0); return [-d / 2, d / 2]; }
  const b = P.bbox(el.kind === 'solid' ? solidBody(el).footprint : P.rotate(shapePoly(el), elementTurn(el)));
  return Number.isFinite(b.y0) ? [b.y0, b.y1] : [0, 0];
}

/** Whether an element runs the plate's whole width on every size (a full-width grip; EdgeLabel's hood never does). */
export const spansWidth = el => el.kind === 'grip' && !!el.fullWidth && el.style !== 'edgelabel';

/** An element's centre on a plate: its anchor plus its offset, or on the edge it sits flush with. A full-width grip
 *  stays centred side to side, whatever its Offset X or anchor column says (either would push it off the plate). */
export function elementCentre(el, W, H) {
  const f = flushEdge(el), centred = spansWidth(el);
  if (f) { const [y0, y1] = spanY(el); return [centred ? 0 : el.x || 0, f === 't' ? H / 2 - y1 : -H / 2 - y0]; }
  const [ax, ay] = anchorPoint(el.anchor, W, H);
  return [centred ? 0 : ax + (el.x || 0), ay + (el.y || 0)];
}

/** Whether symmetry gives this element a mirror twin on this plate. Elements on the centre line stay single. */
export function hasTwin(design, el, W, H) {
  // a 3D texture over the whole face or another element's outline is not placed itself (that element has its twin)
  if (el.kind === 'surface' && el.region !== 'shape') return false;
  return design.symmetry === 'x' && (PLACED.has(el.kind) || el.kind === 'surface') && Math.abs(elementCentre(el, W, H)[0]) > 0.05;
}

let idCounter = 0;
export function newId(prefix = 'el') { idCounter += 1; return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`; }

export function newElement(kind, overrides = {}) {
  const def = ELEMENT_DEFS[kind];
  const el = { id: newId(), kind, name: def.label, visible: true };
  for (const p of def.params) el[p.key] = Array.isArray(p.default) ? p.default.slice() : p.default;   // never share a default array
  if (kind === 'svg') el.groups = [];
  if (kind === 'path') el.pts = [];
  if (kind === 'combine') el.parts = [];
  if (def.params.some(p => p.key === 'fill')) el.fillParams = {};
  Object.assign(el, overrides);
  if (kind === 'pattern') el.params = { ...patternDefaults(el.pattern), ...(overrides.params || {}) };
  if (kind === 'surface') el.texParams = { ...textureDefaults(el.map), ...(overrides.texParams || {}) };
  return el;
}

function shapePoly(el) {
  const w = Math.max(0.1, el.w), h = Math.max(0.1, el.h);
  switch (el.shape) {
    case 'circle': return P.ellipse(0, 0, w / 2, w / 2, Math.max(24, Math.min(96, Math.round(w * 2))));
    case 'ellipse': return P.ellipse(0, 0, w / 2, h / 2, Math.max(24, Math.min(96, Math.round(Math.max(w, h) * 2))));
    case 'roundrect': return P.roundRect(-w / 2, -h / 2, w / 2, h / 2, el.r || 0);
    case 'triangle': return P.polygon([[-w / 2, -h / 2], [w / 2, -h / 2], [0, h / 2]]);
    case 'hexagon': return P.regularPolygon(0, 0, w / 2, 6, 0);
    case 'star': return P.star(0, 0, w / 2, (w / 2) * (el.inner ?? 0.45), el.points || 5);
    default: return P.rect(-w / 2, -h / 2, w / 2, h / 2);
  }
}

function placed(poly, el, W, H) {
  const [cx, cy] = elementCentre(el, W, H);
  return P.translate(P.rotate(poly, elementTurn(el)), cx, cy);
}

/**
 * The 2D parts an element contributes for a plate: [{ poly, op, height, depth, color, name }]. A combine or an
 * outline is worked out from other elements, so it needs the design (as the size has it); without one it has none.
 */
export function elementParts(el, size, design = null) {
  const W = size.w, H = size.h;
  if (el.visible === false) return [];
  switch (el.kind) {
    case 'pattern': {
      let poly = generatePattern(el.pattern, el.params || {}, W, H);
      if (el.invert) poly = P.difference(P.rect(-W / 2 - 1, -H / 2 - 1, W / 2 + 1, H / 2 + 1), poly);
      return [{ poly, op: el.op, height: el.height, depth: el.depth, color: el.color, name: el.name }];
    }
    case 'shape': {
      const sig = JSON.stringify(['shape', el.shape, el.w, el.h, el.r, el.inner, el.points]);
      return [{ poly: placed(applyFill(shapePoly(el), el, sig), el, W, H), op: el.op, height: el.height, depth: el.depth, color: el.color, name: el.name }];
    }
    case 'text': {
      // throws while the font loads (the builder notes it and the app rebuilds when it arrives)
      const t = textOutline(el);
      const notes = [];
      if (t.missing.length) notes.push(`${el.name}: ${t.missing.slice(0, 8).join(' ')} ${t.missing.length > 1 ? 'are' : 'is'} not in this font and ${t.missing.length > 1 ? 'are' : 'is'} left out`);
      if (Math.abs(t.bend) < Math.abs(el.bend || 0) - 0.5) notes.push(`${el.name}: the arc is held to ${Math.round(Math.abs(t.bend))}° so the letters do not turn inside out; lengthen the text or make it smaller`);
      if (!t.poly.length) return notes.length ? [{ poly: [], op: el.op, name: el.name, note: notes[0] }] : [];
      const local = applyFill(t.poly, el, JSON.stringify(['text', t.font, t.size, el.text, el.spacing, el.lineGap, el.align, el.bend]));
      // a symmetry twin of text reads the right way round: the same letters at the mirrored place and angle
      const [cx, cy] = elementCentre(el, W, H);
      const twinPoly = P.translate(P.rotate(local, -(el.rotation || 0)), -cx, cy);
      return [{ poly: placed(local, el, W, H), twinPoly, op: el.op, height: el.height, depth: el.depth, color: el.color, name: el.name, note: notes.join('. ') || undefined }];
    }
    case 'image': {
      // tone k (k = 1 the palest) covers everything at least that dark, so later tones win where they overlap: a
      // raise steps up k x the step height, a cut goes k x the depth, an inlay sets each tone in its own colour
      const body = imageTones(el);
      if (!body) return [];
      return body.tones.map((tone, i) => ({
        poly: placed(tone, el, W, H), op: el.op, name: `${el.name}: tone ${i + 1}`,
        height: (i + 1) * (el.height ?? 0.6), depth: el.op === 'cut' ? (i + 1) * (el.depth ?? 0.6) : el.depth,
        color: el.stepColors?.[i] || 'c2',
      })).filter(pt => pt.poly.length);
    }
    case 'combine': case 'offset': {
      const poly = design ? derivedOutline(el, design, size) : [];
      return poly.length ? [{ poly, op: el.op, height: el.height, depth: el.depth, color: el.color, name: el.name }] : [];
    }
    case 'path': {
      const local = pathOutline(el);
      return local.length ? [{ poly: placed(local, el, W, H), op: el.op, height: el.height, depth: el.depth, color: el.color, name: el.name }] : [];
    }
    case 'svg': {
      if (!el.groups?.length || !el.natural?.w) return [];
      const s = (el.width || 40) / el.natural.w;
      return el.groups.filter(g => g.visible !== false).map((g, i) => ({
        poly: placed(applyFill(P.scale(g.rings, s, s), el, JSON.stringify(['svg', el.id, i, s, g.rings.length, P.pointCount(g.rings), g.rings[0]?.[0]?.[0]])), el, W, H),
        op: g.op || 'raise', height: g.height ?? 1, depth: g.depth ?? 0.6, color: g.color, name: `${el.name}: ${g.name || g.fill}`,
      }));
    }
    default: return [];
  }
}

/**
 * Grip solids for a plate: the shape from grips.js placed and turned, with its footprint, contact base, flat top,
 * undercut angle and bridge for the checks, and where it has material at each height (so relief under an undercut
 * or an arch keeps going under it).
 */
export function gripSolids(el, size, t) {
  if (el.kind !== 'grip' || el.visible === false) return [];
  const W = size.w, H = size.h;
  const [cx, cy] = elementCentre(el, W, H), turn = elementTurn(el);
  const at = mp => (mp && mp.length ? P.translate(P.rotate(mp, turn), cx, cy) : mp);
  const g = gripShape(el, { plateW: W });
  if (g.corner) {
    // EdgeLabel's hood in its top corner (mirrored for the left), and a second 176 mm along on 3W and 4W
    const left = el.corner === 'left', sx = left ? -1 : 1;
    const along = el.pairs !== false && W > 2 * 88 ? [0, CORNER_HOOD.pitch] : [0];
    return along.map((d, k) => {
      const ox = sx * (W / 2 - d), oy = H / 2, src = g.tris, tris = new Array(src.length);
      for (let i = 0; i < src.length; i += 9) for (let j = 0; j < 3; j++) {
        const from = i + 3 * (left && j ? 3 - j : j), to = i + 3 * j;   // a mirror turns the winding round
        tris[to] = sx * src[from] + ox; tris[to + 1] = src[from + 1] + oy; tris[to + 2] = src[from + 2] + t;
      }
      const at = mp => (mp && mp.length ? P.translate(left ? P.mirrorX(mp, 0) : mp, ox, oy) : mp);
      const seen = new Map();
      const occupies = (z0, z1) => { const key = `${z0.toFixed(4)}|${z1.toFixed(4)}`; if (!seen.has(key)) seen.set(key, at(g.occupies(z0 - t, z1 - t))); return seen.get(key); };
      return { tris, color: el.color, elementId: el.id, name: k ? `${el.name} (second hood)` : el.name, footprint: at(g.footprint), base: at(g.base), top: at(g.top), z0: t, z1: t + g.height, overhang: g.overhang, bridge: 0, strength: g.strength, style: 'edgelabel', occupies };
    });
  }
  const tris = transformTriangles(g.tris, turn, cx, cy, t);
  const seen = new Map();
  const occupies = (z0, z1) => { const k = `${z0.toFixed(4)}|${z1.toFixed(4)}`; if (!seen.has(k)) seen.set(k, at(g.occupies(z0 - t, z1 - t))); return seen.get(k); };
  const out = [{ tris, color: el.color, elementId: el.id, name: el.name, footprint: at(g.footprint), base: at(g.base), top: g.top ? at(g.top) : null, z0: t, z1: t + g.height, overhang: g.overhang, bridge: g.bridge, strength: g.strength, style: el.style, occupies }];
  if (g.accent) {
    // the accent strip: its own body in its own colour, held in the bar's slot (so it needs no face under it)
    const a = g.accent, fp = at(a.footprint);
    out.push({ tris: transformTriangles(a.tris, turn, cx, cy, t), color: el.accentColor || 'c3', elementId: el.id, name: `${el.name}: accent strip`, footprint: fp, base: fp, top: null, z0: t + a.z0, z1: t + a.z1, overhang: 0, bridge: 0, style: 'accent', inside: true, occupies: (z0, z1) => (z1 > t + a.z0 ? fp : []) });
  }
  return out;
}

// ---- imported meshes
const UP_MAPS = {
  z: p => p, y: ([x, y, z]) => [x, -z, y], x: ([x, y, z]) => [-z, y, x],
  '-z': ([x, y, z]) => [x, -y, -z], '-y': ([x, y, z]) => [x, z, -y], '-x': ([x, y, z]) => [z, y, -x],
};
const meshCache = new Map();
/**
 * The mesh's contents as a cache key: an FNV hash of every character of its packed positions and indices. Computed
 * once per data object and remembered (a load, an undo or an import makes a new object; builds reuse it), so two
 * meshes that share an element id and counts but not coordinates never share a cache entry, and a multi-megabyte
 * mesh is hashed once rather than on every build.
 */
const contentKeys = new WeakMap();
function fnv(s) {
  if (typeof s !== 'string') return '';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${h >>> 0}`;
}
function contentKey(data) {
  if (!data || typeof data !== 'object') return '';
  let k = contentKeys.get(data);
  if (!k) { k = `${fnv(data.v)}|${fnv(data.i)}`; contentKeys.set(data, k); }
  return k;
}
export const MESH_TRACE_RES = 0.25;

/**
 * The size-independent part of a mesh element: oriented, scaled, mirrored and rotated triangles with their bottom
 * at z = 0 and their xy centre at the origin, plus the traced footprint, contact base and overhang statistics.
 */
export function meshBody(el) {
  const sig = JSON.stringify([el.data?.nv, el.data?.nt, contentKey(el.data), el.up, el.width, el.mirror, el.rotation]);
  const hit = meshCache.get(el.id);
  if (hit && hit.sig === sig) return hit;
  if (!el.data) return null;
  const raw = flatten(unpackMesh(el.data));
  const map = UP_MAPS[el.up] || UP_MAPS.z;
  const n = raw.length;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i += 3) { const [x, y, z] = map([raw[i], raw[i + 1], raw[i + 2]]); t[i] = el.mirror ? -x : x; t[i + 1] = y; t[i + 2] = z; }
  if (el.mirror) for (let i = 0; i < n; i += 9) { for (let k = 0; k < 3; k++) { const a = t[i + 3 + k]; t[i + 3 + k] = t[i + 6 + k]; t[i + 6 + k] = a; } }   // a mirror flips winding: swap two vertices back
  // bbox, uniform scale to the requested width, centre xy, bottom to z = 0
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i += 3) { if (t[i] < x0) x0 = t[i]; if (t[i] > x1) x1 = t[i]; if (t[i + 1] < y0) y0 = t[i + 1]; if (t[i + 1] > y1) y1 = t[i + 1]; if (t[i + 2] < z0) z0 = t[i + 2]; if (t[i + 2] > z1) z1 = t[i + 2]; }
  const s = Math.max(0.001, el.width || 40) / Math.max(1e-6, x1 - x0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < n; i += 3) { t[i] = (t[i] - cx) * s; t[i + 1] = (t[i + 1] - cy) * s; t[i + 2] = (t[i + 2] - z0) * s; }
  transformTriangles(t, el.rotation || 0, 0, 0, 0);
  const height = (z1 - z0) * s, depth = (y1 - y0) * s, width = (x1 - x0) * s;
  // footprint (all triangles) and contact base (triangles lying within 0.3 mm of the bottom), traced from a raster
  // that covers the mesh at any rotation (the half-diagonal, not the unrotated half-width)
  const half = Math.hypot(width, depth) / 2 + 2;
  const frame = { x0: -half, y0: -half, res: MESH_TRACE_RES, w: Math.ceil(2 * half / MESH_TRACE_RES), h: Math.ceil(2 * half / MESH_TRACE_RES) };
  const footprint = traceMask(rasterizeTriangles(t, frame), frame);
  // the base: triangles lying flat within 0.3 mm of the bottom; a shape that comes to a point or an edge has none,
  // so fall back to every triangle that touches the bottom, and then to the whole footprint
  const lowAll = k => t[k * 9 + 2] <= 0.3 && t[k * 9 + 5] <= 0.3 && t[k * 9 + 8] <= 0.3;
  const lowAny = k => t[k * 9 + 2] <= 0.3 || t[k * 9 + 5] <= 0.3 || t[k * 9 + 8] <= 0.3;
  let base = traceMask(rasterizeTriangles(t, frame, lowAll), frame);
  if (!base.length) base = traceMask(rasterizeTriangles(t, frame, lowAny), frame);
  if (!base.length) base = footprint;
  // overhangs: down-facing triangles above the base, by angle from vertical, area-weighted
  let worst = 0, area45 = 0, area60 = 0;
  for (let i = 0; i < n; i += 9) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz); if (L < 1e-9) continue;
    if (nz / L > -0.02) continue;                                        // not facing down
    if (t[i + 2] <= 0.3 && t[i + 5] <= 0.3 && t[i + 8] <= 0.3) continue;  // the contact base
    const deg = Math.atan2(-nz / L, Math.hypot(nx, ny) / L) * 180 / Math.PI;   // 0 = vertical wall, 90 = flat ceiling
    const a = L / 2;
    if (deg > worst) worst = deg;
    if (deg > 45) area45 += a;
    if (deg > 60) area60 += a;
  }
  const body = { sig, tris: t, width, depth, height, footprint, base, overhang: worst, area45, area60, triCount: n / 9 };
  meshCache.set(el.id, body);
  return body;
}

/** Mesh solids for a plate: the body translated to its anchor, standing on the face or sunk to the backer. */
export function meshSolids(el, size, t) {
  if (el.kind !== 'mesh' || el.visible === false) return [];
  const body = meshBody(el);
  if (!body) return [];
  const [ax, ay] = anchorPoint(el.anchor, size.w, size.h);
  const cx = ax + (el.x || 0), cy = ay + (el.y || 0);
  const z0 = el.base === 'in' ? 0 : t;
  const tris = new Float32Array(body.tris.length);
  for (let i = 0; i < tris.length; i += 3) { tris[i] = body.tris[i] + cx; tris[i + 1] = body.tris[i + 1] + cy; tris[i + 2] = body.tris[i + 2] + z0; }
  return [{ tris, color: el.color, elementId: el.id, name: el.name, kind: 'mesh', footprint: P.translate(body.footprint, cx, cy), base: P.translate(body.base, cx, cy), z0, z1: z0 + body.height, overhang: body.overhang, area45: body.area45, area60: body.area60, style: 'mesh' }];
}

/** A solid block for a plate: at its anchor, standing on the face or on top of the element it sits on. */
export function solidSolids(el, size, t, tops = new Map()) {
  if (el.kind !== 'solid' || el.visible === false) return [];
  const body = solidBody(el);
  const [cx, cy] = elementCentre(el, size.w, size.h);
  const under = el.stackOn && tops.has(el.stackOn) ? tops.get(el.stackOn) : t;
  return [placeSolid(el, body, cx, cy, under + Math.max(0, el.lift || 0))];
}

// ---- combine and outline (2026-11-11, after Erie Sign Studio's booleans and linked offsets)
// A combine joins, cuts away or overlaps the outlines of other flat elements, its pieces, which then stop printing on
// their own (a piece hidden is left out of it); an outline follows one element at a distance, as a band round it or
// as the grown shape, and that element still prints. Both are worked out on each size from what the other elements
// are on that size, their symmetry twins included, so they follow every edit; and both build as a drawing does.

/** The kinds whose outline can be a combine's piece or an outline's source. */
export const OUTLINE_KINDS = new Set(['shape', 'text', 'svg', 'image', 'path', 'pattern', 'combine', 'offset']);

/** A combine's pieces: the elements its parts name, in order, that have an outline (never the combine itself). */
export function combinePieces(el, design) {
  const ids = Array.isArray(el.parts) ? el.parts : [];
  return ids.map(id => design.elements.find(e => e.id === id)).filter(e => e && e !== el && OUTLINE_KINDS.has(e.kind));
}

/** Every element some combine uses, shown or hidden: it prints as part of that combine, not on its own. */
export function consumedIds(design) {
  const out = new Set();
  for (const el of design.elements) if (el.kind === 'combine') for (const p of combinePieces(el, design)) out.add(p.id);
  return out;
}

/**
 * What moves when a combine or an outline is dragged whole: every element it is built from, through combines inside
 * it and the element an outline follows, that has a place of its own (Offset X and Y). Hidden pieces too, so showing
 * one again finds it where the rest went; a pattern spans the plate and stays. Each element once.
 */
export function movablePieces(el, design, seen = new Set()) {
  if (!el || seen.has(el.id)) return [];
  seen.add(el.id);
  if (el.kind === 'combine') return combinePieces(el, design).flatMap(p => movablePieces(p, design, seen));
  if (el.kind === 'offset') { const src = design.elements.find(e => e.id === el.source && e !== el); return src ? movablePieces(src, design, seen) : []; }
  const def = ELEMENT_DEFS[el.kind];
  return def && def.params.some(p => p.key === 'x') && def.params.some(p => p.key === 'y') ? [el] : [];
}

/** Whether `a` uses `b`, directly or through what it uses (so `b` taking `a` would go round in a circle). */
export function usesElement(a, b, design, seen = new Set()) {
  if (!a || seen.has(a.id)) return false;
  seen.add(a.id);
  const direct = a.kind === 'combine' ? combinePieces(a, design) : a.kind === 'offset' ? design.elements.filter(e => e.id === a.source && e !== a) : [];
  return direct.some(d => d.id === b.id || usesElement(d, b, design, seen));
}

/**
 * An element's outline on a plate (MultiPolygon, plate mm), its symmetry twin included: what a combine takes it as,
 * or what an outline follows. Empty for a kind with no outline, a hidden element, or a loop of elements using each
 * other.
 */
export function outlineOf(el, design, size, seen = new Set()) {
  if (!el || !OUTLINE_KINDS.has(el.kind) || seen.has(el.id)) return [];   // (an element already on the way here: a loop)
  const next = new Set(seen); next.add(el.id);
  let polys = [];
  if (el.kind === 'combine' || el.kind === 'offset') {
    if (el.visible !== false) { const d = derivedOutline(el, design, size, next); if (d.length) polys.push(d); }
  } else {
    let parts = [];
    try { parts = elementParts(el, size, design); } catch { parts = []; }   // text while its font loads
    polys = parts.map(p => p.poly).filter(p => p && p.length);
    if (hasTwin(design, el, size.w, size.h)) for (const p of parts) if (p.poly?.length) polys.push(p.twinPoly || P.mirrorX(p.poly, 0));
  }
  return polys.length > 1 ? P.union(...polys) : polys[0] || [];
}

const offsetCache = new Map(), OFFSET_CACHE = 32;

/** A combine's or an outline's own outline on a plate (MultiPolygon, plate mm). */
export function derivedOutline(el, design, size, seen = new Set([el.id])) {
  if (el.kind === 'combine') {
    // the shown pieces in order (a hidden one is left out): the first is what a cut cuts into. A shown piece that
    // comes to nothing still counts: nothing cut away is nothing, and nothing overlaps nothing
    const outs = combinePieces(el, design).filter(p => p.visible !== false).map(p => outlineOf(p, design, size, seen));
    if (!outs.length) return [];
    const op = el.operation === 'join' || el.operation === 'common' ? el.operation : 'cut';
    if (op === 'cut') { const [base, ...rest] = outs; return base.length ? P.difference(base, ...rest.filter(o => o.length)) : []; }
    if (op === 'common') return outs.some(o => !o.length) ? [] : outs.reduce((a, b) => P.intersection(a, b));
    const live = outs.filter(o => o.length);
    return live.length ? P.union(...live) : [];
  }
  if (el.kind === 'offset') {
    const src = design.elements.find(e => e.id === el.source && e !== el);
    if (!src) return [];
    // what it follows is followed even when hidden (an outline alone is a way to draw one)
    const S = outlineOf({ ...src, visible: true }, design, size, seen);
    if (!S.length) return [];
    const x = Number(el.distance), d = Number.isFinite(x) ? Math.min(20, Math.max(-20, x)) : 2;
    if (Math.abs(d) < 1e-6) return el.band === 'shape' ? S : [];
    const key = JSON.stringify([d, polyKey(S)]);
    let grown = offsetCache.get(key);
    if (!grown) {
      grown = offsetPoly(S, d);
      offsetCache.set(key, grown);
      if (offsetCache.size > OFFSET_CACHE) offsetCache.delete(offsetCache.keys().next().value);
    }
    if (el.band === 'shape') return grown;
    return d > 0 ? P.difference(grown, S) : P.difference(S, grown);
  }
  return [];
}

// ---- tapered drawings (path.js): a height field over the drawn outline, cut by the plate and the screw holes
const taperCache = new Map(), TAPER_CACHE = 18;
export function shapedSolids(el, size, t, keep, note = () => {}, design = null) {
  if (!isShapedBody(el) || el.visible === false) return [];
  // a drawing's own outline, placed (its symmetry twin comes from the builder); a combine's or an outline's, worked out
  const outline = el.kind === 'path' ? placed(pathOutline(el), el, size.w, size.h) : design ? derivedOutline(el, design, size) : [];
  if (!outline.length) return [];
  const region = P.intersection(outline, keep);
  if (P.isEmpty(region)) { note(`${el.name} lies outside this plate`); return []; }
  const height = Math.min(FACE_LIMITS.maxRaise, Math.max(0.2, Number(el.height) || 1)), angle = pathTaper(el), { edge, size: edgeSize } = pathEdge(el);
  const key = JSON.stringify([el.id, t, height, angle, edge, edgeSize, polyKey(outline), polyKey(region)]);
  let body = taperCache.get(key);
  if (body === undefined) {
    body = taperBody(region, outline, { z0: t, height, angle, edge, size: edgeSize, keep });
    taperCache.set(key, body);
    if (taperCache.size > TAPER_CACHE) taperCache.delete(taperCache.keys().next().value);
  }
  if (!body) return [];
  // the mesher's outline can sit a few hundredths of a millimetre past the plate's edge: pulled onto it (clip.js).
  // `clear`: the exact area, which takes the place of earlier relief; `unclipped`: what was drawn, for the checks
  const tris = clampTrisToPlate(body.tris, size.w, size.h), plate = P.rect(-size.w / 2, -size.h / 2, size.w / 2, size.h / 2);
  const footprint = tris === body.tris ? body.footprint : P.intersection(body.footprint, plate);
  return [{ tris, color: el.color, elementId: el.id, name: el.name, kind: 'shaped', style: 'taper', footprint, base: footprint, top: null, clear: region, unclipped: outline, z0: body.z0, z1: body.z1, overhang: 0, area45: 0, area60: 0, grid: body.grid }];
}

// ---- 3D textures
const surfaceCache = new Map(), SURFACE_CACHE = 18;
const pictureOf = data => (data && data.w && data.h && typeof data.g === 'string' ? { w: data.w, h: data.h, bytes: b64ToBytes(data.g) } : null);
const pictureMemo = new WeakMap();
// what keys a cached texture: a hash of every coordinate of its area (moving a block inside a whole-face texture
// keeps the area, the box and the point count, but not the coordinates), and a hash of the whole picture, once
const pictureKeys = new WeakMap();
const pictureKey = data => { if (!data) return ''; let k = pictureKeys.get(data); if (!k) { k = fnv(data.g); pictureKeys.set(data, k); } return k; };
function polyKey(mp) {
  let h = 2166136261, n = 0;
  for (const poly of mp) for (const ring of poly) for (const [x, y] of ring) { h = Math.imul(h ^ Math.round(x * 1e4), 16777619); h = Math.imul(h ^ Math.round(y * 1e4), 16777619); n++; }
  return `${n}:${h >>> 0}`;
}

/**
 * The area a 3D texture covers on this plate, and the point its texture is anchored at: the whole face, a shape of
 * its own (placed like any element), or another element's outline (its parts, and its symmetry twin's).
 */
export function surfaceRegion(el, design, size, keep) {
  const W = size.w, H = size.h;
  if (el.region === 'shape') {
    const w = Math.max(1, Number(el.w) || 50), h = Math.max(1, Number(el.h) || 30);
    const local = el.shape === 'ellipse' ? P.ellipse(0, 0, w / 2, h / 2, 96) : el.shape === 'rect' ? P.rect(-w / 2, -h / 2, w / 2, h / 2) : P.roundRect(-w / 2, -h / 2, w / 2, h / 2, Number(el.r) || 0);
    return { poly: P.intersection(placed(local, el, W, H), keep), centre: elementCentre(el, W, H), turn: el.rotation || 0 };
  }
  if (el.region === 'element') {
    const target = design.elements.find(e => e.id === el.target && e !== el && e.kind !== 'surface');
    if (!target) return { poly: [], centre: [0, 0], turn: 0, missing: true };
    const parts = elementParts({ ...target, visible: true }, size, design);
    const polys = parts.map(p => p.poly).filter(p => p && p.length);
    if (hasTwin(design, target, W, H)) for (const p of parts) if (p.poly?.length) polys.push(p.twinPoly || P.mirrorX(p.poly, 0));
    return { poly: polys.length ? P.intersection(P.union(...polys), keep) : [], centre: elementCentre(target, W, H), turn: target.rotation || 0, target };
  }
  return { poly: keep, centre: [0, 0], turn: 0 };
}

/** A 3D texture's body for one plate: a closed heightfield standing on the face (or the backer), cached per edit. */
export function surfaceSolids(el, design, size, t, keep, note = () => {}, exclude = []) {
  if (el.kind !== 'surface' || el.visible === false) return [];
  let region;
  try { region = surfaceRegion(el, design, size, keep); } catch (e) { note(`${el.name}: ${e.message}`); return []; }
  if (region.missing) { note(`${el.name}: the element it textures is gone; pick one in its card`); return []; }
  // what it leaves to others: bodies standing on the face keep their footprints, and a later texture takes its own
  // area (so no two bodies fill the same space)
  if (exclude.length) region = { ...region, poly: P.difference(region.poly, ...exclude) };
  if (P.isEmpty(region.poly)) return [];
  let picture = null;
  if (el.map === 'picture') {
    picture = el.data ? pictureMemo.get(el.data) : null;
    if (el.data && !picture) { picture = pictureOf(el.data); if (picture) pictureMemo.set(el.data, picture); }
    if (!picture) note(`${el.name}: choose a picture in its card; until then it is flat`);
  }
  const b = P.bbox(region.poly);
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const params = cleanTextureParams(el.map, el.texParams);
  const opts = { map: el.map, scale: num(el.scale, 0.5, 60, 4), angle: num(el.angle, -180, 180, 0) + region.turn, seed: num(el.seed, 0, 9999, 1), invert: !!el.invert, centre: region.centre, picture, fit: el.fit, box: b, params };
  const depth = num(el.depth, 0.1, 5, 0.6), base = num(el.base, 0, 10, 0.4), grid = SURFACE_GRIDS[el.detail] || SURFACE_GRIDS.normal;
  // the extras: terraces, a border or rim, cell colours (up to three more filaments) and a tip colour
  const cellColors = (Array.isArray(el.cellColors) ? el.cellColors : []).filter(c => typeof c === 'string' && c).slice(0, 3);
  const extra = {
    terrace: num(el.terrace, 0, 2, 0), edge: el.edge === 'border' || el.edge === 'rim' ? el.edge : 'none', edgeW: num(el.edgeW, 0.4, 20, 2),
    colors: 1 + cellColors.length, colorMode: el.colorMode === 'height' ? 'height' : 'random', tipAt: el.tipOn ? num(el.tipAt, 10, 90, 70) / 100 : null,
  };
  const key = JSON.stringify([el.id, size.id, t, opts.map, opts.scale, opts.angle, opts.seed, opts.invert, opts.centre, opts.fit, params, extra, depth, base, grid, el.map === 'picture' ? pictureKey(el.data) : '', polyKey(region.poly)]);
  let parts = surfaceCache.get(key);
  if (!parts) {
    parts = textureBodies(region.poly, opts, { z0: t, base, depth, grid, ...extra });   // exact for the edged maps, the grid for the rest
    surfaceCache.set(key, parts);
    if (surfaceCache.size > SURFACE_CACHE) surfaceCache.delete(surfaceCache.keys().next().value);
  } else { surfaceCache.delete(key); surfaceCache.set(key, parts); }
  // one solid per filament. `clear`: the exact area, which the builder clears of earlier relief (a meshed outline
  // runs a few hundredths of a millimetre inside it, and would leave hairlines of a raised element it textures)
  if (parts.some(p => p.dropped)) note(`${el.name}: its cell colours or tip colour would not split cleanly into bodies here, so it prints in its own colour. Another seed, or a small change to its settings, usually clears it.`);
  const colourOf = c => (c === 'tip' ? (typeof el.tipColor === 'string' && el.tipColor ? el.tipColor : el.color) : c === 0 ? el.color : cellColors[c - 1] || el.color);
  return parts.map(part => ({ tris: part.tris, color: colourOf(part.colour), elementId: el.id, name: el.name, kind: 'surface', footprint: part.footprint, clear: region.poly, base: part.footprint, top: null, z0: part.z0, z1: part.z1, overhang: 0, area45: 0, area60: 0, style: part.colour === 'tip' ? 'surface-tip' : 'surface', grid: part.grid }));
}

/**
 * For every visible 3D texture on this plate, what it must leave out: the footprints of every block, grip and mesh
 * (twins included) and the areas of every texture after it in the stack. Empty unless the design has a texture.
 */
function surfaceExclusions(design, size, t, keep) {
  const out = new Map();
  const surfaces = design.elements.filter(e => e.kind === 'surface' && e.visible !== false);
  if (!surfaces.length) return out;
  const W = size.w, H = size.h, bodies = [], consumed = consumedIds(design);
  for (const el of design.elements) {
    if (el.visible === false || consumed.has(el.id) || !(el.kind === 'grip' || el.kind === 'mesh' || el.kind === 'solid' || isShapedBody(el))) continue;
    let made = [];
    try { made = el.kind === 'grip' ? gripSolids(el, size, t) : el.kind === 'mesh' ? meshSolids(el, size, t) : SHAPED_KINDS.has(el.kind) ? shapedSolids(el, size, t, keep, () => {}, design) : solidSolids(el, size, t); } catch { made = []; }
    for (const s of made) { if (!P.isEmpty(s.footprint)) bodies.push(s.footprint); if (hasTwin(design, el, W, H) && !P.isEmpty(s.footprint)) bodies.push(P.mirrorX(s.footprint, 0)); }
  }
  const areas = surfaces.map(el => {
    let r = [];
    try { r = surfaceRegion(el, design, size, keep).poly; } catch { r = []; }
    return hasTwin(design, el, W, H) && r.length ? P.union(r, P.mirrorX(r, 0)) : r;
  });
  surfaces.forEach((el, i) => out.set(el.id, [...bodies, ...areas.slice(i + 1)].filter(p => p && p.length)));
  return out;
}

/** Carve a z-range out of the layers wherever `poly` covers them (splitting layers that straddle the range). */
/**
 * Carve a body out of the layers: each layer above the body's bottom gives way where the body has material in that
 * layer's heights (its footprint when the body cannot say), so relief under an undercut or an arch is kept.
 */
function carveBody(layers, g) {
  if (g.clear || !g.occupies) return carve(layers, g.clear || g.footprint, g.z0, Infinity);
  const out = [];
  for (const L of layers) {
    if (L.z1 <= g.z0 + 1e-9) { out.push(L); continue; }
    const a = Math.max(L.z0, g.z0);
    if (L.z0 < a - 1e-9) out.push({ ...L, z1: a });
    const region = g.occupies(a, L.z1);
    const rest = region && region.length ? P.difference(L.poly, region) : L.poly;
    if (!P.isEmpty(rest)) out.push({ ...L, poly: rest, z0: a });
  }
  return out;
}

function carve(layers, poly, z0, z1) {
  const out = [];
  for (const L of layers) {
    if (L.z1 <= z0 + 1e-9 || L.z0 >= z1 - 1e-9) { out.push(L); continue; }
    const a = Math.max(L.z0, z0), b = Math.min(L.z1, z1);
    if (L.z0 < a - 1e-9) out.push({ ...L, z1: a });
    if (L.z1 > b + 1e-9) out.push({ ...L, z0: b });
    const rest = P.difference(L.poly, poly);
    if (!P.isEmpty(rest)) out.push({ ...L, poly: rest, z0: a, z1: b });
  }
  return out;
}

/**
 * Build the face for one plate size.
 * Returns { layers, solids, keep, plate, holes, holeList, t, faceOn, size, notes } where layers are
 * { poly, z0, z1, color, kind, elementId, name, twin } and solids carry tris, footprint, base, top, z0, z1.
 */
export function buildFace(design, size) {
  const W = size.w, H = size.h;
  const on = faceOn(design);
  const t = on ? Math.min(FACE_LIMITS.maxThickness, Math.max(FACE_LIMITS.minThickness, design.face.thickness)) : 0;
  const plate = P.rect(-W / 2, -H / 2, W / 2, H / 2);
  const holeList = mountHoles(design, size);
  const holes = holeList.length ? P.union(...holeList.map(h => P.circle(h.x, h.y, h.d / 2, 40))) : [];
  const keep = holes.length ? P.difference(plate, holes) : plate;
  const notes = [];
  const noted = new Set();
  const note = (el, text, level = 'info') => { const k = `${el.id}|${text}`; if (!noted.has(k)) { noted.add(k); notes.push({ elementId: el.id, text, level }); } };
  let layers = on ? [{ poly: keep, z0: 0, z1: t, color: design.face.color, kind: 'slab', elementId: null, name: 'Face' }] : [];
  const solids = [];
  const tops = new Map();   // element id -> the highest z it reaches, for blocks stacked on it
  const leaveOut = surfaceExclusions(design, size, t, keep);
  // where each element ended up, for the check that nothing is mostly hidden or off the plate: what it was drawn as
  // (full, before the plate clips it; parts may nest, as an image's tones do), what the plate left of it (clipped),
  // what was placed (placed), and what it covers for the others (cover, twins included); its own twin never counts
  const drawn = [];
  // a combine's pieces print as part of it, not on their own: each is kept as a ghost, its outline on this size, so
  // the stage can draw it dashed and it can still be picked and moved
  const consumed = consumedIds(design), ghosts = [];
  for (const el of design.elements) {
    if (el.visible === false) continue;
    if (consumed.has(el.id)) {
      try {
        if (el.kind === 'combine' || el.kind === 'offset') { const g = derivedOutline(el, design, size); if (g.length) ghosts.push({ elementId: el.id, poly: g }); }
        else {
          const parts = elementParts(el, size, design).filter(p => p.poly && p.poly.length);
          if (parts.length) ghosts.push({ elementId: el.id, poly: P.union(...parts.map(p => p.poly)) });
          if (parts.length && hasTwin(design, el, W, H)) ghosts.push({ elementId: el.id, poly: P.union(...parts.map(p => p.twinPoly || P.mirrorX(p.poly, 0))), twin: true });
        }
      } catch { /* text while its font loads */ }
      continue;
    }
    if (el.kind === 'combine' && !combinePieces(el, design).length) note(el, `${el.name}: tick the pieces to combine in its card`);
    if (el.kind === 'offset' && !design.elements.some(e => e.id === el.source && e !== el)) note(el, `${el.name}: the element it follows is gone, or none is picked; pick one in its card`);
    const twin = hasTwin(design, el, W, H);
    if (el.kind === 'grip' || el.kind === 'mesh' || el.kind === 'solid' || el.kind === 'surface' || isShapedBody(el)) {
      // a body stands on the face (or on what it is stacked on): it takes the place of any earlier raise inside its
      // footprint from its own bottom up (later wins); a mesh that replaces the face starts at the backer
      if (el.kind === 'solid' && el.stackOn && !tops.has(el.stackOn)) note(el, `${el.name} sits on an element that is hidden or now above it in the stack, so it stands on the ${on ? 'face' : 'backer'}`);
      let made;
      try {
        made = el.kind === 'grip' ? gripSolids(el, size, t) : el.kind === 'mesh' ? meshSolids(el, size, t)
          : el.kind === 'surface' ? surfaceSolids(el, design, size, t, keep, text => note(el, text), leaveOut.get(el.id))
          : SHAPED_KINDS.has(el.kind) ? shapedSolids(el, size, t, keep, text => note(el, text), design) : solidSolids(el, size, t, tops);
      } catch (e) { if (!SHAPED_KINDS.has(el.kind)) throw e; note(el, `${el.name}: ${e.message}`); continue; }   // (a drawing's mistake stays its own)
      // nothing modelled stands past the plate's edge: blocks, grips and meshes are cut there (textures and drawings
      // are built over the part the plate keeps); a cut that cannot close leaves the body whole, and the checks
      // report it
      // (a body wholly past the edge is gone: noted, and kept as drawn for the checks)
      let gone = [];
      if (el.kind === 'grip' || el.kind === 'mesh' || el.kind === 'solid') {
        made = made.map(g => clipSolidToPlate(g, W, H));
        gone = made.filter(g => g.removed);
        made = made.filter(g => !g.removed);
        if (gone.length && !made.length) note(el, `${el.name} lies outside this plate`);
      }
      if (twin) made = made.concat(made.map(mirrorSolid));
      const kept = [];
      for (const g of made) {
        if (P.isEmpty(g.footprint)) { note(el, `${el.name}: the body has no footprint (empty or unreadable)`); continue; }
        layers = carveBody(layers, g);
        solids.push(g);
        kept.push(g);
        tops.set(el.id, Math.max(tops.get(el.id) ?? -Infinity, g.z1));
      }
      const own = kept.filter(g => !g.twin).map(g => g.footprint);
      // what it was drawn as, before the plate cut it, against what the plate kept
      const whole = [...kept.filter(g => !g.twin).map(g => g.unclipped || g.footprint), ...gone.map(g => g.unclipped)];
      drawn.push({ id: el.id, name: el.name, kind: el.kind, body: true, flag: el.kind !== 'surface', stackOn: el.kind === 'solid' ? el.stackOn || '' : '', top: kept.length ? Math.max(...kept.map(g => g.z1)) : 0,
        target: el.kind === 'surface' && el.region === 'element' ? el.target || '' : '', full: whole, clipped: own, placed: own, cover: kept.map(g => g.footprint) });
      continue;
    }
    let parts;
    try { parts = elementParts(el, size, design); } catch (e) { note(el, `${el.name}: ${e.message}`, e.code === 'font-failed' ? 'fail' : 'info'); continue; }
    if (twin) parts = parts.concat(parts.map(pt => ({ ...pt, poly: pt.twinPoly || P.mirrorX(pt.poly, 0), twin: true, note: undefined })));
    const words = el.kind === 'text' ? String(el.text || '').replace(/\s+/g, ' ').trim() : '';
    const rec = { id: el.id, name: el.name, label: words ? `“${words.length > 24 ? `${words.slice(0, 23)}…` : words}”` : '', kind: el.kind, body: false, flag: el.kind !== 'pattern', full: [], clipped: [], placed: [], cover: [] };
    drawn.push(rec);
    // a part that will be drawn: all of it counts as drawn, what the plate left of it as clipped
    const drawnAt = (part, poly) => { if (!part.twin) { rec.full.push(part.poly); if (poly) rec.clipped.push(poly); } };
    const placedAt = (part, poly) => { if (!part.twin) rec.placed.push(poly); rec.cover.push(poly); };
    for (const part of parts) {
      if (part.note) note(el, part.note);
      if (P.isEmpty(part.poly)) continue;
      let poly = P.intersection(part.poly, keep);
      // a pattern's slivers along the plate edge and round the holes: tidied away, thickened or kept (edges.js)
      if (el.kind === 'pattern' && !P.isEmpty(poly)) poly = tidyEdges(poly, { W, H, holes: holeList, keep, op: part.op, mode: el.edges || 'tidy', key: JSON.stringify([el.pattern, el.params, !!el.invert, size.id]) });
      if (P.isEmpty(poly)) { if (!part.twin) note(el, `${part.name} lies outside this plate`); drawnAt(part, null); continue; }
      if (part.op === 'cut') {
        if (!on) { note(el, `${part.name}: a cut needs the face, and the face is switched off (the backer is never cut)`); continue; }
        const depth = Math.max(0, part.depth ?? 0.6);
        if (depth > t + 1e-9) note(el, `${part.name}: cut depth limited to the ${t} mm face (the backer is never cut)`);
        const z0 = Math.max(0, t - depth);
        layers = carve(layers, poly, z0, Infinity);
        drawnAt(part, poly); placedAt(part, poly);
      } else if (part.op === 'inlay') {
        // flush with the face top, in its own colour: the face gives way from (top - depth) to the top, and what
        // stands above the face stays where it is
        if (!on) { note(el, `${part.name}: an inlay sits in the face, and the face is switched off`); continue; }
        const want = Math.max(0.05, part.depth ?? 0.6);
        if (want > t + 1e-9) note(el, `${part.name}: inlay depth limited to the ${t} mm face (the backer is never cut)`);
        const z0 = Math.max(0, t - Math.min(t, want));
        const blocking = solids.filter(s => s.z0 < t - 1e-6);
        const inlayPoly = blocking.length ? P.difference(poly, ...blocking.map(s => s.footprint)) : poly;
        drawnAt(part, poly);
        if (P.isEmpty(inlayPoly)) continue;
        layers = carve(layers, inlayPoly, z0, t);
        layers.push({ poly: inlayPoly, z0, z1: t, color: part.color || design.face.color, kind: el.kind, elementId: el.id, name: part.name, twin: !!part.twin, inlay: true });
        placedAt(part, inlayPoly);
      } else {
        const h = Math.min(FACE_LIMITS.maxRaise, Math.max(0.05, part.height ?? 1));
        // a raise never grows into an earlier body that starts below its top: the body keeps its footprint
        const blocking = solids.filter(s => s.z0 < t + h - 1e-6);
        const raisePoly = blocking.length ? P.difference(poly, ...blocking.map(s => (s.occupies ? s.occupies(t, t + h) : s.footprint)).filter(q => q && q.length)) : poly;
        drawnAt(part, poly);
        if (P.isEmpty(raisePoly)) continue;
        layers = carve(layers, raisePoly, t, t + h);
        layers.push({ poly: raisePoly, z0: t, z1: t + h, color: part.color || design.face.color, kind: el.kind, elementId: el.id, name: part.name, twin: !!part.twin });
        tops.set(el.id, Math.max(tops.get(el.id) ?? -Infinity, t + h));
        placedAt(part, raisePoly);
      }
    }
  }
  layers = layers.filter(L => !P.isEmpty(L.poly) && L.z1 - L.z0 > 1e-6);
  return { layers, solids, keep, plate, holes, holeList, t, faceOn: on, size, notes, drawn, ghosts };
}

/** Flat triangle arrays for every body of a built face: [{ tris, color, name, elementId, kind }]. */
export function faceTriangles(built, extrude) {
  const bodies = built.layers.map(L => ({ tris: extrude(L.poly, L.z0, L.z1), color: L.color, name: L.name, elementId: L.elementId, kind: L.kind }));
  for (const s of built.solids) bodies.push({ tris: s.tris, color: s.color, name: s.name, elementId: s.elementId, kind: s.kind || 'grip' });
  return bodies;
}
