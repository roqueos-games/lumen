// O som do Lumen, procedural: nenhum arquivo de áudio, só osciladores. O
// AudioContext é do host (no RoqueOS, o compartilhado com os apps de música;
// fora dele, um próprio), e o jogo só toca quando o contexto já está rodando,
// porque tocar num contexto suspenso enfileira som que sai tudo junto depois.
//
// Os timbres, as notas e os volumes são os do componente de antes da extração,
// número por número.

const PENTA = [0, 3, 5, 7, 10]

/**
 * @param {{ contexto: () => AudioContext | null }} audio a capacidade `audio` do host
 * @param {() => boolean} estaMudo
 */
export function criarSom(audio, estaMudo) {
  let volume = null
  let dono = null
  // O zumbido de fundo, que cresce com o enxame.
  let fundo = null
  // A sequência de coletas: cada fagulha pega logo depois da anterior sobe um
  // grau na pentatônica.
  let sequencia = 0
  let sequenciaEm = 0

  const contexto = () => {
    if (estaMudo()) return null
    try {
      const c = audio.contexto()
      if (!c || c.state !== 'running') return null
      // O ganho mestre pertence a UM contexto. Se o host trocar de contexto
      // (o iOS fecha o antigo ao voltar do fundo), recria em vez de ligar num
      // nó morto.
      if (dono !== c) {
        volume = c.createGain()
        volume.gain.value = 0.5
        volume.connect(c.destination)
        dono = c
      }
      return c
    } catch {
      return null
    }
  }

  const envelope = (c, t0, pico, queda) => {
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(pico, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + queda)
    g.connect(volume)
    return g
  }

  return {
    /** Blip cristalino da coleta; o tom sobe com a sequência. */
    coletar() {
      const c = contexto()
      if (!c) return
      const agora = c.currentTime
      if (agora - sequenciaEm < 1.4) sequencia = Math.min(sequencia + 1, 18)
      else sequencia = 0
      sequenciaEm = agora
      const midi = 72 + PENTA[sequencia % 5] + 12 * Math.floor(sequencia / 5)
      const freq = 440 * Math.pow(2, (midi - 69) / 12)
      const g = envelope(c, agora, 0.24, 0.32)
      const o = c.createOscillator()
      o.type = 'triangle'
      o.frequency.value = freq
      o.connect(g)
      o.start(agora)
      o.stop(agora + 0.36)
    },
    /** Acorde suave quando nasce uma luz nova. */
    nascer() {
      const c = contexto()
      if (!c) return
      const agora = c.currentTime
      for (const [f, a] of [
        [330, 0.12],
        [495, 0.08],
      ]) {
        const o = c.createOscillator()
        o.type = 'sine'
        o.frequency.value = f
        const g = envelope(c, agora, a, 0.4)
        o.connect(g)
        o.start(agora)
        o.stop(agora + 0.42)
      }
    },
    /** Baque escuro quando luzes se apagam. */
    perder() {
      const c = contexto()
      if (!c) return
      const agora = c.currentTime
      const o = c.createOscillator()
      o.type = 'sawtooth'
      o.frequency.setValueAtTime(120, agora)
      o.frequency.exponentialRampToValueAtTime(40, agora + 0.18)
      const g = envelope(c, agora, 0.3, 0.24)
      o.connect(g)
      o.start(agora)
      o.stop(agora + 0.26)
    },
    /** Cintilar quando a estrela é pega. */
    estrela() {
      const c = contexto()
      if (!c) return
      const agora = c.currentTime
      for (let i = 0; i < 5; i++) {
        const o = c.createOscillator()
        o.type = 'sine'
        o.frequency.value = 660 * Math.pow(2, i / 5)
        const g = envelope(c, agora + i * 0.05, 0.16, 0.5)
        o.connect(g)
        o.start(agora + i * 0.05)
        o.stop(agora + i * 0.05 + 0.5)
      }
    },
    /** Liga o zumbido de fundo, se ainda não existe e o contexto já roda. */
    ligarFundo() {
      const c = contexto()
      if (!c || fundo) return
      const ganho = c.createGain()
      ganho.gain.value = 0
      ganho.connect(volume)
      const osciladores = []
      for (const f of [55, 82.4]) {
        const o = c.createOscillator()
        o.type = 'sine'
        o.frequency.value = f
        o.connect(ganho)
        o.start()
        osciladores.push(o)
      }
      fundo = { ganho, osciladores }
    },
    /** @param {number} nivel 0 a 1 */
    nivelDoFundo(nivel) {
      if (estaMudo() || !fundo) return
      fundo.ganho.gain.value = Math.max(0, Math.min(nivel, 1)) * 0.16
    },
    /** Zera o fundo na hora, sem esperar o próximo quadro (o botão de mudo). */
    calarFundo() {
      if (fundo) fundo.ganho.gain.value = 0
    },
    pararFundo() {
      if (!fundo) return
      try {
        for (const o of fundo.osciladores) o.stop()
        fundo.ganho.disconnect()
      } catch {
        /* já parado */
      }
      fundo = null
    },
    zerarSequencia() {
      sequencia = 0
    },
  }
}
