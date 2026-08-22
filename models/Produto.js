const mongoose = require('mongoose');

const produtoSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true },
    preco: { type: Number, required: true },
    // Preço "de" (riscado na vitrine) quando o produto está em promoção.
    // null = sem promoção, mostra só `preco`. Quando preenchido, deve ser
    // maior que `preco` — validado nas rotas de escrita (POST/PUT), não só
    // aqui, porque findByIdAndUpdate não roda validação custom sozinha.
    precoOriginal: { type: Number, default: null },
    imagem: { type: String, default: '' },
    // Galeria de fotos adicionais (a imagem "de capa" continua sendo `imagem`,
    // essa lista é o restante das fotos mostradas na página do produto).
    imagens: { type: [String], default: [] },
    descricao: { type: String, default: '' },
    categoria: { type: String, default: 'geral' },
    // null = sem controle de estoque habilitado para este produto (não bloqueia compra).
    // Um número (mesmo 0) = controle ativo, com aquela quantidade disponível.
    estoque: { type: Number, default: null },
    // Array de tamanhos disponíveis para o produto (ex: ['P','M','G'])
    sizes: { type: [String], default: [] },
    // Peso/dimensões REAIS do produto pra cotação de frete — conceito
    // diferente de `sizes` acima: sizes é o que o cliente escolhe (P/M/G),
    // isto aqui é o que a transportadora cobra pra despachar a caixa. Um
    // mesmo produto pode ter os dois, sem relação entre eles.
    // null = não cadastrado. Não bloqueia o cadastro/edição do produto (o
    // lojista pode cadastrar sem esse dado), mas bloqueia a VENDA — ver
    // resolverDadosEnvioProduto: sem peso/dimensão próprios nem um padrão da
    // loja configurado (Config.pesoKgPadrao etc.), o produto não entra no
    // carrinho nem em POST /api/orders. Nunca cai num número fixo genérico —
    // foi exatamente isso que fez o frete sair errado pra todo produto antes
    // desta mudança.
    pesoKg: { type: Number, default: null },
    larguraCm: { type: Number, default: null },
    alturaCm: { type: Number, default: null },
    comprimentoCm: { type: Number, default: null },
    // Sinônimos que o lojista escreve pra própria loja (ex: um produto
    // "Jaqueta" pode listar "casaco, blusa de frio") — entram na busca por
    // trecho junto de nome/categoria/descrição (ver GET /api/produtos/search).
    // Opcional de propósito: produto sem palavra-chave nenhuma continua
    // aparecendo normalmente pelos outros campos, isto só amplia o alcance.
    palavrasChave: { type: [String], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Produto || mongoose.model('Produto', produtoSchema);
