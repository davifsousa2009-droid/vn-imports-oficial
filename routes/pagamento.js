const express = require('express');
const router = express.Router();

const configPadrao = require('../config');
const Settings = require('../models/Settings');
const Order = require('../models/Order');
const Config = require('../models/Config');
const { tryConnectDb } = require('../utils/db');
const { sanitizarChavePix, gerarPixCopiaCola, validarAssinaturaWebhookMp } = require('../utils/pix');
const { mergePublicSettings, temMpTokenSalvo } = require('../utils/settingsLoja');
const { dividirNomePagador, emailPagadorValido } = require('../utils/pagador');

// Rotas de /api/pix/* e /api/payment/* movidas para routes/pagamento.js —
// reorganização pura, mesmo comportamento. GRUPO MAIS SENSÍVEL do sistema
// (pagamento/webhook), movido por último e com atenção redobrada — ver
// relatório final da refatoração.

// ── PIX AUTOMÁTICO ─────────────────────────────────────

// Gera o "Pix Copia e Cola" com valor travado para um pedido específico.
// Usado quando não há token do Mercado Pago configurado (fallback manual) —
// mesmo sem integração automática, o valor não fica mais livre pro cliente editar.
router.post('/pix/copia-cola', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const orderId = req.body?.orderId ? String(req.body.orderId) : null;
    if (!orderId) return res.status(400).json({ ok: false, reason: 'MISSING_ORDER_ID' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    if (order.status !== 'Pendente') {
      return res.status(409).json({ ok: false, reason: 'ORDER_ALREADY_PROCESSED' });
    }

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, reason: 'INVALID_AMOUNT' });
    }

    const [settingsDoc, configDoc] = await Promise.all([
      Settings.findOne().lean(),
      Config.findOne().lean()
    ]);

    const chave = settingsDoc?.pix_key ? String(settingsDoc.pix_key).trim() : '';
    if (!chave) return res.status(400).json({ ok: false, reason: 'NO_PIX_KEY' });

    const chaveLimpa = sanitizarChavePix(chave);

    const nome = configDoc?.nomeLoja || configPadrao.nomeLoja || 'LOJA';
    const cidade = configDoc?.cidadeLoja || 'SAO PAULO';
    const txid = String(order._id);

    const copiaECola = gerarPixCopiaCola({ chave, valor: amount, nome, cidade, txid });

    // Retorna o valor travado (do pedido no banco) e a chave limpa —
    // o front pode exibir a confirmação de valor antes de o cliente copiar.
    return res.json({ ok: true, copiaECola, valor: amount, chave: chaveLimpa });
  } catch (e) {
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

// Consumido pelo checkout (VN_IMPORTS.html) pra decidir se mostra a opção de
// pagamento por cartão — precisa de mp_token salvo (credencial, fica só no
// servidor) e mp_public_key (chave pública, essa sim vai pro navegador pra
// inicializar o SDK do Mercado Pago).
router.get('/payment/config', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.json({ hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' });
    }

    const doc = await Settings.findOne().lean();
    const hasMpToken = temMpTokenSalvo(doc);
    const publicCfg = mergePublicSettings(doc);

    return res.json({
      hasMpToken,
      mpPublicKey: publicCfg.mp_public_key,
      pixKeyFallback: sanitizarChavePix(publicCfg.pix_key)
    });
  } catch {
    return res.json({ hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' });
  }
});

/**
 * Cria o pagamento no Mercado Pago (cartão ou Pix via MP) para um pedido já
 * existente. Chamada pelo checkout do VN_IMPORTS.html depois que o cartão foi
 * tokenizado no navegador (ou, no caso do Pix, direto após criar o pedido).
 *
 * IMPORTANTE: o valor cobrado é sempre order.total, já salvo no banco quando
 * o pedido foi criado em /api/orders — nunca o "total" que vem no corpo desta
 * requisição. Confiar no total do cliente reabriria a mesma brecha de
 * manipulação de preço que /api/orders já corrige na criação do pedido.
 */
router.post('/payment/create', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const settings = await Settings.findOne().lean();
    if (!temMpTokenSalvo(settings)) {
      return res.status(400).json({ ok: false, reason: 'NO_MP_TOKEN' });
    }
    const mpToken = String(settings.mp_token).trim();

    const method = req.body?.method === 'card' ? 'card' : (req.body?.method === 'pix' ? 'pix' : null);
    if (!method) {
      return res.status(400).json({ ok: false, reason: 'INVALID_METHOD' });
    }

    const orderId = req.body?.orderId ? String(req.body.orderId) : null;
    if (!orderId) {
      return res.status(400).json({ ok: false, reason: 'MISSING_ORDER_ID' });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    }
    if (order.status !== 'Pendente') {
      return res.status(409).json({ ok: false, reason: 'ORDER_ALREADY_PROCESSED' });
    }

    const amount = Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, reason: 'INVALID_AMOUNT' });
    }

    const payerEmail = req.body?.payerEmail ? String(req.body.payerEmail).trim() : '';
    // E-mail nunca teve um fallback seguro pro MP — 'test@test.com' passava na
    // validação do formulário (que nem barrava e-mail vazio de verdade) mas é
    // recusado pelo MP em produção. Exige um e-mail plausível antes de gastar
    // a chamada.
    if (!emailPagadorValido(payerEmail)) {
      return res.status(400).json({ ok: false, reason: 'INVALID_PAYER_EMAIL' });
    }
    const payerCpf = req.body?.payerCpf ? String(req.body.payerCpf).replace(/\D/g, '') : '';
    const { first_name, last_name } = dividirNomePagador(req.body?.payerName);
    const payer = {
      email: payerEmail,
      first_name,
      last_name,
      identification: { type: 'CPF', number: payerCpf }
    };

    let payload;
    if (method === 'card') {
      const token = req.body?.token ? String(req.body.token) : '';
      if (!token) {
        return res.status(400).json({ ok: false, reason: 'MISSING_CARD_TOKEN' });
      }
      payload = {
        transaction_amount: amount,
        token,
        description: `Pedido ${orderId} — ${configPadrao.nomeLoja}`,
        installments: Number(req.body?.installments) || 1,
        payment_method_id: req.body?.payment_method_id ? String(req.body.payment_method_id) : '',
        payer
      };
    } else {
      payload = {
        transaction_amount: amount,
        description: `Pedido ${orderId} — ${configPadrao.nomeLoja}`,
        payment_method_id: 'pix',
        payer
      };
    }

    // X-Idempotency-Key evita cobrança duplicada se a mesma requisição for
    // reenviada (retry de rede, dois cliques antes do botão desabilitar).
    // Cartão inclui o token no derivado: cada tokenização é única mesmo numa
    // nova tentativa com o mesmo cartão, então uma tentativa de verdade
    // sempre ganha uma chave nova — só uma requisição IDÊNTICA reenviada
    // (mesmo token) reaproveita a mesma chave e é deduplicada pelo MP, sem
    // travar um retry legítimo após recusa. Pix não tem token por tentativa,
    // mas a criação de um pagamento Pix bem formado praticamente nunca
    // "recusa" pedindo retry com dado diferente (recusa real é payload
    // inválido, que esta correção já resolve) — chavear só por pedido é seguro.
    const idempotencyKey = method === 'card'
      ? `payment-create-card-${orderId}-${payload.token}`
      : `payment-create-pix-${orderId}`;

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mpToken}`,
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    const mpJson = await mpRes.json().catch(() => ({}));

    if (!mpRes.ok) {
      console.error('[payment/create] Mercado Pago recusou a criação do pagamento:', JSON.stringify(mpJson));
      return res.status(502).json({ ok: false, reason: 'MP_PAYMENT_CREATE_FAILED', mpError: mpJson });
    }

    const mpStatus = mpJson?.status || '';
    const approved = mpStatus === 'approved';

    // Guarda o ID do pagamento no pedido em qualquer desfecho — o webhook
    // (/api/pix/webhook) usa isso pra confirmar depois, e vale como registro
    // da tentativa mesmo se for recusada.
    if (mpJson?.id) order.mpPaymentId = String(mpJson.id);
    if (approved) order.status = 'Pago';
    // pendente/em análise (in_process, pending, etc.) mantém status 'Pendente'.
    await order.save();

    if (mpStatus === 'rejected') {
      // Recusado pela operadora/MP — pedido continua Pendente, nada de estoque
      // é decrementado de novo (isso já aconteceu na criação do pedido).
      return res.json({
        ok: false,
        reason: 'MP_PAYMENT_REJECTED',
        mpError: mpJson,
        orderId: String(order._id),
        status: order.status
      });
    }

    const qrCode =
      mpJson?.point_of_interaction?.transaction_data?.qr_code || mpJson?.qr_code || '';
    const qrCodeBase64 =
      mpJson?.point_of_interaction?.transaction_data?.qr_code_base64 || mpJson?.qr_code_base64 || '';

    return res.json({
      ok: true,
      method,
      paymentId: mpJson?.id ? String(mpJson.id) : '',
      status: mpStatus,
      orderId: String(order._id),
      total: order.total,
      approved,
      ...(method === 'pix' ? { qr_code: qrCode, qr_code_base64: qrCodeBase64 } : {})
    });
  } catch (e) {
    console.error('[payment/create] Erro:', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

/**
 * Consultado pelo checkout em polling (a cada poucos segundos) depois de gerar
 * um Pix ou um cartão que ficou em análise, pra saber se o pagamento já foi
 * confirmado. Mesmo padrão de consulta ao MP do webhook (/api/pix/webhook):
 * nunca deixa a consulta quebrar o processo, só loga e devolve o status atual
 * do pedido se a chamada ao MP falhar.
 */
router.get('/payment/status/:orderId', async (req, res) => {
  try {
    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE' });
    }

    const orderId = String(req.params.orderId || '');
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ ok: false, reason: 'ORDER_NOT_FOUND' });
    }

    // Só consulta o MP se ainda estiver pendente e tiver um pagamento associado —
    // se já está 'Pago', devolve direto lá embaixo sem gastar uma chamada à API do MP.
    if (order.status === 'Pendente' && order.mpPaymentId) {
      const settings = await Settings.findOne().lean();
      if (temMpTokenSalvo(settings)) {
        const mpToken = String(settings.mp_token).trim();
        try {
          const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${order.mpPaymentId}`, {
            headers: { Authorization: `Bearer ${mpToken}` }
          });
          const mpJson = await mpRes.json().catch(() => ({}));
          if (mpRes.ok && mpJson?.status === 'approved') {
            order.status = 'Pago';
            await order.save();
          } else if (!mpRes.ok) {
            console.warn('[payment/status] Falha ao consultar pagamento no MP:', mpJson);
          }
        } catch (e) {
          console.error('[payment/status] Erro ao consultar MP:', e.message);
        }
      }
    }

    return res.json({
      ok: true,
      orderId: String(order._id),
      status: order.status,
      approved: order.status === 'Pago',
      mpPaymentId: order.mpPaymentId || '',
      total: order.total
    });
  } catch (e) {
    console.error('[payment/status] Erro:', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', detalhe: e.message });
  }
});

/**
 * Webhook do Mercado Pago. Configure esta URL (https://SEU_DOMINIO/api/pix/webhook)
 * no painel do Mercado Pago em: Sua integração → Webhooks → Configurar notificações.
 * O MP chama essa rota quando o status de um pagamento muda (ex: Pix aprovado).
 * Aceita tanto o formato novo (body JSON com data.id) quanto o legado (query ?id=&topic=payment).
 */
router.post('/pix/webhook', async (req, res) => {
  // Responde 200 rápido mesmo se algo falhar depois — o MP reenvia notificações
  // que não recebem 200, e não queremos ficar recebendo o mesmo evento repetido
  // enquanto investigamos com calma via logs.
  res.status(200).json({ recebido: true });

  try {
    if (!(await tryConnectDb())) {
      console.warn('[pix/webhook] DB indisponível, notificação ignorada.');
      return;
    }

    const paymentId =
      req.body?.data?.id ||
      req.body?.id ||
      req.query?.id ||
      req.query?.['data.id'];

    const topic = req.body?.type || req.body?.topic || req.query?.topic;
    if (!paymentId || (topic && topic !== 'payment')) return;

    const settings = await Settings.findOne().lean();

    if (settings?.mp_webhook_secret) {
      const assinaturaValida = validarAssinaturaWebhookMp(req, settings.mp_webhook_secret);
      // false = avaliamos e não bateu (rejeita, sem consultar o MP nem tocar
      // no banco — é isso que protege contra bombardeio de IDs arbitrários).
      // null = formato legado, sem assinatura pra avaliar — segue normalmente.
      if (assinaturaValida === false) {
        console.warn('[pix/webhook] x-signature inválido para paymentId', paymentId, '— notificação ignorada.');
        return;
      }
    }
    // Sem mp_webhook_secret configurado: segue sem validar, de propósito — ver
    // comentário em validarAssinaturaWebhookMp sobre o risco de rejeitar por
    // engano. A rota continua segura mesmo assim porque nunca confia no corpo
    // da notificação: o status só vem da resposta do MP consultada abaixo.

    if (!temMpTokenSalvo(settings)) {
      console.warn('[pix/webhook] Sem mp_token configurado, não é possível confirmar pagamento.');
      return;
    }
    const mpToken = String(settings.mp_token).trim();

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${mpToken}` }
    });
    const mpJson = await mpRes.json().catch(() => ({}));
    if (!mpRes.ok) {
      console.warn('[pix/webhook] Falha ao consultar pagamento no MP:', mpJson);
      return;
    }

    if (mpJson?.status === 'approved') {
      const order = await Order.findOneAndUpdate(
        { mpPaymentId: String(paymentId), status: 'Pendente' },
        { status: 'Pago' },
        { new: true }
      );
      if (order) {
        console.log('[pix/webhook] Pedido', order._id.toString(), 'confirmado como Pago.');
      } else {
        // Aprovado no MP mas não achou um pedido 'Pendente' com esse mpPaymentId:
        // provavelmente o pedido já foi cancelado por abandono (estoque já
        // devolvido, ver /api/cron/liberar-estoque-pendente) antes do pagamento
        // ser confirmado. De propósito NÃO reabre o pedido nem mexe em estoque
        // sozinho aqui — só loga pra revisão manual do admin (dinheiro entrou,
        // mas o estoque pode já ter sido vendido a outra pessoa).
        const pedidoTardio = await Order.findOne({ mpPaymentId: String(paymentId) }).select('_id status').lean();
        if (pedidoTardio && pedidoTardio.status !== 'Pago') {
          console.warn(
            '[pix/webhook] Pagamento aprovado para pedido', pedidoTardio._id.toString(),
            'que já estava', pedidoTardio.status, '— revisão manual necessária.'
          );
        }
      }
    }
    // outros status (rejected, cancelled, etc.) podem ser tratados aqui se necessário —
    // por ora deixamos o pedido como "Pendente" para revisão manual do admin.
  } catch (e) {
    console.error('[pix/webhook] Erro ao processar notificação:', e.message);
  }
});

module.exports = router;
