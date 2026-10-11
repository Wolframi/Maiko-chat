# Maiko dance intro

Every entry chooses one of two equally likely intros once, retaining that choice
across Strict Mode, resize, and renderer fallback. The manual hand wave is no
longer used. Only the selected binary is fetched:

- `maiko-hiphop.bin` (2,364,632 bytes): quickly assembles from a sphere of moving
  particles, plays a randomly selected six-second segment of `Wave Hip Hop Dance.fbx`, then
  disperses. Total intro: 8.15 seconds after asset readiness.
- `maiko-samba.bin` (2,447,312 bytes): assembles from the same sphere, plays a random six-second segment
  of `Samba Dancing.fbx`, then disperses. Total intro: 8.15 seconds.
  Samba replaces Moonwalk in the random selection.

The full clips (16.0 / 18.21 seconds) are retained. The starting time is picked
uniformly from the range that leaves six uninterrupted seconds; it does not
wrap or freeze at the end of a short clip. The same start survives Strict Mode,
resizes, and renderer fallback. Reduced motion skips animation.

The supplied FBXs already include the mascot and a 65-bone Mixamo rig. Their
complete editable scenes are saved through Blenderwright MCP in
`output/maiko-intro/maiko-hiphop.blend` and `maiko-samba.blend`. The original
clips run at 60 fps; the browser palette is sampled at 24 fps and interpolated.
Horizontal mocap root drift is removed. Each frame is grounded using the
evaluated mesh's lowest sole, aligning it to the horizontal platform at browser
Y = -1.2. The platform rim and surface use the same perspective projection as
the character, so the supporting foot neither floats nor sinks into it.

Both assets contain 84,000 surface samples with texture luminance, normals,
four joint indices, and four skin weights. WebGL2 skins the points using a float
palette texture (40,000 points on mobile). The Canvas fallback uses the same
animation palette, with 14,000/7,000 points. Hover produces only a bounded
cursor repulsion for 10% accent points, with smoothed pointer/focus and
return to the surface after the cursor leaves. The other 90% preserve the
silhouette and facial detail, limiting hover displacement to about 0.0021 units.
Every particle has an independent
spring offset and repels its three closest surface neighbours. This simulation
runs at a bounded 60 Hz on the GPU in `src/lib/maikoParticleGpu.ts`, using two
pairs of float textures. `src/lib/maikoParticleMotion.ts` supplies the neighbour
graph and the CPU implementation for Canvas. Offsets stay within
0.035 units (0.003 for the dense core) and follow the current skeleton pose.
Rendering projects offsets onto the surface tangent, with 70% less movement
on the face. Controlled pinpoint sizes and reduced backface glow keep the surface
sharp while the accent points move and shimmer.
Hover starts repeating light ripples at the pointer and curls accent points
around it. The effect fades when the pointer leaves the mascot; its brightness
is independent of displacement, preserving the detailed core.
The lowest visible points are
clamped to the platform plane, preserving foot contact. Failed assets also release
the loading screen, and animation work stops while the page is hidden.

Regenerate with Blender from the supplied FBX files or saved MCP scenes:

```powershell
& 'D:/Steam/steamapps/common/Blender/blender.exe' --background --python scripts/export-maiko-dance.py -- 'path/to/Wave Hip Hop Dance.fbx' public/models/maiko-hiphop.bin 100
& 'D:/Steam/steamapps/common/Blender/blender.exe' --background --python scripts/export-maiko-dance.py -- 'path/to/Samba Dancing.fbx' public/models/maiko-samba.bin 100
```

MKAN v1's binary layout is documented in `scripts/export-maiko-dance.py`.
The browser decoder and renderers are in `src/lib/maikoDance.ts`.

When transferring the dances to the mascot rig, use
`scripts/retarget-maiko-dance.py` before exporting. Bone names match, but their
bind axes do not: the right arm and forearm have different bone rolls. Copying
the source quaternion curves directly makes the elbows bend in the wrong
direction. The retargeter transfers armature-space rotation deltas relative to
each skeleton's bind pose and verifies the resulting rotations on every frame.
It retains the target mesh, skin weights, proportions and scaled root travel.

The corrected editable scenes are in `output/maiko-arm-fix/maiko-hiphop.blend`
and `output/maiko-arm-fix/maiko-samba.blend`. Regenerate the binaries from these
scenes with `scripts/export-maiko-dance.py`. The asset URL includes a revision
to refresh previously cached animation data.
