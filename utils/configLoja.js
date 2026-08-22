const configPadrao = require('../config');
const { TEMAS_FUNDO, TEMAS_HERO } = require('./temas');
const { slugifyTenantTag } = require('./slug');
const { tryConnectDb } = require('./db');
const Config = require('../models/Config');

// Referência provisória (CTN art. 173 — prazo de 5 anos que a Receita tem
// pra constituir crédito tributário), NÃO parecer jurídico/contábil. Usado só
// como fallback até o lojista confirmar o prazo certo com o contador dele
// (varia por regime tributário) e salvar um valor no painel — ver
// retencaoPedidosPagosAnos no ConfigSchema e /api/cron/anonimizar-pedidos-antigos.
const RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK = 5;

function mergePublicConfig(doc) {
  const nomeDb = doc?.nomeLoja?.trim();
  const pixDb = doc?.chavePix != null ? String(doc.chavePix).trim() : '';
  const corPrimaria = String(doc?.corPrimaria || configPadrao.corPrimaria || '').trim();
  const corSecundaria = String(doc?.corSecundaria || configPadrao.corSecundaria || '').trim();
  const cepOrigemSalvo = doc?.cepOrigem ? String(doc.cepOrigem).replace(/\D/g, '') : '';
  const cepOrigemEfetivo =
    cepOrigemSalvo ||
    String(process.env.LOJA_CEP_ORIGEM || configPadrao.cepOrigem || '01310100').replace(/\D/g, '');
  // Mesmo padrão do cepOrigem acima: painel > config.js > fallback fixo.
  const pageTitleSuffixSalvo = doc?.pageTitleSuffix ? String(doc.pageTitleSuffix).trim() : '';
  const pageTitleSuffixEfetivo =
    pageTitleSuffixSalvo || String(configPadrao.pageTitleSuffix || 'Loja Oficial').trim();
  // Mesmo padrão de painel > fallback fixo dos campos acima — aqui o fallback
  // é RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK (ver comentário na constante).
  const retencaoPedidosPagosAnosSalvo =
    doc?.retencaoPedidosPagosAnos != null && Number.isFinite(Number(doc.retencaoPedidosPagosAnos)) && Number(doc.retencaoPedidosPagosAnos) > 0
      ? Number(doc.retencaoPedidosPagosAnos)
      : null;
  const retencaoPedidosPagosAnosEfetivo =
    retencaoPedidosPagosAnosSalvo || RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK;
  // CNPJ não tem fallback nenhum (ver comentário no schema) — só o que o
  // painel salvou, ou vazio mesmo, pras páginas legais saberem mostrar um
  // aviso de "complete isso" em vez de inventar um número.
  const cnpjSalvo = doc?.cnpj ? String(doc.cnpj).replace(/\D/g, '') : '';
  // Sem terceiro degrau de fallback aqui de propósito (diferente do cepOrigem
  // acima) — um peso/dimensão inventado é exatamente o bug que motivou essa
  // mudança inteira. null = sem padrão definido, e é isso mesmo.
  const numeroPositivoOuNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const pesoKgPadrao = numeroPositivoOuNull(doc?.pesoKgPadrao);
  const larguraCmPadrao = numeroPositivoOuNull(doc?.larguraCmPadrao);
  const alturaCmPadrao = numeroPositivoOuNull(doc?.alturaCmPadrao);
  const comprimentoCmPadrao = numeroPositivoOuNull(doc?.comprimentoCmPadrao);
  // Só aceita chave conhecida do catálogo — nunca um valor arbitrário vindo do banco.
  const temaFundoKey = TEMAS_FUNDO[doc?.temaFundo] ? doc.temaFundo : 'neblina';
  const temaFundo = TEMAS_FUNDO[temaFundoKey];
  const corPainelHeroFallback = TEMAS_HERO[configPadrao.corPainelHero] ? configPadrao.corPainelHero : 'preto';
  const corPainelHeroKey = TEMAS_HERO[doc?.corPainelHero] ? doc.corPainelHero : corPainelHeroFallback;
  const corPainelHero = TEMAS_HERO[corPainelHeroKey];
  const colorsMerged = {
    // ink/accent (e todo o resto de "fixo, mesmo valor pra qualquer loja")
    // já chegam aqui por este spread — nunca precisam de uma linha própria
    // abaixo, só bg/bg2/border/hero-panel-bg/gold/gold2 realmente variam
    // por loja/tema. Ver construirOverrideCoresStyle() pra onde ink/accent
    // também são injetados no SSR (mesmo valor, só pra fechar o flash).
    ...(configPadrao.colors || {}),
    bg: temaFundo.bg,
    bg2: temaFundo.bg2,
    border: temaFundo.border,
    // Chave literal igual ao sufixo da CSS custom property (--hero-panel-bg)
    // de propósito: aplicarCoresDaLoja() no client faz 'root.style.setProperty
    // ("--" + chave, valor)' sem nenhuma conversão de camelCase pra
    // kebab-case — uma chave "heroPanelBg" geraria "--heroPanelBg", que não
    // bate com nada no CSS, e o valor nunca apareceria.
    'hero-panel-bg': corPainelHero.cor,
    ...(corPrimaria ? { gold: corPrimaria } : {}),
    ...(corSecundaria ? { gold2: corSecundaria } : {})
  };

  const bool = (v, dflt) => {
    if (v === undefined) return dflt;
    return !!v;
  };

  return {
    nomeLoja: nomeDb || configPadrao.nomeLoja,
    chavePix: pixDb || (configPadrao.chavePix || '').trim(),
    corPrimaria,
    corSecundaria,
    temaFundo: temaFundoKey,
    corPainelHero: corPainelHeroKey,
    whatsappContato: String(doc?.whatsappContato || configPadrao.whatsappContato || '').trim(),
    instagramLink: String(doc?.instagramLink || configPadrao.instagramLink || '').trim(),
    emailContato: String(doc?.emailContato || configPadrao.emailContato || '').trim(),
    clienteTag: slugifyTenantTag(doc?.clienteTag || doc?.nomeLoja || configPadrao.clienteTag || configPadrao.nomeLoja),
    cidadeLoja: String(doc?.cidadeLoja || '').trim().toUpperCase() || 'SAO PAULO',
    // cepOrigem: valor cru salvo pelo painel (vazio = nunca configurado por lá).
    // cepOrigemEfetivo: o que de fato é usado pra cotar frete agora, seguindo a
    // ordem painel > LOJA_CEP_ORIGEM (.env) > cepOrigem do config.js > fallback
    // fixo. Precedência intencional: uma vez que o admin salva um CEP aqui,
    // esse valor manda para sempre — o .env só serve pra inicializar uma loja
    // nova antes do primeiro save, nunca mais depois disso. Os dois campos
    // juntos permitem o painel avisar o lojista quando o valor em uso não é
    // o que está (ou não está) salvo ali, em vez de uma divergência muda.
    cepOrigem: cepOrigemSalvo,
    cepOrigemEfetivo,
    colors: colorsMerged,
    // pageTitleSuffix: valor cru salvo pelo painel (vazio = nunca configurado
    // por lá). pageTitleSuffixEfetivo: o que de fato entra no <title> agora —
    // mesma lógica de precedência do cepOrigem, sem o rung do .env (não faz
    // sentido pra esse campo).
    pageTitleSuffix: pageTitleSuffixSalvo,
    pageTitleSuffixEfetivo,
    cnpj: cnpjSalvo,
    retencaoPedidosPagosAnos: retencaoPedidosPagosAnosSalvo,
    retencaoPedidosPagosAnosEfetivo,
    pesoKgPadrao,
    larguraCmPadrao,
    alturaCmPadrao,
    comprimentoCmPadrao,

    // Textos do hero — vazio de propósito quando não configurado no admin,
    // pra o front saber que deve preservar o texto padrão já no HTML.
    heroTitle: String(doc?.heroTitle ?? '').trim(),
    heroFont: String(doc?.heroFont ?? '').trim(),
    heroEyebrow: String(doc?.heroEyebrow ?? '').trim(),
    heroSubtitulo: String(doc?.heroSubtitulo ?? '').trim(),

    // Conteúdo (About + Benefícios)
    sobreTitulo: String(doc?.sobreTitulo ?? '').trim() || configPadrao.sobreTitulo,
    sobreTexto: String(doc?.sobreTexto ?? '').trim() || configPadrao.sobreTexto,

    benef1Titulo: String(doc?.benef1Titulo ?? '').trim() || 'Entrega Rápida',
    benef1Texto: String(doc?.benef1Texto ?? '').trim() || 'Receba em até 3 dias úteis. Frete grátis acima de R$299.',
    benef1IcoEnabled: bool(doc?.benef1IcoEnabled, true),
    benef1Ico: String(doc?.benef1Ico ?? '').trim() || '🚚',

    benef2Titulo: String(doc?.benef2Titulo ?? '').trim() || 'Devolução em 7 Dias',
    benef2Texto: String(doc?.benef2Texto ?? '').trim() || 'Direito de arrependimento garantido por lei.',
    benef2IcoEnabled: bool(doc?.benef2IcoEnabled, true),
    benef2Ico: String(doc?.benef2Ico ?? '').trim() || '↩️',

    benef3Titulo: String(doc?.benef3Titulo ?? '').trim() || 'Pagamento Seguro',
    benef3Texto: String(doc?.benef3Texto ?? '').trim() || 'PIX com total segurança.',
    benef3IcoEnabled: bool(doc?.benef3IcoEnabled, true),
    benef3Ico: String(doc?.benef3Ico ?? '').trim() || '🔒',

    benef4Titulo: String(doc?.benef4Titulo ?? '').trim() || 'Importado Selecionado',
    benef4Texto: String(doc?.benef4Texto ?? '').trim() || 'Curadoria rigorosa de produtos internacionais.',
    benef4IcoEnabled: bool(doc?.benef4IcoEnabled, true),
    benef4Ico: String(doc?.benef4Ico ?? '').trim() || '💎',

    // Barra de anúncio: só mostra o que o admin realmente ativou.
    usaTamanhosPadrao: bool(doc?.usaTamanhosPadrao, configPadrao.usaTamanhosPadrao !== false),

    freteGratisAtivo: bool(doc?.freteGratisAtivo, false),
    freteGratisValor: Number(doc?.freteGratisValor) || 0,
    parcelamentoAtivo: bool(doc?.parcelamentoAtivo, false),
    parcelamentoMax: Math.max(1, Number(doc?.parcelamentoMax) || 1),

    // Banner de promoção: só aparece quando o admin ativar de verdade.
    promoAtiva: bool(doc?.promoAtiva, false),
    promoEyebrow: String(doc?.promoEyebrow ?? '').trim(),
    promoTitulo: String(doc?.promoTitulo ?? '').trim(),
    promoSubtitulo: String(doc?.promoSubtitulo ?? '').trim(),
    promoCtaTexto: String(doc?.promoCtaTexto ?? '').trim() || 'Ver promoções'
  };
}

// Loja config
// Inclui: nome, whatsapp e demais tokens usados pelo template (busca no banco,
// cria o documento padrão se for a primeira vez, e devolve já mesclado com
// os fallbacks de configPadrao via mergePublicConfig).
//
// PENDÊNCIA REGISTRADA (não mexer agora — próxima rodada): se a leitura do
// Mongo falhar aqui (linha do catch logo abaixo), a função engole o erro e
// segue com doc=null — mergePublicConfig(null) calcula todo campo a partir
// dos fallbacks de configPadrao, e GET /api/config devolve 200 OK com esse
// conteúdo. Do lado de fora, uma falha de banco fica indistinguível de "loja
// realmente configurada assim". Foi um dos dois gatilhos confirmados do bug
// em que o formulário de admin salvou "Minha Loja" por cima de um nome real
// (ver loadConfig()/configCarregado em admin.html — a mitigação atual é do
// lado do cliente, recusando salvar quando o carregamento não foi confirmado
// como bem-sucedido). Vale essa rota propagar a falha (5xx) em vez de
// devolver 200 com fallback — não implementado agora de propósito, pra não
// misturar essa mudança de servidor com a correção já aprovada no cliente.
async function buscarConfigCompleta() {
  let doc = null;
  try {
    if (await tryConnectDb()) {
      doc = await Config.findOne().lean();
      if (!doc) {
        doc = await Config.create({
          nomeLoja: configPadrao.nomeLoja,
          chavePix: configPadrao.chavePix || '',
          corPrimaria: configPadrao.corPrimaria,
          corSecundaria: configPadrao.corSecundaria,
          whatsappContato: configPadrao.whatsappContato,
          instagramLink: configPadrao.instagramLink,
          emailContato: configPadrao.emailContato,
          clienteTag: slugifyTenantTag(configPadrao.clienteTag || configPadrao.nomeLoja)
        });
        doc = doc?.toObject ? doc.toObject() : doc;
      }
    }
  } catch (e) {
    console.warn('buscarConfigCompleta:', e.message);
  }

  // Para preservar compatibilidade, garantimos campos extras se existirem no banco.
  // Se o banco estiver vazio, retornamos um objeto padrão.
  return mergePublicConfig(doc);
}

module.exports = { mergePublicConfig, RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK, buscarConfigCompleta };
