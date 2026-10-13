"""Trusted Blender scene builder. Input is a validated, portable JSON spec."""
import argparse
import bisect
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def report(stage, **values):
    print('JINGCE_PREVIS ' + json.dumps({'stage': stage, **values}, ensure_ascii=True), flush=True)


def rgb(value):
    return tuple(int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1.0,)


def primitive(shape, name, position, size, color, yaw=0, parent=None):
    if shape == 'sphere':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=position)
    elif shape == 'cylinder':
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, location=position)
    else:
        bpy.ops.mesh.primitive_cube_add(size=2, location=position)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_euler.z = math.radians(yaw)
    obj.color = rgb(color)
    material = bpy.data.materials.new(name + '_mat')
    material.diffuse_color = obj.color
    obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    return obj


def sample(keys, time, smooth, field):
    index = min(len(keys) - 2, max(0, bisect.bisect_right([k['time'] for k in keys], time) - 1))
    first, second = keys[index:index + 2]
    u = min(1, max(0, (time - first['time']) / (second['time'] - first['time'])))
    if smooth:
        u = u * u * (3 - 2 * u)
    return Vector(first[field]).lerp(Vector(second[field]), u), index, u


def look(camera, position, target):
    camera.location = position
    direction = Vector(target) - Vector(position)
    if direction.length < 0.01:
        raise ValueError('Camera path crosses its look target. Move the camera or its target.')
    camera.rotation_mode = 'QUATERNION'
    camera.rotation_quaternion = direction.to_track_quat('-Z', 'Y')


def make_actor(actor):
    root = bpy.data.objects.new(actor['id'], None)
    bpy.context.collection.objects.link(root)
    width, depth, height = actor['size']
    legs = []
    if actor['shape'] == 'human':
        primitive('box', actor['id'] + '_body', (0, 0, height * .61), (width * .7, depth, height * .37), actor['color'], parent=root)
        primitive('sphere', actor['id'] + '_head', (0, 0, height * .92), (width * .48, depth * 1.05, height * .17), actor['color'], parent=root)
        # Leg pivot at hip height. Each limb extends down in local coordinates.
        for side in (-1, 1):
            pivot = bpy.data.objects.new(actor['id'] + '_hip_' + str(side), None)
            bpy.context.collection.objects.link(pivot)
            pivot.parent = root
            pivot.location = (side * width * .18, 0, height * .44)
            primitive('box', actor['id'] + '_leg_' + str(side), (0, 0, -height * .21),
                      (width * .24, depth * .75, height * .42), actor['color'], parent=pivot)
            legs.append((pivot, side))
            primitive('box', actor['id'] + '_arm_' + str(side), (side * width * .47, 0, height * .6),
                      (width * .18, depth * .72, height * .35), actor['color'], parent=root)
    else:
        primitive(actor['shape'], actor['id'] + '_proxy', (0, 0, height / 2), actor['size'], actor['color'], parent=root)
    return root, legs


def route(name, points, color):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = .04
    spline = curve.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for point, position in zip(spline.points, points):
        point.co = (*position[:2], .1, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.color = rgb(color)
    material = bpy.data.materials.new(name + '_mat')
    material.diffuse_color = obj.color
    curve.materials.append(material)
    obj.hide_render = True
    return obj


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--engine', choices=['workbench', 'cycles'], default='workbench')
    args = parser.parse_args(argv)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    frames = output / 'frames'
    frames.mkdir(exist_ok=True)
    spec = json.loads(Path(args.spec).read_text(encoding='utf-8-sig'))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH' if args.engine == 'workbench' else 'CYCLES'
    if args.engine == 'cycles':
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 8
        scene.cycles.use_denoising = False
        world = bpy.data.worlds.new('PrevisWorld')
        scene.world = world
        world.use_nodes = True
        world.node_tree.nodes['Background'].inputs['Color'].default_value = (.7, .7, .7, 1)
        world.node_tree.nodes['Background'].inputs['Strength'].default_value = .8
        bpy.ops.object.light_add(type='AREA', location=(0, 0, 10))
        bpy.context.object.data.energy = 1800
        bpy.context.object.data.size = 15
    else:
        scene.display.shading.light = 'STUDIO'
        scene.display.shading.color_type = 'OBJECT'
        scene.display.shading.show_shadows = True
        scene.display.shading.show_cavity = True
        scene.display.shading.cavity_type = 'BOTH'
        scene.display.shading.background_type = 'WORLD'
        scene.world = bpy.data.worlds.new('PrevisWorld')
        scene.world.color = (.12, .13, .15)
    a, b = map(int, spec['ratio'].split(':'))
    edge = spec['resolution']
    scene.render.resolution_x = round(edge * a / b / 2) * 2 if a >= b else edge
    scene.render.resolution_y = round(edge * b / a / 2) * 2 if b >= a else edge
    scene.render.resolution_percentage = 100
    scene.render.fps = spec['fps']
    scene.render.fps_base = 1
    scene.frame_start = 1
    scene.frame_end = round(spec['duration'] * spec['fps'])
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.film_transparent = False
    scene.render.filepath = str(frames / 'frame_')
    primitive('box', 'Floor', (0, 0, -.1), (*spec['world']['size'], .2), spec['world']['color'])
    for item in spec['objects']:
        primitive(item['shape'], item['id'], item['position'], item['size'], item['color'], item['yaw'])
    roots = [(actor, *make_actor(actor)) for actor in spec['actors']]
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = 'PrevisCamera'
    camera.data.lens = spec['camera']['lens']
    camera.data.clip_end = 500
    scene.camera = camera
    # Bake integer frames so Blender 4/5 layered F-Curve APIs need no special handling.
    previous_quaternion = None
    for frame in range(1, scene.frame_end + 1):
        time = (frame - 1) * spec['duration'] / max(1, scene.frame_end - 1)
        scene.frame_set(frame)
        for actor, root, legs in roots:
            position, index, u = sample(actor['keys'], time, actor['interpolation'] == 'smooth', 'position')
            root.location = position
            first, second = actor['keys'][index:index + 2]
            direction = Vector(second['position']) - Vector(first['position'])
            default_yaw = math.degrees(math.atan2(-direction.x, direction.y)) if direction.xy.length > .01 else 0
            start = first.get('yaw', default_yaw)
            end = second.get('yaw', start)
            root.rotation_euler.z = math.radians(start + ((end - start + 180) % 360 - 180) * u)
            root.keyframe_insert(data_path='location', frame=frame)
            root.keyframe_insert(data_path='rotation_euler', frame=frame)
            moving = direction.length > .01
            for leg, side in legs:
                leg.rotation_euler.x = math.sin(time * math.tau * 1.4) * .25 * side if moving else 0
                leg.keyframe_insert(data_path='rotation_euler', frame=frame)
        position, _, _ = sample(spec['camera']['keys'], time, spec['camera']['interpolation'] == 'smooth', 'position')
        target, _, _ = sample(spec['camera']['keys'], time, spec['camera']['interpolation'] == 'smooth', 'target')
        look(camera, position, target)
        if previous_quaternion is not None and previous_quaternion.dot(camera.rotation_quaternion) < 0:
            camera.rotation_quaternion.negate()
        previous_quaternion = camera.rotation_quaternion.copy()
        camera.keyframe_insert(data_path='location', frame=frame)
        camera.keyframe_insert(data_path='rotation_quaternion', frame=frame)
    routes = [route('CameraRoute', [k['position'] for k in spec['camera']['keys']], '#e39e69')]
    routes += [route(actor['id'] + '_route', [k['position'] for k in actor['keys']], actor['color']) for actor in spec['actors']]
    for beat in spec['beats']:
        scene.timeline_markers.new(beat['label'], frame=min(scene.frame_end, 1 + round(beat['time'] * spec['fps'])))
    bpy.ops.object.camera_add(location=(0, 0, 40))
    overview = bpy.context.object
    overview.name = 'TopDownCamera'
    overview.data.type = 'ORTHO'
    # Include the camera route, which can extend beyond the ground footprint.
    coordinates = [key['position'] for key in spec['camera']['keys']] + [[-spec['world']['size'][0]/2, -spec['world']['size'][1]/2, 0], [spec['world']['size'][0]/2, spec['world']['size'][1]/2, 0]]
    xmin, xmax = min(p[0] for p in coordinates), max(p[0] for p in coordinates)
    ymin, ymax = min(p[1] for p in coordinates), max(p[1] for p in coordinates)
    look(overview, ((xmin + xmax)/2, (ymin + ymax)/2, 120), ((xmin + xmax)/2, (ymin + ymax)/2, 0))
    overview.data.clip_end = 500
    overview.data.ortho_scale = max(xmax - xmin, (ymax - ymin) * a / b) * 1.15
    scene.frame_set(1)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'scene.blend'), compress=False)
    report('built', total=scene.frame_end, engine=args.engine)
    scene.camera = overview
    for obj in routes:
        obj.hide_render = False
    scene.render.filepath = str(output / 'overview.png')
    bpy.ops.render.render(write_still=True)
    for obj in routes:
        obj.hide_render = True
    scene.camera = camera
    for frame in range(1, scene.frame_end + 1):
        scene.frame_set(frame)
        scene.render.filepath = str(frames / ('frame_%04d.png' % frame))
        bpy.ops.render.render(write_still=True)
        report('frame', frame=frame, total=scene.frame_end)
    report('rendered', total=scene.frame_end)


if __name__ == '__main__':
    main()
