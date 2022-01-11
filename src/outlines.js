const m = require('makerjs')
const u = require('./utils')
const a = require('./assert')
const o = require('./operation')
const Point = require('./point')
const prep = require('./prepare')
const anchor = require('./anchor').parse
const filter = require('./filter').parse

const binding = (base, bbox, point, units) => {

    let bind = a.trbl(point.meta.bind || 0, `${point.meta.name}.bind`)(units)
    // if it's a mirrored key, we swap the left and right bind values
    if (point.meta.mirrored) {
        bind = [bind[0], bind[3], bind[2], bind[1]]
    }

    const bt = Math.max(bbox.high[1], 0) + Math.max(bind[0], 0)
    const br = Math.max(bbox.high[0], 0) + Math.max(bind[1], 0)
    const bd = Math.min(bbox.low[1], 0) - Math.max(bind[2], 0)
    const bl = Math.min(bbox.low[0], 0) - Math.max(bind[3], 0)

    if (bind[0] || bind[1]) base = u.union(base, u.rect(br, bt))
    if (bind[1] || bind[2]) base = u.union(base, u.rect(br, -bd, [0, bd]))
    if (bind[2] || bind[3]) base = u.union(base, u.rect(-bl, -bd, [bl, bd]))
    if (bind[3] || bind[0]) base = u.union(base, u.rect(-bl, bt, [bl, 0]))

    return base
}

const rectangle = (config, name, points, outlines, units) => {

    // prepare params
    a.unexpected(config, `${name}`, ['size', 'corner', 'bevel'])
    const size = a.wh(params.size, `${export_name}.size`)(units)
    const rec_units = prep.extend({
        sx: size[0],
        sy: size[1]
    }, units)
    const corner = a.sane(params.corner || 0, `${export_name}.corner`, 'number')(rec_units)
    const bevel = a.sane(params.bevel || 0, `${export_name}.bevel`, 'number')(rec_units)

    // return shape function
    return (point, bound) => {

        const error = (dim, val) => `Rectangle for "${name}" isn't ${dim} enough for its corner and bevel (${val} - 2 * ${corner} - 2 * ${bevel} <= 0)!`
        const [w, h] = size
        const mod = 2 * (corner + bevel)
        const cw = w - mod
        a.assert(cw >= 0, error('wide', w))
        const ch = h - mod
        a.assert(ch >= 0, error('tall', h))

        let rect = new m.models.Rectangle(cw, ch)
        if (bevel) {
            rect = u.poly([
                [-bevel, 0],
                [-bevel, ch],
                [0, ch + bevel],
                [cw, ch + bevel],
                [cw + bevel, ch],
                [cw + bevel, 0],
                [cw, -bevel],
                [0, -bevel]
            ])
        }
        if (corner > 0) rect = m.model.outline(rect, corner, 0)
        rect = m.model.moveRelative(res, [-cw/2, -ch/2])
        if (bound) {
            const bbox = {high: [w/2, h/2], low: [-w/2, -h/2]}
            rect = binding(rect, bbox, point, rec_units)
        }
        rect = point.position(rect)

        return rect
    }
}

const circle = (config, name, points, outlines, units) => {

    // prepare params
    a.unexpected(config, `${name}`, ['radius'])
    const radius = a.sane(config.radius, `${name}.radius`, 'number')(units)
    const circ_units = prep.extend({
        r: radius
    }, units)

    // return shape function
    return (point, bound) => {
        let circle = u.circle([0, 0], radius)
        if (bound) {
            const bbox = {high: [radius, radius], low: [-radius, -radius]}
            circle = binding(circle, bbox, point, circ_units)
        }
        circle = point.position(circle)
        return circle
    }
}

const polygon = (config, name, points, outlines, units) => {

    // prepare params
    a.unexpected(config, `${name}`, ['points'])
    const poly_points = a.sane(config.points, `${name}.points`, 'array')()

    // return shape function
    return (point, bound) => {
        const parsed_points = []
        let last_anchor = new Point()
        let poly_index = -1
        for (const poly_point of poly_points) {
            const poly_name = `${name}.points[${++poly_index}]`
            last_anchor = anchor(poly_point, poly_name, points, true, last_anchor)(units)
            parsed_points.push(last_anchor.p)
        }
        let poly = u.poly(parsed_points)
        if (bound) {
            const bbox = u.bbox(parsed_points)
            poly = binding(poly, bbox, point, units)
        }
        poly = point.position(poly)
        return poly
    }
}

const outline = (config, name, points, outlines, units) => {

    // prepare params
    a.unexpected(config, `${name}`, ['name', 'fillet', 'expand', 'origin'])
    a.assert(outlines[config.name], `Field "${name}.name" does not name an existing outline!`)
    const fillet = a.sane(config.fillet || 0, `${name}.fillet`, 'number')(units)
    const expand = a.sane(config.expand || 0, `${name}.expand`, 'number')(units)
    const joints = a.in(a.sane(config.joints || 0, `${name}.joints`, 'number')(units), `${name}.joints`, [0, 1, 2])
    const origin = anchor(config.origin, `${name}.origin`, points)(units)

    // return shape function
    return (point, bound) => {
        let o = u.deepcopy(outlines[config.name])
        o = origin.unposition(o)

        if (fillet) {
            for (const [index, chain] of m.model.findChains(o).entries()) {
                o.models[`fillet_${index}`] = m.chain.fillet(chain, fillet)
            }
        }

        if (expand) {
            o = m.model.outline(o, Math.abs(expand), joints, (expand < 0), {farPoint: u.farPoint})
        }

        if (bound) {
            const bbox = m.measure.modelExtents(o)
            o = binding(o, bbox, point, units)
        }

        o = point.position(o)
        return o
    }
}

const whats = {
    rectangle,
    circle,
    polygon,
    outline
}

exports.parse = (config = {}, points = {}, units = {}) => {

    // output outlines will be collected here
    const outlines = {}

    // the config must be an actual object so that the exports have names
    config = a.sane(config, 'outlines', 'object')()
    for (let [outline_name, parts] of Object.entries(config)) {

        // placeholder for the current outline
        outlines[outline_name] = {models: {}}

        // each export can consist of multiple parts
        // either sub-objects or arrays are fine...
        if (a.type(parts)() == 'array') {
            parts = {...parts}
        }
        parts = a.sane(parts, `outlines.${key}`, 'object')()
        
        for (let [part_name, part] of Object.entries(parts)) {
            
            const name = `outlines.${key}.${part_name}`

            // string part-shortcuts are expanded first
            if (a.type(part)() == 'string') {
                part = o.operation(part, {outline: Object.keys(outlines)})
            }

            // process keys that are common to all part declarations
            const operation = u[a.in(part.operation || 'add', `${name}.operation`, ['add', 'subtract', 'intersect', 'stack'])]
            const what = a.in(part.what || 'outline', `${name}.what`, ['rectangle', 'circle', 'polygon', 'outline'])
            const bound_by_default = ['rectangle']
            const bound = part.bound === undefined ? bound_by_default.includes(what) : !!part.bound
            const mirror = a.sane(part.mirror || false, `${name}.mirror`, 'boolean')()
            // `where` is delayed until we have all, potentially what-dependent units
            // default where is the single default anchor (at [0,0])
            const where = units => filter(part.where || {}, `${name}.where`, points, units, mirror)

            // these keys are then removed, so ops can check their own unexpected keys without interference
            delete part.operation
            delete part.what
            delete part.bound
            delete part.mirror
            delete part.where

            // a prototype "shape" maker (and its units) are computed
            const [shape_maker, shape_units] = whats[what](part, name, points, outlines, units)

            // and then the shape is repeated for all where positions
            for (const w of where(shape_units)) {
                const shape = shape_maker(w, bound)
                outlines[outline_name] = operation(outlines[outline_name], shape)
            }
        }

        // final adjustments
        m.model.originate(outlines[outline_name])
        m.model.simplify(outlines[outline_name])

    }

    return outlines
}   
