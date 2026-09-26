# Lumen

Jogo da organização roqueos-games, montado pelo RoqueOS através do `jogo-sdk`. Leia o
README antes de mudar qualquer coisa.

- Gate: `yarn verificar` (o mesmo do CI e do pre-push).
- O jogo só importa `vue`, `three`, `@roqueos-games/jogo-sdk` e arquivo deste repo. O
  RoqueOS confere isso e reprova o pin se aparecer outra coisa. O `three` é o do RoqueOS
  (`peerDependencies`); não troque a versão.
- Nada de shader ou GPU sem evidência no aparelho-alvo: renderer, pixel ratio, materiais, o
  remendo de shader do enxame e o corte do modo leve só mudam com teste no iPhone de verdade.
- JSON do jogo entra com `?raw` e `JSON.parse`: o build do RoqueOS quebra com import de JSON
  direto.
- Chaves de armazenamento e nomes de evento não mudam.
- Toda correção vem com teste que reprova sem ela.
- Português do Brasil no código e nos commits.
