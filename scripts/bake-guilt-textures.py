"""Bakes GUILT's materials into static images: python scripts/bake-guilt-textures.py

CSS gradients cannot light a shape; these images are lit height maps. Every
surface is modelled as a height field and lit head-on — a ring light in front
of the cabinet, where the player is, plus a soft fill. Nothing is lit from the
side, so no face is dark because of the direction it points in: what darkens a
surface here is depth. Output is committed; nothing runs at build or in the
browser, and the page only moves opacity and transforms over these images.

  guilt-shell.webp   the cabinet rim, as a 9-slice (border-image), with the
                     shadow the rim casts into the recessed front
  guilt-box.webp     the walls of the box the glass sits at the back of, and
                     the shadow they cast on it — also a 9-slice
  guilt-knob.webp    a knurled machined cap, lit and static: only its
                     indicator rotates, as the light on a real cap does not
  guilt-jack.webp    the input nut and the plug in it
  guilt-brushed.webp a tileable brushed-metal grain for the control plate

Needs numpy and Pillow (with WebP support).
"""
import numpy as np
from PIL import Image

OUT = 'public/images/'
rng = np.random.default_rng(7)

# Head-on, barely above the axis: enough to tell a bump from a dent, not
# enough to throw a shadow to one side.
KEY = np.array([0.0, -0.16, 1.0]); KEY /= np.linalg.norm(KEY)
FILL = np.array([0.0, 0.10, 1.0]); FILL /= np.linalg.norm(FILL)
HALF = KEY + np.array([0, 0, 1.0]); HALF /= np.linalg.norm(HALF)
AMBIENT = 0.24


def blur(a, sigma, axis=None, wrap=False):
    """Separable gaussian blur, in pure numpy."""
    radius = int(3 * sigma) + 1
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    k /= k.sum()
    for ax in ([0, 1] if axis is None else [axis]):
        mode = 'wrap' if wrap else 'edge'
        pad = [(0, 0)] * a.ndim
        pad[ax] = (radius, radius)
        p = np.pad(a, pad, mode=mode)
        a = np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), ax, p)
    return a


def normals(h):
    gy, gx = np.gradient(h)
    n = np.dstack([-gx, -gy, np.ones_like(h)])
    return n / np.linalg.norm(n, axis=2, keepdims=True)


def light(n, albedo, diffuse, spec, shine, ring):
    """`ring` is how much of the light in front the surface mirrors back: a
    face square to the viewer returns all of it, one turned away returns
    none. That is what makes an edge read as an edge without a shadow."""
    ny, nz = n[..., 1], n[..., 2]
    lam = np.clip(n @ KEY, 0, 1) * diffuse + np.clip(n @ FILL, 0, 1) * 0.26 + AMBIENT
    blinn = np.clip(n @ HALF, 0, 1)
    ry, rz = 2 * nz * ny, 2 * nz * nz - 1
    # A ring reflects as a ring: a face square to the viewer mirrors the dark
    # middle of it, a rounded edge mirrors the lit ring itself. That is where
    # the light on this cabinet lives — on its edges, not on its flats.
    front = np.exp(-((rz - 0.55) / 0.22) ** 2)
    room = 0.20 * np.clip((-ry - 0.35) / 0.4, 0, 1)      # a trace of the ceiling
    rgb = lam[..., None] * np.array(albedo)
    # Lit head-on, every flat face points straight at the light, so a broad
    # specular would wash the whole cabinet out: it is tied to the material.
    rgb += (spec * (blinn ** shine + 0.25 * blinn ** 8))[..., None]
    rgb += (ring * (front + room))[..., None] * np.array([0.97, 0.95, 1.0])
    return rgb


def rounded_rect_sd(x, y, cx, cy, hw, hh, r):
    qx = np.abs(x - cx) - hw + r
    qy = np.abs(y - cy) - hh + r
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def save(rgb, alpha, name, **kw):
    img = np.dstack([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)])
    Image.fromarray((img * 255 + 0.5).astype(np.uint8), 'RGBA').save(OUT + name, **kw)


def shell():
    S = 2                      # device pixels per CSS pixel
    rim, band = 26, 44         # CSS px: the rim, and how far its shadow reaches in
    slice_ = (rim + band) * S  # the 9-slice cut, in source pixels
    W, H = 2 * slice_ + 800, 2 * slice_ + 600
    y, x = np.mgrid[0:H, 0:W].astype(float) + 0.5
    d_out = -rounded_rect_sd(x, y, W / 2, H / 2, W / 2, H / 2, 22 * S)
    d_in = rounded_rect_sd(x, y, W / 2, H / 2, W / 2 - rim * S, H / 2 - rim * S, 6 * S)

    # A quarter-round outer edge onto a flat rim, and a smaller round down
    # into the recess.
    ro, ri = 9 * S, 4 * S
    h1 = np.sqrt(np.clip(ro ** 2 - (ro - np.clip(d_out, 0, ro)) ** 2, 0, None))
    h2 = np.sqrt(np.clip(ri ** 2 - (ri - np.clip(d_in, 0, ri)) ** 2, 0, None))
    h = np.minimum(h1, ro - ri + h2)
    # Satin powder coat: a fine, soft grain, far below leather's scale.
    h = h + blur(rng.standard_normal((H, W)), 1.6) * 0.07
    rgb = light(normals(h), [0.25, 0.225, 0.28], 0.5, 0.07, 70, 0.40)
    # Barely any falloff down the cabinet: the light is in front, not above.
    rgb *= (1.03 - 0.07 * y / H)[..., None]
    shell_a = np.clip(d_out + 0.5, 0, 1) * np.clip(d_in + 0.5, 0, 1)

    # The rim's shadow on the front. Lit head-on, a rim shades what it
    # overhangs by the same amount all round, plus a contact line.
    t = np.clip(-d_in, 0, None)
    over = 0.55 * np.exp(-t / (8 * S))
    contact = np.clip(1 - t / (1.5 * S), 0, 1) * 0.75
    shade = 1 - (1 - over) * (1 - contact)
    shade *= np.clip((band * S - t) / (10 * S), 0, 1) * (d_in < 0.5)
    alpha = shell_a + shade * (1 - shell_a)
    rgb = rgb * (shell_a / np.maximum(alpha, 1e-6))[..., None]
    save(rgb, alpha, 'guilt-shell.webp', quality=90, method=6)
    print('shell', W, H, 'slice', slice_)


def box():
    """The walls of the box the glass sits at the back of. Four faces in
    perspective, all turned away from a light that is in front, so all four
    darken towards the back by the same amount and the shadow they cast on
    the art is even all round. Depth is what darkens them, not direction."""
    S = 2
    wall, ao = 9, 24             # CSS px: the wall's depth, then its shadow
    slice_ = (wall + ao) * S
    W, H = 2 * slice_ + 600, 2 * slice_ + 400
    y, x = np.mgrid[0:H, 0:W].astype(float) + 0.5

    # Which wall a pixel belongs to: the nearest edge, so corners mitre.
    dt, db, dl, dr = y, H - y, x, W - x
    d = np.minimum(np.minimum(dt, db), np.minimum(dl, dr))
    side = np.argmin(np.stack([dt, db, dl, dr]), axis=0)     # 0 top .. 3 right
    u = np.clip(d / (wall * S), 0, 1)                        # 0 at the front edge

    # Every wall turns away from the viewer, so every wall is darker than the
    # front plane and falls off towards the back. The floor of the box picks
    # up a little bounce off the art, the ceiling a little less light.
    near = np.array([0.185, 0.235, 0.21, 0.21])[side]
    far = np.array([0.065, 0.105, 0.08, 0.08])[side]
    v = near + (far - near) * u ** 0.8
    v *= 1 + 0.05 * blur(rng.standard_normal((H, W)), 2.0)   # a little tooth
    wall_a = np.clip((wall * S - d) + 0.5, 0, 1)

    # The shadow the walls cast on the art, from the wall's inner edge in.
    t = np.clip(d - wall * S, 0, None)
    sigma = np.array([7.0, 5.0, 6.0, 6.0])[side] * S
    depth = np.array([0.52, 0.42, 0.47, 0.47])[side]
    shade = depth * np.exp(-t / sigma) * np.clip((ao * S - t) / (8 * S), 0, 1)
    # Corners are the deepest part of any box: two walls shade them at once.
    corner = (np.clip(1 - np.clip(np.minimum(dt, db) - wall * S, 0, None) / (34 * S), 0, 1)
              * np.clip(1 - np.clip(np.minimum(dl, dr) - wall * S, 0, None) / (50 * S), 0, 1))
    shade = 1 - (1 - shade) * (1 - 0.20 * corner)

    alpha = np.clip(wall_a + shade * (1 - wall_a), 0, 1)
    rgb = np.dstack([v * 0.95, v * 0.88, v]) * (wall_a / np.maximum(alpha, 1e-6))[..., None]
    # The glass's own cut edge, a hairline of light at the very front.
    lip = np.clip(1.6 - d / S, 0, 1) * 0.6
    rgb = np.clip(rgb + lip[..., None] * np.array([0.85, 0.80, 0.95]), 0, 1)
    alpha = np.maximum(alpha, lip)
    save(rgb, alpha, 'guilt-box.webp', quality=92, method=6)
    print('box', W, H, 'slice', slice_)


def knob():
    D, R = 144, 66              # 48 CSS px at 3x
    y, x = np.mgrid[0:D, 0:D].astype(float) + 0.5 - D / 2
    r = np.hypot(x, y) / R
    theta = np.arctan2(y, x)
    face, edge = 0.76, 1.0
    top = 1 + 0.035 * (1 - np.clip(r / face, 0, 1) ** 2)
    u = np.clip((r - face) / (edge - face), 0, 1)
    side = np.sqrt(np.clip(1 - u ** 2, 0, 1))
    h = np.where(r < face, top, side)
    # Machined rings on the face, knurling on the skirt.
    h = h + np.where(r < face, 0.004 * np.sin(r * R * 2.3), 0)
    h = h + np.where(r > face + 0.03, 0.03 * np.cos(48 * theta) * np.clip((u - 0.1) * 4, 0, 1), 0)
    n = normals(h * R * 0.32)
    rgb = light(n, [0.255, 0.24, 0.275], 0.42, 0.40, 90, 0.36)
    # Spun metal lit head-on: the light comes back as a ring centred on the
    # cap, not as a highlight off to one side.
    spun = np.exp(-((r / face - 0.6) / 0.26) ** 2) * (r < face) * 0.13
    rgb += spun[..., None] * np.array([0.92, 0.90, 0.96])
    rgb *= np.where(r > face, 0.88, 1.0)[..., None]
    alpha = np.clip((1 - r) * R + 0.5, 0, 1)
    save(rgb, alpha, 'guilt-knob.webp', quality=92, method=6)
    print('knob', D)


def jack():
    """The input: a knurled nut around a hole, and a plug in it — the barrel
    pointing at the viewer, its rubber boot bending down into the lead."""
    S = 3                                   # 3x: 52 x 56 CSS px
    W, H = 52 * S, 56 * S
    cx, cy = W / 2, 16 * S                  # the socket's centre on the plate
    y, x = np.mgrid[0:H, 0:W].astype(float) + 0.5
    r = np.hypot(x - cx, y - cy)

    # The nut: a ring, domed across its width, knurled on its rim.
    r_in, r_out = 8.5 * S, 15.5 * S
    u = np.clip((r - r_in) / (r_out - r_in), 0, 1)
    nut_h = np.sqrt(np.clip(1 - (2 * u - 1) ** 2, 0, 1)) * 2.2 * S
    nut_h += 0.10 * S * np.cos(64 * np.arctan2(y - cy, x - cx)) * np.clip(u * 3, 0, 1)
    nut = (r >= r_in - 0.5) & (r <= r_out + 0.5)

    # The plug: a barrel wider than the hole, so it covers it, falling into a
    # rubber boot that narrows and bends left towards the lead.
    t = np.clip((y - cy) / (H - cy), 0, 1)
    axis = cx - 7 * S * t ** 2
    rad = (11 * S) * (1 - t) ** 1.6 + (4.8 * S) * t
    dx = np.abs(x - axis) / np.maximum(rad, 1e-6)
    tube = np.sqrt(np.clip(1 - dx ** 2, 0, 1)) * rad
    barrel = np.sqrt(np.clip((11 * S) ** 2 - r ** 2, 0, None))
    plug_h = np.where(y < cy, barrel, np.maximum(tube, barrel))
    plug = plug_h > 0.5

    h = np.where(nut, nut_h + 2 * S, 0)
    h = np.where(plug, plug_h + 4 * S, h)
    n = normals(blur(h, 1.2))

    chrome = light(n, [0.35, 0.34, 0.37], 0.45, 0.5, 100, 0.6)
    rubber = light(n, [0.085, 0.08, 0.10], 0.5, 0.25, 45, 0.25)
    rgb = np.where(plug[..., None], rubber, chrome)
    # The plug's own shadow on the nut around it.
    rgb *= np.clip(1 - 0.5 * np.exp(-np.clip(r - 11 * S, 0, None) / (2.5 * S)) * ~plug, 0, 1)[..., None]
    alpha = np.clip(np.maximum(nut * (r_out + 0.5 - r), plug * (plug_h * 2)), 0, 1)
    save(rgb, alpha, 'guilt-jack.webp', quality=92, method=6)
    print('jack', W, H)


def brushed():
    W, H = 512, 256
    v = blur(rng.standard_normal((H, W)), 0.6, axis=0, wrap=True)
    v = blur(v, 45, axis=1, wrap=True)
    v = (v - v.mean()) / v.std()
    fine = blur(rng.standard_normal((H, W)), 3, axis=1, wrap=True)
    v = 0.7 * v + 0.3 * fine / fine.std()
    rgb = np.where(v[..., None] > 0, 1.0, 0.0) * np.ones(3)
    alpha = np.clip(np.abs(v) * 0.032, 0, 0.09)
    save(rgb, alpha, 'guilt-brushed.webp', quality=85, method=6)
    print('brushed', W, H)


shell()
box()
knob()
jack()
brushed()
