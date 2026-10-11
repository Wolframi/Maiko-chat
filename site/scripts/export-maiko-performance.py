"""Blender --background --python scripts/export-maiko-performance.py -- source.fbx output.bin.

MKPF v2: magic/version/count (12 bytes), then 37 bytes/sample: three posed
positions (9 little-endian int16 / 8192), three posed normals (9 int16 / 32767),
texture luminance (uint8). Identical triangle/barycentric samples in every pose.
"""
import bpy, bisect, math, os, random, struct, sys
sys.dont_write_bytecode = True
import numpy as np
from mathutils import Vector
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('maiko_greeting_pose', os.path.join(os.path.dirname(__file__), 'maiko-greeting-pose.py'))
greeting = module_from_spec(spec)
spec.loader.exec_module(greeting)
set_maiko_pose = greeting.set_maiko_pose

source, destination = sys.argv[sys.argv.index('--') + 1:]
if source.lower().endswith('.blend'):
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(source))
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(source))
bpy.context.scene.frame_set(1)
rig = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
rig.animation_data_clear()
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.hide_render]

def pose(wave=None):
    set_maiko_pose(rig, wave)

def geometry():
    result = []
    dg = bpy.context.evaluated_depsgraph_get()
    for obj in meshes:
        evaluated = obj.evaluated_get(dg)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        world = evaluated.matrix_world
        nm = world.to_3x3().inverted().transposed()
        vertices = [world @ v.co for v in mesh.vertices]
        normals = [(nm @ v.normal).normalized() for v in mesh.vertices]
        uv = mesh.uv_layers.active
        for t in mesh.loop_triangles:
            result.append(([vertices[i].copy() for i in t.vertices], [normals[i].copy() for i in t.vertices],
                           [uv.data[i].uv.copy() for i in t.loops] if uv else None))
        evaluated.to_mesh_clear()
    return result

pose()
rest = geometry()
pose(0)
wave_a = geometry()
pose(1)
wave_b = geometry()
assert len(rest) == len(wave_a) == len(wave_b)
vertices = [v for t, _, _ in rest for v in t]
low = Vector(tuple(min(v[i] for v in vertices) for i in range(3)))
high = Vector(tuple(max(v[i] for v in vertices) for i in range(3)))
center = (low + high) * 0.5
scale = 2.4 / (high.z - low.z)
texture = next((im for im in bpy.data.images if im.size[0] > 32 and im.size[1] > 32), None)
pixels = None
if texture:
    w, h = texture.size
    pixels = np.empty(w * h * 4, dtype=np.float32)
    texture.pixels.foreach_get(pixels)
    pixels = pixels.reshape((h, w, 4))

cumulative, area = [], 0.0
for tri, _, _ in rest:
    weight = (tri[1] - tri[0]).cross(tri[2] - tri[0]).length * 0.5
    # Extra resolution on the face/ears, without sacrificing hands and clothing.
    height = sum(v.z for v in tri) / 3
    area += weight * (1.75 if height > 0.64 else 1.0)
    cumulative.append(area)

count = 84000
rng = random.Random(392124)
payload = bytearray(struct.pack('<4sII', b'MKPF', 2, count))
for _ in range(count):
    index = bisect.bisect_left(cumulative, rng.random() * area)
    u, v = math.sqrt(rng.random()), rng.random()
    weights = (1-u, u*(1-v), u*v)
    packed = []
    for shape in (rest, wave_a, wave_b):
        p = (sum((pt * weight for pt, weight in zip(shape[index][0], weights)), Vector()) - center) * scale
        packed.extend(round(x * 8192) for x in (p.x, p.z, -p.y))
    for shape in (rest, wave_a, wave_b):
        n = sum((normal * weight for normal, weight in zip(shape[index][1], weights)), Vector()).normalized()
        packed.extend(round(x * 32767) for x in (n.x, n.z, -n.y))
    luminance = 1.0
    uv = rest[index][2]
    if pixels is not None and uv:
        tex = sum((coord * weight for coord, weight in zip(uv, weights)), Vector((0, 0)))
        rgb = pixels[int((tex.y % 1) * (h-1)), int((tex.x % 1) * (w-1)), :3]
        luminance = max(0, min(1, float(rgb @ np.array([0.2126, 0.7152, 0.0722]))))
    payload.extend(struct.pack('<18hB', *packed, round(luminance * 255)))
os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
with open(destination, 'wb') as f:
    f.write(payload)
print('MAIKO_PERFORMANCE', {'points': count, 'bytes': len(payload), 'texture': texture.name if texture else None,
                           'max_pose_change': max((a-b).length for ra, wa in zip(rest,wave_a) for a,b in zip(ra[0],wa[0]))})
