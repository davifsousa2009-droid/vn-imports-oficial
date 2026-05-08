# TODO — Sistema de Avaliações Dinâmico

## Passo 1 — Model
- [x] Criar `models/Review.js` com schema: nome, comentario, estrelas (1-5), data, aprovado (default false)

## Passo 2 — Backend
- [x] Atualizar `server.js`:
  - [x] importar `Review` do model

- [x] adicionar rotas públicas/privadas:

    - [x] POST `/api/reviews`


    - [x] GET `/api/reviews/public`

    - [x] GET `/api/admin/reviews` (JWT)

    - [x] PUT `/api/admin/reviews/:id` (JWT) aprovar

    - [x] DELETE `/api/admin/reviews/:id` (JWT) excluir


## Passo 3 — Frontend (VN_IMPORTS.html)
- [x] Criar seção luxuosa preto/dourado para depoimentos

- [x] Carregar reviews aprovadas via `/api/reviews/public`

- [x] Atualizar summary (média + contagem)


- [ ] Criar formulário (nome, estrelas 1-5, comentario) que envia POST `/api/reviews`

- [ ] Remover/neutralizar reviews hardcoded do `DEF.reviews`


## Passo 4 — Admin (admin.html)
- [ ] Adicionar nova aba/painel “Avaliações” na sidebar
- [ ] Implementar listagem de todas avaliações via `/api/admin/reviews`
- [ ] Botões:
  - [ ] Aprovar (PUT)
  - [ ] Excluir (DELETE)
- [ ] Garantir mensagens de erro/401 seguem padrão JWT (relogin)

## Passo 5 — Testes
- [ ] Rodar `npm run dev`
- [ ] Testar fluxo público: enviar avaliação -> não aparece até aprovar
- [ ] Testar admin: aprovar -> aparece na vitrine
- [ ] Testar delete -> remove da lista/admin

