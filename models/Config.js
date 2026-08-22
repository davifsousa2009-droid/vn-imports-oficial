const mongoose = require('mongoose');
const configPadrao = require('../config');
const { slugifyTenantTag } = require('../utils/slug');
const { TEMAS_HERO } = require('../utils/temas');

const ConfigSchema = new mongoose.Schema({
  nomeLoja: { type: String, default: configPadrao.nomeLoja },
  chavePix: { type: String, default: '' },
  corPrimaria: { type: String, default: configPadrao.corPrimaria },
  corSecundaria: { type: String, default: configPadrao.corSecundaria },
  // Chave de um tema pré-calibrado em TEMAS_FUNDO — nunca um hex livre (ver
  // comentário acima do catálogo).
  temaFundo: { type: String, default: 'neblina' },
  // Chave de um tom pré-calibrado em TEMAS_HERO (cor do painel de texto do
  // hero) — mesmo princípio do temaFundo acima, nunca hex livre. Default vem
  // de configPadrao (config.js), mesmo padrão de usaTamanhosPadrao: cada
  // implantação pode nascer com outro tom sem afetar lojas já em produção.
  corPainelHero: { type: String, default: TEMAS_HERO[configPadrao.corPainelHero] ? configPadrao.corPainelHero : 'preto' },
  whatsappContato: { type: String, default: configPadrao.whatsappContato },
  instagramLink: { type: String, default: configPadrao.instagramLink },
  emailContato: { type: String, default: configPadrao.emailContato },
  clienteTag: { type: String, default: slugifyTenantTag(configPadrao.clienteTag || configPadrao.nomeLoja) },
  // Cidade do lojista — exigida pelo padrão do Pix (BR Code) no Copia e Cola.
  cidadeLoja: { type: String, default: 'SAO PAULO' },
  // CEP de origem (remetente) usado nas cotações do Melhor Envio. Vazio =
  // painel nunca foi usado pra isso — nesse caso o valor efetivo (calculado
  // em mergePublicConfig) cai pra LOJA_CEP_ORIGEM (.env) ou cepOrigem do
  // config.js. Assim que o admin salva algo aqui, esse valor manda, sempre —
  // ver comentário em mergePublicConfig sobre a precedência.
  cepOrigem: { type: String, default: '' },
  // Sufixo do <title> (ex: "Nome da Loja — Loja Oficial"), usado em SEO.
  // Vazio = painel nunca foi usado pra isso — mesmo padrão do cepOrigem
  // acima: o valor efetivo cai pro pageTitleSuffix do config.js, e se
  // também estiver vazio, num fallback fixo neutro.
  pageTitleSuffix: { type: String, default: '' },
  // CNPJ da loja — exigido nas páginas legais (Política de Privacidade,
  // Termos de Uso, Devolução). Não existe fallback nenhum pra isso
  // (config.js não tem CNPJ de propósito — branco-de-loja não pode chumbar
  // documento de empresa): vazio aqui é vazio nas páginas, com aviso pro
  // lojista completar, não um número inventado.
  cnpj: { type: String, default: '' },
  // Prazo (em anos) até um pedido PAGO ser anonimizado (ver
  // /api/cron/anonimizar-pedidos-antigos). null = painel nunca configurado —
  // usa RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK. 5 anos é referência provisória
  // (CTN art. 173), não parecer jurídico/contábil — mantido configurável
  // aqui de propósito pra ajustar sem redeploy assim que confirmado com o
  // contador do lojista.
  retencaoPedidosPagosAnos: { type: Number, default: null },

  // Peso/dimensões padrão da loja, usados só quando um produto específico
  // não tem os próprios cadastrados (ver resolverDadosEnvioProduto) — reduz
  // trabalho de cadastro pra loja com produtos de peso parecido. null em
  // qualquer um destes = sem padrão definido; nesse caso um produto sem dado
  // próprio fica bloqueado pra venda, não usa nenhum valor inventado.
  pesoKgPadrao: { type: Number, default: null },
  larguraCmPadrao: { type: Number, default: null },
  alturaCmPadrao: { type: Number, default: null },
  comprimentoCmPadrao: { type: Number, default: null },

  // Mostra ou não os atalhos de tamanho P/M/G/GG no cadastro de produto do
  // admin — branco-de-loja: nem toda loja vende roupa/calçado. Default vem
  // de configPadrao (config.js), não de um true fixo, pra cada implantação
  // poder nascer já com o valor certo pro segmento do cliente.
  usaTamanhosPadrao: { type: Boolean, default: configPadrao.usaTamanhosPadrao !== false },

  // Barra de anúncio (frete grátis / parcelamento) — desligada por padrão.
  // Antes esses valores eram texto fixo no HTML, prometendo algo que a loja
  // podia nem oferecer de verdade (ex: parcelamento sem ter cartão configurado).
  freteGratisAtivo: { type: Boolean, default: false },
  freteGratisValor: { type: Number, default: 0 },
  parcelamentoAtivo: { type: Boolean, default: false },
  parcelamentoMax: { type: Number, default: 1 },

  // Banner de promoção — desligado por padrão. Antes era um "Até 40% OFF" fixo,
  // mostrado pra sempre mesmo sem nenhuma promoção real acontecendo.
  promoAtiva: { type: Boolean, default: false },
  promoEyebrow: { type: String, default: '' },
  promoTitulo: { type: String, default: '' },
  promoSubtitulo: { type: String, default: '' },
  promoCtaTexto: { type: String, default: '' },

  // heroImagem/heroImagemUrl (foto única do hero antigo) removidos — a
  // imagem do hero agora vem de /api/banners (ver models/Banner.js), não
  // mais daqui. Textos do hero (título, selo "Coleção Exclusiva" e
  // subtítulo) continuam aqui, sem relação com a foto. Vazio = mantém
  // o texto padrão já escrito no HTML (o front só sobrescreve quando vier algo).
  heroTitle: { type: String, default: '' },
  heroFont: { type: String, default: '' },
  heroEyebrow: { type: String, default: '' },
  heroSubtitulo: { type: String, default: '' },

  // ✅ NOVO: Configurações dinâmicas de conteúdo do site (Admin → vitrine)
  // Default vem de configPadrao (config.js), mesmo padrão de nomeLoja/corPrimaria
  // acima — não um texto de cliente específico chumbado no schema.
  sobreTitulo: { type: String, default: configPadrao.sobreTitulo },
  sobreTexto: { type: String, default: configPadrao.sobreTexto },

  // Benefício 1: Entrega Rápida
  benef1Titulo: { type: String, default: 'Entrega Rápida' },
  benef1Texto: { type: String, default: 'Receba em até 3 dias úteis. Frete grátis acima de R$299.' },
  benef1IcoEnabled: { type: Boolean, default: true },
  benef1Ico: { type: String, default: '🚚' },

  // Benefício 2: Devolução em 7 Dias (direito de arrependimento, CDC art. 49
  // — nunca "troca": a loja não promete trocar produto por outro tamanho/cor,
  // só devolver dentro do prazo legal. Ver /devolucao.html.)
  benef2Titulo: { type: String, default: 'Devolução em 7 Dias' },
  benef2Texto: { type: String, default: 'Direito de arrependimento garantido por lei.' },
  benef2IcoEnabled: { type: Boolean, default: true },
  benef2Ico: { type: String, default: '↩️' },

  // Benefício 3: Pagamento Seguro
  benef3Titulo: { type: String, default: 'Pagamento Seguro' },
  benef3Texto: { type: String, default: 'PIX com total segurança.' },
  benef3IcoEnabled: { type: Boolean, default: true },
  benef3Ico: { type: String, default: '🔒' },

  // Benefício 4: Importado Selecionado
  benef4Titulo: { type: String, default: 'Importado Selecionado' },
  benef4Texto: { type: String, default: 'Curadoria rigorosa de produtos internacionais.' },
  benef4IcoEnabled: { type: Boolean, default: true },
  benef4Ico: { type: String, default: '💎' }
});

module.exports = mongoose.models.Config || mongoose.model('Config', ConfigSchema);
