<template>
  <div
    ref="rootRef"
    class="ros-lumen"
    :class="{ 'ros-lumen--low': modoLeve }"
    :dir="estado.idioma === 'ar-AR' ? 'rtl' : 'ltr'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
  >
    <!-- Biome background — two layers crossfaded as the score climbs -->
    <div
      class="ros-lumen__bg"
      :class="{ 'ros-lumen__bg--visible': activeBgLayer === 0 }"
      :style="bgLayerA"
    />
    <div
      class="ros-lumen__bg"
      :class="{ 'ros-lumen__bg--visible': activeBgLayer === 1 }"
      :style="bgLayerB"
    />

    <canvas ref="canvasRef" class="ros-lumen__canvas" />

    <!-- HUD -->
    <div v-if="status === 'playing'" class="ros-lumen__hud" aria-hidden="true">
      <div class="ros-lumen__score">{{ scoreDisplay }}</div>
      <div class="ros-lumen__lights">✦ {{ lightsDisplay }}</div>
      <transition name="lumen-pop">
        <div v-if="starActive" class="ros-lumen__starpill">★ {{ starLeft }}s</div>
      </transition>
    </div>

    <div v-if="best > 0 && status === 'playing'" class="ros-lumen__best-badge" aria-hidden="true">
      👑 {{ best }}
    </div>

    <!-- Sound toggle -->
    <button
      class="ros-lumen__sound"
      :aria-label="muted ? txt('soundOff') : txt('soundOn')"
      @pointerdown.stop
      @click.stop="toggleMute"
    >
      <Icone :nome="muted ? 'mudo' : 'som'" :tamanho="20" />
    </button>

    <!-- Start screen -->
    <div v-if="status === 'ready'" class="ros-lumen__start">
      <div class="ros-lumen__logo">{{ txt('title') }}</div>
      <div class="ros-lumen__tagline">{{ txt('tagline') }}</div>
      <div v-if="best > 0" class="ros-lumen__start-best">👑 {{ txt('best') }} · {{ best }}</div>
      <div class="ros-lumen__cta">{{ txt('tapToPlay') }}</div>
    </div>

    <!-- First-run hint -->
    <div v-if="showHint && status === 'playing'" class="ros-lumen__hint">
      {{ txt('hint') }}
    </div>

    <!-- Pause overlay -->
    <div v-if="paused" class="ros-lumen__pause">
      <div class="ros-lumen__pause-title">{{ txt('paused') }}</div>
      <div class="ros-lumen__pause-cta">{{ txt('tapToResume') }}</div>
    </div>

    <!-- Game over -->
    <div v-if="status === 'over'" class="ros-lumen__over">
      <div class="ros-lumen__over-card">
        <div class="ros-lumen__over-label">{{ txt('score') }}</div>
        <div class="ros-lumen__over-score">{{ scoreDisplay }}</div>
        <div v-if="isRecord" class="ros-lumen__over-record">🏆 {{ txt('newRecord') }}</div>
        <div class="ros-lumen__over-stats">
          <span>✦ {{ txt('peak') }} {{ peakDisplay }}</span>
          <span class="ros-lumen__over-dot">·</span>
          <span>👑 {{ txt('best') }} {{ best }}</span>
          <span class="ros-lumen__over-dot">·</span>
          <span>{{ txt('games') }} {{ games }}</span>
        </div>
        <div class="ros-lumen__over-actions">
          <button class="ros-lumen__btn-play" @pointerdown.stop @click.stop="restart">
            {{ txt('playAgain') }}
          </button>
          <button class="ros-lumen__btn-share" @pointerdown.stop @click.stop="shareScore">
            <Icone nome="compartilhar" :tamanho="16" />
            {{ txt('share') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// O Lumen. Fala com o sistema só pelo `host` do jogo-sdk: placar, áudio, modo
// leve, métricas, avisos e armazenamento chegam por ele, e é por isso que o
// mesmo arquivo roda dentro do RoqueOS, no `yarn dev` do repo e no teste.
//
// ⚠️ Tudo o que toca a GPU (renderer e opções, pixel ratio, materiais, o
// remendo de shader do enxame, texturas, o corte de qualidade do modo leve)
// veio do componente do front SEM MUDANÇA. Mudar qualquer linha disso pede
// teste no iPhone de verdade antes de ir para produção.
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as THREE from 'three'
import { emModoE2E } from '@roqueos-games/jogo-sdk'
import {
  MAX_LIGHTS,
  BIOMES,
  createGame,
  startGame,
  stepGame,
  setTarget,
  centroidOf,
  swarmRadius,
  biomeForScore,
} from './engine.js'
import { criarSom } from './som.js'
import { traduzir } from './textos.js'
import Icone from './Icone.vue'

const props = defineProps({
  /** O host do contrato v1 do jogo-sdk. */
  host: { type: Object, required: true },
  /** `{ ativo, idioma, textos }`, reativo; quem escreve é o `montar` do jogo. */
  estado: { type: Object, required: true },
})

const host = props.host
const txt = (chave, valores) => traduzir(props.estado.textos, chave, valores)

// ── Reactive UI (engine state itself is NON-reactive — perf) ─────────────────
const rootRef = ref(null)
const canvasRef = ref(null)
const status = ref('ready')
const scoreDisplay = ref(0)
const lightsDisplay = ref(0)
const peakDisplay = ref(0)
const starActive = ref(false)
const starLeft = ref(0)
const best = ref(0)
const games = ref(0)
const muted = ref(false)
const paused = ref(false)
const isRecord = ref(false)
const showHint = ref(false)
const activeBgLayer = ref(0)
const bgLayerA = ref({})
const bgLayerB = ref({})
const modoLeve = ref(false)

// ── Engine + Three internals (plain) ─────────────────────────────────────────
let game = null
let renderer = null
let scene = null
let camera = null
let world = null
let glowTexture = null

// Swarm — one THREE.Points, capacity MAX_LIGHTS (draw-count = live lights)
let swarmGeo = null
let swarmPoints = null
let swarmPos = null // Float32Array(MAX*3)
let swarmColor = null // Float32Array(MAX*3)
let swarmSize = null // Float32Array(MAX)

// Trail echoes — a ring buffer of faint points behind the swarm
let trailGeo = null
let trailPoints = null
let trailPos = null
let trailColor = null
const TRAIL_CAP = 260
let trailHead = 0
let trailFill = 0
let trailAccum = 0

// Motes — one Points
let moteGeo = null
let motePoints = null
let motePos = null
const MOTE_CAP = 200

// Predators (few) — sprites
let predatorSprites = []
let starSprite = null
let fx = [] // {mesh, vx, vy, life, ttl, grow?}
let rafId = 0
let lastT = 0
let running = false
let resizeObserver = null
let currentBiome = -1
let camX = 0
let camY = 0
let camZoom = 9
let lowEnd = false
const pendingTimers = new Set()

const PALETTE = [
  new THREE.Color('#38bdf8'),
  new THREE.Color('#22d3ee'),
  new THREE.Color('#a78bfa'),
  new THREE.Color('#f0abfc'),
  new THREE.Color('#5eead4'),
  new THREE.Color('#93c5fd'),
]

const later = (fn, ms) => {
  const id = setTimeout(() => {
    pendingTimers.delete(id)
    fn()
  }, ms)
  pendingTimers.add(id)
}

// ── Audio (fully procedural) ─────────────────────────────────────────────────
const som = criarSom(host.audio, () => muted.value)

// Chamado de dentro do gesto (toque, clique, tecla), sem `await` antes: o iOS
// só libera o áudio assim.
const primeAudio = () => {
  try {
    host.audio.destravar()?.catch?.(() => {})
  } catch {
    /* best-effort */
  }
}

const buzz = (pattern) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* best-effort */
  }
}

const toggleMute = () => {
  muted.value = !muted.value
  if (muted.value) som.calarFundo()
  host.armazenamento.gravar('muted', muted.value ? '1' : '0')
}

// ── Background biomes ────────────────────────────────────────────────────────
const applyBiome = (idx, instant = false) => {
  if (idx === currentBiome) return
  currentBiome = idx
  const b = BIOMES[idx]
  const grad = { background: `radial-gradient(120% 90% at 50% 20%, ${b.bottom} 0%, ${b.top} 75%)` }
  if (instant) {
    bgLayerA.value = grad
    activeBgLayer.value = 0
  } else if (activeBgLayer.value === 0) {
    bgLayerB.value = grad
    activeBgLayer.value = 1
  } else {
    bgLayerA.value = grad
    activeBgLayer.value = 0
  }
}

// ── Three.js scene ───────────────────────────────────────────────────────────
const makeGlowTexture = () => {
  const cv = document.createElement('canvas')
  cv.width = 64
  cv.height = 64
  const g = cv.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(cv)
}

const makeSprite = (color, scale, opacity = 0.85) => {
  const mat = new THREE.SpriteMaterial({
    map: glowTexture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const s = new THREE.Sprite(mat)
  s.scale.setScalar(scale)
  return s
}

const initThree = () => {
  // O perfil leve vem do host (`desempenho.modoLeve`); o que ele corta abaixo é
  // o de antes da extração.
  lowEnd = Boolean(host.desempenho.modoLeve())
  modoLeve.value = lowEnd
  scene = new THREE.Scene()
  world = new THREE.Group()
  scene.add(world)
  glowTexture = makeGlowTexture()

  camera = new THREE.OrthographicCamera(-15, 15, 15, -15, -100, 100)
  camera.position.z = 10

  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    alpha: true,
    antialias: !lowEnd,
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1.25 : 2))

  // Swarm points (additive glow, per-vertex color + size)
  swarmPos = new Float32Array(MAX_LIGHTS * 3)
  swarmColor = new Float32Array(MAX_LIGHTS * 3)
  swarmSize = new Float32Array(MAX_LIGHTS)
  swarmGeo = new THREE.BufferGeometry()
  swarmGeo.setAttribute('position', new THREE.BufferAttribute(swarmPos, 3))
  swarmGeo.setAttribute('color', new THREE.BufferAttribute(swarmColor, 3))
  swarmGeo.setAttribute('asize', new THREE.BufferAttribute(swarmSize, 1))
  swarmGeo.setDrawRange(0, 0)
  swarmPoints = new THREE.Points(swarmGeo, makeSwarmMaterial())
  swarmPoints.frustumCulled = false
  world.add(swarmPoints)

  // Trail echoes
  trailPos = new Float32Array(TRAIL_CAP * 3)
  trailColor = new Float32Array(TRAIL_CAP * 3)
  trailGeo = new THREE.BufferGeometry()
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3))
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailColor, 3))
  trailGeo.setDrawRange(0, 0)
  trailPoints = new THREE.Points(
    trailGeo,
    new THREE.PointsMaterial({
      map: glowTexture,
      vertexColors: true,
      size: 8,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  trailPoints.frustumCulled = false
  world.add(trailPoints)

  // Motes
  motePos = new Float32Array(MOTE_CAP * 3)
  moteGeo = new THREE.BufferGeometry()
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3))
  moteGeo.setDrawRange(0, 0)
  motePoints = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({
      map: glowTexture,
      color: new THREE.Color('#fde68a'),
      size: 12,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  motePoints.frustumCulled = false
  world.add(motePoints)

  handleResize()
}

/** Points material with per-vertex size via a tiny onBeforeCompile patch. */
const makeSwarmMaterial = () => {
  const mat = new THREE.PointsMaterial({
    map: glowTexture,
    vertexColors: true,
    size: 15,
    sizeAttenuation: false,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float asize;\n' +
      shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * asize;')
  }
  return mat
}

const handleResize = () => {
  if (!renderer || !rootRef.value) return
  const w = rootRef.value.clientWidth || 640
  const h = rootRef.value.clientHeight || 480
  renderer.setSize(w, h, false)
  updateCamera(true)
}

const updateCamera = (instant = false) => {
  if (!camera || !renderer) return
  const { width, height } = renderer.domElement.getBoundingClientRect()
  const aspect = (width || 640) / (height || 480)
  const halfH = camZoom
  const halfW = halfH * aspect
  camera.left = -halfW
  camera.right = halfW
  camera.top = halfH
  camera.bottom = -halfH
  camera.updateProjectionMatrix()
  if (instant) {
    camera.position.x = camX
    camera.position.y = camY
  }
}

// ── Pointer (continuous control) ─────────────────────────────────────────────
const screenToWorld = (clientX, clientY) => {
  const rect = renderer.domElement.getBoundingClientRect()
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1
  const ny = -(((clientY - rect.top) / rect.height) * 2 - 1)
  return {
    x: camX + nx * (camera.right - camera.left) * 0.5,
    y: camY + ny * (camera.top - camera.bottom) * 0.5,
  }
}

let pointerDown = false

const handlePrimary = (clientX, clientY) => {
  if (paused.value) {
    paused.value = false
    return
  }
  if (status.value === 'ready') {
    start()
    if (clientX != null) setTarget(game, screenToWorld(clientX, clientY))
    return
  }
  if (status.value === 'playing' && clientX != null) {
    setTarget(game, screenToWorld(clientX, clientY))
  }
}

const onPointerDown = (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  pointerDown = true
  primeAudio()
  handlePrimary(e.clientX, e.clientY)
}

const onPointerMove = (e) => {
  if (!pointerDown || status.value !== 'playing' || paused.value) return
  setTarget(game, screenToWorld(e.clientX, e.clientY))
}

const onPointerUp = () => {
  pointerDown = false
  if (game && status.value === 'playing') setTarget(game, null) // release → swarm wanders
}

// Só a janela ativa ouve o teclado. O ouvinte é do `window`, então com duas
// janelas de jogo abertas o Espaço valeria nas duas; o `ativo` vem do host (a
// janela em foco, no RoqueOS).
const onKeyDown = (e) => {
  if (!props.estado.ativo) return
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return
  if (status.value === 'over') return
  e.preventDefault()
  primeAudio()
  if (paused.value) paused.value = false
  else if (status.value === 'ready') start()
}

// ── FX ───────────────────────────────────────────────────────────────────────
const spawnBurst = (x, y, color, count, speed, size) => {
  if (lowEnd) count = Math.ceil(count / 2)
  for (let i = 0; i < count; i++) {
    const s = makeSprite(color, size * (0.6 + Math.random() * 0.7), 0.9)
    s.position.set(x, y, 0.2)
    world.add(s)
    const ang = Math.random() * Math.PI * 2
    const sp = speed * (0.5 + Math.random() * 0.8)
    fx.push({
      mesh: s,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 0,
      ttl: 0.5 + Math.random() * 0.3,
    })
  }
}

const spawnRing = (x, y, color) => {
  const s = makeSprite(color, 1.4, 0.7)
  s.position.set(x, y, 0.25)
  world.add(s)
  fx.push({ mesh: s, vx: 0, vy: 0, life: 0, ttl: 0.5, grow: 10 })
}

// ── Game flow ────────────────────────────────────────────────────────────────
// As chaves `best`, `games`, `muted` e `seen` viram `roqueos:lumen:<chave>` no
// host, as mesmas de antes da extração: quem já jogava não perde o recorde, e a
// galeria continua lendo o best dali. O host já engole a exceção do modo
// privado (null na leitura, false na escrita).
const seenBefore = () => host.armazenamento.ler('seen') === '1'
const markSeen = () => {
  host.armazenamento.gravar('seen', '1')
}

const loadLocal = () => {
  best.value = parseInt(host.armazenamento.ler('best'), 10) || 0
  games.value = parseInt(host.armazenamento.ler('games'), 10) || 0
  muted.value = host.armazenamento.ler('muted') === '1'
}

const persistScores = () => {
  host.armazenamento.gravar('best', String(best.value))
  host.armazenamento.gravar('games', String(games.value))
  Promise.resolve()
    .then(() => host.placar.salvar({ best: best.value, games: games.value }))
    .catch(() => {})
}

// O placar da conta ganha do local quando é maior, e o local sobe quando é o
// maior. Convidado não tem placar na conta: o host devolve null no carregar e
// ignora o salvar.
const syncRemote = async () => {
  try {
    const remote = await host.placar.carregar()
    if (remote) {
      if ((remote.best || 0) > best.value) best.value = remote.best
      if ((remote.games || 0) > games.value) games.value = remote.games
      host.armazenamento.gravar('best', String(best.value))
      host.armazenamento.gravar('games', String(games.value))
    }
    if (best.value > (remote?.best || 0)) {
      await host.placar.salvar({ best: best.value, games: games.value })
    }
  } catch (err) {
    console.error('[LUMEN] Score sync failed:', err)
  }
}

const start = () => {
  startGame(game)
  status.value = 'playing'
  showHint.value = !seenBefore()
  if (showHint.value) {
    later(() => {
      showHint.value = false
      markSeen()
    }, 5600)
    markSeen()
  }
  som.ligarFundo()
  host.metricas.evento('game_start')
}

const finishGame = () => {
  status.value = 'over'
  games.value += 1
  isRecord.value = game.score > 0 && game.score > best.value
  if (isRecord.value) best.value = game.score
  persistScores()
  som.perder()
  buzz([40, 60, 120])
  const c = centroidOf(game.lights.length ? game.lights : [{ x: camX, y: camY }])
  spawnBurst(c.x, c.y, new THREE.Color('#93c5fd'), 22, 8, 0.8)
  host.metricas.evento('game_over', { score: game.score })
}

const restart = (seed) => {
  game = createGame({ seed: typeof seed === 'number' ? seed : Math.floor(Math.random() * 1e9) })
  status.value = 'ready'
  isRecord.value = false
  scoreDisplay.value = 0
  lightsDisplay.value = 0
  peakDisplay.value = 0
  starActive.value = false
  som.zerarSequencia()
  trailHead = 0
  trailFill = 0
  currentBiome = -1
  for (const p of predatorSprites) world.remove(p.mesh)
  predatorSprites = []
  if (starSprite) {
    world.remove(starSprite)
    starSprite = null
  }
  for (const p of fx) world.remove(p.mesh)
  fx = []
  const c = centroidOf(game.lights)
  camX = c.x
  camY = c.y
  camZoom = 9
  applyBiome(0)
  start()
}

// ── Sync engine → buffers ────────────────────────────────────────────────────
const syncSwarm = () => {
  const lights = game.lights
  const n = Math.min(lights.length, MAX_LIGHTS)
  const shine = game.starPower > 0
  for (let i = 0; i < n; i++) {
    const l = lights[i]
    swarmPos[i * 3] = l.x
    swarmPos[i * 3 + 1] = l.y
    swarmPos[i * 3 + 2] = 0
    const base = PALETTE[Math.floor(l.hue * PALETTE.length) % PALETTE.length]
    const pulse = 0.75 + 0.25 * Math.sin(game.time * 3 + l.phase)
    const boost = shine ? 1.5 : 1
    swarmColor[i * 3] = Math.min(base.r * pulse * boost, 1)
    swarmColor[i * 3 + 1] = Math.min(base.g * pulse * boost, 1)
    swarmColor[i * 3 + 2] = Math.min(base.b * pulse * boost, 1)
    swarmSize[i] = (1.05 + 0.4 * pulse) * (shine ? 1.5 : 1)
  }
  swarmGeo.setDrawRange(0, n)
  swarmGeo.attributes.position.needsUpdate = true
  swarmGeo.attributes.color.needsUpdate = true
  swarmGeo.attributes.asize.needsUpdate = true
}

const pushTrail = (dt) => {
  trailAccum += dt
  const interval = lowEnd ? 0.06 : 0.03
  if (trailAccum < interval || !game.lights.length) return
  trailAccum = 0
  // Sample a handful of lights into the ring buffer
  const step = Math.max(1, Math.floor(game.lights.length / 10))
  for (let i = 0; i < game.lights.length; i += step) {
    const l = game.lights[i]
    const idx = trailHead % TRAIL_CAP
    trailPos[idx * 3] = l.x
    trailPos[idx * 3 + 1] = l.y
    trailPos[idx * 3 + 2] = -0.1
    const base = PALETTE[Math.floor(l.hue * PALETTE.length) % PALETTE.length]
    trailColor[idx * 3] = base.r * 0.6
    trailColor[idx * 3 + 1] = base.g * 0.6
    trailColor[idx * 3 + 2] = base.b * 0.6
    trailHead++
    trailFill = Math.min(trailFill + 1, TRAIL_CAP)
  }
  trailGeo.setDrawRange(0, trailFill)
  trailGeo.attributes.position.needsUpdate = true
  trailGeo.attributes.color.needsUpdate = true
}

const syncMotes = () => {
  const n = Math.min(game.motes.length, MOTE_CAP)
  for (let i = 0; i < n; i++) {
    motePos[i * 3] = game.motes[i].x
    motePos[i * 3 + 1] = game.motes[i].y
    motePos[i * 3 + 2] = -0.05
  }
  moteGeo.setDrawRange(0, n)
  moteGeo.attributes.position.needsUpdate = true
}

const syncPredators = () => {
  // Grow/shrink the sprite pool to match live predators
  while (predatorSprites.length < game.predators.length) {
    const core = makeSprite(new THREE.Color('#1e0a1e'), 3.4, 0.92)
    const ring = makeSprite(new THREE.Color('#ff2d6f'), 4.6, 0.0)
    world.add(core)
    world.add(ring)
    predatorSprites.push({ core, ring })
  }
  while (predatorSprites.length > game.predators.length) {
    const p = predatorSprites.pop()
    world.remove(p.core)
    world.remove(p.ring)
  }
  for (let i = 0; i < game.predators.length; i++) {
    const p = game.predators[i]
    const s = predatorSprites[i]
    s.core.position.set(p.x, p.y, 0.3)
    s.ring.position.set(p.x, p.y, 0.28)
    // Telegraph flash: ring blooms bright just before a dash
    let ringOp = 0.12
    let ringScale = 4.6
    if (p.mode === 'telegraph') {
      const k = 0.5 + 0.5 * Math.sin(game.time * 40)
      ringOp = 0.4 + 0.5 * k
      ringScale = 5 + k * 2
    } else if (p.mode === 'dash') {
      ringOp = 0.7
      ringScale = 6.5
    }
    s.ring.material.opacity = ringOp
    s.ring.scale.setScalar(ringScale)
    s.core.scale.setScalar(p.mode === 'dash' ? 4 : 3.4)
  }
}

const syncStar = () => {
  if (game.star && !starSprite) {
    starSprite = makeSprite(new THREE.Color('#fff7cc'), 3, 1)
    world.add(starSprite)
  } else if (!game.star && starSprite) {
    world.remove(starSprite)
    starSprite = null
  }
  if (game.star && starSprite) {
    starSprite.position.set(game.star.x, game.star.y, 0.4)
    const pulse = 2.6 + 0.9 * Math.sin(game.time * 6)
    starSprite.scale.setScalar(pulse)
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
const step = (dt) => {
  if (status.value === 'playing' && !paused.value) {
    const events = stepGame(game, dt)
    let grew = false
    let lost = false
    for (const ev of events) {
      if (ev.type === 'grow') {
        grew = true
        spawnRing(ev.x, ev.y, new THREE.Color('#a7f3d0'))
      } else if (ev.type === 'collect') {
        grew = true
      } else if (ev.type === 'lightLost') {
        lost = true
        spawnBurst(ev.x, ev.y, new THREE.Color('#6b7280'), 4, 4, 0.4)
      } else if (ev.type === 'starTaken') {
        som.estrela()
        buzz([12, 30, 12])
        spawnBurst(
          game.lights.length ? game.lights[0].x : camX,
          camY,
          new THREE.Color('#fff7cc'),
          18,
          7,
          0.7,
        )
      } else if (ev.type === 'death') {
        finishGame()
      }
    }
    if (grew) {
      som.coletar()
      if (events.some((e) => e.type === 'grow')) som.nascer()
      buzz(8)
    }
    if (lost) {
      som.perder()
      buzz([25, 40])
    }

    if (scoreDisplay.value !== game.score) scoreDisplay.value = game.score
    if (lightsDisplay.value !== game.lights.length) lightsDisplay.value = game.lights.length
    if (peakDisplay.value !== game.peakLights) peakDisplay.value = game.peakLights
    const starOn = game.starPower > 0
    if (starActive.value !== starOn) starActive.value = starOn
    if (starOn) starLeft.value = Math.ceil(game.starPower)

    const biome = biomeForScore(game.score)
    if (biome !== currentBiome) applyBiome(biome)
    pushTrail(dt)
  }

  // Sync buffers every frame (cheap: typed arrays)
  syncSwarm()
  syncMotes()
  syncPredators()
  syncStar()

  // FX
  fx = fx.filter((p) => {
    p.life += dt
    const k = p.life / p.ttl
    if (k >= 1) {
      world.remove(p.mesh)
      if (p.mesh.material) p.mesh.material.dispose()
      return false
    }
    p.mesh.position.x += p.vx * dt
    p.mesh.position.y += p.vy * dt
    p.mesh.material.opacity = (p.grow ? 0.7 : 0.9) * (1 - k)
    if (p.grow) p.mesh.scale.setScalar(p.mesh.scale.x + p.grow * dt)
    return true
  })

  // Camera: follow centroid, zoom to fit the swarm radius
  const c = centroidOf(game.lights.length ? game.lights : [{ x: camX, y: camY }])
  const r = swarmRadius(game.lights, c)
  const targetZoom = Math.max(8, Math.min(r * 1.6 + 4.5, 22))
  const ease = Math.min(1, dt * 3.2)
  camX += (c.x - camX) * ease
  camY += (c.y - camY) * ease
  if (Math.abs(targetZoom - camZoom) > 0.02) {
    camZoom += (targetZoom - camZoom) * Math.min(1, dt * 2)
    updateCamera()
  }
  camera.position.set(camX, camY, 10)

  // Ambient pad swells with swarm size + danger
  const sizeLevel = game.lights.length / MAX_LIGHTS
  som.nivelDoFundo(status.value === 'playing' && !paused.value ? 0.3 + sizeLevel * 0.7 : 0)
}

const tick = (now) => {
  if (!running) return
  const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0
  lastT = now
  step(dt)
  renderer.render(scene, camera)
  rafId = requestAnimationFrame(tick)
}

const startLoop = () => {
  if (running || !renderer) return
  running = true
  lastT = 0
  rafId = requestAnimationFrame(tick)
}

const stopLoop = () => {
  running = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

// ── Share ────────────────────────────────────────────────────────────────────
const composeShareCard = () => {
  const w = 1080
  const h = 1350
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  const biome = BIOMES[Math.max(0, currentBiome)]
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, biome.top)
  grad.addColorStop(1, biome.bottom)
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  renderer.render(scene, camera)
  const src = renderer.domElement
  const bandY = 330
  const bandH = 760
  const scale = Math.max(w / src.width, bandH / src.height)
  g.drawImage(
    src,
    (w - src.width * scale) / 2,
    bandY + (bandH - src.height * scale) / 2,
    src.width * scale,
    src.height * scale,
  )
  const top = g.createLinearGradient(0, 0, 0, 430)
  top.addColorStop(0, 'rgba(0,0,0,0.6)')
  top.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = top
  g.fillRect(0, 0, w, 430)
  const bottom = g.createLinearGradient(0, h - 260, 0, h)
  bottom.addColorStop(0, 'rgba(0,0,0,0)')
  bottom.addColorStop(1, 'rgba(0,0,0,0.65)')
  g.fillStyle = bottom
  g.fillRect(0, h - 260, w, 260)
  g.textAlign = 'center'
  g.fillStyle = 'rgba(255,255,255,0.8)'
  g.font = '600 44px -apple-system, "Segoe UI", Roboto, sans-serif'
  g.fillText(txt('score').toUpperCase(), w / 2, 150)
  g.fillStyle = '#ffffff'
  g.font = '200 300px -apple-system, "Segoe UI", Roboto, sans-serif'
  g.fillText(String(game.score), w / 2, 420)
  g.fillStyle = 'rgba(255,255,255,0.92)'
  g.font = '700 52px -apple-system, "Segoe UI", Roboto, sans-serif'
  g.fillText(`${txt('title')} · RoqueOS`, w / 2, h - 120)
  g.fillStyle = 'rgba(255,255,255,0.65)'
  g.font = '400 36px -apple-system, "Segoe UI", Roboto, sans-serif'
  g.fillText('roqueos.com.br', w / 2, h - 62)
  return c
}

const shareScore = async () => {
  try {
    const text = txt('shareText', { score: game.score })
    const url = 'https://roqueos.com.br'
    let blob = null
    try {
      const card = composeShareCard()
      blob = await new Promise((resolve) => card.toBlob(resolve, 'image/png'))
    } catch {
      blob = null
    }
    if (blob && navigator.share && navigator.canShare) {
      const file = new File([blob], 'lumen-score.png', { type: 'image/png' })
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title: txt('title') })
        return
      }
    }
    if (navigator.share) {
      await navigator.share({ text, url, title: txt('title') })
      return
    }
    if (blob) {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'lumen-score.png'
      a.click()
      later(() => URL.revokeObjectURL(a.href), 4000)
      host.avisar(txt('shareSaved'), { tipo: 'sucesso' })
    }
  } catch (err) {
    if (err?.name === 'AbortError') return
    console.error('[LUMEN] Share failed:', err)
    // Era `errors.operationFailed` do RoqueOS. O texto veio para o JSON do jogo,
    // o mesmo nos dez idiomas, porque fora do RoqueOS esse namespace não existe.
    host.avisar(txt('operationFailed'), { tipo: 'erro' })
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
// Perder o foco (a janela no RoqueOS, a aba no `yarn dev`) pausa a partida e
// para o laço; voltar retoma o laço, e a pausa sai com um toque.
watch(
  () => props.estado.ativo,
  (active) => {
    if (!active) {
      if (status.value === 'playing') paused.value = true
      som.nivelDoFundo(0)
      stopLoop()
    } else {
      startLoop()
    }
  },
)

const onVisibility = () => {
  if (document.hidden) {
    if (status.value === 'playing') paused.value = true
    som.nivelDoFundo(0)
    stopLoop()
  } else if (props.estado.ativo) {
    startLoop()
  }
}

let pararIdentidade = null

onMounted(() => {
  loadLocal()
  game = createGame({ seed: Math.floor(Math.random() * 1e9) })
  applyBiome(0, true)
  initThree()
  const c = centroidOf(game.lights)
  camX = c.x
  camY = c.y
  syncRemote()
  // Quem entra na conta com o jogo aberto vê o recorde da conta sem reabrir.
  pararIdentidade = host.identidade.aoMudar(() => syncRemote())
  startLoop()

  resizeObserver = new ResizeObserver(handleResize)
  resizeObserver.observe(rootRef.value)
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('visibilitychange', onVisibility)

  if (emModoE2E()) {
    window.__lumen = {
      get state() {
        return game
      },
      start,
      steer: (wx, wy) => setTarget(game, { x: wx, y: wy }),
      release: () => setTarget(game, null),
      restart,
      kill: () => {
        if (status.value === 'playing') {
          game.lights = []
          finishGame()
        }
      },
    }
  }
})

onUnmounted(() => {
  stopLoop()
  som.pararFundo()
  for (const id of pendingTimers) clearTimeout(id)
  pendingTimers.clear()
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('visibilitychange', onVisibility)
  resizeObserver?.disconnect()
  pararIdentidade?.()
  if (emModoE2E()) delete window.__lumen
  for (const p of fx) world?.remove(p.mesh)
  swarmGeo?.dispose()
  swarmPoints?.material.dispose()
  trailGeo?.dispose()
  trailPoints?.material.dispose()
  moteGeo?.dispose()
  motePoints?.material.dispose()
  glowTexture?.dispose()
  renderer?.dispose()
  renderer = null
  scene = null
  camera = null
})
</script>

<style scoped lang="scss">
.ros-lumen {
  // Cores de identidade do jogo, como custom property para que um tema consiga
  // alcançá-las. As de texto, véu, borda e sombra herdam o token do RoqueOS
  // quando ele existe e caem no valor que o RoqueOS dá a ele hoje (tema padrão)
  // quando o jogo roda sozinho, porque fora do RoqueOS não há `tokens-root.scss`
  // nenhum carregado.
  --ros-lumen-texto: var(--ros-text, rgba(255, 255, 255, 0.95));
  --ros-lumen-texto-100: var(--ros-text-100, #ffffff);
  --ros-lumen-texto-suave: var(--ros-text-muted, rgba(255, 255, 255, 0.72));
  --ros-lumen-texto-sutil: var(--ros-text-subtle, rgba(255, 255, 255, 0.62));
  --ros-lumen-borda-sutil: var(--ros-border-subtle, rgba(255, 255, 255, 0.12));
  --ros-lumen-preenchimento-06: var(--ros-fill-06, rgba(255, 255, 255, 0.06));
  --ros-lumen-preenchimento-14: var(--ros-fill-14, rgba(255, 255, 255, 0.14));
  --ros-lumen-sombra-50: var(--ros-shadow-50, rgba(0, 0, 0, 0.5));
  --ros-lumen-sombra-lg: var(--ros-shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.4));
  --ros-lumen-veu-30: var(--ros-scrim-30, rgba(0, 0, 0, 0.3));
  --ros-lumen-veu-50: var(--ros-scrim-50, rgba(0, 0, 0, 0.5));
  --ros-lumen-preto-rgb: var(--ros-black-rgb, 0, 0, 0);
  --ros-lumen-desfoque: var(--ros-backdrop-blur, blur(20px));
  --ros-lumen-fg-1: #7dd3fc;
  --ros-lumen-fg-2: #fde68a;
  --ros-lumen-bg-1: #a5f3fc;
  --ros-lumen-bg-2: #818cf8;
  --ros-lumen-bg-3: #f0abfc;
  --ros-lumen-shadow-1: rgba(129, 140, 248, 0.4);
  --ros-lumen-bg-4: rgba(12, 18, 30, 0.68);
  --ros-lumen-bg-5: #38bdf8;
  --ros-lumen-bg-6: rgba(12, 18, 30, 0.95);
}

.ros-lumen {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  cursor: crosshair;

  &__bg {
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity 2s ease;
    pointer-events: none;

    &--visible {
      opacity: 1;
    }
  }

  &__canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  // ── HUD ─────────────────────────────────────────────────────────────────────
  &__hud {
    position: absolute;
    top: 16px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    pointer-events: none;
  }

  &__score {
    font-size: 56px;
    font-weight: 200;
    line-height: 1;
    color: var(--ros-lumen-texto);
    text-shadow: 0 2px 20px var(--ros-lumen-sombra-50);
    font-variant-numeric: tabular-nums;
  }

  &__lights {
    font-size: 13px;
    font-weight: 700;
    color: var(--ros-lumen-fg-1);
    text-shadow: 0 1px 8px var(--ros-lumen-sombra-50);
  }

  &__starpill {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.6px;
    color: var(--ros-lumen-fg-2);
    background: rgba(var(--ros-lumen-preto-rgb), 0.32);
    padding: 3px 12px;
    border-radius: 999px;
  }

  &__best-badge {
    position: absolute;
    top: 14px;
    left: 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ros-lumen-texto-suave);
    background: var(--ros-lumen-veu-30);
    padding: 4px 10px;
    border-radius: 999px;
    pointer-events: none;
  }

  &__sound {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: var(--ros-lumen-veu-30);
    color: var(--ros-lumen-texto-suave);
    cursor: pointer;
    z-index: 5;
    transition: background 0.15s ease;

    &:hover {
      background: var(--ros-lumen-veu-50);
      color: var(--ros-lumen-texto);
    }

    @media (max-width: 768px) {
      top: 58px;
    }
  }

  // ── Start ───────────────────────────────────────────────────────────────────
  &__start {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: clamp(46px, 16%, 140px);
    pointer-events: none;
  }

  &__logo {
    font-size: clamp(46px, 11vw, 66px);
    font-weight: 800;
    letter-spacing: 12px;
    margin-left: 12px;
    background: linear-gradient(
      120deg,
      var(--ros-lumen-bg-1) 5%,
      var(--ros-lumen-bg-2) 50%,
      var(--ros-lumen-bg-3) 92%
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 4px 26px var(--ros-lumen-shadow-1));
  }

  &__tagline {
    margin-top: 6px;
    font-size: 14px;
    font-weight: 500;
    color: var(--ros-lumen-texto-suave);
    letter-spacing: 0.4px;
    text-align: center;
    padding: 0 26px;
  }

  &__start-best {
    margin-top: 22px;
    font-size: 14px;
    font-weight: 600;
    color: var(--ros-lumen-texto);
    background: var(--ros-lumen-veu-30);
    padding: 6px 14px;
    border-radius: 999px;
  }

  &__cta {
    position: absolute;
    bottom: calc(16% + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.5px;
    color: var(--ros-lumen-texto);
    animation: lumen-pulse 1.6s ease-in-out infinite;
  }

  &__hint {
    position: absolute;
    bottom: calc(12% + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: min(86%, 440px);
    text-align: center;
    font-size: 13px;
    font-weight: 500;
    color: var(--ros-lumen-texto);
    background: rgba(var(--ros-lumen-preto-rgb), 0.36);
    padding: 8px 16px;
    border-radius: 999px;
    pointer-events: none;
    animation: lumen-pulse 2s ease-in-out infinite;
  }

  // ── Pause ───────────────────────────────────────────────────────────────────
  &__pause {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: rgba(var(--ros-lumen-preto-rgb), 0.42);
    pointer-events: none;
  }

  &__pause-title {
    font-size: 26px;
    font-weight: 700;
    color: var(--ros-lumen-texto);
    letter-spacing: 2px;
  }

  &__pause-cta {
    font-size: 14px;
    color: var(--ros-lumen-texto-suave);
  }

  // ── Game over ───────────────────────────────────────────────────────────────
  &__over {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(var(--ros-lumen-preto-rgb), 0.42);
    animation: lumen-fade-in 0.45s ease both;
  }

  &__over-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(340px, 92%);
    padding: 28px 26px 26px;
    border-radius: 22px;
    background: var(--ros-lumen-bg-4);
    backdrop-filter: var(--ros-lumen-desfoque);
    -webkit-backdrop-filter: var(--ros-lumen-desfoque);
    border: 1px solid var(--ros-lumen-borda-sutil);
    box-shadow: var(--ros-lumen-sombra-lg);
  }

  &__over-label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 2.4px;
    text-transform: uppercase;
    color: var(--ros-lumen-texto-sutil);
  }

  &__over-score {
    font-size: 82px;
    font-weight: 200;
    line-height: 1.05;
    color: var(--ros-lumen-texto);
    font-variant-numeric: tabular-nums;
  }

  &__over-record {
    margin-top: 2px;
    font-size: 15px;
    font-weight: 700;
    color: var(--ros-lumen-fg-2);
    animation: lumen-pulse 1.4s ease-in-out infinite;
  }

  &__over-stats {
    margin-top: 12px;
    display: flex;
    gap: 8px;
    font-size: 13px;
    color: var(--ros-lumen-texto-suave);
  }

  &__over-dot {
    opacity: 0.5;
  }

  &__over-actions {
    margin-top: 22px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  &__btn-play {
    width: 100%;
    padding: 12px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(135deg, var(--ros-lumen-bg-5) 0%, var(--ros-lumen-bg-2) 100%);
    color: var(--ros-lumen-texto-100);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3px;
    cursor: pointer;
    transition: filter 0.15s ease;

    &:hover {
      filter: brightness(1.12);
    }
  }

  &__btn-share {
    width: 100%;
    padding: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid var(--ros-lumen-borda-sutil);
    border-radius: 12px;
    background: var(--ros-lumen-preenchimento-06);
    color: var(--ros-lumen-texto);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: var(--ros-lumen-preenchimento-14);
    }
  }
}

@keyframes lumen-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

@keyframes lumen-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.lumen-pop-enter-active,
.lumen-pop-leave-active {
  transition:
    transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 0.25s ease;
}

.lumen-pop-enter-from,
.lumen-pop-leave-to {
  transform: scale(0.6);
  opacity: 0;
}

// O perfil leve vem do host (`desempenho.modoLeve`), não do atributo que o
// RoqueOS põe no <html>: fora do RoqueOS esse atributo não existe.
.ros-lumen--low {
  .ros-lumen__bg {
    transition: none;
  }

  .ros-lumen__over-card {
    background: var(--ros-lumen-bg-6);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
