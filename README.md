# MODULITH Faceplate Customizer

A browser tool for designing custom decor faceplates on the MODULITH **Essential** backer, and
exporting them ready to slice. Static files, no build step, no account: the same shape as the planner
and the label generators.

## Run it

```bash
python serve.py
```

then open http://localhost:8765/. ES modules need http, so `file://` will not work. Tests:

```bash
npm test
```

## Live site

https://faceplates.modulith.systems/ is GitHub Pages serving the `main` branch of
`Jerrari12/modulith-faceplate-customizer` as it is: no build, and `.nojekyll` keeps Pages from processing
anything. `CNAME` holds the address; its DNS record is a CNAME to `jerrari12.github.io` in the
modulith.systems zone on Cloudflare, DNS only, like the Planner's and Label Studio's. A change goes live
when it is pushed to `main`, and only then, so run `npm test` first. Pages serves files case-sensitively,
where Windows does not, so a path has to match its file's case exactly.

## What it does

- **Every plate is the real Essential backer** (4.2 mm, with the drawer clips and compliant mechanisms),
  extracted from the Essential v2602 STLs into `assets/backers/*.bin`, plus a face the tool generates
  on top. Nothing ever cuts below the backer's front plane.
- **Two design modes.** *Face Down* prints the decorated face on the bed like the Essential and Chevron
  plates: cuts and grooves only, recesses must be narrow enough to bridge. *Face Up* prints the backer
  on the bed: raised relief, grips and tabs, with overhang and support checks.
- **The face slab is optional.** Switch the Essential face off and the bare backer is the clean slate:
  everything stands on it, nothing can be cut, and the backer's own two screw holes stay open.
- **Handle mount**: the bolt-on handle's two M3 holes, one centre **knob** hole, or none (the face covers the
  holes, for a grip or blocks that are the handle). Adding a grip closes the bolt-on holes. The knob needs a
  reworked backer that is not made yet, so the checks hold a knob design back as a problem.
- **Flush with an edge.** A grip, a solid block or a shape can sit flush with the top or bottom edge of the plate,
  its outer side in line with the plate's on every size; Offset X slides it along the edge (dragging on the 2D
  stage does too), and a grip turns so its flush side faces the edge. The Lip pull tile adds one on the top edge.
  A full-width grip has nothing to slide along: it stays centred side to side, and Offset X is hidden while it is on.
- **Raise, cut or inlay.** Every flat element (a pattern, a shape, text, a picture, each colour layer of SVG art) can stand
  proud of the face, be cut into it, or be **inlaid**: set flush into the face in its own filament, a multicolour
  print that works face down (the colours are the first layers on the bed) or face up. New shapes, text and art
  start as inlays on a face-down design with its face on, and stand proud otherwise; new patterns start there as
  cuts (grooves in one filament, like the series' face-down plates).
- **Fills.** A shape, text or SVG art can be filled with a **texture** (any pattern that is not linked to the wall
  grid) inside a solid **border**, or be just its **outline** (outlined lettering). The texture lives in the
  element's own frame, so it moves, turns and mirrors with it; pieces the outline clips too small to print go.
  Borders come from a raster offset of the outline (about 0.02 mm accurate).
- **3D textures** (Face Up only). A real relief lifted off the surface, in the manner of displacement tools such
  as BumpMesh: crystal, pebbles, noise, hammered, knurl, hex domes, weave, bricks, wood, ripples, or your own
  greyscale **picture** (white high; stretched over the area or repeated). It covers the whole face, a shape of
  its own, or the outline of another element (letters, a shape, art), where it stands in place of any raised
  relief. Feature size, texture height, a base thickness under it, turn, seed and invert are set per texture,
  and the card says how high the whole thing stands (base plus texture height). The textures
  with edges (crystal, pebbles, bricks, hex domes, knurl, weave, and fluted, reeded, studs, dimples, scales,
  tumbling blocks and diamond tread plate) are built from exact cells, so their cliffs and creases are sharp
  straight edges and the area's outline is followed exactly; crystal facets are flat planes, pebbles and hex domes
  rounded pillows. The smooth ones (noise, hammered, wood, ripples, a picture) are sampled on a 0.25, 0.4 or 0.6 mm
  grid (Detail), which also sets how finely the pillows and strands are stepped. Each texture has a **Shape**
  section of its own: irregularity (an even honeycomb to wild), facet tilt, gaps between cells, profiles (dome,
  cone, mesa, dimple; round, V or flat beads), height variation, the knurl's groove angle and flat tops, five
  brick bonds (running, third, stacked, herringbone, basket weave) in three lengths, strands per weave block.
  **Terraces** snap the relief to flat steps of a set height (0.2 mm matches a 0.2 mm layer), a topographic look on
  any texture. An **edge** frames it: a flat border at its base or a raised rim at its top. **Cell colours** give
  the cells (a stone, a brick, a scale, a block's face) up to three more filaments, at random or by height; a
  smooth texture is coloured in height bands. A **tip colour** prints the peaks above a set height in another
  filament. Every colour is its own body in the download. Blocks, grips and meshes keep their footprints clear,
  and a later texture takes its own area from an earlier one, so no two bodies fill the same space.
- **Elements**, applied in order (later wins): repeating **patterns** (stripes, chevron in four layouts
  including two seamless slants, grid, dots, bricks, hex, checker, and the fine **textures** knurl, ripples,
  wood grain and stipple) with plate-centre or top-left-corner
  anchoring and a pattern offset that slides it inside its area (stripes start as horizontal ribs 3 mm every 7 mm with a gap on the centre line,
  which lands every top and bottom edge in a gap on every size and lines the ribs up across plates stacked
  on the 56 mm grid); where a pattern meets the plate edge or a screw hole, its **thin bits at the edges**
  (slivers under the 0.8 mm minimum running along the edge, crumbs, and for a cut or an inlay thin walls of
  face left against the edge) are tidied away by default, or thickened to 0.8 mm, or kept as drawn; **linked patterns** (Truchet-style tiles and waves) drawn on the wall's own
  88 x 56 mm grid, whose lines always leave a plate where its neighbour's arrive, on any size and any seed;
  **your own tiles**, drawn in the **tile editor**: join points on a tile's edges (the midpoints, or two per
  edge at the thirds) with curved or straight lines, add a centre dot, weight how often each tile appears,
  and let cells turn their tile at random. Every line meets its edge square at a fixed point, so any mix of
  drawn tiles still joins up across plates; a four-plate preview with four seeds shows it;
  **solid blocks** (box, cylinder, taper, dome, pyramid, wedge) with square, chamfered or rounded top edges
  that stack on each other, so a handle can be built from simple pieces; **text** in seven open-licence
  fonts (Archivo, IBM Plex Sans and Mono, Fredoka, Bitter, Bungee, Pacifico), sized by its capital height,
  on several lines, aligned, spaced and bent round an arc; **pictures** (PNG, JPG, WebP), kept in the design as
  greyscale at up to 256 px and split into one to six tones by brightness: raised in steps (a stepped relief),
  cut in steps, or inlaid with each tone in its own filament, with Balance, Smoothing and a smallest piece to
  shape them (the anti-aliased halo round a logo's edge is merged into the ink, not left as a thin ring);
  **shapes**;
  **SVG art** imported as one layer per fill colour; **grips** (bar, wedge and ledge with 45°
  undercuts, dome, the **lip pull**: a bar on the plate's edge with a finger pocket under its lip, and the
  **arch pull**: a bar on two legs over a 45° pointed arch, the face-up answer to a U pull, and the series' own
  **Classic Pro** and **Classic** grips, rebuilt from the shipped models: a full-width hood along the top edge with
  its finger pocket, leaning ends and an accent strip in a second colour; and **EdgeLabel**'s corner hood, in the top
  right or top left, with a second hood 176 mm along on 3W and 4W as the series ships it) for Face Up designs,
  each with ends square, angled or rounded in plan, ends that lean in as they rise, and chamfered top edges, all
  kept to what prints without support (undercuts at 45° or less, short bridges, checked); relief keeps going under
  a grip wherever the grip has no material at its height (under an undercut, a lip's pocket, an arch). Each grip's
  card says how sturdy it is where it meets the face, and Make it sturdy finds the smallest fix; **meshes** (STL or OBJ, e.g. a Nomad Sculpt relief) scaled to a
  width, oriented by their up axis, standing on the face or replacing it, with their footprint traced for the
  checks and their undersides measured for overhangs.
- **Placing things**: a 3 x 3 slot grid puts an element 3 mm in from the edges it names (or on the handle
  line) and keeps it there on every size; dragging snaps to the centre lines, quarters, edges, the handle
  line and the other elements, with guides (Alt drags free); **symmetry** mirrors every placed element
  across the centre line.
- **Filaments, not RGB**: each colour slot is a filament from the planner's catalogue (copied from the
  planner), with its shop link and the planner's disclosure line, or a custom colour.
- **All 18 sizes at once**: 1W to 4W by 0.5H to 3H (no 3W-3H or 4W-3H). The Wall view shows the
  neighbouring plates on the 88 x 56 mm pitch so you can see a pattern run across drawers.
- **Print checks** in the sign-builder style: screw holes and handle seat, bridges and recesses,
  floating or unsupported features, thin features and closing gaps, grip undercut angles, height,
  bed fit, and anything you will not see: an element half or more under another (a label under a hood on the
  0.5H plates, a grip buried in a taller one) or off a smaller plate warns on that size. Pattern and shape widths are checked exactly from their parameters; a text's thinnest stroke is
  measured on each glyph (the narrowest width at which a stroke would break, which tapered ends and sharp
  corners do not count as); every inlaid colour's pieces are measured on their own, since each prints by
  itself; everything else is measured on a 0.1 mm raster with a distance transform. A too-thin sliver lying
  along the plate edge or a hole (where a pattern meets it) is noted, not failed: losing it changes nothing
  visible. A thin line that crosses the edge still fails.
- **Export** per size or all enabled sizes zipped: PrusaSlicer 3MF (multi-part by colour, element or
  piece, with the Chevron series' Core One / XL profiles embedded), Bambu Studio / OrcaSlicer 3MF,
  or STL. Colour slots map to extruders in the order of the Style tab's Colours list; the backer is
  always extruder 1. The export settings are remembered in this browser, and the first download from the dock
  says how the files will be made (slicer, printer, which side prints down, colour slots, what is in it) with the
  slicer and printer changeable right there, until "Don't ask again". Under the sizes, *In the slicer* gives
  four steps for the chosen format (open it, check or pick the profiles, match the filaments to the colour list,
  and look at the layers where the decorated face prints); the first-download card carries them folded.
- **Designs are small JSON files** (`*.faceplate.json`): parameters, not meshes. They autosave in the
  browser as you work, and are the unit of sharing. Starting or opening another design keeps the open one in
  this browser's list first (an empty one, or the untouched sample, is not kept), so nothing is lost by
  switching; entries are told apart by identity, so two designs that share a name are both kept. A design file
  is also dropped into every "Download all" zip.
- **Version history** (design menu; after Erie Sign Studio's): every change is kept in this browser, folded
  into 10-minute steps; after two weeks one step a day is kept, after three months one a week, 200 at most.
  Ctrl+S saves a version that is kept until you delete it, and so is every download (the exact design each
  file was made from, under the file's name). Pick a version to see it drawn, then bring it back (one undo step:
  Ctrl+Z returns to what was open), open it as a copy, save it as a design file, keep it under a name, or delete
  it. The picker reaches the history of every design this browser has held, including ones removed from the
  list. It lives in IndexedDB, with pictures and meshes stored once however many versions hold them.
- **One design, every size, each size free to differ** (after Erie Sign Studio's sign types and signs): the
  design is the master, and the inspector's **Change for** switch sends an edit to **Every size** or **Only**
  the size shown (a drag on the stage follows the same switch). A setting a size changed for itself is marked
  with a badge ("4W-1H only ×", click to make it follow every size again), a "+N sizes" note says where else
  it differs, and the size's card in All sizes shows how many it has ("2 own"). Numbers, choices, switches and
  text can differ per size; colours, fills, fonts, the slot or edge an element is placed on, a drawing's
  points and form, and a texture's own settings are the same on every size. A value equal to what the size would get anyway is not kept as its
  own, so a sideways drag does not pin the height.
- **Formulas in number fields**: type `=W-20` and it is worked out on every size (W and H are the plate's
  width and height in mm), kept inside the setting's range, with what it comes to shown beside the field.
  `+ - * /`, brackets, and min, max, round (to a step: `round(W/3, 0.5)`), floor, ceil, abs and clamp. A
  mistake is marked as you type and said in words; nothing changes until the formula is whole. The formula is
  parsed by hand (no eval), so a design file from anyone can carry one safely. Each size is built, checked and
  exported from what it really uses.
- **Draw your own shapes** (after Erie Sign Studio's pen): **Draw** in the library, then click for corners and
  press and drag for curves; click the first point to close a shape, or the last one again (or Enter) to end a
  line; Backspace takes a point back, Esc stops. Points snap to 0.25 mm (1 mm with Shift, free with Alt). On a
  selected drawing, drag its points and handles (Alt bends one handle alone), double-click a point to make it a
  corner or a curve, double-click the line to add a point, Delete removes the chosen one, and the inspector types
  its X and Y. A closed drawing is **Filled** or a **Wall** of a set thickness inside its outline (a path that
  crosses itself fills every lobe); an open one is a **Line** of a set thickness with round or flat ends. Like a
  shape it raises, cuts or inlays.
- **Tapered extrude**: raise a drawing (up to 30 mm) with a **Taper angle** and every side leans in by that
  angle as it rises, as Fusion's tapered extrude does; the card says how far in the top edge stands. Where the
  sides meet before the full height (a thin arm, a line) they meet in a ridge instead of failing, so a tapered
  line is a sharp rib. It prints face up; it leans in only, since an outward lean is an overhang. It is built
  crisp: every side is one flat face, and every crease (a hip where two sides meet, a ridge, the line where a
  chamfer starts) is a sharp edge exactly where the sides meet, worked out from the outline's exact distance. On
  the rare drawing that cannot be built that way, it falls back to a height field on the 3D textures' grid mesher
  (facets of about 0.25 mm), still a closed body.
- **Top edges on a drawing**: a raised drawing's top edge can be **Square**, a 45° **Chamfer** or **Round**, with
  an edge size (a round's radius, held under the height), on straight or tapered sides, as a block's can. The
  round meets the side and the top smoothly; a side already leaning past 45° leaves a chamfer nothing to cut, and
  the card says so. A shaped top makes it print face up, like a taper.
- **Combine** (after Erie Sign Studio's booleans): select an element, then **Combine**, and tick the other pieces
  in its card: **Join** makes them one, **Cut away** cuts every other piece out of the first (a panel with a
  window, or a pattern with a clear area), **Overlap** keeps only where they all overlap. Pieces can be shapes,
  text, drawings, SVG art, pictures, patterns, and other combines and outlines. They stop printing on their own
  and show dashed on the drawing, where a piece is moved and edited by its dashed edge; a hidden piece is left out,
  and **Make first** picks what the others cut into. Dragging the combine itself moves it whole: every piece with a
  place moves by the same amount, through combines inside it (a pattern stays put), in one undo step, snapping
  and following **Change for** like any drag. The combine builds as a drawing does (raise, cut or inlay, a taper, top
  edges).
- **Outline** (after Erie's linked offsets): select an element, then **Outline**: a band round it (a border or a
  halo, under it in the stack and in another colour where there is one) or the shape grown or shrunk, at a distance from -20 to
  20 mm. It follows that element through every edit, on every size, its symmetry twin included; that element still
  prints, and if it is hidden the outline stays on its own. Dragging the outline moves the element it follows. It
  builds as a drawing does too.
- **Nothing modelled stands past the plate's edge**: relief, textures and drawings are built only over what the
  plate keeps, and blocks, grips and imported meshes are cut by the plate's sides with a flat cap, flush with the
  edge and still closed (the tests check every edge is shared; a cut block reads manifold in PrusaSlicer). One
  wholly off the plate is left out with a note, and the checks still say when most of something runs off a size.
- **A new faceplate starts with how it prints**: blank face down, blank face up, or the chevron sample (or a
  design file). A first visit opens on that choice, with the sample behind it.

## The workspace

The shell is the MODULITH planner's, so the two tools feel like one product: a full-window stage under
floating glass panels, Day Grid and Night Grid themes, Archivo, IBM Plex Sans and IBM Plex Mono, and
Phosphor icons. Orange marks only the selection and the primary action.

- **Top bar**: the design switcher (rename, save or open a design file, start a new one, version history, and
  your other designs in this browser), the Design / All sizes / Export tabs, the print chip (Face down or Face up), and the
  light / dark toggle.
- **Library**, on the left: *Elements* (add tiles and the stack, top prints last), *Style* (whatever
  applies to the whole design: print mode, face thickness and colour, handle holes, colour slots), and
  *Sizes* (the 18 plates drawn to scale, with an export tick and a check dot on each).
- **Inspector**, on the right: the selected element only, the planner's "This unit only" card. It hides
  when nothing is selected. The everyday settings come first; fine-tuning (seeds, spacing and arc, chamfers and
  lean, smoothing, pattern origin and pattern offset) waits under **More settings**, which says how many of them were
  changed. A seeded pattern or texture has Shuffle by its title. The series' grips say which parts of them are
  fixed, and the handle mount on a grip's card is marked as a whole-design setting.
- **Toolbar** over the stage (3D or 2D, wall, grid, dimensions, issue markers, fit, undo and redo) and the
  **dock** below it: the print-check status (which opens the check card), the size and its dimensions,
  and the Download button. It downloads this size in Design, and every ticked size elsewhere; there the status
  speaks for every ticked size ("4 of 18 with warnings"), and its card lists the sizes that need a look. A
  size with nothing to flag reads **Checks pass**, not "prints clean": the card says what the checks look at
  (widths, gaps, overhangs, bridges, screw holes, the handle seat, grip strength, hidden parts) and that they
  cannot see the slicer settings or the filament, so the sliced layers are still worth a look.
- **Tablets and phones** (below 1024 px): the panels stack under the stage and the page scrolls. The top bar keeps
  the design switcher (its name shortened to fit) over the tabs; on phones (below 640 px) the print chip shows
  its icon only, light / dark is one button, the menus span the screen, and the dock is two rows (the check
  status and size over a full-width Download; the plate's millimetres are on the drawing). Nothing is wider than
  the screen, checked at 360, 390, 768 and 1100 px.
- **Setting names.** Anything's height out of the face is **Stands out** (raised relief, grips, blocks);
  **Height** is only ever a size down the plate. A grip is Length by Width by Stands out; a tapered block's
  **Top-to-base ratio** says the base and top it makes in mm; a sculpt's **Face under it** is Kept or Replaced;
  a fill's rim is **Outline width** for an outline and **Border width** round a texture.

`css/tokens.css` is a verbatim copy of the planner's tokens (modulith-planner main `55a849b`): re-copy
it, never edit it. Panels that rebuild on every commit draw through `panelRenderer` in
`js/ui/controls.js`, and every control carries a `data-k`. Together these keep the keyboard where it was
and stop a rebuild from swallowing the click that caused it.

## Geometry facts the tool is built on

Measured from the Essential v2602 STLs on 2026-11-05 (see `assets/sizes.json`):

| what | value |
|---|---|
| Plate widths (1W..4W) | 87, 175, 263, 351 mm (pitch 88 per cell) |
| Plate heights (0.5H..3H) | 27.15, 55, 83, 111, 167 mm (pitch 56 per cell) |
| Essential face slab | 0.8 mm on a 4.2 mm backer (5.0 total); the Chevron uses a 2 mm face |
| Handle screw holes | Ø3.2 through face and backer at x = ±22 mm, y = -0.5 mm (-0.42 on 0.5H plates) |
| Corners | square |
| Frame | face-up: x right, y up, z out of the face; backer front plane at z = 0 |

## Layout

```
index.html, css/app.css        the workspace shell
css/tokens.css, css/fonts.css  the planner's design tokens and font faces (copied, not edited)
fonts/, img/, icons/           Archivo and IBM Plex (OFL), the MODULITH wordmark, the Phosphor sprite
fonts/text/                    the text element's TrueType fonts and their licences (OFL, unchanged)
js/app.js                      boot and wiring: top bar, workspaces, toolbar, imports, keys
js/state.js                    design, selection, undo, build cache, local storage
js/variants.js                 per-size overrides and formulas: a size's value, the design a size is built from, writes
js/expr.js                     the formula parser (W, H, + - * /, min, max, round, floor, ceil, abs, clamp; no eval)
js/history.js                  version history: fold and thin rules, IndexedDB (memory fallback), shared blobs
js/ui/historyview.js           the Version history panel: list, drawing, restore, copy, keep, delete
js/data/sizes.js               the 18 sizes (generated from assets/sizes.json)
js/geometry/polys.js           polygon helpers over polygon-clipping
js/geometry/patterns.js        repeating pattern generators
js/geometry/edges.js           a pattern's slivers along the plate edge and the holes: tidied, thickened or kept
js/geometry/face.js            design + size -> layers and grip solids (the 2.5D builder)
js/geometry/extrude.js         polygons -> closed triangle soups
js/geometry/backer.js          the fixed backer meshes
js/checks/raster.js            rasteriser, distance transform, components
js/checks/checks.js            the print checks
js/export/threemf.js, stl.js   writers; orient.js for print orientation and beds; design.js for files
js/ui/stage2d.js, stage3d.js   the 2D stage (SVG) and the 3D stage (three.js)
js/ui/pen.js                   the pen: drawing on the 2D stage, editing a drawing's points and handles
js/ui/leftpanel.js             the library: Elements, Sizes; stylepane.js is its Style tab
js/ui/inspector.js             the selected element's card
js/ui/checksui.js              the dock and the check card
js/ui/sizesview.js, exportview.js   the All sizes and Export workspaces
js/ui/controls.js              steppers, tracks, swatches, panelRenderer and keepFocus
js/ui/snapping.js              magnetic snapping lines for dragging on the 2D stage
js/ui/filamentpicker.js        the filament picker; shoplinks.js carries the planner's disclosure rule
js/geometry/solids.js          solid blocks: lofted, chamfered or rounded, stacked; symmetry twins
js/geometry/path.js            drawings: Bezier paths flattened, filled, walls and lines (square or round ends), the taper
js/geometry/roof.js            the crisp taper: flat faces and sharp creases from the outline's sides and inside corners
js/geometry/clip.js            the plate's edge cutting a body: plane cuts with closed caps, and the taper's clamp
                               (combine and outline live in face.js: outlineOf, derivedOutline, consumedIds)
js/geometry/grips.js           every grip: closed mesh, footprint, contact base, undercut and bridge, material by height
js/geometry/hoods.js           the series' Classic Pro and Classic grips, as measured off the shipped models
js/geometry/cornerhood.js      the series' EdgeLabel corner hood: the measured planes, the pocket cut out of them
tools/compare-shipped-grips.mjs  slices the shipped Classic models and the rebuild alike and reports where they differ
js/geometry/tiles.js           drawn tiles: edge points, curves, cleaning a tile list from a file, presets
js/geometry/text.js            text: font loading, layout, glyph outlines (nonzero fill), the arc, stroke widths
js/geometry/image.js           pictures: greyscale storage, tones by marching squares, thin-band merging, nesting
js/geometry/fill.js            texture and outline fills in an element's own frame; offset.js grows or shrinks outlines
js/geometry/heightmaps.js      3D texture height maps: procedural (seeded noise, Voronoi, knurl...) and pictures
js/geometry/surface.js         3D texture bodies: the grid mesher (marching squares) and the exact mesher for cells
js/geometry/cells.js           exact planar meshes for the edged textures (Voronoi cells, bricks, hexes, diamonds, strands,
                               studs, scales, blocks, tread bars), level cutting for terraces and tips, finest detail
js/ui/tileeditor.js            the tile editor dialog and its four-plate preview
js/data/filament-db.js         the planner's filament catalogue, copied verbatim (re-copy, never edit)
js/ui/glyphs.js, icons.js      generated element glyphs in the design's colours; the icon helper
js/ui/render2d.js              plates and thumbnails as SVG; svgimport.js (SVG art to layers); actions.js (element actions)
tools/make-icons.mjs           rebuilds icons/phosphor.svg from @phosphor-icons/core
assets/backers/*.bin           backer meshes; assets/profiles/*.ini the PrusaSlicer profiles
test/                          node --test suites and an export smoke script
vendor/                        three 0.187, polygon-clipping 0.15.7, JSZip 3.10.1, opentype.js 1.3.4 (all local)
```

## Known limits (v1)

- What a combine does with its pieces, what an outline follows and its band are the same on every size (the distance and the build settings can differ). Blocks, grips,
  meshes and 3D textures cannot be pieces. An outline's corners come out round, and it is accurate to about 0.02 mm.
- A drawing's points and its form are the same on every size (its thickness, height and taper can differ). A
  taper only leans in. Its faces are flat and on the true surface, except that an inside corner's sweep is flat
  sectors of at most 7.5°, a round top edge is flat chords within about 0.011 mm, a slight inside turn (under 10°,
  as along a curve) meets in a mitre (under 0.01 mm off at 6 mm in), and the outline is first thinned to within
  0.01 mm. Corners closer than 0.3 micron can be merged into one, and a hairline gap that leaves in the top is
  filled, but only where at most a thousandth of the fill falls outside the drawing, and within the area the
  left-out slivers had (plus a ten-millionth of the drawing's). So a hole of the drawing's own stays a hole unless
  it is smaller than that thousandth of a fill around it. Where a drawing pinches to a point, its two lobes come out
  as two bodies 0.05 micron apart. About 3 in 100 random drawings still fall back to the 0.25 mm grid (closed
  either way). A cut that does not close (a mesh that was never a closed body) leaves that body uncut, and the
  checks report it past the edge.
- A size's own value is a plain number, choice or text; only the master holds formulas. Formulas know W and H
  only (not other settings or elements), are at most 120 characters, and a size where one cannot be worked out
  (it divides by zero there) uses the stored value. A phone's number keypad has no "=", so a new formula is
  typed on a computer (a field that already holds one opens the full keyboard).
- Version history is per browser: it does not travel with a design file or to another computer, and clearing
  the site's data clears it. Where the browser refuses IndexedDB (some private windows) it lasts until the page
  closes, and the panel says so. Two tabs editing one design at once can each fold the other's last step away.
  The downloaded files themselves are not kept, only the exact design each was made from.
- Text uses the seven bundled fonts; your own font file cannot be loaded yet. Characters a font lacks (emoji,
  most non-Latin scripts) are left out and named in a builder note.
- Pictures are split by brightness only, so two colours of the same lightness become one tone; recolour or
  adjust them in an image editor first. They are kept at 256 px on the long side, so fine detail in a large
  picture is lost, and a busy picture costs about 0.1 to 0.2 s per plate to build (the All sizes view builds 18).
- Fills work on shapes, text and SVG art, not on pictures, blocks or meshes. A texture fine enough to make
  more than 20,000 pieces (or 150,000 outline points) over its area stops with a builder note instead of
  stalling the page; the defaults fit the largest plate many times over.
- The Classic Pro and Classic grips match the shipped models within 2 % of every compared slice, except on 3W and 4W
  Classic Pro, whose shipped pocket roof thins outside the middle 88 mm: the rebuild keeps the thicker blade the whole
  length (the same outside). The small round hole in the shipped pocket roof is not reproduced. A Classic on a 1H
  plate ships on the lower half; flush with the top edge puts it on the upper half (anchor it to the bottom edge with
  Offset Y 13.5 to match). Of EdgeLabel, only its grip (the corner hood) is rebuilt: its accent plate and label are
  not; the hood matches within about 1 % up to 12 mm above the face, and its rounded ridge and apex are left sharp.
- Grip strength is an estimate, not a measurement: a firm pull (100 N, about 10 kg) straight out of the face at the
  edge fingers hook, as tension plus bending on the grip's base (an arch: at each leg's root, plus its bar over the
  bridge), against printed PLA parting between layers at roughly 15 to 30 MPa (thin over 5 MPa, may snap over 10).
  It has not been checked against pull tests on real prints, and other filaments differ.
- 3D textures print face up only; the 2D stage draws their relief shaded (size cards and thumbnails show the
  hatched outline). A tip colour's body reaches 0.05 mm down into the texture under it, so the slicer sees the
  two meet without a gap. Where a texture's cells, colours and outline meet awkwardly at one corner (a rare case,
  most often tumbling blocks with deep sides), its cell or tip colours cannot be split into clean bodies: it then
  prints in its own colour and its card says so (another seed usually clears it). Terraces or colours on a
  smooth texture (built on a 0.6 mm lattice) take two or three seconds for a whole 2W-1H face; on the textures
  with edges they cost little. A big area is meshed on a coarser grid so it stays under 160,000 cells; the Detail row on the card
  says which grid the current size really uses, and the download is built from that same mesh. Smooth textures make big
  files (a whole-face hammered texture on a 2W-1H plate is about 1.2 MB of 3MF); the faceted ones are far
  smaller (whole-face crystal at a 4 mm feature size is about 10,000 triangles, against some 126,000 on the
  grid; the 3MF of a crystal face with knurled letters is about 220 KB). A very fine
  edged texture over a big area (more than 250,000 faces) is meshed on the grid instead, as is any that fails
  the exact mesher's own closure check. The checks see a texture's footprint and height, not the shape of its
  hills (overhangs, thin peaks): keep the texture height modest against the feature size.
- Inlays: the pieces of each inlaid colour are measured, and so is the face left between a pattern's or a shape's
  pieces (from their parameters), but not the face left between pieces of inlaid SVG art. An inlay in the face's
  own colour is simply face, and is not checked as a piece.
- A text's stroke check measures each glyph on its own; where letters touch or overlap (tight spacing, the
  joined script of Pacifico) the joins between them are not measured.
- The centre knob has no backer to match yet: the Essential backer is solid at the centre.
- On a very flat cell (a dozen or more rows per 56 mm and few columns) at the widest line, a drawn curve that
  turns toward a corner runs along the cell edge for a stretch; it stays in its own cell, and the ports still meet.
- A dense set of drawn tiles on the largest plates (4W-3H, a dozen cells per 88 mm) takes about a second to
  build; the cost is the polygon library's union of thousands of bands.
- Linked patterns join at every edge, but each plate draws its own cells from its own seed; a wall-sized
  mural with one continuous random field would need each plate's place on the wall.
- Mesh overhang statistics count every down-facing facet, so a sculpt made of overlapping shells reports its
  internal faces too: union the shells in the sculpting app first. Meshes are stored inside the design file
  (about 100 bytes per triangle), so keep sculpts under roughly 150,000 triangles.
- Strip chamfers are not modelled (the Chevron series has 0.25 mm top-edge chamfers).
- Cuts are measured from the face top, not from the top of a raised feature under them.
- Per-size overrides do not exist: one design, the same parameters on every size.
- The 3MF profile is the Chevron series' MMU setup; single-extruder printers still slice it, with a
  wipe tower they can switch off.
- No membership gate and no planner integration yet - both planned.
