import { describe, it, expect } from 'vitest'
import {
  START_LIGHTS,
  MAX_LIGHTS,
  LIGHT_SPEED_PANIC,
  SEPARATION_R,
  KILL_R,
  STAR_DURATION,
  MOTE_SCORE,
  TELEGRAPH_TIME,
  DASH_TIME,
  BIOMES,
  biomeForScore,
  mulberry32,
  cellRng,
  buildGrid,
  neighborsOf,
  createGame,
  startGame,
  setTarget,
  centroidOf,
  swarmRadius,
  spawnMotesAround,
  stepGame,
} from '../src/engine.js'

const playing = (seed = 7) => startGame(createGame({ seed }))

const stepFor = (state, seconds, dt = 1 / 60) => {
  const all = []
  for (let t = 0; t < seconds; t += dt) all.push(...stepGame(state, dt))
  return all
}

describe('lumen engine', () => {
  describe('rng & spatial hash', () => {
    it('mulberry32 and cellRng are deterministic per seed', () => {
      const a = mulberry32(9)
      const b = mulberry32(9)
      expect([a(), a()]).toEqual([b(), b()])
      const c1 = cellRng(3, -2, 42)
      const c2 = cellRng(3, -2, 42)
      const c3 = cellRng(4, -2, 42)
      expect(c1()).toBe(c2())
      expect(c1()).not.toBe(c3())
    })

    it('grid neighbor query matches brute force on a small set', () => {
      const lights = [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2.5, y: 0.5 },
        { x: 40, y: 40 },
      ]
      const grid = buildGrid(lights)
      const near = neighborsOf(grid, 0, 0)
      expect(near).toContain(0)
      expect(near).toContain(1)
      expect(near).toContain(2)
      expect(near).not.toContain(3)
    })
  })

  describe('createGame / basics', () => {
    it('starts ready with the initial swarm and no threats', () => {
      const g = createGame({ seed: 1 })
      expect(g.status).toBe('ready')
      expect(g.lights).toHaveLength(START_LIGHTS)
      expect(g.predators).toHaveLength(0)
      expect(g.score).toBe(0)
      expect(stepGame(g, 1 / 60)).toEqual([]) // no-op before start
    })

    it('is deterministic per seed (same first seconds of simulation)', () => {
      const a = playing(33)
      const b = playing(33)
      stepFor(a, 1)
      stepFor(b, 1)
      expect(a.lights.map((l) => [l.x, l.y])).toEqual(b.lights.map((l) => [l.x, l.y]))
      expect(a.motes).toEqual(b.motes)
    })
  })

  describe('flocking', () => {
    it('the swarm follows the pointer target (centroid moves toward it)', () => {
      const g = playing()
      setTarget(g, { x: 30, y: 0 })
      const before = centroidOf(g.lights)
      stepFor(g, 2)
      const after = centroidOf(g.lights)
      expect(after.x).toBeGreaterThan(before.x + 4)
      const distBefore = Math.hypot(30 - before.x, 0 - before.y)
      const distAfter = Math.hypot(30 - after.x, 0 - after.y)
      expect(distAfter).toBeLessThan(distBefore)
    })

    it('separation keeps lights from collapsing onto one point', () => {
      const g = playing()
      // Squeeze everyone onto (almost) the same spot
      for (const l of g.lights) {
        l.x = (Math.random() - 0.5) * 0.01
        l.y = (Math.random() - 0.5) * 0.01
      }
      stepFor(g, 1.2)
      let minPair = Infinity
      for (let i = 0; i < g.lights.length; i++) {
        for (let j = i + 1; j < g.lights.length; j++) {
          const d = Math.hypot(g.lights[i].x - g.lights[j].x, g.lights[i].y - g.lights[j].y)
          if (d < minPair) minPair = d
        }
      }
      expect(minPair).toBeGreaterThan(SEPARATION_R * 0.12) // spread back out
    })

    it('cohesion keeps a scattered swarm together (radius shrinks)', () => {
      const g = playing()
      // Scattered on a FIXED ring rather than at random: with `Math.random()`
      // an unlucky draw could start the swarm already near the target, where
      // three steps do not measurably shrink the radius, and the whole gate
      // failed on a coin toss (seen 2026-07-29). The claim is unchanged.
      g.lights.forEach((l, i) => {
        const a = (i / g.lights.length) * Math.PI * 2
        l.x = Math.cos(a) * 12
        l.y = Math.sin(a) * 12
      })
      setTarget(g, { x: 0, y: 0 })
      const r0 = swarmRadius(g.lights)
      stepFor(g, 3)
      expect(swarmRadius(g.lights)).toBeLessThan(r0)
    })

    it('lights flee a predator and may exceed normal max speed while panicking', () => {
      const g = playing()
      const c = centroidOf(g.lights)
      g.predators.push({
        id: 99,
        x: c.x,
        y: c.y,
        vx: 0,
        vy: 0,
        mode: 'dash',
        timer: 99,
        dashX: 1,
        dashY: 0,
        heading: 0,
      })
      // Keep the predator harmless for this test (kill radius 0 away? use far dash timer)
      // Move it slightly off-center so flee has a direction, and disable kills by star power.
      g.predators[0].x += 0.5
      g.starPower = 0
      stepFor(g, 0.3)
      const speeds = g.lights.map((l) => Math.hypot(l.vx, l.vy))
      expect(Math.max(...speeds)).toBeGreaterThan(7.6) // above LIGHT_SPEED_MAX
      expect(Math.max(...speeds)).toBeLessThanOrEqual(LIGHT_SPEED_PANIC + 1e-9)
      // And they actually moved away
      const dists = g.lights.map((l) => Math.hypot(l.x - g.predators[0].x, l.y - g.predators[0].y))
      expect(Math.min(...dists)).toBeGreaterThan(0.4)
    })
  })

  describe('motes', () => {
    it('spawning is per-cell deterministic and collecting grows swarm + score', () => {
      const g = playing(5)
      spawnMotesAround(g, 0, 0)
      expect(g.motes.length).toBeGreaterThan(0)
      const mote = g.motes[0]
      g.motes = [mote] // isolate: only the target mote can be collected this step
      // Teleport a light onto the mote
      g.lights[0].x = mote.x
      g.lights[0].y = mote.y
      const before = g.lights.length
      const ev = stepGame(g, 1 / 60)
      expect(g.lights.length).toBe(before + 1)
      expect(g.score).toBeGreaterThanOrEqual(MOTE_SCORE)
      expect(ev.some((e) => e.type === 'grow')).toBe(true)
      expect(g.motes.find((m) => m.id === mote.id)).toBeUndefined()
    })

    it('at MAX_LIGHTS the swarm stops growing but scores double', () => {
      const g = playing(5)
      spawnMotesAround(g, 0, 0)
      // Fake a full swarm
      while (g.lights.length < MAX_LIGHTS) {
        g.lights.push({ x: 999, y: 999, vx: 0, vy: 0, hue: 0.5, phase: 0 })
      }
      const mote = g.motes[0]
      g.lights[0].x = mote.x
      g.lights[0].y = mote.y
      const before = g.lights.length
      const scoreBefore = g.score
      const ev = stepGame(g, 1 / 60)
      expect(g.lights.length).toBe(before)
      expect(g.score - scoreBefore).toBeGreaterThanOrEqual(2)
      expect(ev.some((e) => e.type === 'collect')).toBe(true)
    })
  })

  describe('predators', () => {
    it('spawns after the warm-up and hunts → telegraphs → dashes', () => {
      const g = playing(3)
      setTarget(g, { x: 0, y: 0 })
      stepFor(g, 11)
      expect(g.predators.length).toBeGreaterThanOrEqual(1)
      const p = g.predators[0]
      // Drop it right next to the swarm: it must telegraph then dash
      const c = centroidOf(g.lights)
      p.x = c.x + 5
      p.y = c.y
      p.mode = 'hunt'
      let seenTelegraph = false
      let seenDash = false
      for (let t = 0; t < 3; t += 1 / 60) {
        stepGame(g, 1 / 60)
        if (p.mode === 'telegraph') seenTelegraph = true
        if (p.mode === 'dash') seenDash = true
        if (seenDash) break
      }
      expect(seenTelegraph).toBe(true)
      expect(seenDash).toBe(true)
      expect(TELEGRAPH_TIME).toBeGreaterThan(0.3) // dodgeable by design
      expect(DASH_TIME).toBeGreaterThan(0)
    })

    it('a dashing predator kills lights it touches (and emits events)', () => {
      const g = playing()
      // Cluster the whole swarm at the origin so the dash can't miss.
      for (const l of g.lights) {
        l.x = 0
        l.y = 0
        l.vx = 0
        l.vy = 0
      }
      // Predator dashing straight through the cluster.
      g.predators.push({
        id: 1,
        x: -0.2,
        y: 0,
        vx: 0,
        vy: 0,
        mode: 'dash',
        timer: DASH_TIME,
        dashX: 1,
        dashY: 0,
        heading: 0,
      })
      const before = g.lights.length
      const events = []
      for (let i = 0; i < 4; i++) events.push(...stepGame(g, 1 / 60))
      expect(g.lights.length).toBeLessThan(before)
      expect(events.some((e) => e.type === 'lightLost')).toBe(true)
      expect(KILL_R).toBeGreaterThan(0)
    })

    it('losing every light ends the run', () => {
      const g = playing()
      g.lights = [g.lights[0]]
      g.predators.push({
        id: 1,
        x: g.lights[0].x,
        y: g.lights[0].y,
        vx: 0,
        vy: 0,
        mode: 'dash',
        timer: DASH_TIME,
        dashX: 0,
        dashY: 0,
        heading: 0,
      })
      const ev = stepGame(g, 1 / 60)
      expect(g.status).toBe('over')
      expect(ev.some((e) => e.type === 'death')).toBe(true)
    })
  })

  describe('star', () => {
    it('spawns on schedule, grants invulnerability and scares predators away', () => {
      const g = playing(9)
      g.nextStarAt = 0.01
      stepFor(g, 0.1)
      expect(g.star).toBeTruthy()
      // Take it
      g.lights[0].x = g.star.x
      g.lights[0].y = g.star.y
      const ev = stepGame(g, 1 / 60)
      expect(ev.some((e) => e.type === 'starTaken')).toBe(true)
      expect(g.starPower).toBeGreaterThan(STAR_DURATION - 0.5)

      // Invulnerable: a dashing predator on top kills nothing…
      const c = centroidOf(g.lights)
      g.predators.push({
        id: 1,
        x: c.x,
        y: c.y,
        vx: 0,
        vy: 0,
        mode: 'dash',
        timer: DASH_TIME,
        dashX: 1,
        dashY: 0,
        heading: 0,
      })
      const before = g.lights.length
      stepGame(g, 1 / 60)
      expect(g.lights.length).toBe(before)
      // …and predators run AWAY from the swarm while it shines
      const p = g.predators[0]
      const dBefore = Math.hypot(p.x - c.x, p.y - c.y)
      stepFor(g, 0.5)
      const c2 = centroidOf(g.lights)
      expect(Math.hypot(p.x - c2.x, p.y - c2.y)).toBeGreaterThan(dBefore)
    })
  })

  describe('helpers', () => {
    it('centroid/radius and biome thresholds behave', () => {
      const lights = [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
      ]
      const c = centroidOf(lights)
      expect(c).toEqual({ x: 2, y: 0 })
      expect(swarmRadius(lights, c)).toBe(2)
      expect(biomeForScore(0)).toBe(0)
      expect(biomeForScore(BIOMES[2].from)).toBe(2)
      expect(biomeForScore(99999)).toBe(BIOMES.length - 1)
    })
  })

  describe('long-run integrity (pointer bot survives and grows)', () => {
    it('steering toward motes grows the swarm without state corruption', () => {
      const g = playing(21)
      let guard = 0
      while (g.status === 'playing' && g.time < 12 && guard++ < 1600) {
        const c = centroidOf(g.lights)
        // Aim at the nearest mote (simple greedy bot)
        let best = null
        let bd = Infinity
        for (const m of g.motes) {
          const d = Math.hypot(m.x - c.x, m.y - c.y)
          if (d < bd) {
            bd = d
            best = m
          }
        }
        setTarget(g, best ? { x: best.x, y: best.y } : null)
        stepGame(g, 1 / 60)
      }
      expect(g.status).toBe('playing') // survives the warm-up window
      expect(g.score).toBeGreaterThan(2)
      expect(g.lights.length).toBeGreaterThan(START_LIGHTS)
      expect(g.peakLights).toBeGreaterThanOrEqual(g.lights.length)
      for (const l of g.lights) {
        expect(Number.isFinite(l.x)).toBe(true)
        expect(Number.isFinite(l.y)).toBe(true)
      }
    })
  })
})
