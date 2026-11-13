// 3MF writers, ported from the GEN2 Classic Pro Label Generator (which was proven in PrusaSlicer, Bambu Studio
// and OrcaSlicer) and the Chevron series' 3MF packaging.
//
// PrusaSlicer layout: ONE mesh object whose parts are triangle ranges listed in Metadata/Slic3r_PE_model.config
// with their extruders, vertices already in bed coordinates, an identity build item, and the full print
// profile in Metadata/Slic3r_PE.config so the file opens as a ready-to-slice project.
//
// Bambu Studio / OrcaSlicer layout: one object per part carrying an extruder metadata, an assembly object
// made of components, and Metadata/model_settings.config naming the parts and their extruders. Those slicers
// never split a mesh by triangle ranges, so the two layouts cannot live in one file.
//
// bodies: [{ name, tris: flat xyz array (bed coordinates, z >= 0), extruder (1-based) }]

const JSZipLib = () => {
  const z = globalThis.JSZip;
  if (!z) throw new Error('JSZip is not loaded');
  return z;
};

export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>`;

/** Index a flat triangle array into unique vertices (exact match), returning { verts: [[x,y,z]], tris: [[a,b,c]] }. */
export function indexTriangles(tris) {
  const map = new Map(), verts = [], out = [];
  const idx = (x, y, z) => {
    const k = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    let i = map.get(k);
    if (i === undefined) { i = verts.length; map.set(k, i); verts.push([x, y, z]); }
    return i;
  };
  for (let i = 0; i < tris.length; i += 9) {
    const a = idx(tris[i], tris[i + 1], tris[i + 2]), b = idx(tris[i + 3], tris[i + 4], tris[i + 5]), c = idx(tris[i + 6], tris[i + 7], tris[i + 8]);
    if (a === b || b === c || a === c) continue;
    out.push([a, b, c]);
  }
  return { verts, tris: out };
}

function meshXml(verts, tris, vOff = 0) {
  let vx = '', tx = '';
  for (const v of verts) vx += `<vertex x="${v[0].toFixed(4)}" y="${v[1].toFixed(4)}" z="${v[2].toFixed(4)}"/>`;
  for (const t of tris) tx += `<triangle v1="${t[0] + vOff}" v2="${t[1] + vOff}" v3="${t[2] + vOff}"/>`;
  return { vx, tx };
}

export async function buildPrusa3MF({ bodies, name, profileIni, application = 'MODULITH Faceplate Customizer (PrusaSlicer 3MF)' }) {
  let vx = '', tx = '', vOff = 0, tOff = 0;
  let config = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n  <metadata type="object" key="name" value="${escapeXml(name)}"/>\n`;
  for (const b of bodies) {
    const m = indexTriangles(b.tris);
    if (!m.tris.length) continue;
    const x = meshXml(m.verts, m.tris, vOff);
    vx += x.vx; tx += x.tx;
    config += `  <volume firstid="${tOff}" lastid="${tOff + m.tris.length - 1}">\n` +
      `   <metadata type="volume" key="name" value="${escapeXml(b.name)}"/>\n` +
      `   <metadata type="volume" key="volume_type" value="ModelPart"/>\n` +
      `   <metadata type="volume" key="extruder" value="${b.extruder}"/>\n  </volume>\n`;
    vOff += m.verts.length; tOff += m.tris.length;
  }
  config += ' </object>\n</config>\n';
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">${escapeXml(application)}</metadata><metadata name="Designer">Jerrari3D</metadata>` +
    `<metadata name="Title">${escapeXml(name)}</metadata><metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>` +
    `<resources><object id="1" type="model"><mesh><vertices>${vx}</vertices><triangles>${tx}</triangles></mesh></object></resources>` +
    `<build><item objectid="1"/></build></model>`;
  const zip = new (JSZipLib())();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('3D').file('3dmodel.model', modelXml);
  const meta = zip.folder('Metadata');
  meta.file('Slic3r_PE_model.config', config);
  if (profileIni) meta.file('Slic3r_PE.config', profileIni);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function buildBambu3MF({ bodies, name, application = 'MODULITH Faceplate Customizer' }) {
  const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  let resources = '', comps = '', settings = `<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="1000"><metadata key="name" value="${escapeXml(name)}"/>`;
  let id = 1;
  for (const b of bodies) {
    const m = indexTriangles(b.tris);
    if (!m.tris.length) continue;
    const x = meshXml(m.verts, m.tris, 0);
    resources += `<object id="${id}" type="model" p:UUID="${uuid(id)}"><metadata name="name">${escapeXml(b.name)}</metadata><metadata name="extruder">${b.extruder}</metadata>` +
      `<mesh><vertices>${x.vx}</vertices><triangles>${x.tx}</triangles></mesh></object>`;
    comps += `<component objectid="${id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`;
    settings += `<part id="${id}" subtype="normal_part"><metadata key="name" value="${escapeXml(b.name)}"/><metadata key="extruder" value="${b.extruder}"/></part>`;
    id++;
  }
  resources += `<object id="1000" type="model" p:UUID="${uuid(1000)}"><metadata name="name">${escapeXml(name)}</metadata><components>${comps}</components></object>`;
  settings += '</object></config>';
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">` +
    `<metadata name="Application">${escapeXml(application)}</metadata><metadata name="Designer">Jerrari3D</metadata>` +
    `<metadata name="Title">${escapeXml(name)}</metadata><metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>` +
    `<resources>${resources}</resources><build><item objectid="1000" transform="1 0 0 0 1 0 0 0 1 0 0 0" p:UUID="${uuid(2000)}"/></build></model>`;
  const zip = new (JSZipLib())();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('3D').file('3dmodel.model', modelXml);
  zip.folder('Metadata').file('model_settings.config', settings);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
