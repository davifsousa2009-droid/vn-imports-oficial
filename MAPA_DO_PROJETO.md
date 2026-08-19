# Mapa do Projeto

Documento de leitura — gerado a partir de uma varredura do código em 2026-08-18. Nenhuma linha de código foi alterada para produzir isto. Se você (ou eu, em seis meses) estiver perdido no projeto, comece por aqui.

**Atualização 2026-08-18:** dos "Pontos de atenção" abaixo, os itens 1 (arquivos órfãos), 2 (`server_HEAD.js`/arquivo `git`), 6 (default "Cibelle") e 9 (TODOs desatualizados) já foram resolvidos. Os demais continuam em aberto. A seção 6 ganhou uma entrada nova sobre hierarquia de categorias (o que existe hoje e o que ativar de verdade exigiria) — ver "Categorias são flat hoje".

**Atualização 2026-08-19:** a partir dos achados de `AUDITORIA_QUALIDADE.md`, mais itens foram removidos — o item 4 abaixo (`qr_backend_patch.js`) foi resolvido. Além disso, sem chamador em nenhum front-end confirmado por busca: as rotas `POST /api/pix/qr-mp` e `GET /api/pix/automatic` (duplicavam, sem uso, o que `POST /api/payment/create` e `GET /api/payment/config` já fazem — removidas da tabela da seção 2); a dependência `mongodb` no `package.json` (nunca usada diretamente — `mongoose` já a traz como dependência própria); e, em `VN_IMPORTS.html`, um segundo mecanismo morto de contador do carrinho no cabeçalho (`updateHeaderDots`, lendo uma chave de `localStorage` que nunca era escrita) junto de uma tela de confirmação de carrinho nunca ligada a nenhum botão (`showCartConfirmation`) — `produto.html` e `search.html` também tiveram sua versão do contador corrigida para usar o mesmo mecanismo visual que já funcionava (`syncDots`, classe `.on`) em vez de escrever texto num elemento que o CSS mantém sempre invisível.

Este é um template white-label de e-commerce (Node/Express + MongoDB Atlas + Mongoose, deploy na Vercel como função serverless, sem etapa de build). Cada cliente roda sua própria cópia do repositório, com seu próprio banco e suas próprias variáveis de ambiente.

---

## 1. Arquivos principais

### Backend

**`server.js`** (~3470 linhas) — o backend inteiro. Não há divisão por módulos: Express app, todos os schemas Mongoose que importam de verdade (Produto, Category, Banner, Settings, Order, Config — só `Review` vem de um arquivo separado), todas as rotas de API, geração dos HTMLs templados, os dois crons, integração com Mercado Pago (cartão e Pix), cotação de frete (Melhor Envio), upload para Cloudinary, autenticação JWT. **Este é o arquivo que você vai abrir para quase qualquer mudança de backend.**

**`config.js`** (~40 linhas) — o "branco-de-loja": valores específicos de cada implantação, editados à mão uma vez por cliente. Comentário no próprio arquivo: *"Para um novo cliente, altere apenas este arquivo."* Contém nome da loja, cor primária/secundária, CEP de origem, tag do cliente (Cloudinary), chave Pix padrão, sufixo do título, se a loja usa tamanhos de roupa por padrão, e a paleta de cores base. Mexa aqui ao configurar uma loja nova.

**`models/Review.js`** — único arquivo em `models/` que é realmente usado (`require`'d por `server.js`). Schema de avaliação (nome, comentário, estrelas, aprovado).

~~**`routes/`, `models/Product.js`, `models/Category.js`** — não eram usados (confirmado por três caminhos independentes: nenhum `require` em `server.js`, nenhuma menção em `vercel.json`/`package.json`, nenhuma referência em qualquer outro `.js` do projeto). Removidos em 2026-08-18.~~

### Frontend (HTML com JS/CSS inline, sem build)

**`VN_IMPORTS.html`** (~245KB) — a vitrine: home, grid de produtos com filtros, carrinho, checkout, página de produto embutida em `<div class="view">`, avaliações, lista de desejos. O maior e mais importante arquivo do frontend. Servido via `renderLojaHtmlComConfig()`, que injeta nome da loja, imagem do hero, cores (`bg`/`bg2`/`border`/`gold`/`gold2`) e meta tags antes de mandar pro navegador.

**`search.html`** — página dedicada de resultados de busca. Estruturalmente quase idêntica ao `VN_IMPORTS.html` (mesmo CSS, mesmos tokens), mas só recebe o override de cor no servidor — nome/hero/meta tags não são injetados aqui (nunca foram).

**`produto.html`** — página dedicada de produto individual (link direto/compartilhável). Mesmo tratamento de `search.html`: só cor é templada no servidor.

**`admin.html`** (~136KB) — painel administrativo: login, CRUD de produtos/categorias/banners/avaliações, configurações da loja, configurações de pagamento, tema de cores. SPA de painel único (`showPanel(nome)` troca qual `.panel` fica visível). Servido via `renderAdminHtmlComConfig()`, que só injeta nome/título (não cor, não hero).

**`privacidade.html`, `termos.html`, `devolucao.html`** — páginas legais estáticas. Têm seu próprio bloco `:root` compacto (não compartilham o de VN_IMPORTS via arquivo, é uma cópia). Preenchidas no cliente via `fetch('/api/config')` (nome, CNPJ — mostram aviso se CNPJ não estiver cadastrado). Servidas cruas do cache em memória, sem templating server-side de conteúdo.

**`index.html`** — só um redirecionador (`<meta http-equiv="refresh">` + `location.replace('/VN_IMPORTS.html')`). Na prática, em qualquer ambiente (local ou Vercel), a rota `/index.html` do `server.js` intercepta antes e serve o mesmo HTML templado de `VN_IMPORTS.html` — este arquivo estático quase nunca chega a ser servido como está escrito.

### Scripts e configuração de deploy

**`scripts/relatorio-tamanhos-perdidos.js`, `relatorio-produtos-sem-envio.js`, `relatorio-pedidos-sem-tamanho.js`** — diagnósticos somente-leitura, rodados manualmente (`node scripts/nome.js`) contra o banco de produção/dev via `MONGODB_URI` do `.env`. Não escrevem nada, só imprimem um relatório no terminal. Use quando quiser saber "quantos produtos/pedidos estão numa situação X" sem escrever uma query na mão.

**`vercel.json`** — config de deploy: `rewrites` (por que toda página HTML precisa de uma entrada aqui, ver seção 6), `crons` (horários dos dois crons), `functions.server.js.maxDuration` (30s).

**`package.json`** — dependências (`express`, `mongoose`, `cloudinary`, `jsonwebtoken`, `helmet`, `express-rate-limit`, `multer`, `cors`, `dotenv`) e os dois scripts npm: `start` (`node server.js`) e `dev` (`nodemon server.js`).

**`.env`** — segredos e config local, nunca commitado (`.gitignore`). Ver seção 3.

**`.gitignore`** — exclui `node_modules/`, `.env`, logs.

**`uploads/`** — pasta vazia (só um `.gitkeep`), não referenciada em nenhum lugar do código. Resquício de antes do Cloudinary. Ver "Pontos de atenção".

**`TODO.md`, `TODO_FRONT_VN_IMPORTS_NEXT.md`, `TODO_VN_IMPORTS_FILTERS.md`** — anotações de planejamento antigas. Ver "Pontos de atenção" — estão desatualizadas.

---

## 2. Rotas do servidor

Todas as rotas de API vivem em `server.js`, prefixadas com `/api`. "Auth" significa que a rota exige `verificarJWT` (header `Authorization: Bearer <token>`, token obtido em `/api/admin/login`).

### Produtos
| Rota | Método | Acesso |
|---|---|---|
| `/api/produtos` | GET | Público |
| `/api/produtos/search` | GET | Público |
| `/api/produtos/:id` | GET | Público |
| `/api/produtos` | POST | Auth |
| `/api/produtos/:id` | PUT | Auth |
| `/api/produtos/:id` | DELETE | Auth |

### Categorias
| Rota | Método | Acesso |
|---|---|---|
| `/api/categories` | GET | Público |
| `/api/categories/tree` | GET | Público (hoje sempre devolve categorias "raiz" sem filhos — ver seção 6) |
| `/api/categories` | POST | Auth |
| `/api/categories/:id` | DELETE | Auth |

### Banners
| Rota | Método | Acesso |
|---|---|---|
| `/api/banners` | GET | Público |
| `/api/banners` | POST | Auth |
| `/api/banners/:id` | DELETE | Auth |

### Avaliações
| Rota | Método | Acesso |
|---|---|---|
| `/api/reviews` | POST | Público (limitado: `reviewsLimiter`, 10/15min) |
| `/api/reviews/public` | GET | Público (só aprovadas) |
| `/api/admin/reviews` | GET | Auth (todas, aprovadas ou não) |
| `/api/admin/reviews/:id` | PUT | Auth (aprovar/reprovar) |
| `/api/admin/reviews/:id` | DELETE | Auth |

### Configuração da loja
| Rota | Método | Acesso |
|---|---|---|
| `/api/config` | GET | Público (nome, cores, hero, textos — nunca segredo) |
| `/api/config` | POST | Auth |
| `/api/settings` | GET | Público (só `pix_key`/`mp_public_key` — nunca `mp_token`/`me_token`/`mp_webhook_secret`) |
| `/api/settings` | POST | Auth |

### Pedidos
| Rota | Método | Acesso |
|---|---|---|
| `/api/orders` | POST | Público (limitado: `ordersLimiter`, 30/15min) — criação do pedido pelo cliente |
| `/api/orders` | GET | Auth |
| `/api/orders/:id` | PUT | Auth |
| `/api/orders/:id` | DELETE | Auth |
| `/api/admin/orders/buscar-por-comprador` | GET | Auth |
| `/api/admin/orders/anonimizar-comprador` | POST | Auth |

### Pagamento (Mercado Pago / Pix)
| Rota | Método | Acesso |
|---|---|---|
| `/api/pix/copia-cola` | POST | Público |
| `/api/payment/config` | GET | Público |
| `/api/payment/create` | POST | Público |
| `/api/payment/status/:orderId` | GET | Público |
| `/api/pix/webhook` | POST | Público, mas validado por assinatura (`x-signature` conferida contra `mp_webhook_secret`, não JWT) — é o Mercado Pago chamando, não o navegador do cliente |

### Frete
| Rota | Método | Acesso |
|---|---|---|
| `/api/frete/calcular` | POST | Público |

### Upload
| Rota | Método | Acesso |
|---|---|---|
| `/api/upload` | POST | Auth — vai para o Cloudinary, nunca disco local |

### Autenticação
| Rota | Método | Acesso |
|---|---|---|
| `/api/admin/login` | POST | Público (limitado: `loginLimiter`) — único jeito de obter um JWT |

### Cron (Vercel Scheduled Functions)
| Rota | Método | Acesso |
|---|---|---|
| `/api/cron/liberar-estoque-pendente` | GET | Protegido por `CRON_SECRET` (header `Authorization: Bearer <CRON_SECRET>`), **não** JWT |
| `/api/cron/anonimizar-pedidos-antigos` | GET | Idem |

### Infraestrutura / diagnóstico
| Rota | Método | Acesso |
|---|---|---|
| `/api/status` | GET | Público |
| `/api/csp-report` | POST | Público, sem auth — só loga violação de CSP no console do servidor |
| `/favicon.svg` | GET | Público — gerado na hora (monograma com a inicial + cor da loja) |

### Páginas HTML (não-API)
| Rota | Templada com | Acesso |
|---|---|---|
| `/`, `/index.html`, `/VN_IMPORTS.html`, `/VN_IMPORTS` | nome, hero, cores, meta tags | Público |
| `/admin.html` | nome/título | Público (o conteúdo é protegido pelo login JS, não pela rota) |
| `/search.html`, `/produto.html` | só cores | Público |
| `/devolucao.html`, `/privacidade.html`, `/termos.html` | nada (cache cru) | Público |

**Superfície exposta, resumindo:** toda escrita (criar/editar/apagar produto, categoria, banner, pedido, configuração, aprovar avaliação, upload) exige JWT. Toda leitura de catálogo/config pública é de fato pública (não vaza segredo — confirmado em `mergePublicConfig`/`mergePublicSettings`, que nunca incluem token de pagamento). As únicas escritas públicas sem JWT são: criar pedido (`POST /api/orders` — é o cliente comprando), criar avaliação (`POST /api/reviews` — fica pendente de aprovação), e o fluxo de pagamento (que precisa ser público pra funcionar). Os crons usam um segredo próprio, não JWT, porque não há usuário logado quando a Vercel os dispara.

---

## 3. Variáveis de ambiente

Lidas de `process.env` — localmente vêm do `.env` (via `dotenv`, carregado só quando `VERCEL` não está definido); na Vercel, vêm do painel do projeto (Settings → Environment Variables).

| Variável | Para quê | Se faltar |
|---|---|---|
| `MONGODB_URI` | Connection string do MongoDB Atlas | Qualquer rota que precise do banco falha (503/500 tratado, não derruba o servidor) — mas o servidor sobe normalmente |
| `JWT_SECRET` | Assina/valida os tokens de login do admin | **Servidor recusa iniciar** (`process.exit(1)`) — é a única env var que bloqueia o boot inteiro |
| `ADMIN_PASSWORD` | Senha mestra pra `POST /api/admin/login` | Login sempre devolve 500 "Configuração do servidor incorreta" — ninguém entra no painel |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Credenciais de upload de imagem | Se qualquer uma faltar, `POST /api/upload` devolve 503 com mensagem explícita dizendo quais faltam. Resto do site funciona normal |
| `CRON_SECRET` | Autoriza as duas rotas de cron | Sem ela, as rotas de cron ficam **inacessíveis pra sempre** (falha fechada de propósito — nem com o header certo alguém entra) |
| `LOJA_CEP_ORIGEM` | CEP de origem pro cálculo de frete, usado só se o painel nunca configurou um | Cai pro `cepOrigem` do `config.js`; se esse também estiver vazio, cai num fallback fixo (`01310100`) |
| `ALLOWED_ORIGIN` | Domínios extras liberados no CORS (separados por vírgula), além do próprio domínio do request e `localhost` | Só o próprio domínio + localhost ficam liberados — normal se a loja não tiver domínio próprio adicional |
| `NODE_ENV` | Se `!== 'production'`, o servidor chama `app.listen()` (modo local) | Na Vercel isso nunca roda de qualquer forma (a função serverless não usa `app.listen`) — só importa pra rodar local |
| `PORT` | Porta do `app.listen()` local | Cai pra `3000` |
| `VERCEL` | Definida automaticamente pela Vercel — decide se carrega `.env` via dotenv (local) ou não (produção, vem do painel) | N/A, não é algo que você define |

**No `.env` local hoje** (conferido, só nomes): `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `MONGODB_URI`, `PORT`, `ADMIN_PASSWORD`, `JWT_SECRET`, `LOJA_CEP_ORIGEM`. **Faltam `CRON_SECRET` e `ALLOWED_ORIGIN`** — normal para dev local (cron não roda localmente por agendamento, e não há domínio extra a liberar), mas **os dois precisam ser configurados no painel da Vercel** em cada implantação nova, ou os crons nunca vão funcionar e um domínio próprio pode esbarrar em CORS.

---

## 4. Campos de configuração da loja

Existem duas fontes de configuração, com papéis diferentes:

- **`Config` (banco, editável pelo painel)** — o que o lojista muda em Configurações do Sistema. Schema em `server.js` (`ConfigSchema`).
- **`config.js` (arquivo, editado à mão por você)** — o "branco-de-loja": valor de fábrica de cada implantação, e teto de alguns tokens que o painel nunca alcança.

A regra geral (ver seção 6 para a cadeia completa): **painel → `config.js` → fallback fixo no código**, mas cada campo individual pode ter um número de degraus diferente.

### Editável pelo lojista no painel (`Config`/`ConfigSchema`)
`nomeLoja`, `chavePix`, `corPrimaria`, `corSecundaria`, `temaFundo` (só a *chave* de um tema pré-calibrado — nunca hex livre), `whatsappContato`, `instagramLink`, `emailContato`, `clienteTag`, `cidadeLoja`, `cepOrigem`, `pageTitleSuffix`, `cnpj`, `retencaoPedidosPagosAnos`, `pesoKgPadrao`/`larguraCmPadrao`/`alturaCmPadrao`/`comprimentoCmPadrao`, `usaTamanhosPadrao`, `freteGratisAtivo`/`freteGratisValor`, `parcelamentoAtivo`/`parcelamentoMax`, `promoAtiva`/`promoEyebrow`/`promoTitulo`/`promoSubtitulo`/`promoCtaTexto`, `heroImagem`/`heroImagemUrl`/`heroTitle`/`heroFont`/`heroEyebrow`/`heroSubtitulo`, `sobreTitulo`/`sobreTexto`, `benef1..4Titulo`/`Texto`/`IcoEnabled`/`Ico`.

Também no banco, mas em outra coleção (`Settings`, não `Config`): `mp_token`, `mp_public_key`, `me_token`, `pix_key`, `mp_webhook_secret` — configurados em "Sua Integração" no painel, nunca em `config.js`.

### Só existe em `config.js` (nunca aparece no painel)
`nomeLoja`, `corPrimaria`, `corSecundaria`, `whatsappContato`, `instagramLink`, `emailContato`, `cepOrigem`, `clienteTag`, `chavePix`, `pageTitleSuffix`, `usaTamanhosPadrao` também existem aqui — mas como **valor de fábrica**, não como campo editável; o painel sempre pode sobrescrever. Os que **de fato nunca são tocados pelo painel**, mesmo depois do lojista mexer em tudo:
- `colors.ink`, `ink2`, `mid`, `muted`, `silver`, `border2`, `white`, `accent`, `red`, `green` — fixos, o mesmo valor pra qualquer loja, qualquer tema. Só `bg`/`bg2`/`border` (vêm do tema escolhido) e `gold`/`gold2` (vêm de `corPrimaria`/`corSecundaria`) são dinâmicos.
- O catálogo `TEMAS_FUNDO` em si (os 5 temas e seus hex) — o painel só escolhe uma *chave* dele, nunca edita um hex diretamente.

---

## 5. Rotinas automáticas (crons)

Configuradas em `vercel.json`, ambas protegidas por `CRON_SECRET` (ver seção 3) — sem essa env var, ficam inacessíveis mesmo pra quem soubesse a URL.

### `/api/cron/liberar-estoque-pendente` — todo dia às 03:00 (`0 3 * * *`)
Libera o estoque de pedidos com `status: 'Pendente'` criados há mais de **24 horas** (`HORAS_LIMITE_PEDIDO_PENDENTE`) que ainda não tiveram estoque revertido. Cobre os casos sem rotina própria: cliente abandonou o checkout, Pix expirou, cartão foi recusado. Se falhar (erro de banco, por exemplo), devolve 500 com a mensagem de erro — não há retry automático próprio, só o que a Vercel eventualmente fizer por conta. Como não é idempotente por *tempo* mas sim por `estoqueRevertido`, rodar de novo manualmente não duplica a liberação.

### `/api/cron/anonimizar-pedidos-antigos` — todo dia às 04:00 (`0 4 * * *`)
Anonimiza dados pessoais (CPF/e-mail/telefone/endereço) de pedidos com `status: 'Pago'` mais velhos que o prazo de retenção configurado (`Config.retencaoPedidosPagosAnos`, ou o fallback `RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK` se o painel nunca configurou). Não mexe em pedido nunca pago (esse caso é resolvido na hora, pelo cancelamento, não por idade). **Idempotente de verdade**: cada pedido só é tocado se `anonimizadoEm` ainda for `null`, com trava atômica no próprio `updateOne` — rodar duas vezes seguidas não repete o efeito. Deliberadamente um cron **separado** do de estoque (comentário no código): estoque é sentido no mesmo dia pelo lojista, anonimização é faxina sem urgência — se ela travar ou ficar lenta numa base grande, isso não pode arrastar a liberação de estoque junto.

Se **qualquer um dos dois falhar** (ex: `CRON_SECRET` não configurado no ambiente, banco fora do ar no horário agendado): a Vercel simplesmente não recebe um 200 — não há alerta configurado no projeto além do que aparecer nos logs da função. Vale ter isso em mente: hoje, uma falha silenciosa nesses crons só aparece se alguém for olhar os logs ou notar o sintoma (estoque preso, dado pessoal retido além do prazo).

---

## 6. Convenções específicas deste projeto

A parte que ninguém de fora adivinharia lendo o código pela primeira vez.

**Toda rota HTML nova precisa de entrada no `vercel.json`.** Em produção, `express.static` fica **desligado** (`if (process.env.NODE_ENV !== 'production') app.use(express.static(...))`) — só roda localmente. Na Vercel, sem uma entrada em `rewrites` apontando `/nome-da-pagina.html` pra `/server.js` **e** uma rota `app.get('/nome-da-pagina.html', ...)` correspondente em `server.js`, a página bate 404, mesmo que o arquivo exista fisicamente no repositório. Isso já mordeu o projeto antes (comentário no código sobre `search.html`/`produto.html`/páginas legais "batendo 404" antes dessas rotas existirem).

**Cadeia de resolução de configuração: painel → `config.js` → fallback fixo no código** — mas o número de degraus varia por campo, não é sempre 3. Exemplos reais:
- `cepOrigem`: painel (`Config.cepOrigem`) → **env var** `LOJA_CEP_ORIGEM` → `config.js` (`configPadrao.cepOrigem`) → fallback fixo `'01310100'`. Quatro degraus, com um rung de env var que a maioria dos outros campos não tem.
- `pageTitleSuffix`: painel → `config.js` → fallback fixo `'Loja Oficial'`. Três degraus, sem env var (comentário explícito: "sem o rung do .env, não faz sentido pra esse campo").
- `cnpj`: **sem fallback nenhum**, de propósito — vazio fica vazio (as páginas legais mostram aviso pra completar), nunca um número inventado, porque é documento de empresa.
- Cores: `bg`/`bg2`/`border` vêm de `TEMAS_FUNDO[temaFundo]`; `gold`/`gold2` vêm de `corPrimaria`/`corSecundaria` se preenchidos, senão do `config.js`; todo o resto da paleta nunca sai do `config.js`.

Antes de assumir que um campo segue o padrão "óbvio" de 3 degraus, confira `mergePublicConfig()` — é a função com a fonte da verdade de cada cadeia.

**`buscarConfigCompleta()` sempre devolve 200, mesmo se o Mongo falhar.** Se a leitura do banco der erro, a função engole o erro (só loga um `console.warn`) e segue com `doc = null` — `mergePublicConfig(null)` calcula tudo a partir dos fallbacks de `config.js`. `GET /api/config` nunca devolve 5xx por causa disso. Do lado de fora, uma falha de banco fica **indistinguível** de "loja genuinamente configurada com os valores padrão". Isso é uma pendência já registrada no próprio código (comentário extenso acima da função) — ver "Pontos de atenção".

**`TEMAS_FUNDO` existe em dois lugares e precisa ser sincronizado manualmente.** O catálogo de temas de cor vive em `server.js` (fonte da verdade, validado no `POST /api/config` — só aceita uma chave conhecida, nunca hex livre) **e** tem uma cópia idêntica em `admin.html` (usada só pra desenhar os cartõezinhos de tema no painel). Mudar um tema em um lugar sem mudar no outro não quebra nada visivelmente na hora — o painel mostraria uma cor errada no seletor, mas o valor realmente salvo continuaria vindo do `server.js`. Ambos os arquivos têm comentário se referenciando um ao outro pra lembrar disso.

**`--bg`/`--bg2` não são só cor de fundo — também servem de cor de texto claro sobre superfície escura** (rodapé, botões no hover, badges, banner). Por isso o painel não expõe hex livre pra tema de fundo, só os 5 pré-calibrados: um hex "só pensando em fundo" pode deixar esse texto ilegível sem aviso nenhum. O token `--white` (fixo, nunca sobrescrito por tema) é o que hoje carrega esses casos de "texto claro" — decisão tomada quando os temas foram intensificados, pra desacoplar as duas funções.

**Cor é injetada no servidor, não só aplicada via JS no cliente.** `renderLojaHtmlComConfig()` e a função irmã pra `search.html`/`produto.html` montam um `<style>:root{...}</style>` com os valores reais de `bg`/`bg2`/`border`/`gold`/`gold2` e injetam antes de `</head>`, na mesma resposta HTTP — evita o "flash" de cor padrão → cor real que existiria se só o JS (`aplicarCoresDaLoja()`, que ainda roda depois, por outros motivos) fizesse a troca depois do primeiro paint. Qualquer novo token de cor que precise variar por loja deveria seguir o mesmo caminho (adicionar em `construirOverrideCoresStyle`), não só confiar no JS client-side.

**`Produto.sizes` (tamanho que o cliente escolhe) e `Produto.pesoKg`/`larguraCm`/`alturaCm`/`comprimentoCm` (peso/dimensão real pro frete) são conceitos completamente diferentes, sem relação entre si**, apesar de ficarem lado a lado no formulário de cadastro. Um produto pode ter um sem o outro. Falta de peso/dimensão (nem no produto, nem um padrão em `Config`) **bloqueia a venda** (não entra no carrinho); falta de `sizes` não bloqueia nada.

**Categorias são flat hoje — não existe subcategoria de verdade, apesar do nome de uma rota sugerir o contrário.** Vale um registro completo porque é o tipo de coisa que só se redescobre lendo código com atenção, e um cliente pedindo "categoria dentro de categoria" é um pedido razoável de aparecer.

*O que existe hoje:*
- `CategorySchema` (`server.js`) só tem `nome` e `slug`. Sem `parent`, sem `ordem`, sem `ativo`.
- `GET /api/categories/tree` — apesar do nome — sempre devolve `list.map(c => ({ ...c, children: [] }))`: toda categoria vira uma raiz, `children` sempre vazio, porque não há campo nenhum pra agrupar por.
- `admin.html` (`adicionarCategoria()`) só manda `{ nome }` pro servidor — a tela de cadastro de categoria nem tem campo pra escolher uma categoria-pai.
- **Do lado do cliente**, `expandirSlugsComFilhos()` (em `VN_IMPORTS.html`, usada pelo filtro de categoria da vitrine) **já sabe lidar** com uma árvore de verdade — ela lê `children` de cada nó e expande a seleção de categoria pra incluir os filhos automaticamente. Mas como a árvore que ela recebe hoje é sempre rasa, essa parte do código nunca tem efeito prático: opera corretamente, só que sobre uma entrada que nunca tem profundidade.

*O que ativar hierarquia de verdade exigiria:*
1. Adicionar `parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null }` ao `CategorySchema` real em `server.js` (não ressuscitar `models/Category.js` — esse arquivo foi removido e, mesmo vivo, não batia com a tela de categorias atual).
2. Reescrever `GET /api/categories/tree` pra agrupar por `parent` de verdade, em vez do `map` raso atual — a lógica de montar árvore a partir de uma lista flat com referência a pai já existia (removida) em `routes/categories.js`, mas precisaria ser adaptada ao schema/estilo atual do `server.js`, não copiada como estava.
3. Adicionar um seletor de categoria-pai em `adicionarCategoria()`/na tela de categorias do `admin.html` (hoje só tem campo de nome).
4. Decidir o que fazer com `POST /api/categories`/`DELETE /api/categories/:id` — hoje não levam `parent` em conta; apagar uma categoria-pai deixaria filhas "órfãs" sem nenhuma regra definida pra esse caso.
5. `expandirSlugsComFilhos()` no client-side **não precisaria mudar** — já é o pedaço que está pronto, esperando o resto.

**Todo pedido tem estoque revertido no máximo uma vez, controlado por `estoqueRevertido` (no pedido) e `estoqueDecrementado` (por item).** A reversão pode vir de duas rotas diferentes (cancelamento manual pelo admin, ou o cron de liberação) — ambas passam pela mesma função `devolverEstoqueDoPedido`, que respeita essa trava. Não assuma que só existe um caminho pra estoque voltar.

**JWT é obrigatório pra o servidor sequer iniciar.** Diferente de toda outra env var (que falha rota-a-rota), `JWT_SECRET` ausente derruba o boot inteiro (`process.exit(1)`) — decisão deliberada pra nunca rodar em "modo vulnerável" com autenticação quebrada.

**Segurança: LGPD e anonimização já são parte do fluxo normal, não um extra.** Além do cron diário de retenção (seção 5), existe uma rota de admin (`POST /api/admin/orders/anonimizar-comprador`) pra anonimizar sob demanda os pedidos de um comprador específico (por CPF/e-mail), e pedidos abandonados (nunca pagos) já são anonimizados no próprio instante do cancelamento — não esperam o cron.

---

## Pontos de atenção

Nada aqui foi corrigido — é uma lista pra você decidir o que fazer com cada item.

1. **[RESOLVIDO 2026-08-18] `routes/products.js` e `routes/categories.js`, com `models/Product.js` e `models/Category.js`, não eram usados.** `server.js` nunca dava `require` em nenhum dos dois arquivos de `routes/`. `models/Product.js` definia um `ProductSchema` bem mais simples que o `produtoSchema` real (sem peso/dimensão, sem `palavrasChave`, sem `estoque`) — claramente uma versão antiga, de antes do backend ser consolidado num único `server.js`. `models/Category.js` tinha `parent`/`ordem`/`ativo` (suporte a hierarquia) que o schema de categoria realmente usado **não tem** (é flat — ver "Categorias são flat hoje" na seção 6 pro detalhe completo). `routes/categories.js` ainda tinha sua própria cópia de `verificarJWT`, duplicada. Confirmado por três caminhos independentes (requires de `server.js`, `vercel.json`, `package.json`, e busca por qualquer referência em todo `.js` do projeto) que nada os carregava. Removidos; servidor e admin verificados de pé depois (rotas `/`, `/admin.html`, `/search.html`, `/produto.html`, `/api/produtos`, `/api/categories`, `/api/categories/tree`, `/api/config`, `/api/status` todas respondendo normalmente).

2. **[RESOLVIDO 2026-08-18] `server_HEAD.js`** — uma cópia antiga de `server.js` (1372 linhas contra as 3570 atuais), rastreada no Git, criada num commit chamado literalmente `"erro sintaxe"`. Parece um backup manual feito durante alguma sessão de correção de bug, nunca removido depois. Removido.

3. **[RESOLVIDO 2026-08-18] Um arquivo chamado `git`** (0 bytes) na raiz do projeto, também rastreado no Git — commitado junto de um commit chamado `"animação"`, sem relação nenhuma com controle de versão. Quase certamente um acidente de terminal (`git` redirecionado pra um arquivo por engano) que acabou entrando num `git add .`. Removido.

4. **[RESOLVIDO 2026-08-19] `qr_backend_patch.js`** — arquivo com um único comentário: `"helper (não executa): arquivo placeholder para manter contexto."`. Não era importado por nada. Removido.

5. **`buscarConfigCompleta()` sempre devolve HTTP 200, mesmo com o Mongo fora do ar** (detalhado na seção 6) — já registrado como pendência dentro do próprio código, explicitamente adiado "pra não misturar com a correção já aprovada no cliente" (a trava `configCarregado` do `admin.html`). Se decidir resolver, o comentário acima da função em `server.js` já descreve a mudança sugerida (propagar 5xx em vez de fallback silencioso).

6. **[RESOLVIDO 2026-08-18] `sobreTitulo`/`sobreTexto` no `ConfigSchema` tinham default hardcoded pra "Cibelle"/"Cibelle Imports"** — nome de um cliente específico vazado como valor de fábrica no schema, e não no `config.js` (que é onde esse tipo de coisa deveria morar, e que de fato não mencionava nome nenhum de cliente). Movido pra `config.js` (`sobreTitulo`/`sobreTexto` novos, texto genérico), seguindo o mesmo padrão de `nomeLoja`/`corPrimaria`. Havia uma **segunda ocorrência** do mesmo texto hardcoded dentro de `mergePublicConfig()` — um fallback independente do default do schema, fácil de não notar — também corrigida. E uma terceira, cosmética: o placeholder do campo no `admin.html` ("Ex: Cibelle Imports") também citava o nome; trocado por um exemplo genérico.

7. **Os 4 blocos de "Benefício" (`benef1`..`benef4`) têm texto promocional específico hardcoded como default** — ex: `benef1Texto: 'Receba em até 3 dias úteis. Frete grátis acima de R$299.'`. É exatamente o padrão que o comentário ao lado de `freteGratisAtivo` (linhas seguintes do mesmo schema) descreve como bug já corrigido em outro lugar ("texto fixo... prometendo algo que a loja podia nem oferecer de verdade") — só que aqui o mesmo padrão continua existindo, sem o toggle que os outros ganharam.

8. **`uploads/` está vazia e não é referenciada em lugar nenhum do código.** Upload de imagem vai direto pro Cloudinary via buffer em memória (`multer.memoryStorage()`), nunca toca disco. Resquício de uma versão anterior do upload.

9. **[RESOLVIDO 2026-08-18] `TODO.md`, `TODO_FRONT_VN_IMPORTS_NEXT.md` e `TODO_VN_IMPORTS_FILTERS.md` estavam desatualizados.** `TODO.md` já tinha tudo marcado `[x]` (era essencialmente um changelog encerrado). Os outros dois listavam como pendente trabalho que **já existia no código** — meta tags SEO/OG (já injetadas em `renderLojaHtmlComConfig`), skeleton loader (`showSkeletonGrid()` já existe e já é chamado, CSS `.sk-grid` já no lugar certo, persistência de `vn_cart` intacta), e o sistema de filtros da sidebar inteiro (categorias/tamanho/preço, hover com atalho de tamanho, overlay mobile — tudo implementado e recentemente até refinado). Todos os itens dos três arquivos foram conferidos um a um contra o código real; nenhum item pendente de verdade sobrou em nenhum dos três, então os três foram removidos por completo (em vez de mantidos com itens reescritos), conforme critério combinado.

10. **`/api/categories/tree` sempre devolve categorias "raiz" sem filhos** — não é inconsistência, é o comportamento real e documentado do schema flat de hoje. Detalhe completo, incluindo o que ativar hierarquia de verdade exigiria, na seção 6 ("Categorias são flat hoje").
