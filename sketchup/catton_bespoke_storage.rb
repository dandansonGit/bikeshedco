# =============================================================================
#  The Bike Shed Co - Bespoke Storage for Richard Catton
#  Built from drawing 1817 DWG.01, page 2 ("Plan & Side View", issued 08/10/2026)
#
#  HOW TO RUN (SketchUp 2017 or newer):
#    1. Open a new, empty SketchUp model.
#    2. Window > Ruby Console.
#    3. Type this (change the path to where you saved this file) and press Enter:
#         load 'C:/Users/you/Downloads/catton_bespoke_storage.rb'
#       (on a Mac:  load '/Users/you/Downloads/catton_bespoke_storage.rb')
#    4. The whole shed is built as one group. Edit > Undo removes it in one go.
#
#  AXES:  red X = width (left to right), green Y = depth (front doors at Y=0,
#         back wall at Y=820), blue Z = height. Body front-left-bottom corner
#         sits at the origin, so the lid overhang goes 60 mm past it.
#
#  To change a size, edit the numbers below and run the script again.
# =============================================================================

module BSCCattonStore
  extend self

  # ---- Sizes taken from the drawing (mm) ------------------------------------
  BODY_W   = 2600   # external footprint width  (blue 2600)
  BODY_D   = 820    # external footprint depth  (blue 820)
  OVERHANG = 60     # lid overhang each side: (2720-2600)/2 and (940-820)/2
  H_FRONT  = 1355   # overall height at the door side (top of lid)
  H_BACK   = 1400   # overall height at the back      (top of lid)
  WALL     = 50     # wall thickness: (2600-2500)/2 and (820-720)/2

  # ---- Sizes NOT on the drawing - sensible defaults, change as needed --------
  CLAD_T      = 20   # cladding board thickness
  BOARD_H     = 125  # cladding board height (cover)
  BOARD_GAP   = 3    # shadow gap between boards
  BEARER_W    = 45   # base bearer width
  BEARER_H    = 70   # base bearer height
  DECK_T      = 25   # floor deck thickness  -> floor top at 95 mm
  LID_T       = 60   # lid thickness         -> internal height ~1200 mm
  LID_FRONT_D = 600  # depth of the opening (front) lid section, incl. overhang
  LID_GAP     = 3    # gap between front and rear lid sections (hinge line)
  DOOR_LEAVES = 4    # bifold: 2 pairs of 625 mm leaves (matches 625 clearance)
  DOOR_GAP    = 3    # gap around / between door leaves
  LEDGE_T     = 20   # door ledge thickness
  LEDGE_H     = 95   # door ledge height
  RAIL_H      = 45   # frame rail height
  HEAD_H      = 50   # door head rail height

  # ---- Worked out from the above ---------------------------------------------
  FRAME_T = WALL - CLAD_T               # 30 mm frame behind the cladding
  LID_W   = BODY_W + 2 * OVERHANG       # 2720
  LID_D   = BODY_D + 2 * OVERHANG       # 940
  SLOPE   = (H_BACK - H_FRONT).to_f / LID_D
  FLOOR   = BEARER_H + DECK_T           # top of floor

  # Top of the lid at depth y (y measured from the body front).
  def lid_top(y)
    H_FRONT + SLOPE * (y + OVERHANG)
  end

  # Underside of the lid at depth y - walls stop here.
  def under(y)
    lid_top(y) - LID_T
  end

  # ---------------------------------------------------------------------------
  def pt(x, y, z)
    Geom::Point3d.new(x.mm, y.mm, z.mm)
  end

  def new_group(ents, name, mat, tag)
    g = ents.add_group
    g.name = name
    g.material = mat if mat
    g.layer = tag if tag
    g
  end

  # Rectangular block. x,y,z = corner nearest the origin; w,d,h = sizes.
  def box(ents, name, x, y, z, w, d, h, mat, tag)
    g = new_group(ents, name, mat, tag)
    f = g.entities.add_face(pt(x, y, z), pt(x + w, y, z),
                            pt(x + w, y + d, z), pt(x, y + d, z))
    f.reverse! if f.normal.z < 0
    f.pushpull(h.mm)
    g
  end

  # Prism: a profile drawn in the side (Y-Z) plane, pushed along X by w.
  # profile = [[y, z], ...]
  def yz_prism(ents, name, x, w, profile, mat, tag)
    g = new_group(ents, name, mat, tag)
    f = g.entities.add_face(profile.map { |y, z| pt(x, y, z) })
    f.reverse! if f.normal.x < 0
    f.pushpull(w.mm)
    g
  end

  # Cut a [y, z] polygon so nothing is above the lid underside.
  def clip_under_lid(poly)
    inside = ->(p) { under(p[0]) - p[1] }
    out = []
    poly.each_with_index do |cur, i|
      prev = poly[i - 1]
      fc = inside.(cur)
      fp = inside.(prev)
      if (fc >= 0) != (fp >= 0)
        t = fp / (fp - fc)
        out << [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]
      end
      out << cur if fc >= 0
    end
    # drop repeated points
    out.each_with_object([]) do |p, acc|
      acc << p unless acc.any? { |q| (q[0] - p[0]).abs < 0.01 && (q[1] - p[1]).abs < 0.01 }
    end
  end

  # Y-Z rectangle trimmed to the lid slope, pushed along X. Skips if nothing left.
  def yz_trimmed(ents, name, x, w, y0, y1, z0, z1, mat, tag)
    poly = clip_under_lid([[y0, z0], [y1, z0], [y1, z1], [y0, z1]])
    return nil if poly.size < 3
    yz_prism(ents, name, x, w, poly, mat, tag)
  end

  # ---------------------------------------------------------------------------
  def material(model, name, rgb)
    m = model.materials[name] || model.materials.add(name)
    m.color = Sketchup::Color.new(*rgb)
    m
  end

  def run
    model = Sketchup.active_model
    model.start_operation('Build Catton Bespoke Storage', true)

    larch = material(model, 'BSC Larch cladding', [201, 156, 104])
    frame = material(model, 'BSC Frame timber',  [168, 128, 84])
    lidm  = material(model, 'BSC Lid',           [92, 96, 100])

    t_base = model.layers.add('BSC Base')
    t_frm  = model.layers.add('BSC Frame')
    t_clad = model.layers.add('BSC Cladding')
    t_door = model.layers.add('BSC Doors')
    t_lid  = model.layers.add('BSC Lid')

    root = model.active_entities.add_group
    root.name = 'Bespoke Storage - R Catton (1817)'
    e = root.entities

    # --- Base: 3 bearers running left-right, then the floor deck -------------
    [0, (BODY_D - BEARER_W) / 2.0, BODY_D - BEARER_W].each_with_index do |y, i|
      box(e, "Bearer #{i + 1}", 0, y, 0, BODY_W, BEARER_W, BEARER_H, frame, t_base)
    end
    box(e, 'Floor deck', 0, 0, BEARER_H, BODY_W, BODY_D, DECK_T, frame, t_base)

    # --- Frame -----------------------------------------------------------------
    xl = CLAD_T                      # left frame x (inside the cladding)
    xr = BODY_W - CLAD_T - FRAME_T   # right frame x
    yb = BODY_D - CLAD_T - FRAME_T   # back frame y (inside the back cladding)
    top = 99_999                     # "tall enough" - trimmed to the lid slope

    # Corner posts (front posts are deeper - doors hang off them)
    yz_trimmed(e, 'Post front left',  xl, FRAME_T, 0,  WALL,        FLOOR, top, frame, t_frm)
    yz_trimmed(e, 'Post front right', xr, FRAME_T, 0,  WALL,        FLOOR, top, frame, t_frm)
    yz_trimmed(e, 'Post back left',   xl, FRAME_T, yb, yb + FRAME_T, FLOOR, top, frame, t_frm)
    yz_trimmed(e, 'Post back right',  xr, FRAME_T, yb, yb + FRAME_T, FLOOR, top, frame, t_frm)

    # Side rails (bottom, middle, sloped top)
    z_mid = (FLOOR + under(0)) / 2.0 - RAIL_H / 2.0
    [[xl, 'left'], [xr, 'right']].each do |x, side|
      box(e, "Side rail bottom #{side}", x, WALL, FLOOR, FRAME_T, yb - WALL, RAIL_H, frame, t_frm)
      box(e, "Side rail middle #{side}", x, WALL, z_mid, FRAME_T, yb - WALL, RAIL_H, frame, t_frm)
      yz_prism(e, "Side rail top #{side}", x, FRAME_T,
               [[WALL, under(WALL) - RAIL_H], [yb, under(yb) - RAIL_H],
                [yb, under(yb)], [WALL, under(WALL)]], frame, t_frm)
    end

    # Back rails
    bw = xr - (xl + FRAME_T)
    box(e, 'Back rail bottom', xl + FRAME_T, yb, FLOOR, bw, FRAME_T, RAIL_H, frame, t_frm)
    box(e, 'Back rail middle', xl + FRAME_T, yb, z_mid, bw, FRAME_T, RAIL_H, frame, t_frm)
    box(e, 'Back rail top',    xl + FRAME_T, yb, under(yb) - RAIL_H, bw, FRAME_T, RAIL_H, frame, t_frm)

    # Door head rail (front, under the lid)
    box(e, 'Door head rail', WALL, 0, under(0) - HEAD_H, BODY_W - 2 * WALL, WALL, HEAD_H, frame, t_frm)

    # --- Cladding: horizontal boards, sides trimmed to the lid slope ---------
    n = 0
    z0 = FLOOR
    while z0 < under(BODY_D)
      n += 1
      z1 = z0 + BOARD_H - BOARD_GAP
      yz_trimmed(e, "Left board #{n}",  0, CLAD_T, 0, BODY_D, z0, z1, larch, t_clad)
      yz_trimmed(e, "Right board #{n}", BODY_W - CLAD_T, CLAD_T, 0, BODY_D, z0, z1, larch, t_clad)
      back_top = [z1, under(BODY_D - CLAD_T)].min
      if back_top > z0
        box(e, "Back board #{n}", CLAD_T, BODY_D - CLAD_T, z0,
            BODY_W - 2 * CLAD_T, CLAD_T, back_top - z0, larch, t_clad)
      end
      z0 += BOARD_H
    end

    # --- Bifold doors: 4 leaves, hinged as two pairs off the front posts -----
    opening = BODY_W - 2 * WALL                        # 2500
    leaf_w  = (opening - (DOOR_LEAVES + 1) * DOOR_GAP) / DOOR_LEAVES.to_f
    dz0     = FLOOR + DOOR_GAP
    dz1     = under(0) - HEAD_H - DOOR_GAP
    names   = ['hinged to left post', 'folds off leaf 1',
               'folds off leaf 4', 'hinged to right post']
    DOOR_LEAVES.times do |i|
      x = WALL + DOOR_GAP + i * (leaf_w + DOOR_GAP)
      leaf = new_group(e, "Door leaf #{i + 1} (#{names[i] || 'bifold'})", nil, t_door)
      le = leaf.entities
      bz = dz0
      b  = 0
      while bz < dz1
        b += 1
        h = [BOARD_H - BOARD_GAP, dz1 - bz].min
        box(le, "Door board #{b}", x, 0, bz, leaf_w, CLAD_T, h, larch, t_door)
        bz += BOARD_H
      end
      inset = 30
      box(le, 'Ledge bottom', x + inset, CLAD_T, dz0 + 60, leaf_w - 2 * inset,
          LEDGE_T, LEDGE_H, frame, t_door)
      box(le, 'Ledge top', x + inset, CLAD_T, dz1 - 60 - LEDGE_H, leaf_w - 2 * inset,
          LEDGE_T, LEDGE_H, frame, t_door)
    end

    # --- Lid: front section lifts up (hinge line), rear section fixed --------
    ly0 = -OVERHANG
    ly1 = ly0 + LID_FRONT_D
    ly2 = ly1 + LID_GAP
    ly3 = BODY_D + OVERHANG
    slab = ->(a, b) { [[a, lid_top(a) - LID_T], [b, lid_top(b) - LID_T], [b, lid_top(b)], [a, lid_top(a)]] }
    yz_prism(e, 'Lid front (opening)', -OVERHANG, LID_W, slab.(ly0, ly1), lidm, t_lid)
    yz_prism(e, 'Lid rear (fixed)',    -OVERHANG, LID_W, slab.(ly2, ly3), lidm, t_lid)

    model.commit_operation
    model.active_view.zoom_extents
    puts "Built: lid top #{H_FRONT} mm front / #{H_BACK} mm back, " \
         "internal #{opening} x #{BODY_D - 2 * WALL} mm, " \
         "internal height #{(under(0) - FLOOR).round} mm at the doors."
    root
  rescue StandardError => err
    model.abort_operation if model
    puts "Something went wrong: #{err.message}"
    raise
  end
end

BSCCattonStore.run
