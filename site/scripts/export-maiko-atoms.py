"""Run with Blender --background --python scripts/export-maiko-atoms.py -- source.fbx output.bin.

Samples the supplied model, without modifying it. MKAT v1: 12-byte header
(magic, uint32 version, uint32 count), then int16 x/y/z (scale 8192) and
int16 normal x/y/z (scale 32767), little endian. Browser coordinates are Y-up.
"""
import bisect
import math
import os
import random
import struct
import sys
sys.dont_write_bytecode = True

import bpy
from mathutils import Vector
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('maiko_greeting_pose', os.path.join(os.path.dirname(__file__), 'maiko-greeting-pose.py'))
greeting = module_from_spec(spec)
spec.loader.exec_module(greeting)

source, destination = sys.argv[sys.argv.index('--') + 1:]
if source.lower().endswith('.blend'):
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(source))
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(source))
bpy.context.scene.frame_set(1)
# Pose the supplied rig in memory; the original FBX is never overwritten.
rig = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
rig.animation_data_clear()
greeting.set_maiko_pose(rig)
for side in ('Left', 'Right'):
    assert rig.pose.bones['mixamorig:' + side + 'Hand'].head.z < rig.pose.bones['mixamorig:' + side + 'Arm'].head.z - 0.15
depsgraph = bpy.context.evaluated_depsgraph_get()
triangles, cumulative = [], []
area = 0.0
for obj in bpy.context.scene.objects:
    if obj.type != 'MESH' or obj.hide_render:
        continue
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    matrix = evaluated.matrix_world
    normal_matrix = matrix.to_3x3().inverted().transposed()
    for triangle in mesh.loop_triangles:
        vertices = [matrix @ mesh.vertices[i].co for i in triangle.vertices]
        weight = (vertices[1] - vertices[0]).cross(vertices[2] - vertices[0]).length * 0.5
        if weight < 1e-12:
            continue
        normals = [(normal_matrix @ mesh.vertices[i].normal).normalized() for i in triangle.vertices]
        area += weight
        cumulative.append(area)
        triangles.append((vertices, normals))
    evaluated.to_mesh_clear()
assert triangles, 'Source model has no mesh triangles'
vertices = [v for triangle, _ in triangles for v in triangle]
low = Vector(tuple(min(v[i] for v in vertices) for i in range(3)))
high = Vector(tuple(max(v[i] for v in vertices) for i in range(3)))
center = (low + high) * 0.5
scale = 2.4 / max(high - low)
rng = random.Random(392124)
count = 6800
payload = bytearray(struct.pack('<4sII', b'MKAT', 1, count))
for _ in range(count):
    triangle, normals = triangles[bisect.bisect_left(cumulative, rng.random() * area)]
    u = math.sqrt(rng.random())
    v = rng.random()
    weights = (1 - u, u * (1 - v), u * v)
    p = (sum((point * w for point, w in zip(triangle, weights)), Vector()) - center) * scale
    n = sum((normal * w for normal, w in zip(normals, weights)), Vector()).normalized()
    payload.extend(struct.pack('<6h', *(round(value * 8192) for value in (p.x, p.z, -p.y)),
                               *(round(value * 32767) for value in (n.x, n.z, -n.y))))
os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
with open(destination, 'wb') as output:
    output.write(payload)
print('MAIKO_ATOMS', {'source': os.path.basename(source), 'points': count, 'bytes': len(payload),
                      'bounds': [list(low), list(high)], 'output': destination})
