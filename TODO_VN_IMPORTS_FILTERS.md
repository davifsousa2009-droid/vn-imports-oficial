# TODO — VN_IMPORTS.html (filtros estilo Nike)

## Passo 1
- Criar layout com `aside` esquerdo (sidebar) + grid de produtos à direita dentro de `#sec-prod`.

## Passo 2
- Implementar HTML/inputs da sidebar:
  - Categorias (dinâmico via `categoriasVitrine`)
  - Tamanhos (PP, P, M, G, GG) com seleção em tempo real
  - Preço (slider e exibição da faixa)

## Passo 3
- Implementar responsividade:
  - No mobile: botão flutuante “Filtros” no topo e painel overlay com os filtros.

## Passo 4
- Implementar lógica JS:
  - estado dos filtros
  - `applyFilters()` para filtrar `S.products` (cat + tamanhos + faixa de preço)
  - chamar `renderGrid()` com a lista filtrada.

## Passo 5
- Ajustar cards e hover:
  - no hover, mostrar botão “Adicionar ao Carrinho”
  - permitir seleção rápida de tamanho no card (chips) e adicionar com o tamanho selecionado.

## Passo 6
- Ajustar CSS para limpeza visual:
  - cards mais limpos, tipografia sans, espaço em branco
  - estrelas como linha discreta.

## Passo 7
- Validar:
  - desktop e mobile
  - adicionar ao carrinho com tamanhos rápidos
  - filtros funcionam sem abrir página de produto.

