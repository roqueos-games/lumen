# Changelog

## 0.1.0 (25/09/2026)

- O Lumen sai do repositório do RoqueOS e passa a falar com ele só pelo `jogo-sdk` 0.1.0.
  O `three` é o do RoqueOS (`peerDependencies ^0.171.0`), e o código que toca a GPU veio sem
  mudança: só a origem do modo leve passou a ser o host.
- Texto nos dez idiomas em `i18n/`, com o título e a mensagem de erro do compartilhar, que
  antes vinham do i18n do RoqueOS. Ícones SVG próprios no lugar do `q-icon`, e o jogo roda
  sozinho com `yarn dev`.
- O som procedural foi para `src/som.js`, com os mesmos timbres e volumes.
- Entrar na conta com o jogo aberto busca o placar da conta de novo, sem precisar reabrir.
