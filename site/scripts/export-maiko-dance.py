"""Export a supplied FBX or Blender scene to compact skinned surface particles.

MKAN v1: <4sIIIIIff (32 bytes): magic/version/points/bones/frames/fps/duration/0.
Each point: 3h position /8192, 3h normal /32767, 4B joints, 4B weights /255,
1B texture luminance (21 bytes). Each frame/bone: 12h /4096, column-major
affine 3x4 skin matrix in normalized browser coordinates. Fourth row is 0,0,0,1.
"""
import bpy, bisect, math, os, random, struct, sys
sys.dont_write_bytecode=True
import numpy as np
from mathutils import Vector, Matrix
source,destination,seconds=sys.argv[sys.argv.index('--')+1:]
if source.lower().endswith('.fbx'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(source))
else:
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(source))
scene=bpy.context.scene
scene.frame_set(1)
rig=next(o for o in scene.objects if o.type=='ARMATURE')
obj=next(o for o in scene.objects if o.type=='MESH')
mesh=obj.data
mesh.calc_loop_triangles()
world=obj.matrix_world.copy()
dg=bpy.context.evaluated_depsgraph_get()
ev=obj.evaluated_get(dg)
posed=ev.to_mesh()
coords=[world@v.co for v in posed.vertices]
low=Vector(tuple(min(v[i] for v in coords) for i in range(3)))
high=Vector(tuple(max(v[i] for v in coords) for i in range(3)))
center=(low+high)*.5
scale=2.4/(high.z-low.z)
ev.to_mesh_clear()
conversion=Matrix(((scale,0,0,-center.x*scale),(0,0,scale,-center.z*scale),(0,-scale,0,center.y*scale),(0,0,0,1)))
inverse=conversion.inverted()
normal_matrix=(conversion@world).to_3x3().inverted().transposed()
bones=list(rig.data.bones)
assert len(bones)<256
bone_index={b.name:i for i,b in enumerate(bones)}
group_index={g.index:bone_index[g.name] for g in obj.vertex_groups if g.name in bone_index}
vertex_weights=[]
for v in mesh.vertices:
    weights={group_index[g.group]:g.weight for g in v.groups if g.group in group_index and g.weight>0}
    assert weights, 'Unbound surface vertex'
    vertex_weights.append(weights)
texture=next((n.image for mat in mesh.materials if mat and mat.node_tree for n in mat.node_tree.nodes if n.type=='TEX_IMAGE' and n.image),None)
pixels=None
if texture:
    w,h=texture.size
    pixels=np.empty(w*h*4,dtype=np.float32)
    texture.pixels.foreach_get(pixels)
    pixels=pixels.reshape((h,w,4))
uv=mesh.uv_layers.active
triangles=list(mesh.loop_triangles)
cumulative=[]
area=0
for tri in triangles:
    vs=[mesh.vertices[i].co for i in tri.vertices]
    area+=(vs[1]-vs[0]).cross(vs[2]-vs[0]).length*.5
    cumulative.append(area)
count=84000
fps=24
source_fps=scene.render.fps/scene.render.fps_base
duration=min(float(seconds),(rig.animation_data.action.frame_range[1]-1)/source_fps)
frames=math.ceil(duration*fps)+1
duration=(frames-1)/fps
payload=bytearray(struct.pack('<4sIIIIIff',b'MKAN',1,count,len(bones),frames,fps,duration,0))
rng=random.Random(4228724)
for i in range(count):
    tri=triangles[bisect.bisect_left(cumulative,rng.random()*area)]
    u,v=math.sqrt(rng.random()),rng.random()
    bary=(1-u,u*(1-v),u*v)
    verts=[mesh.vertices[j] for j in tri.vertices]
    p=conversion@world@sum((vert.co*weight for vert,weight in zip(verts,bary)),Vector())
    n=(normal_matrix@sum((vert.normal*weight for vert,weight in zip(verts,bary)),Vector())).normalized()
    merged={}
    for vi,b in zip(tri.vertices,bary):
        for joint,weight in vertex_weights[vi].items(): merged[joint]=merged.get(joint,0)+b*weight
    top=sorted(merged.items(),key=lambda item:item[1],reverse=True)[:4]
    total=sum(weight for _,weight in top)
    joints=[joint for joint,_ in top]+[0]*(4-len(top))
    quant=[round(weight/total*255) for _,weight in top]+[0]*(4-len(top))
    quant[0]+=255-sum(quant)
    luminance=1
    if pixels is not None and uv:
        tex=sum((uv.data[loop].uv*weight for loop,weight in zip(tri.loops,bary)),Vector((0,0)))
        rgb=pixels[int((tex.y%1)*(h-1)),int((tex.x%1)*(w-1)),:3]
        luminance=max(0,min(1,float(rgb@np.array([.2126,.7152,.0722]))))
    payload.extend(struct.pack('<6h9B',*[round(c*8192) for c in p],*[round(c*32767) for c in n],*joints,*quant,round(luminance*255)))
scene.frame_set(1)
first_root=rig.matrix_world@rig.pose.bones['mixamorig:Hips'].head
rest_inverse=[b.matrix_local.inverted() for b in bones]
rig_world=rig.matrix_world.copy()
rig_inverse=rig_world.inverted()
maximum=0
for frame in range(frames):
    source_frame=min(float(rig.animation_data.action.frame_range[1]),1+frame/fps*source_fps)
    scene.frame_set(int(source_frame),subframe=source_frame%1)
    root=rig_world@rig.pose.bones['mixamorig:Hips'].head
    # Ground the lowest sole on the same plane in every pose. Mixamo clips can
    # otherwise hover or intersect the platform as their root height changes.
    dg=bpy.context.evaluated_depsgraph_get()
    evaluated=obj.evaluated_get(dg)
    floor=min((evaluated.matrix_world@Vector(corner)).z for corner in evaluated.bound_box)
    drift=Matrix.Translation(Vector((first_root.x-root.x,first_root.y-root.y,low.z-floor)))
    for bone,rest in zip(bones,rest_inverse):
        palette=conversion@drift@rig_world@rig.pose.bones[bone.name].matrix@rest@rig_inverse@inverse
        vals=[palette[row][col] for col in range(4) for row in range(3)]
        maximum=max(maximum,max(abs(x) for x in vals))
        assert maximum<7.999, 'Skin palette exceeds quantization range'
        payload.extend(struct.pack('<12h',*[round(x*4096) for x in vals]))
os.makedirs(os.path.dirname(os.path.abspath(destination)),exist_ok=True)
with open(destination,'wb') as file: file.write(payload)
print('MAIKO_DANCE',{'points':count,'bones':len(bones),'frames':frames,'seconds':duration,'bytes':len(payload),'texture':texture.name if texture else None,'max_palette':maximum})
