const express = require('express');
const router = express.Router();

const configPadrao = require('../config');
const Config = require('../models/Config');
const Settings = require('../models/Settings');
const { verificarJWT } = require('../middleware/auth');
const { ensureDbConnected, tryConnectDb } = require('../utils/db');
const { mergePublicSettings } = require('../utils/settingsLoja');
const { mergePublicConfig, buscarConfigCompleta } = require('../utils/configLoja');
const { TEMAS_FUNDO, TEMAS_HERO } = require('../utils/temas');
const { slugifyTenantTag } = require('../utils/slug');

// Lê peso/dimensão do corpo da requisição: vazio/ausente é válido (não
// bloqueia cadastro nem edição — ver decisão registrada no schema de
// Produto), null é o valor salvo pra "não preenchido"; só rejeita algo que
// não é número válido e positivo, pra não salvar NaN por engano. Mesma
// função de routes/produtos.js — duplicada de propósito (função pequena e
// pura, usada só nestes dois lugares; não valia criar um utils/ só pra ela).
function lerCampoEnvioOpcional(valor, rotulo) {
  if (valor === '' || valor == null) return { ok: true, valor: null };
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, erro: `${rotulo} inválido — use um número maior que zero, ou deixe em branco.` };
  return { ok: true, valor: n };
}

router.get('/settings', async (req, res) => {
  let doc = null;
  try {
    if (await tryConnectDb()) doc = await Settings.findOne().lean();
  } catch {
    // ignore
  }
  if (!doc) doc = { pix_key: '' };
  res.json(mergePublicSettings(doc));
});

router.post('/settings', verificarJWT, async (req, res) => {

  if (!(await ensureDbConnected(res))) return;
  try {
    const mp_token = req.body?.mp_token != null ? String(req.body.mp_token).trim() : '';
    const mp_public_key = req.body?.mp_public_key != null ? String(req.body.mp_public_key).trim() : '';
    const me_token = req.body?.me_token != null ? String(req.body.me_token).trim() : '';
    const pix_key = req.body?.pix_key != null ? String(req.body.pix_key).trim() : '';
    const mp_webhook_secret = req.body?.mp_webhook_secret != null ? String(req.body.mp_webhook_secret).trim() : '';

    // mp_token/me_token/mp_webhook_secret nunca voltam pro formulário do admin
    // (o valor salvo fica escondido por segurança) — então um valor vazio aqui
    // é ambíguo: pode ser "sem token" ou só "não mexi nesse campo agora". Por
    // isso só sobrescrevemos quando vier algo de fato preenchido, e usamos
    // $set (nunca um objeto de substituição direta) pra essa atualização
    // nunca apagar campos que não fazem parte deste payload.
    // pix_key entra na mesma regra dos tokens acima (achado de auditoria: uma
    // falha ao carregar a página deixava esse campo em branco, indistinguível
    // de "lojista limpou de propósito", e salvar nesse estado apagava a chave
    // Pix real — quebra silenciosa de recebimento). mp_public_key não é
    // segredo e continua sempre aplicado — é o mesmo texto que já aparece
    // preenchido no formulário, sem essa ambiguidade.
    const dados = { mp_public_key };
    if (pix_key) dados.pix_key = pix_key;
    if (mp_token) dados.mp_token = mp_token;
    if (me_token) dados.me_token = me_token;
    if (mp_webhook_secret) dados.mp_webhook_secret = mp_webhook_secret;

    const updated = await Settings.findOneAndUpdate(
      {},
      { $set: dados },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ mensagem: 'Configurações salvas!', config: mergePublicSettings(updated) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar settings', detalhe: err.message });
  }
});

router.get('/config', async (req, res) => {
  const cfg = await buscarConfigCompleta();
  return res.json(cfg);
});

router.post('/config', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const {
      nomeLoja,
      chavePix,
      corPrimaria,
      corSecundaria,
      temaFundo,
      corPainelHero,
      whatsappContato,
      instagramLink,
      emailContato,
      clienteTag,
      cidadeLoja,
      cepOrigem,
      pageTitleSuffix,
      cnpj,
      retencaoPedidosPagosAnos,
      pesoKgPadrao,
      larguraCmPadrao,
      alturaCmPadrao,
      comprimentoCmPadrao,

      // heroImagem/heroImagemUrl removidos — imagem do hero agora vem de
      // /api/banners, não mais daqui.
      heroTitle,
      heroFont,
      heroEyebrow,
      heroSubtitulo,

      // ✅ NOVO: Conteúdo dinâmico
      sobreTitulo,
      sobreTexto,

      benef1Titulo,
      benef1Texto,
      benef1IcoEnabled,
      benef1Ico,

      benef2Titulo,
      benef2Texto,
      benef2IcoEnabled,
      benef2Ico,

      benef3Titulo,
      benef3Texto,
      benef3IcoEnabled,
      benef3Ico,

      benef4Titulo,
      benef4Texto,
      benef4IcoEnabled,
      benef4Ico,

      usaTamanhosPadrao,

      freteGratisAtivo,
      freteGratisValor,
      parcelamentoAtivo,
      parcelamentoMax,

      promoAtiva,
      promoEyebrow,
      promoTitulo,
      promoSubtitulo,
      promoCtaTexto
    } = req.body;

    const dados = { nomeLoja: nomeLoja?.trim() || configPadrao.nomeLoja };
    if (chavePix !== undefined) dados.chavePix = String(chavePix).trim();
    if (corPrimaria !== undefined) dados.corPrimaria = String(corPrimaria).trim();
    if (corSecundaria !== undefined) dados.corSecundaria = String(corSecundaria).trim();
    // Só grava se for uma chave conhecida do catálogo — barra tentativa de
    // salvar um valor arbitrário direto na API, não só na UI do admin.
    if (temaFundo !== undefined) dados.temaFundo = TEMAS_FUNDO[temaFundo] ? temaFundo : 'neblina';
    if (corPainelHero !== undefined) {
      dados.corPainelHero = TEMAS_HERO[corPainelHero]
        ? corPainelHero
        : (TEMAS_HERO[configPadrao.corPainelHero] ? configPadrao.corPainelHero : 'preto');
    }
    if (whatsappContato !== undefined) dados.whatsappContato = String(whatsappContato).trim();
    if (instagramLink !== undefined) dados.instagramLink = String(instagramLink).trim();
    if (emailContato !== undefined) dados.emailContato = String(emailContato).trim();
    if (clienteTag !== undefined) dados.clienteTag = slugifyTenantTag(clienteTag);
    if (cidadeLoja !== undefined) dados.cidadeLoja = String(cidadeLoja).trim().toUpperCase().slice(0, 15);
    if (cepOrigem !== undefined) {
      // Mesmo critério de CEP usado em /api/frete/calcular e /api/orders:
      // 8 dígitos ou nada. Vazio é válido de propósito — é como o lojista
      // "desfaz" o valor salvo aqui e volta a depender do .env/config.js.
      const cepOrigemDigitos = String(cepOrigem).replace(/\D/g, '');
      if (cepOrigemDigitos && cepOrigemDigitos.length !== 8) {
        return res.status(400).json({ erro: 'CEP de origem inválido — use 8 dígitos ou deixe em branco.' });
      }
      dados.cepOrigem = cepOrigemDigitos;
    }
    // Vazio é válido de propósito — mesmo raciocínio do cepOrigem: "desfaz" o
    // valor salvo aqui e volta a depender do config.js. Limite de tamanho só
    // pra não deixar alguém colar um parágrafo inteiro num <title>.
    if (pageTitleSuffix !== undefined) dados.pageTitleSuffix = String(pageTitleSuffix).trim().slice(0, 60);
    if (cnpj !== undefined) {
      // Mesmo critério de CPF já usado em /api/orders: 14 dígitos ou nada.
      // Vazio é válido — apaga o CNPJ salvo, as páginas legais voltam a
      // mostrar o aviso de "complete isso" em vez de manter um valor velho.
      const cnpjDigitos = String(cnpj).replace(/\D/g, '');
      if (cnpjDigitos && cnpjDigitos.length !== 14) {
        return res.status(400).json({ erro: 'CNPJ inválido — use 14 dígitos ou deixe em branco.' });
      }
      dados.cnpj = cnpjDigitos;
    }
    if (retencaoPedidosPagosAnos !== undefined) {
      // Vazio é válido de propósito — mesmo raciocínio do cepOrigem: "desfaz"
      // o valor salvo aqui e volta a depender de RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK.
      // Faixa de 1-20 anos é só uma trava de sanidade contra erro de digitação
      // (ex: "500"), não um limite legal.
      const anosRaw = String(retencaoPedidosPagosAnos).trim();
      if (!anosRaw) {
        dados.retencaoPedidosPagosAnos = null;
      } else {
        const anosNum = Number(anosRaw);
        if (!Number.isFinite(anosNum) || !Number.isInteger(anosNum) || anosNum < 1 || anosNum > 20) {
          return res.status(400).json({ erro: 'Prazo de retenção inválido — use um número inteiro de anos entre 1 e 20, ou deixe em branco.' });
        }
        dados.retencaoPedidosPagosAnos = anosNum;
      }
    }
    // Padrão da loja de peso/dimensão — mesmo raciocínio de "vazio apaga o
    // valor salvo" do cepOrigem/retenção acima. Sem terceiro fallback fixo
    // (ver comentário em mergePublicConfig): vazio aqui é vazio de verdade.
    for (const [chave, valor, rotulo] of [
      ['pesoKgPadrao', pesoKgPadrao, 'Peso padrão'],
      ['larguraCmPadrao', larguraCmPadrao, 'Largura padrão'],
      ['alturaCmPadrao', alturaCmPadrao, 'Altura padrão'],
      ['comprimentoCmPadrao', comprimentoCmPadrao, 'Comprimento padrão']
    ]) {
      if (valor === undefined) continue;
      const lido = lerCampoEnvioOpcional(valor, rotulo);
      if (!lido.ok) return res.status(400).json({ erro: lido.erro });
      dados[chave] = lido.valor;
    }
    if (!dados.clienteTag) dados.clienteTag = slugifyTenantTag(dados.nomeLoja || configPadrao.nomeLoja);

    if (heroTitle !== undefined) dados.heroTitle = String(heroTitle).trim();
    if (heroFont !== undefined) dados.heroFont = String(heroFont).trim();
    if (heroEyebrow !== undefined) dados.heroEyebrow = String(heroEyebrow).trim();
    if (heroSubtitulo !== undefined) dados.heroSubtitulo = String(heroSubtitulo).trim();

    // ✅ NOVO: Conteúdo dinâmico (About + Benefícios)
    if (sobreTitulo !== undefined) dados.sobreTitulo = String(sobreTitulo).trim();
    if (sobreTexto !== undefined) dados.sobreTexto = String(sobreTexto).trim();

    if (benef1Titulo !== undefined) dados.benef1Titulo = String(benef1Titulo).trim();
    if (benef1Texto !== undefined) dados.benef1Texto = String(benef1Texto).trim();
    if (benef1IcoEnabled !== undefined) dados.benef1IcoEnabled = !!benef1IcoEnabled;
    if (benef1Ico !== undefined) dados.benef1Ico = String(benef1Ico).trim();

    if (benef2Titulo !== undefined) dados.benef2Titulo = String(benef2Titulo).trim();
    if (benef2Texto !== undefined) dados.benef2Texto = String(benef2Texto).trim();
    if (benef2IcoEnabled !== undefined) dados.benef2IcoEnabled = !!benef2IcoEnabled;
    if (benef2Ico !== undefined) dados.benef2Ico = String(benef2Ico).trim();

    if (benef3Titulo !== undefined) dados.benef3Titulo = String(benef3Titulo).trim();
    if (benef3Texto !== undefined) dados.benef3Texto = String(benef3Texto).trim();
    if (benef3IcoEnabled !== undefined) dados.benef3IcoEnabled = !!benef3IcoEnabled;
    if (benef3Ico !== undefined) dados.benef3Ico = String(benef3Ico).trim();

    if (benef4Titulo !== undefined) dados.benef4Titulo = String(benef4Titulo).trim();
    if (benef4Texto !== undefined) dados.benef4Texto = String(benef4Texto).trim();
    if (benef4IcoEnabled !== undefined) dados.benef4IcoEnabled = !!benef4IcoEnabled;
    if (benef4Ico !== undefined) dados.benef4Ico = String(benef4Ico).trim();

    if (usaTamanhosPadrao !== undefined) dados.usaTamanhosPadrao = !!usaTamanhosPadrao;

    if (freteGratisAtivo !== undefined) dados.freteGratisAtivo = !!freteGratisAtivo;
    if (freteGratisValor !== undefined) dados.freteGratisValor = Number(freteGratisValor) || 0;
    if (parcelamentoAtivo !== undefined) dados.parcelamentoAtivo = !!parcelamentoAtivo;
    if (parcelamentoMax !== undefined) dados.parcelamentoMax = Math.max(1, Number(parcelamentoMax) || 1);

    if (promoAtiva !== undefined) dados.promoAtiva = !!promoAtiva;
    if (promoEyebrow !== undefined) dados.promoEyebrow = String(promoEyebrow).trim();
    if (promoTitulo !== undefined) dados.promoTitulo = String(promoTitulo).trim();
    if (promoSubtitulo !== undefined) dados.promoSubtitulo = String(promoSubtitulo).trim();
    if (promoCtaTexto !== undefined) dados.promoCtaTexto = String(promoCtaTexto).trim();

    // $set é essencial aqui: sem ele, o MongoDB trata isso como substituição
    // TOTAL do documento — qualquer campo fora de `dados` (ex: os salvos pelo
    // outro formulário do admin) seria apagado. Com $set, só o que está em
    // `dados` é tocado; o resto do documento permanece intacto.
    const atualizado = await Config.findOneAndUpdate({}, { $set: dados }, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    res.json({ mensagem: 'Configuração atualizada!', config: mergePublicConfig(atualizado) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
