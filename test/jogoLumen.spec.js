// O Lumen inteiro, montado pelo contrato do jogo-sdk com o host falso.
//
// Nenhum mock de store, de analytics ou de i18n do RoqueOS: se o jogo ainda
// alcançasse algo do RoqueOS, este arquivo não rodaria fora dele. Os casos do
// teste que rodava no front antes da extração (ROSLumen.spec.js, 25/09/2026)
// estão todos aqui, com o contrato no lugar das stores.
//
// O único dublê de biblioteca é o do `three`. O jsdom não tem WebGL, então o
// three vira uma casca que aceita o encanamento de atributos (Points,
// BufferGeometry, Sprite) sem contexto de GL, a mesma casca do teste do front.
// Ela mora aqui, e não em test/preparar.js, porque só este arquivo monta a
// tela; e ela guarda as opções do renderer, para o teste afirmar que o perfil
// leve do host chega na GPU do jeito que chegava antes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { VERSAO_DO_CONTRATO } from '@roqueos-games/jogo-sdk'
import { criarHostFalso } from '@roqueos-games/jogo-sdk/host-falso'
import jogo from '../src/index.js'
import { START_LIGHTS } from '../src/engine.js'
import ptBR from '../i18n/pt-BR.json'
import enUS from '../i18n/en-US.json'
import tela from '../src/JogoLumen.vue?raw'

const { renderizadores } = vi.hoisted(() => ({ renderizadores: [] }))

vi.mock('three', () => {
  class Vec3 {
    constructor() {
      this.x = 0
      this.y = 0
      this.z = 0
    }
    set(x, y, z) {
      this.x = x
      this.y = y
      this.z = z
      return this
    }
    setScalar(s) {
      return this.set(s, s, s)
    }
  }
  class Color {
    constructor() {
      this.r = 1
      this.g = 1
      this.b = 1
    }
    setScalar() {
      return this
    }
  }
  class Object3D {
    constructor() {
      this.children = []
      this.position = new Vec3()
      this.scale = new Vec3()
      this.material = { opacity: 1, dispose() {} }
    }
    add(...i) {
      this.children.push(...i)
    }
    remove(x) {
      this.children = this.children.filter((c) => c !== x)
    }
  }
  class Attr {
    constructor(array, itemSize) {
      this.array = array
      this.itemSize = itemSize
      this.needsUpdate = false
    }
  }
  class Geometry {
    constructor() {
      this.attributes = {}
    }
    setAttribute(n, a) {
      this.attributes[n] = a
    }
    setDrawRange() {}
    dispose() {}
  }
  class Material {
    constructor(opts = {}) {
      Object.assign(this, opts)
      this.opacity = opts.opacity ?? 1
    }
    dispose() {}
  }
  class Camera extends Object3D {
    updateProjectionMatrix() {}
  }
  class Renderer {
    constructor(opcoes) {
      this.opcoes = opcoes
      this.pixelRatio = null
      this.domElement = document.createElement('canvas')
      this.domElement.width = 640
      this.domElement.height = 480
      renderizadores.push(this)
    }
    setClearColor() {}
    setPixelRatio(v) {
      this.pixelRatio = v
    }
    setSize() {}
    render() {}
    dispose() {}
  }
  class CanvasTexture {
    dispose() {}
  }
  return {
    Scene: Object3D,
    Group: Object3D,
    Points: class extends Object3D {
      constructor(geo, mat) {
        super()
        this.geometry = geo
        this.material = mat
      }
    },
    Sprite: class extends Object3D {
      constructor(mat) {
        super()
        this.material = mat
      }
    },
    BufferGeometry: Geometry,
    BufferAttribute: Attr,
    PointsMaterial: Material,
    SpriteMaterial: Material,
    OrthographicCamera: Camera,
    Color,
    WebGLRenderer: Renderer,
    CanvasTexture,
    AdditiveBlending: 1,
  }
})

const ctx2d = () =>
  new Proxy(
    {},
    {
      get: (_t, p) => {
        if (p === 'createLinearGradient' || p === 'createRadialGradient')
          return () => ({ addColorStop() {} })
        return () => {}
      },
      set: () => true,
    },
  )

let el = null
let host = null
let montagem = null

const palco = () => {
  el = document.createElement('div')
  document.body.appendChild(el)
  return el
}
const montou = () =>
  vi.waitFor(() => {
    if (!el.querySelector('.ros-lumen')) throw new Error('o Lumen ainda não montou')
  })
// Monta com um host já pronto (para semear o armazenamento ou o placar antes).
const montarCom = async (h, { ativo = true } = {}) => {
  host = h
  montagem = jogo.mount(palco(), host, { windowId: 'w1', ativo })
  // O app só monta com o texto do idioma carregado.
  await montou()
  await nextTick()
}
const montar = ({ ativo = true, ...opcoesDoHost } = {}) =>
  montarCom(criarHostFalso({ jogoId: 'lumen', ...opcoesDoHost }), { ativo })
const $ = (sel) => el.querySelector(sel)
const eventos = (nome) =>
  host.chamadas.filter((c) => c.capacidade === 'metricas' && c.args[0] === nome)
const avisos = () => host.chamadas.filter((c) => c.capacidade === 'avisar').map((c) => c.args)
const ponteiro = async (tipo, clientX = 320, clientY = 240) => {
  $('.ros-lumen').dispatchEvent(new MouseEvent(tipo, { bubbles: true, clientX, clientY }))
  await nextTick()
}
const tecla = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code }))
const clicar = async (sel) => {
  $(sel).click()
  await nextTick()
}
const perder = async (pontos) => {
  window.__lumen.state.score = pontos
  window.__lumen.kill()
  await nextTick()
}

describe('Lumen pelo jogo-sdk', () => {
  let origCtx
  let origRect
  beforeEach(() => {
    window.__ROS_E2E__ = {}
    renderizadores.length = 0
    origCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2d())
    // Tela de 640×480 fixa: a conta de tela para mundo fica determinística.
    origRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 640,
      height: 480,
      right: 640,
      bottom: 480,
      x: 0,
      y: 0,
    }))
  })
  afterEach(() => {
    montagem?.desmontar()
    el?.remove()
    montagem = null
    el = null
    host = null
    HTMLCanvasElement.prototype.getContext = origCtx
    Element.prototype.getBoundingClientRect = origRect
    delete window.__ROS_E2E__
    delete window.__lumen
    vi.restoreAllMocks()
  })

  it('é um jogo do SDK, com o id que o catálogo e o recorde usam', () => {
    expect(jogo.id).toBe('lumen')
    expect(jogo.versaoDoContrato).toBe(VERSAO_DO_CONTRATO)
    expect(jogo.capacidades).toEqual([])
  })

  it('abre na tela inicial (logo, frase, chamada), com o texto do idioma do host', async () => {
    await montar()
    expect($('.ros-lumen__logo').textContent).toBe(ptBR.title)
    expect($('.ros-lumen__tagline').textContent).toBe(ptBR.tagline)
    expect($('.ros-lumen__cta').textContent).toBe(ptBR.tapToPlay)
    expect($('.ros-lumen__hud')).toBeNull()
  })

  it('fala o idioma do host, e troca quando o host troca', async () => {
    await montar({ idioma: 'en-US' })
    expect($('.ros-lumen__tagline').textContent).toBe(enUS.tagline)
    host.disparar('idioma', 'pt-BR')
    await vi.waitFor(() => expect($('.ros-lumen__tagline').textContent).toBe(ptBR.tagline))
  })

  it('começa no primeiro toque: HUD aparece, enxame vivo, game_start registrado', async () => {
    await montar()
    await ponteiro('pointerdown')
    expect(window.__lumen.state.status).toBe('playing')
    expect(window.__lumen.state.lights.length).toBe(START_LIGHTS)
    expect($('.ros-lumen__score')).not.toBeNull()
    expect(eventos('game_start').map((c) => c.args)).toEqual([['game_start', {}]])
  })

  it('com a partida começada, o laço anda e o motor avança no tempo', async () => {
    await montar()
    await ponteiro('pointerdown')
    await vi.waitFor(() => expect(window.__lumen.state.time).toBeGreaterThan(0))
  })

  it('arrastar põe um alvo no mundo e soltar tira', async () => {
    await montar()
    await ponteiro('pointerdown')
    await ponteiro('pointermove', 500, 120)
    expect(window.__lumen.state.target).toBeTruthy()
    expect(window.__lumen.state.target.x).toBeGreaterThan(0) // à direita do centro
    await ponteiro('pointerup')
    expect(window.__lumen.state.target).toBeNull()
  })

  it('morrer mostra o cartão de fim, grava nas chaves de antes, salva na conta e registra game_over', async () => {
    await montar()
    await ponteiro('pointerdown')
    await perder(77)
    expect($('.ros-lumen__over-card')).not.toBeNull()
    expect($('.ros-lumen__over-record').textContent).toContain(ptBR.newRecord)
    expect(host.storage.getItem('roqueos:lumen:best')).toBe('77')
    expect(host.storage.getItem('roqueos:lumen:games')).toBe('1')
    expect(eventos('game_over').map((c) => c.args)).toEqual([['game_over', { score: 77 }]])
    await vi.waitFor(async () =>
      expect(await host.placar.carregar()).toEqual({ best: 77, games: 1 }),
    )

    await clicar('.ros-lumen__btn-play')
    expect(window.__lumen.state.status).toBe('playing')
    expect(window.__lumen.state.lights.length).toBe(START_LIGHTS)
    expect($('.ros-lumen__over-card')).toBeNull()
    expect(eventos('game_start')).toHaveLength(2)
  })

  it('fim abaixo do recorde não é recorde, e o recorde fica', async () => {
    const h = criarHostFalso({ jogoId: 'lumen' })
    h.storage.setItem('roqueos:lumen:best', '500')
    await montarCom(h)
    await ponteiro('pointerdown')
    await perder(40)
    expect($('.ros-lumen__over-record')).toBeNull()
    expect(host.storage.getItem('roqueos:lumen:best')).toBe('500')
    expect(host.storage.getItem('roqueos:lumen:games')).toBe('1')
  })

  it('restart aceita semente e gera o mesmo enxame', async () => {
    await montar()
    await ponteiro('pointerdown')
    window.__lumen.restart(4242)
    const a = window.__lumen.state.lights.map((l) => [l.x.toFixed(4), l.y.toFixed(4)])
    window.__lumen.restart(4242)
    const b = window.__lumen.state.lights.map((l) => [l.x.toFixed(4), l.y.toFixed(4)])
    expect(a).toEqual(b)
    expect(window.__lumen.state.status).toBe('playing')
  })

  it('o mudo liga e desliga na chave de antes e não mexe no enxame', async () => {
    await montar()
    await ponteiro('pointerdown')
    const antes = window.__lumen.state.lights.length
    await clicar('.ros-lumen__sound')
    expect(host.storage.getItem('roqueos:lumen:muted')).toBe('1')
    expect($('.ros-lumen__sound').getAttribute('aria-label')).toBe(ptBR.soundOff)
    expect(window.__lumen.state.lights.length).toBe(antes)
    await clicar('.ros-lumen__sound')
    expect(host.storage.getItem('roqueos:lumen:muted')).toBe('0')
    expect($('.ros-lumen__sound').getAttribute('aria-label')).toBe(ptBR.soundOn)
  })

  it('o recorde, as partidas e o mudo de antes da extração voltam ao abrir', async () => {
    const h = criarHostFalso({ jogoId: 'lumen' })
    h.storage.setItem('roqueos:lumen:best', '120')
    h.storage.setItem('roqueos:lumen:games', '7')
    h.storage.setItem('roqueos:lumen:muted', '1')
    await montarCom(h)
    expect($('.ros-lumen__start-best').textContent).toContain('120')
    expect($('.ros-lumen__sound').getAttribute('aria-label')).toBe(ptBR.soundOff)
    await ponteiro('pointerdown')
    await perder(10)
    expect(host.storage.getItem('roqueos:lumen:games')).toBe('8')
  })

  it('a dica aparece só na primeira partida, e a chave seen é a de antes', async () => {
    await montar()
    await ponteiro('pointerdown')
    expect($('.ros-lumen__hint').textContent.trim()).toBe(ptBR.hint)
    expect(host.storage.getItem('roqueos:lumen:seen')).toBe('1')
    montagem.desmontar()
    el.remove()

    const h = criarHostFalso({ jogoId: 'lumen' })
    h.storage.setItem('roqueos:lumen:seen', '1')
    await montarCom(h)
    await ponteiro('pointerdown')
    expect($('.ros-lumen__hint')).toBeNull()
  })

  it('perder o foco pausa, e um toque retoma', async () => {
    await montar()
    await ponteiro('pointerdown')
    montagem.ativar(false)
    await nextTick()
    expect($('.ros-lumen__pause-title').textContent).toBe(ptBR.paused)
    montagem.ativar(true)
    await nextTick()
    await ponteiro('pointerdown')
    expect($('.ros-lumen__pause')).toBeNull()
  })

  it('só a janela ativa ouve o teclado', async () => {
    await montar({ ativo: false })
    tecla('Space')
    await nextTick()
    expect(eventos('game_start')).toHaveLength(0)
    expect($('.ros-lumen__start')).not.toBeNull()

    montagem.ativar(true)
    tecla('Space')
    await nextTick()
    expect(eventos('game_start')).toHaveLength(1)
    expect($('.ros-lumen__start')).toBeNull()
  })

  it('convidado não tem placar na conta: nada quebra e o recorde local fica', async () => {
    // O host do RoqueOS, para convidado: carregar devolve null e salvar devolve
    // false, sem nem tocar no Firestore.
    const h = criarHostFalso({ jogoId: 'lumen' })
    h.placar.carregar = vi.fn(async () => null)
    h.placar.salvar = vi.fn(async () => false)
    h.storage.setItem('roqueos:lumen:best', '50')
    await montarCom(h)
    await vi.waitFor(() => expect(h.placar.carregar).toHaveBeenCalled())
    expect($('.ros-lumen__start-best').textContent).toContain('50')
    await ponteiro('pointerdown')
    await perder(90)
    expect($('.ros-lumen__over-record')).not.toBeNull()
    expect(host.storage.getItem('roqueos:lumen:best')).toBe('90')
    await vi.waitFor(() => expect(h.placar.salvar).toHaveBeenCalledWith({ best: 90, games: 1 }))
  })

  it('o placar da conta maior que o local vem para a tela e para a chave da galeria', async () => {
    const h = criarHostFalso({ jogoId: 'lumen' })
    await h.placar.salvar({ best: 300, games: 9 })
    await montarCom(h)
    await vi.waitFor(() => expect(h.storage.getItem('roqueos:lumen:best')).toBe('300'))
    expect(h.storage.getItem('roqueos:lumen:games')).toBe('9')
    await nextTick()
    expect($('.ros-lumen__start-best').textContent).toContain('300')
  })

  it('o recorde local maior que o da conta sobe para a conta', async () => {
    const h = criarHostFalso({ jogoId: 'lumen' })
    h.storage.setItem('roqueos:lumen:best', '80')
    h.storage.setItem('roqueos:lumen:games', '3')
    await montarCom(h)
    await vi.waitFor(async () => expect(await h.placar.carregar()).toEqual({ best: 80, games: 3 }))
  })

  it('entrar na conta com o jogo aberto busca o placar da conta de novo', async () => {
    await montar()
    await vi.waitFor(() => expect(host.contar('placar', 'carregar')).toBe(1))
    host.disparar('identidade', { uid: 'u1', nome: 'Ana' })
    await vi.waitFor(() => expect(host.contar('placar', 'carregar')).toBe(2))
  })

  it('o perfil leve do host chega na tela e no renderer, com os cortes de antes', async () => {
    await montar({ modoLeve: true })
    expect($('.ros-lumen').classList.contains('ros-lumen--low')).toBe(true)
    const [leve] = renderizadores
    expect(leve.opcoes).toMatchObject({
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
    })
    expect(leve.pixelRatio).toBeLessThanOrEqual(1.25)
    montagem.desmontar()
    el.remove()

    renderizadores.length = 0
    await montar({ modoLeve: false })
    expect($('.ros-lumen').classList.contains('ros-lumen--low')).toBe(false)
    expect(renderizadores[0].opcoes).toMatchObject({ alpha: true, antialias: true })
  })

  it('compartilhar sem a folha do sistema baixa a imagem e avisa com sucesso', async () => {
    const baixou = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
      cb(new Blob(['x'], { type: 'image/png' })),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(baixou)
    const origCriar = URL.createObjectURL
    const origRevogar = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:lumen')
    URL.revokeObjectURL = vi.fn()
    try {
      await montar()
      await ponteiro('pointerdown')
      await perder(33)
      await clicar('.ros-lumen__btn-share')
      await vi.waitFor(() => expect(avisos()).toEqual([[ptBR.shareSaved, { tipo: 'sucesso' }]]))
      expect(baixou).toHaveBeenCalledTimes(1)
    } finally {
      URL.createObjectURL = origCriar
      URL.revokeObjectURL = origRevogar
    }
  })

  it('compartilhar que falha avisa com o erro do jogo; cancelar não avisa nada', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(null))
    const erroNoConsole = vi.spyOn(console, 'error').mockImplementation(() => {})
    const compartilhar = vi.fn()
    Object.defineProperty(navigator, 'share', { value: compartilhar, configurable: true })
    try {
      await montar()
      await ponteiro('pointerdown')
      await perder(33)

      compartilhar.mockRejectedValueOnce(
        Object.assign(new Error('cancelou'), { name: 'AbortError' }),
      )
      await clicar('.ros-lumen__btn-share')
      await vi.waitFor(() => expect(compartilhar).toHaveBeenCalledTimes(1))
      await new Promise((r) => setTimeout(r, 0))
      expect(avisos()).toEqual([])

      compartilhar.mockRejectedValueOnce(new Error('sem permissão'))
      await clicar('.ros-lumen__btn-share')
      await vi.waitFor(() => expect(avisos()).toEqual([[ptBR.operationFailed, { tipo: 'erro' }]]))
      expect(erroNoConsole).toHaveBeenCalled()
    } finally {
      delete navigator.share
    }
  })

  it('desmontar solta tudo: o gancho, a tela e o teclado', async () => {
    await montar()
    expect(window.__lumen).toBeTruthy()
    montagem.desmontar()
    expect(window.__lumen).toBeUndefined()
    expect(el.querySelector('.ros-lumen')).toBeNull()
    tecla('Space')
    expect(eventos('game_start')).toHaveLength(0)
    // Desmontar de novo acontece de verdade (a janela fecha e o componente em
    // volta desmonta depois) e não pode lançar.
    expect(() => montagem.desmontar()).not.toThrow()
  })

  it('desmontar antes de o texto chegar não monta nada depois', async () => {
    host = criarHostFalso({ jogoId: 'lumen' })
    montagem = jogo.mount(palco(), host, { ativo: true })
    montagem.desmontar()
    await new Promise((r) => setTimeout(r, 50))
    expect(el.querySelector('.ros-lumen')).toBeNull()
  })

  it('toda chave que a tela usa existe no pt-BR', () => {
    const usadas = [...tela.matchAll(/txt\('([\w.]+)'/g)].map((m) => m[1])
    expect(usadas.length).toBeGreaterThan(15)
    const faltando = usadas.filter((k) => typeof ptBR[k] !== 'string')
    expect(faltando).toEqual([])
  })
})
