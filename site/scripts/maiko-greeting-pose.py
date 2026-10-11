"""Run inside Blender, or use from the particle exporter.

Aim each limb in armature space, preserving bone lengths. The greeting moves
the forearm along the elbow hinge, retaining its inherited orientation without
bending the wrist sideways. No mesh or original source file is overwritten.
"""
import bpy
import math
from mathutils import Matrix, Vector


def set_maiko_pose(rig, wave=None):
    for bone in rig.pose.bones:
        bone.matrix_basis.identity()
    bpy.context.view_layer.update()

    def aim(name, direction):
        bone = rig.pose.bones['mixamorig:' + name]
        target = Vector(direction).normalized()
        rotation = (bone.tail-bone.head).normalized().rotation_difference(target).to_matrix().to_4x4()
        pivot = bone.head.copy()
        bone.matrix = Matrix.Translation(pivot) @ rotation @ Matrix.Translation(-pivot) @ bone.matrix
        bpy.context.view_layer.update()

    def rotate_local(name, angle, axis):
        bone = rig.pose.bones['mixamorig:' + name]
        pivot = bone.head.copy()
        direction = bone.matrix.to_3x3().col[axis].normalized()
        rotation = Matrix.Rotation(math.radians(angle), 4, direction)
        bone.matrix = Matrix.Translation(pivot) @ rotation @ Matrix.Translation(-pivot) @ bone.matrix
        bpy.context.view_layer.update()

    def orient_hinge(name, direction, hinge):
        bone = rig.pose.bones['mixamorig:' + name]
        y = direction.normalized()
        x = (hinge - y * hinge.dot(y)).normalized()
        z = x.cross(y).normalized()
        matrix = Matrix((x, y, z)).transposed().to_4x4()
        matrix.translation = bone.head
        bone.matrix = matrix
        bpy.context.view_layer.update()

    aim('RightArm', (-0.24, -0.06, -0.97))
    aim('RightForeArm', (-0.14, -0.18, -0.97))
    if wave is None:
        aim('LeftArm', (0.25, -0.06, -0.97))
        aim('LeftForeArm', (0.17, -0.14, -0.97))
    else:
        # In this FBX, forward is -Y. Define the bend plane explicitly rather
        # than trusting the imported bone roll (its hinge points sideways).
        upper = Vector((0.15, -0.8, -0.58)).normalized()
        forearm = Vector((0.28, -0.4, 0.872)).normalized()
        hinge = upper.cross(forearm).normalized()
        orient_hinge('LeftArm', upper, hinge)
        orient_hinge('LeftForeArm', upper, hinge)
        flexion = math.degrees(upper.angle(forearm))
        rotate_local('LeftForeArm', flexion + (-10 if wave == 0 else 10), 0)
        # The hand inherits the forearm pose. Only a subtle head tilt accompanies it.
        head = rig.pose.bones['mixamorig:Head']
        pivot = head.head.copy()
        rotation = Matrix.Rotation(math.radians(-3 if wave == 0 else 3), 4, 'Y')
        head.matrix = Matrix.Translation(pivot) @ rotation @ Matrix.Translation(-pivot) @ head.matrix
        bpy.context.view_layer.update()


def author_maiko_greeting(rig):
    rig.animation_data_clear()
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 145
    scene.render.fps = 24
    for frame, wave in ((1, None), (48, None), (65, 0), (73, 1), (81, 0), (89, 1), (99, 0), (115, None), (145, None)):
        set_maiko_pose(rig, wave)
        for bone in rig.pose.bones:
            bone.rotation_mode = 'QUATERNION'
            bone.keyframe_insert(data_path='rotation_quaternion', frame=frame, group=bone.name)
            bone.keyframe_insert(data_path='location', frame=frame, group=bone.name)
    scene.frame_set(73)
    print('MAIKO_GREETING_READY', {'frames': scene.frame_end, 'hand': list(rig.pose.bones['mixamorig:LeftHand'].head)})


if __name__ == '__main__':
    author_maiko_greeting(next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE'))
