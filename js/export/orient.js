// Print orientation and bed placement for export. The design frame is face-up with the backer's front plane at
// z = 0; a plate is printed either face down (decorated face on the bed: rotate 180 degrees about X, which is
// what the Chevron packaging script did) or face up (backer on the bed: shift up by the backer thickness).

import { BACKER_THICKNESS } from '../data/sizes.js';

/**
 * Transform a flat triangle array in place for printing.
 * orientation: 'down' | 'up'; zTop: the highest z of the face (so a face-down print starts at z = 0).
 * bed: { w, l } puts the plate centre on the bed centre; omit it to keep the plate centred on the origin.
 */
export function orientForPrint(tris, orientation, zTop, bed, offset = { x: 0, y: 0 }) {
  const cx = bed ? bed.w / 2 : 0, cy = bed ? bed.l / 2 : 0;
  if (orientation === 'down') {
    for (let i = 0; i < tris.length; i += 3) {
      tris[i] += cx + offset.x; tris[i + 1] = -tris[i + 1] + cy + offset.y; tris[i + 2] = zTop - tris[i + 2];
    }
    // a 180 degree rotation keeps the winding right-handed, so no triangle flip is needed
  } else {
    for (let i = 0; i < tris.length; i += 3) {
      tris[i] += cx + offset.x; tris[i + 1] += cy + offset.y; tris[i + 2] += BACKER_THICKNESS;
    }
  }
  return tris;
}

export const BEDS = {
  'prusa-coreone-mmu3': { label: 'Prusa CORE One (250 x 220)', w: 250, l: 220, profile: 'assets/profiles/prusa-coreone-mmu3.ini' },
  'prusa-xl-5t': { label: 'Prusa XL 5T (360 x 360)', w: 360, l: 360, profile: 'assets/profiles/prusa-xl-5t.ini' },
  'bambu-256': { label: 'Bambu X1 / P1 / A1 / P2S (256 x 256)', w: 256, l: 256 },
  'bambu-180': { label: 'Bambu A1 mini (180 x 180)', w: 180, l: 180 },
  'bambu-325': { label: 'Bambu H2D / H2C / H2S (325 x 320)', w: 325, l: 320 },
  'generic-220': { label: 'Generic 220 x 220', w: 220, l: 220 },
  'generic-300': { label: 'Generic 300 x 300', w: 300, l: 300 },
};

/** Pick the Prusa profile that fits a plate: Core One for 1W/2W, XL for 3W/4W (as the Chevron files do). */
export function prusaBedFor(size) {
  return (size.w <= 240 && size.h <= 210) ? 'prusa-coreone-mmu3' : 'prusa-xl-5t';
}

/** Does the plate fit the bed, either way round, with 2 mm to spare (a 4W plate is 351 on the XL's 360). */
export function fitsBed(size, bed, clearance = 2) {
  return (size.w + clearance <= bed.w && size.h + clearance <= bed.l) || (size.h + clearance <= bed.w && size.w + clearance <= bed.l);
}
