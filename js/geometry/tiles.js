// Tiles you draw yourself, for the linked patterns. A tile is a cell of the wall grid with fixed PORTS on its edges
// (the edge midpoints, or two per edge at the thirds) and LINKS that join two ports with a band. Every path leaves a
// port square to its edge, so where a cell's path ends, the neighbouring cell's path (on this plate or the next)
// carries straight on at the same point, the same width and the same direction. That is the whole guarantee: any
// mix of tiles, any seed, any quarter-turns, and the lines still meet across plates. A port no link uses is an open
// end; the editor shows it, and it simply ends there.
//
// Unit square: u from 0 (left) to 1 (right), v from 0 (bottom) to 1 (top). Ports are numbered clockwise from the
// top-left, so turning a tile a quarter clockwise just adds one edge's worth to every port number.

export const PORT_SETS = {
  mid: [[0.5, 1], [1, 0.5], [0.5, 0], [0, 0.5]],
  thirds: [[1 / 3, 1], [2 / 3, 1], [1, 2 / 3], [1, 1 / 3], [2 / 3, 0], [1 / 3, 0], [0, 1 / 3], [0, 2 / 3]],
};
const PER_EDGE = { mid: 1, thirds: 2 };
const INWARD = [[0, -1], [-1, 0], [0, 1], [1, 0]];   // top, right, bottom, left
export const MAX_TILES = 8, MAX_LINKS = 16;
export const TILE_STYLES = [['curve', 'Curve'], ['straight', 'Straight']];

export const portSet = name => (name === 'thirds' ? 'thirds' : 'mid');
export const portCount = set => PORT_SETS[portSet(set)].length;
export const portEdge = (set, i) => Math.floor(i / PER_EDGE[portSet(set)]);
export const rotatePort = (set, i, quarters) => (i + quarters * PER_EDGE[portSet(set)]) % portCount(set);

// numbers from a file: only a number or a numeric string counts (Number() on an object can throw: {"toString": null})
const numeric = v => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
const clamp = (v, a, b, d) => { const n = numeric(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d; };

/**
 * A tile list from anywhere (a design file someone sent, an old version) made safe: at most MAX_TILES tiles of at
 * most MAX_LINKS links, each link two different port numbers that exist in this port set, no link twice.
 */
export function normTiles(raw, set) {
  const n = portCount(set);
  return (Array.isArray(raw) ? raw.slice(0, MAX_TILES) : []).map(t => {
    const seen = new Set(), links = [];
    for (const l of Array.isArray(t?.links) ? t.links : []) {
      if (!Array.isArray(l) || l.length !== 2) continue;
      const a = Math.trunc(numeric(l[0])), b = Math.trunc(numeric(l[1]));
      if (!(a >= 0 && b >= 0 && a < n && b < n) || a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key); links.push([a, b]);
      if (links.length >= MAX_LINKS) break;
    }
    return { links, style: t?.style === 'straight' ? 'straight' : 'curve', dot: clamp(t?.dot, 0, 0.6, 0), weight: clamp(t?.weight, 0, 9, 1) };
  });
}

/** Ports no link uses (they end in an open end where a neighbour's line arrives). */
export function openPorts(tile, set) {
  const used = new Set(tile.links.flat());
  return [...Array(portCount(set)).keys()].filter(i => !used.has(i));
}

/**
 * The centre line of one link in a cell of cw x ch mm with its bottom-left corner at (x0, y0): points in mm, plus
 * which edge each end sits on. A curve is a cubic Bezier whose ends leave square to their edges (two adjacent
 * midpoints make a quarter circle, two opposite ones a straight line, two ports on one edge a U-turn); a straight
 * link is the chord between its ports.
 */
export function linkLine(set, a, b, style, x0, y0, cw, ch, steps = 20, w = 0) {
  set = portSet(set);
  const [ua, va] = PORT_SETS[set][a], [ub, vb] = PORT_SETS[set][b];
  const ea = portEdge(set, a), eb = portEdge(set, b);
  const A = [x0 + ua * cw, y0 + va * ch], B = [x0 + ub * cw, y0 + vb * ch];
  if (style === 'straight' && ea !== eb) {
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
    return { pts: [A, B], ea, eb, da: u, db: u };
  }
  const na = INWARD[ea], nb = INWARD[eb];
  // Each end's control arm runs along its own edge's normal, sized by how far the other end lies along that axis:
  // two ports on adjacent edges make a true quarter ellipse about the corner, ports on opposite edges a straight line
  // or a gentle S, and every arm stays inside the cell, so a curve never leaves it except at its ports (an arm sized
  // by the chord, on a flat cell, dipped through the cell below). A U-turn between two ports on one edge is a half
  // circle, flattened only as far as the cell's depth needs (a shallower U folds the band back over the edge).
  let ka, kb;
  if (ea === eb) {
    // the band, not just its centre line, stays in the cell: its depth (0.75 k) plus half the width under 95 %
    const along = Math.hypot(B[0] - A[0], B[1] - A[1]), depth = na[0] ? cw : ch;
    ka = kb = Math.min((2 / 3) * along, Math.max(0.05, (0.95 * depth - w / 2) / 0.75));
  } else {
    ka = 0.552 * Math.abs(na[0] ? B[0] - A[0] : B[1] - A[1]);
    kb = 0.552 * Math.abs(nb[0] ? A[0] - B[0] : A[1] - B[1]);
  }
  const P1 = [A[0] + na[0] * ka, A[1] + na[1] * ka], P2 = [B[0] + nb[0] * kb, B[1] + nb[1] * kb];
  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, m = 1 - t;
    pts.push([
      m * m * m * A[0] + 3 * m * m * t * P1[0] + 3 * m * t * t * P2[0] + t * t * t * B[0],
      m * m * m * A[1] + 3 * m * m * t * P1[1] + 3 * m * t * t * P2[1] + t * t * t * B[1],
    ]);
  }
  // the exact directions at the ends: a curve leaves A along A's inward normal and arrives at B along B's outward
  // normal. The band's cross-section at a port is set from these, not from the first sampled chord, so it is exactly
  // the port +/- w/2 along the edge whatever tile it belongs to (a sharp bend made the sampled one tilt)
  return { pts, ea, eb, da: [na[0], na[1]], db: [-nb[0], -nb[1]] };
}

/**
 * A band of width w along a link's centre line, as one ring of points. Each end is cut along its cell edge and run
 * `join` mm past it, so it overlaps the neighbour's band instead of meeting it edge to edge (which the clipper
 * handles badly), and an angled straight link meets its neighbour in a clean mitre.
 */
export function bandRing(line, w, x0, y0, cw, ch, join) {
  const pts = line.pts, n = pts.length;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    let dx, dy;
    if (i === 0 && line.da) [dx, dy] = line.da;
    else if (i === n - 1 && line.db) [dx, dy] = line.db;
    else { const p = pts[Math.max(0, i - 1)], q = pts[Math.min(n - 1, i + 1)], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; dx = (q[0] - p[0]) / L; dy = (q[1] - p[1]) / L; }
    const nx = -dy * w / 2, ny = dx * w / 2;
    left.push([pts[i][0] + nx, pts[i][1] + ny]); right.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  // the edge line through an end, moved `join` mm outward (away from the cell)
  const edgeLine = e => (e === 0 ? { axis: 1, at: y0 + ch + join } : e === 2 ? { axis: 1, at: y0 - join } : e === 1 ? { axis: 0, at: x0 + cw + join } : { axis: 0, at: x0 - join });
  const cut = (side, end, e) => {
    const i = end ? n - 1 : 0, j = end ? n - 2 : 1, a = side[i], b = side[j], E = edgeLine(e);
    const da = a[E.axis] - b[E.axis];
    if (Math.abs(da) < 1e-9) return;                       // runs along the edge: leave it
    const t = (E.at - b[E.axis]) / da;
    side[i] = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t];
  };
  for (const side of [left, right]) { cut(side, false, line.ea); cut(side, true, line.eb); }
  // Held to the cell (and `join` past it): on a flat cell the inner side of a tight curve can rise over an edge near
  // a port, which would lay band into the neighbouring cell where no port is. Pulling every point back onto the cell
  // keeps a band in its own cell everywhere except the ports.
  const lo = [x0 - join, y0 - join], hi = [x0 + cw + join, y0 + ch + join];
  return [...left, ...right.reverse()].map(([x, y]) => [Math.min(hi[0], Math.max(lo[0], x)), Math.min(hi[1], Math.max(lo[1], y))]);
}

/** Starting sets for the editor. */
export const TILE_PRESETS = {
  arcs: { label: 'Arcs', ports: 'mid', tiles: [{ links: [[0, 3], [1, 2]] }, { links: [[0, 1], [2, 3]] }] },
  circuit: { label: 'Circuit', ports: 'mid', tiles: [{ links: [[0, 3], [1, 2]] }, { links: [[0, 1], [2, 3]] }, { links: [[0, 2], [1, 3]], weight: 0.6, dot: 0.25 }] },
  angles: { label: 'Angles', ports: 'mid', tiles: [{ links: [[0, 3], [1, 2]], style: 'straight' }, { links: [[0, 1], [2, 3]], style: 'straight' }] },
  braid: { label: 'Braid', ports: 'thirds', tiles: [
    { links: [[0, 7], [1, 2], [3, 4], [5, 6]] },
    { links: [[0, 5], [1, 4], [2, 7], [3, 6]] },
    { links: [[0, 1], [2, 3], [4, 5], [6, 7]], weight: 0.5 },
  ] },
};

export function presetTiles(name) {
  const p = TILE_PRESETS[name] || TILE_PRESETS.arcs;
  return { ports: p.ports, tiles: normTiles(p.tiles, p.ports) };
}
