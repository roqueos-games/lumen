/**
 * LUMEN — pure game engine (no Three.js, no DOM).
 *
 * You steer a living swarm of bioluminescent lights with the pointer.
 * Real Reynolds flocking (separation / alignment / cohesion) plus pointer
 * attraction and predator flee, accelerated by a spatial hash grid so a
 * 200+ agent swarm stays O(n). Shadow predators patrol, hunt the swarm,
 * telegraph and dash — every light they touch goes out. Energy motes grow
 * the swarm; a rare star makes it invulnerable and scares predators away.
 * The run ends when the last light dies.
 *
 * Everything gameplay-critical lives here so it can be unit tested; the Vue
 * component only renders this state and feeds the pointer target.
 */

// ── Tuning constants ─────────────────────────────────────────────────────────
export const START_LIGHTS = 18
export const MAX_LIGHTS = 200
export const LIGHT_SPEED_MIN = 2.2
export const LIGHT_SPEED_MAX = 7.5
export const LIGHT_SPEED_PANIC = 10.5 // allowed while fleeing
export const NEIGHBOR_R = 3 // alignment/cohesion radius
export const SEPARATION_R = 1.25
export const FLEE_R = 6.5 // predator fear radius
export const CELL = 3 // spatial hash cell size

export const W_SEPARATION = 30
export const W_ALIGNMENT = 1.5
export const W_COHESION = 1.0
export const W_TARGET = 6.0 // pointer attraction
export const W_WANDER = 1.4 // idle attraction to a drifting point
export const W_FLEE = 16

export const MOTE_R = 1.45 // collect radius (any light)
export const MOTE_SCORE = 1
export const MOTE_SCORE_CAPPED = 2 // when the swarm is at max size
export const CHUNK = 16 // world cell for procedural mote spawning
export const VIEW_INTEREST = 34 // spawn cells within this radius of the swarm

export const PREDATOR_CAP = 5
export const PREDATOR_EVERY = 22 // seconds between new predators (cap above)
export const PREDATOR_SPEED = 4.2
export const PREDATOR_DASH_SPEED = 16
export const AGGRO_R = 13
export const TELEGRAPH_TIME = 0.55
export const DASH_TIME = 0.6
export const DASH_REST = 1.6
export const KILL_R = 1.0

export const STAR_EVERY = 32 // seconds between star spawns
export const STAR_LIFE = 12 // despawns if not taken
export const STAR_DURATION = 6.5 // invulnerability window
export const STAR_TAKE_R = 1.4

// Background biomes by score (component crossfades CSS gradients).
export const BIOMES = [
  { id: 'abyss', from: 0, top: '#04060f', bottom: '#0d1b33', glow: '#38bdf8' },
  { id: 'kelp', from: 25, top: '#031008', bottom: '#0d3323', glow: '#34d399' },
  { id: 'dusk', from: 60, top: '#0e0518', bottom: '#3b1054', glow: '#c084fc' },
  { id: 'ember', from: 110, top: '#160404', bottom: '#4a1420', glow: '#fb7185' },
  { id: 'aurora', from: 170, top: '#020617', bottom: '#123a4f', glow: '#5eead4' },
]

export const biomeForScore = (s) => {
  let idx = 0
  for (let i = 0; i < BIOMES.length; i++) if (s >= BIOMES[i].from) idx = i
  return idx
}

// ── Deterministic RNG (mulberry32) ───────────────────────────────────────────
export const mulberry32 = (seed) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic per-cell hash rng (world-chunk mote spawning). */
export const cellRng = (cx, cy, seed) => {
  let h = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) ^ Math.imul(seed, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 3266489917)
  h ^= h >>> 16
  return mulberry32(h >>> 0)
}

// ── Spatial hash (neighbor queries in O(1) per light) ────────────────────────
export const buildGrid = (lights) => {
  const grid = new Map()
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]
    const key = `${Math.floor(l.x / CELL)},${Math.floor(l.y / CELL)}`
    let bucket = grid.get(key)
    if (!bucket) {
      bucket = []
      grid.set(key, bucket)
    }
    bucket.push(i)
  }
  return grid
}

export const neighborsOf = (grid, x, y) => {
  const cx = Math.floor(x / CELL)
  const cy = Math.floor(y / CELL)
  const out = []
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucket = grid.get(`${gx},${gy}`)
      if (bucket) out.push(...bucket)
    }
  }
  return out
}

// ── Game state ───────────────────────────────────────────────────────────────
export const createGame = ({ seed = 1 } = {}) => {
  const rng = mulberry32(seed)
  const lights = []
  for (let i = 0; i < START_LIGHTS; i++) {
    const ang = (i / START_LIGHTS) * Math.PI * 2
    const r = 1.5 + rng() * 2
    lights.push({
      x: Math.cos(ang) * r,
      y: Math.sin(ang) * r,
      vx: (rng() - 0.5) * 2,
      vy: (rng() - 0.5) * 2,
      hue: rng(), // 0..1 → component maps to a palette tint
      phase: rng() * Math.PI * 2, // glow pulse offset
    })
  }
  return {
    status: 'ready', // ready | playing | over
    seed,
    rng,
    lights,
    predators: [],
    motes: [],
    star: null, // { x, y, life }
    starPower: 0, // seconds of invulnerability left
    target: null, // { x, y } pointer in world coords (null = wander)
    wander: { x: 0, y: 6, t: 0 },
    spawnedCells: new Set(),
    time: 0,
    score: 0,
    peakLights: START_LIGHTS,
    nextPredatorAt: 10, // first predator after a warm-up
    nextStarAt: STAR_EVERY,
    deathsThisStep: [], // renderer FX (positions of lights lost this step)
  }
}

export const startGame = (state) => {
  if (state.status !== 'ready') return state
  state.status = 'playing'
  return state
}

export const setTarget = (state, target) => {
  state.target = target ? { x: target.x, y: target.y } : null
}

/** Swarm centroid (camera anchor + predator aim). */
export const centroidOf = (lights) => {
  if (!lights.length) return { x: 0, y: 0 }
  let x = 0
  let y = 0
  for (const l of lights) {
    x += l.x
    y += l.y
  }
  return { x: x / lights.length, y: y / lights.length }
}

/** Swarm radius around the centroid (camera zoom driver). */
export const swarmRadius = (lights, c = centroidOf(lights)) => {
  let max = 0
  for (const l of lights) {
    const d = Math.hypot(l.x - c.x, l.y - c.y)
    if (d > max) max = d
  }
  return max
}

// ── Procedural mote spawning (per world chunk, deterministic) ────────────────
export const spawnMotesAround = (state, cx, cy) => {
  const minX = Math.floor((cx - VIEW_INTEREST) / CHUNK)
  const maxX = Math.floor((cx + VIEW_INTEREST) / CHUNK)
  const minY = Math.floor((cy - VIEW_INTEREST) / CHUNK)
  const maxY = Math.floor((cy + VIEW_INTEREST) / CHUNK)
  for (let gx = minX; gx <= maxX; gx++) {
    for (let gy = minY; gy <= maxY; gy++) {
      const key = `${gx},${gy}`
      if (state.spawnedCells.has(key)) continue
      state.spawnedCells.add(key)
      const rng = cellRng(gx, gy, state.seed)
      const count = 1 + Math.floor(rng() * 2) + (rng() < 0.3 ? 1 : 0)
      for (let i = 0; i < count; i++) {
        state.motes.push({
          id: `${key}:${i}`,
          x: gx * CHUNK + rng() * CHUNK,
          y: gy * CHUNK + rng() * CHUNK,
          phase: rng() * Math.PI * 2,
        })
      }
    }
  }
  // Cull far motes (keeps arrays flat on long runs)
  if (state.motes.length > 160) {
    state.motes = state.motes.filter(
      (m) => Math.abs(m.x - cx) < VIEW_INTEREST * 2.2 && Math.abs(m.y - cy) < VIEW_INTEREST * 2.2,
    )
  }
}

// ── Predators ────────────────────────────────────────────────────────────────
const spawnPredator = (state, c) => {
  const ang = state.rng() * Math.PI * 2
  const dist = 26 + state.rng() * 8
  state.predators.push({
    id: state.predators.length + 1,
    x: c.x + Math.cos(ang) * dist,
    y: c.y + Math.sin(ang) * dist,
    vx: 0,
    vy: 0,
    mode: 'patrol', // patrol | hunt | telegraph | dash | rest
    timer: 0,
    dashX: 0,
    dashY: 0,
    heading: ang + Math.PI,
  })
}

const stepPredator = (state, p, dt, c) => {
  const distC = Math.hypot(c.x - p.x, c.y - p.y)
  const speedScale = Math.min(1 + state.time * 0.004, 1.6) // slow difficulty ramp

  if (state.starPower > 0) {
    // Fear: run from the shining swarm
    const d = Math.max(distC, 0.001)
    p.vx = ((p.x - c.x) / d) * PREDATOR_SPEED * 1.4
    p.vy = ((p.y - c.y) / d) * PREDATOR_SPEED * 1.4
    p.mode = 'patrol'
    p.timer = 0
  } else if (p.mode === 'patrol') {
    p.heading += (state.rng() - 0.5) * 1.6 * dt * 4
    p.vx = Math.cos(p.heading) * PREDATOR_SPEED * 0.7
    p.vy = Math.sin(p.heading) * PREDATOR_SPEED * 0.7
    // Drift back toward the action when it strays far
    if (distC > 34) {
      p.vx = ((c.x - p.x) / distC) * PREDATOR_SPEED
      p.vy = ((c.y - p.y) / distC) * PREDATOR_SPEED
    }
    if (distC < AGGRO_R) p.mode = 'hunt'
  } else if (p.mode === 'hunt') {
    const d = Math.max(distC, 0.001)
    p.vx = ((c.x - p.x) / d) * PREDATOR_SPEED * speedScale
    p.vy = ((c.y - p.y) / d) * PREDATOR_SPEED * speedScale
    if (distC < 7.5) {
      p.mode = 'telegraph'
      p.timer = TELEGRAPH_TIME
      // Lock the dash direction at telegraph start (dodgeable!)
      const dd = Math.max(distC, 0.001)
      p.dashX = (c.x - p.x) / dd
      p.dashY = (c.y - p.y) / dd
    }
    if (distC > AGGRO_R * 1.6) p.mode = 'patrol'
  } else if (p.mode === 'telegraph') {
    p.vx *= 0.82
    p.vy *= 0.82
    p.timer -= dt
    if (p.timer <= 0) {
      p.mode = 'dash'
      p.timer = DASH_TIME
    }
  } else if (p.mode === 'dash') {
    p.vx = p.dashX * PREDATOR_DASH_SPEED * speedScale
    p.vy = p.dashY * PREDATOR_DASH_SPEED * speedScale
    p.timer -= dt
    if (p.timer <= 0) {
      p.mode = 'rest'
      p.timer = DASH_REST
    }
  } else if (p.mode === 'rest') {
    p.vx *= 0.9
    p.vy *= 0.9
    p.timer -= dt
    if (p.timer <= 0) p.mode = distC < AGGRO_R ? 'hunt' : 'patrol'
  }

  p.x += p.vx * dt
  p.y += p.vy * dt
}

// ── Main step ────────────────────────────────────────────────────────────────
/**
 * Advance the world by dt (clamped). Returns events for the renderer:
 * collect / grow / lightLost / starSpawn / starTaken / death.
 */
export const stepGame = (state, dt) => {
  const events = []
  if (state.status !== 'playing') return events
  const h = Math.min(dt, 0.05)
  state.time += h
  state.deathsThisStep = []

  const c = centroidOf(state.lights)

  // Wander point drifts when there is no pointer
  state.wander.t += h
  if (state.wander.t > 2.4) {
    state.wander.t = 0
    state.wander.x = c.x + (state.rng() - 0.5) * 16
    state.wander.y = c.y + (state.rng() - 0.5) * 16
  }
  const goal = state.target || state.wander

  // ── Flocking (spatial hash) ────────────────────────────────────────────────
  const grid = buildGrid(state.lights)
  const fleeing = []
  for (let i = 0; i < state.lights.length; i++) {
    const l = state.lights[i]
    let sepX = 0
    let sepY = 0
    let aliX = 0
    let aliY = 0
    let cohX = 0
    let cohY = 0
    let n = 0
    for (const j of neighborsOf(grid, l.x, l.y)) {
      if (j === i) continue
      const o = state.lights[j]
      const dx = l.x - o.x
      const dy = l.y - o.y
      const d = Math.hypot(dx, dy)
      if (d > NEIGHBOR_R || d === 0) continue
      n++
      aliX += o.vx
      aliY += o.vy
      cohX += o.x
      cohY += o.y
      if (d < SEPARATION_R) {
        sepX += (dx / d) * (SEPARATION_R - d)
        sepY += (dy / d) * (SEPARATION_R - d)
      }
    }
    let ax = sepX * W_SEPARATION
    let ay = sepY * W_SEPARATION
    if (n > 0) {
      ax += (aliX / n - l.vx) * W_ALIGNMENT
      ay += (aliY / n - l.vy) * W_ALIGNMENT
      ax += (cohX / n - l.x) * W_COHESION
      ay += (cohY / n - l.y) * W_COHESION
    }
    // Goal attraction (pointer or wander)
    const gx = goal.x - l.x
    const gy = goal.y - l.y
    const gd = Math.hypot(gx, gy) || 0.001
    const wGoal = state.target ? W_TARGET : W_WANDER
    ax += (gx / gd) * wGoal
    ay += (gy / gd) * wGoal
    // Predator flee
    let panicked = false
    if (state.starPower <= 0) {
      for (const p of state.predators) {
        const fx = l.x - p.x
        const fy = l.y - p.y
        const fd = Math.hypot(fx, fy)
        if (fd < FLEE_R && fd > 0) {
          const boost = p.mode === 'dash' ? 1.8 : 1
          ax += (fx / fd) * (FLEE_R - fd) * W_FLEE * boost
          ay += (fy / fd) * (FLEE_R - fd) * W_FLEE * boost
          panicked = true
        }
      }
    }
    fleeing.push(panicked)
    l.vx += ax * h
    l.vy += ay * h
    const sp = Math.hypot(l.vx, l.vy)
    const vmax = panicked ? LIGHT_SPEED_PANIC : LIGHT_SPEED_MAX
    if (sp > vmax) {
      l.vx = (l.vx / sp) * vmax
      l.vy = (l.vy / sp) * vmax
    } else if (sp < LIGHT_SPEED_MIN && sp > 0) {
      l.vx = (l.vx / sp) * LIGHT_SPEED_MIN
      l.vy = (l.vy / sp) * LIGHT_SPEED_MIN
    }
    l.x += l.vx * h
    l.y += l.vy * h
  }

  // ── Predators ──────────────────────────────────────────────────────────────
  if (state.time >= state.nextPredatorAt && state.predators.length < PREDATOR_CAP) {
    spawnPredator(state, c)
    state.nextPredatorAt = state.time + PREDATOR_EVERY
  }
  for (const p of state.predators) stepPredator(state, p, h, c)

  // Dash kills (invulnerable while the star burns)
  if (state.starPower <= 0) {
    for (const p of state.predators) {
      if (p.mode !== 'dash') continue
      for (let i = state.lights.length - 1; i >= 0; i--) {
        const l = state.lights[i]
        if (Math.hypot(l.x - p.x, l.y - p.y) < KILL_R) {
          state.deathsThisStep.push({ x: l.x, y: l.y, hue: l.hue })
          state.lights.splice(i, 1)
          events.push({ type: 'lightLost', x: l.x, y: l.y })
        }
      }
    }
  }

  // ── Motes ──────────────────────────────────────────────────────────────────
  spawnMotesAround(state, c.x, c.y)
  for (let m = state.motes.length - 1; m >= 0; m--) {
    const mote = state.motes[m]
    let taken = false
    for (const l of state.lights) {
      if (Math.hypot(l.x - mote.x, l.y - mote.y) < MOTE_R) {
        taken = true
        break
      }
    }
    if (!taken) continue
    state.motes.splice(m, 1)
    if (state.lights.length < MAX_LIGHTS) {
      const src = state.lights[Math.floor(state.rng() * state.lights.length)] || {
        x: mote.x,
        y: mote.y,
        vx: 0,
        vy: 0,
      }
      state.lights.push({
        x: mote.x,
        y: mote.y,
        vx: src.vx,
        vy: src.vy,
        hue: state.rng(),
        phase: state.rng() * Math.PI * 2,
      })
      state.score += MOTE_SCORE
      events.push({ type: 'grow', x: mote.x, y: mote.y })
    } else {
      state.score += MOTE_SCORE_CAPPED
      events.push({ type: 'collect', x: mote.x, y: mote.y })
    }
    state.peakLights = Math.max(state.peakLights, state.lights.length)
  }

  // ── Star ───────────────────────────────────────────────────────────────────
  if (state.starPower > 0) state.starPower = Math.max(0, state.starPower - h)
  if (!state.star && state.time >= state.nextStarAt) {
    const ang = state.rng() * Math.PI * 2
    state.star = { x: c.x + Math.cos(ang) * 11, y: c.y + Math.sin(ang) * 11, life: STAR_LIFE }
    state.nextStarAt = state.time + STAR_EVERY
    events.push({ type: 'starSpawn', x: state.star.x, y: state.star.y })
  }
  if (state.star) {
    state.star.life -= h
    if (state.star.life <= 0) {
      state.star = null
    } else {
      for (const l of state.lights) {
        if (Math.hypot(l.x - state.star.x, l.y - state.star.y) < STAR_TAKE_R) {
          state.starPower = STAR_DURATION
          state.star = null
          events.push({ type: 'starTaken' })
          break
        }
      }
    }
  }

  // ── Death ──────────────────────────────────────────────────────────────────
  if (state.lights.length === 0) {
    state.status = 'over'
    events.push({ type: 'death' })
  }

  return events
}
