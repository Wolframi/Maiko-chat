"""Blender --background --factory-startup --python scripts/retarget-maiko-dance.py
-- target.blend source.fbx output.blend

Transfer armature-space rotation deltas, accounting for each rig's bind axes.
Copying quaternion curves by bone name alone twists elbows when bone rolls differ.
The target scene supplies its mesh, weights, proportions and scaled root travel.
"""
import bpy
import os
import math
import sys
from mathutils import Quaternion

target_path, source_path, destination = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=os.path.abspath(target_path))
scene = bpy.context.scene
target = next(o for o in scene.objects if o.type == 'ARMATURE')
original_objects = set(bpy.data.objects)
bpy.ops.import_scene.fbx(filepath=os.path.abspath(source_path))
imported = [o for o in bpy.data.objects if o not in original_objects]
source = next(o for o in imported if o.type == 'ARMATURE')
start, end = (int(v) for v in source.animation_data.action.frame_range)
bones = list(target.data.bones)
assert all(b.name in source.data.bones for b in bones)
target_rest = {b.name: b.matrix_local.to_quaternion() for b in bones}
source_rest = {b.name: source.data.bones[b.name].matrix_local.to_quaternion() for b in bones}
alignment = target.matrix_world.to_quaternion().inverted() @ source.matrix_world.to_quaternion()
samples = []
for frame in range(start, end + 1):
    scene.frame_set(frame)
    rotations = {}
    for b in bones:
        delta = source.pose.bones[b.name].matrix.to_quaternion() @ source_rest[b.name].inverted()
        rotations[b.name] = alignment @ delta @ alignment.inverted() @ target_rest[b.name]
    samples.append((frame, rotations, target.pose.bones['mixamorig:Hips'].location.copy()))

target.animation_data_clear()
target.animation_data_create()
target.animation_data.action = bpy.data.actions.new('Maiko bind-aware dance')
previous = {}
max_error = 0.0
for frame, rotations, root_location in samples:
    for b in bones:
        parent_rest = target_rest[b.parent.name] if b.parent else Quaternion()
        parent_pose = rotations[b.parent.name] if b.parent else Quaternion()
        relative_rest = parent_rest.inverted() @ target_rest[b.name]
        q = relative_rest.inverted() @ parent_pose.inverted() @ rotations[b.name]
        if b.name in previous and q.dot(previous[b.name]) < 0:
            q.negate()
        previous[b.name] = q.copy()
        pb = target.pose.bones[b.name]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = q
        pb.location = root_location if b.name == 'mixamorig:Hips' else (0, 0, 0)
        pb.scale = (1, 1, 1)
        pb.keyframe_insert(data_path='rotation_quaternion', frame=frame, group=b.name)
        if b.name == 'mixamorig:Hips':
            pb.keyframe_insert(data_path='location', frame=frame, group=b.name)
    bpy.context.view_layer.update()
    for b in bones:
        actual = target.pose.bones[b.name].matrix.to_quaternion()
        error = 2 * math.acos(min(1.0, abs(actual.normalized().dot(rotations[b.name].normalized()))))
        max_error = max(max_error, error)
assert max_error < 0.002, f'Retarget rotation error: {max_error}'
for obj in imported:
    bpy.data.objects.remove(obj, do_unlink=True)
scene.frame_start, scene.frame_end = start, end
scene.frame_set(start)
os.makedirs(os.path.dirname(os.path.abspath(destination)), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(destination))
print('MAIKO_RETARGET', {'frames': len(samples), 'bones': len(bones), 'max_rotation_error': max_error}, flush=True)
