const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const Order = require('../models/Order');
const Produto = require('../models/Produto');
const Config = require('../models/Config');
const Settings = require('../models/Settings');
const { verificarJWT } = require('../middleware/auth');
const { ensureDbConnected, tryConnectDb } = require('../utils/db');
const { emailPagadorValido } = require('../utils/pagador');
const { buscarConfigCompleta, RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK } = require('../utils/configLoja');
const { resolverDadosEnvioProduto, cotarFreteMelhorEnvio } = require('../utils/frete');
const { escapeRegexEspecial } = require('../utils/busca');

// Rate limit para rotas públicas de escrita (evita spam de pedidos/avaliações falsas).
const ordersLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.' }
});

/**
 * Reverte decrementos de estoque já aplicados quando um pedido falha no meio do processamento
 * (ex: item 3 de 5 sem estoque — os itens 1 e 2 já decrementados precisam voltar).
 */
async function rollbackStock(decrementedList) {
  for (const { productId, qty } of decrementedList) {
    try {
      await Produto.findByIdAndUpdate(productId, { $inc: { estoque: qty } });
    } catch (e) {
      console.error('[orders] Falha ao reverter estoque de', productId, '-', e.message);
    }
  }
}

/**
 * Campos de dado pessoal zerados na anonimização de um pedido — usado tanto
 * pra pedido nunca pago (devolverEstoqueDoPedido, abaixo) quanto pra pedido
 * pago velho (ver /api/cron/anonimizar-pedidos-antigos) e pra pedido de
 * exclusão sob demanda de um comprador específico (ver
 * /api/admin/orders/anonimizar-comprador). Mantém tudo que tem valor de
 * histórico de vendas — total, items, frete, status — e generaliza em vez de
 * apagar cidade/estado: sozinhos, sem rua/número/CEP, não identificam
 * ninguém, mas ainda dão pro lojista análise regional de vendas.
 */
function camposAnonimizacaoPedido() {
  return {
    customerName: '',
    email: '',
    telefone: '',
    cpf: '',
    rua: '',
    numero: '',
    complemento: '',
    bairro: '',
    cep: '',
    anonimizadoEm: new Date()
  };
}

/**
 * Devolve ao estoque os itens de um pedido que nunca foi pago — abandono
 * detectado pelo cron (ver /api/cron/liberar-estoque-pendente) ou cancelamento
 * manual do admin (ver PUT /api/orders/:id). Sem isso, todo pedido 'Pendente'
 * que o cliente desiste (aba fechada, Pix expirado, cartão recusado) prende o
 * estoque decrementado na criação pra sempre — ver rollbackStock acima, que só
 * cobre falha DENTRO da própria criação do pedido, não abandono depois dela.
 *
 * Também anonimiza o pedido nesse mesmo momento: um pedido nunca pago não
 * gerou venda nem documento fiscal nenhum, então não há razão pra guardar
 * CPF/endereço dele nem um dia além do necessário pra confirmar que ele não
 * vai virar venda. Isso nunca acontece com Pago->Cancelado (reembolso depois
 * do envio, por exemplo) — esse caso não passa por aqui, ver PUT /api/orders/:id.
 *
 * Idempotente e seguro contra corrida: o findOneAndUpdate abaixo só "ganha" o
 * direito de devolver quem conseguir marcar estoqueRevertido false->true
 * primeiro — atômico por documento no Mongo, então mesmo que essa função seja
 * chamada duas vezes pro mesmo pedido (cron sobreposto, clique duplo do admin)
 * apenas uma delas de fato incrementa o estoque (e anonimiza).
 *
 * Só incrementa itens com estoqueDecrementado:true (gravado na criação do
 * pedido) — produtos com controle de estoque desativado (estoque:null) nunca
 * foram decrementados, então nunca são tocados aqui.
 */
async function devolverEstoqueDoPedido(orderId, novoStatus) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, estoqueRevertido: { $ne: true } },
    { $set: { estoqueRevertido: true, status: novoStatus, ...camposAnonimizacaoPedido() } },
    { new: false }
  );
  if (!order) return false; // já tinha sido revertido, ou pedido não existe

  for (const item of order.items || []) {
    if (!item.estoqueDecrementado || !item.productId) continue;
    try {
      await Produto.findByIdAndUpdate(item.productId, { $inc: { estoque: item.qty } });
    } catch (e) {
      console.error('[orders] Falha ao devolver estoque de', item.productId, '-', e.message);
    }
  }
  return true;
}

// Orders
/**
 * customerName vem do checkout sem autenticação nenhuma — era o único campo
 * de pedido renderizado no admin sem escape (achado de auditoria: permitia
 * XSS armazenado só de completar um pedido, sem nem precisar pagar). A defesa
 * real contra XSS é escapar na exibição (corrigido em admin.html), não aqui —
 * mas cortar caracteres sem uso legítimo num nome de pessoa (controle, < e >)
 * e limitar o tamanho reduz o que qualquer consumidor futuro desse dado
 * (relatório, exportação, e-mail automático) precisa se preocupar em escapar,
 * sem arriscar corromper nomes reais: acentos, apóstrofo e hífen (comuns em
 * nomes de verdade) continuam intactos.
 */
function sanitizarNomeCliente(nome) {
  const semControleNemAngulo = Array.from(String(nome || ''))
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code > 31 && code !== 127 && ch !== '<' && ch !== '>';
    })
    .join('');
  return semControleNemAngulo.trim().slice(0, 120);
}

router.post('/orders', ordersLimiter, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const customerName = sanitizarNomeCliente(req.body?.customerName);
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const cep = req.body?.cep != null ? String(req.body.cep).trim() : '';
    const email = req.body?.payerEmail != null ? String(req.body.payerEmail).trim() : '';
    const telefone = req.body?.payerTelefone != null ? String(req.body.payerTelefone).replace(/\D/g, '') : '';
    const cpf = req.body?.payerCpf != null ? String(req.body.payerCpf).replace(/\D/g, '') : '';
    const rua = req.body?.rua != null ? String(req.body.rua).trim() : '';
    const numero = req.body?.numero != null ? String(req.body.numero).trim() : '';
    const complemento = req.body?.complemento != null ? String(req.body.complemento).trim() : '';
    const bairro = req.body?.bairro != null ? String(req.body.bairro).trim() : '';
    const cidade = req.body?.cidade != null ? String(req.body.cidade).trim() : '';
    const estado = req.body?.estado != null ? String(req.body.estado).trim().toUpperCase() : '';

    if (!rawItems.length) return res.status(400).json({ erro: 'items vazios' });

    // Mesmo critério de /api/frete/calcular: CEP precisa ter 8 dígitos.
    // Validado aqui, antes de qualquer decremento de estoque, porque o catch
    // externo desta rota não faz rollbackStock — um CEP malformado não pode
    // ser rejeitado depois que o estoque já foi debitado.
    const cepDigitosValidacao = cep.replace(/\D/g, '');
    if (cepDigitosValidacao.length !== 8) {
      return res.status(400).json({ erro: 'CEP inválido' });
    }

    // Dados de entrega e contato: sem eles o pedido é pago mas não dá pra
    // despachar nem falar com o cliente. O checkout já valida isso no HTML,
    // mas validação de cliente não protege a rota (mesmo motivo do CEP acima)
    // — e como o catch externo desta rota não chama rollbackStock, tudo isso
    // precisa ser checado aqui, antes de qualquer decremento de estoque, não
    // depois. emailPagadorValido é a mesma função usada em /api/payment/create.
    if (!emailPagadorValido(email)) {
      return res.status(400).json({ erro: 'E-mail inválido' });
    }
    if (telefone.length < 10 || telefone.length > 11) {
      return res.status(400).json({ erro: 'Telefone inválido' });
    }
    if (cpf.length !== 11) {
      return res.status(400).json({ erro: 'CPF inválido' });
    }
    // Número e complemento nunca vêm do CEP — sempre digitados pelo cliente,
    // por isso são checados aqui e não deduzidos de nada.
    if (!rua || !numero || !bairro || !cidade || estado.length !== 2) {
      return res.status(400).json({ erro: 'Endereço de entrega incompleto — informe rua, número, bairro, cidade e UF.' });
    }

    // IMPORTANTE: preço e total NUNCA vêm do cliente — sempre recalculados a partir
    // do Produto salvo no banco. Isso impede que alguém edite o carrinho no navegador
    // (localStorage/DevTools) para pagar um valor diferente do real.
    const decrementedForRollback = []; // acumula decrementos aplicados, para rollback em caso de erro
    const itemsForOrder = [];
    // Peso/dimensões reais por item, resolvidos no loop abaixo (produto ou
    // padrão da loja — ver resolverDadosEnvioProduto), pra cotar o frete de
    // verdade mais adiante. Buscamos a Config aqui, antes do loop, porque
    // cfgFrete.pesoKgPadrao etc. são o padrão da loja usado item a item.
    const itemsParaCotarFrete = [];
    const cfgFrete = await buscarConfigCompleta();
    let totalNum = 0;

    for (const it of rawItems) {
      const qty = Number(it?.qty || 1);
      if (!Number.isFinite(qty) || qty < 1) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({ erro: 'Quantidade inválida no carrinho.' });
      }

      const productId = it?.productId ? String(it.productId) : (it?._id ? String(it._id) : null);
      if (!productId) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({ erro: 'Item do carrinho sem productId — não é possível validar o preço.' });
      }

      // Decremento atômico: só aplica se o produto tiver controle de estoque ativo
      // (estoque numérico) E quantidade suficiente. Evita condição de corrida entre
      // dois clientes comprando o mesmo item ao mesmo tempo.
      const withStockControl = await Produto.findOneAndUpdate(
        { _id: productId, estoque: { $gte: qty } },
        { $inc: { estoque: -qty } },
        { new: true }
      );

      let prod = withStockControl;
      if (!prod) {
        // Não bateu: produto inexistente, sem controle de estoque (estoque=null) ou estoque insuficiente.
        const existing = await Produto.findById(productId).lean();
        if (!existing) {
          await rollbackStock(decrementedForRollback);
          return res.status(400).json({ erro: 'Produto não encontrado: ' + productId });
        }
        if (existing.estoque == null) {
          // estoque=null => controle de estoque desativado para este produto; não bloqueia a compra.
          prod = existing;
        } else {
          await rollbackStock(decrementedForRollback);
          return res.status(409).json({
            erro: 'Sem estoque suficiente para ' + (existing.nome || it?.name || 'item'),
            produtoId: productId,
            estoqueDisponivel: existing.estoque,
            quantidadeSolicitada: qty
          });
        }
      } else {
        decrementedForRollback.push({ productId, qty });
      }

      // Produto com tamanhos cadastrados exige um tamanho VÁLIDO (um dos
      // valores reais de prod.sizes, não só "não vazio") — achado ao
      // investigar um bug de adicionar-rápido que mandava tamanho vazio ou
      // herdado de outro produto sem passar por nenhuma validação aqui.
      // Igual às checagens acima: antes de somar ao pedido, com rollback de
      // estoque se falhar — o carrinho é do navegador, nunca confiável.
      const tamanhoEnviado = it?.tamanhoSelecionado ? String(it.tamanhoSelecionado).trim() : '';
      if (Array.isArray(prod.sizes) && prod.sizes.length > 0 && !prod.sizes.includes(tamanhoEnviado)) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({
          erro: 'Selecione um tamanho válido para ' + (prod.nome || it?.name || 'item'),
          produtoId: productId,
          motivo: 'TAMANHO_INVALIDO',
          tamanhosDisponiveis: prod.sizes
        });
      }

      // Produto sem peso/dimensão própria nem padrão da loja não pode ser
      // vendido (decisão registrada no schema de Produto) — checado aqui,
      // logo após resolver `prod` e ANTES de somar ao pedido, seguindo o
      // mesmo padrão das validações de endereço acima: nunca decrementar
      // estoque de um item e só descobrir depois que o pedido não pode
      // fechar. Cobre também o produto que perdeu o dado depois de já estar
      // no carrinho do cliente — o carrinho é do navegador, não é confiável.
      const dadosEnvio = resolverDadosEnvioProduto(prod, cfgFrete);
      if (!dadosEnvio.ok) {
        await rollbackStock(decrementedForRollback);
        return res.status(409).json({
          erro: 'Produto sem peso/dimensão cadastrados — indisponível para venda: ' + (prod.nome || it?.name || 'item'),
          produtoId: productId,
          motivo: 'SEM_DADOS_ENVIO'
        });
      }

      const precoReal = Number(prod.preco || 0);
      totalNum += precoReal * qty;

      itemsForOrder.push({
        name: String(prod.nome || it?.name || '').trim(),
        qty,
        price: precoReal,
        tamanhoSelecionado: tamanhoEnviado,
        productId,
        // true só quando este item de fato debitou estoque real (branch do
        // withStockControl acima) — produto com controle de estoque desativado
        // (estoque=null) nunca deve ser incrementado na devolução.
        estoqueDecrementado: !!withStockControl
      });

      itemsParaCotarFrete.push({
        id: productId,
        quantity: qty,
        unitary_value: precoReal,
        pesoKg: dadosEnvio.pesoKg,
        larguraCm: dadosEnvio.larguraCm,
        alturaCm: dadosEnvio.alturaCm,
        comprimentoCm: dadosEnvio.comprimentoCm
      });
    }

    totalNum = Math.round(totalNum * 100) / 100;

    // Frete: req.body.frete NUNCA é usado como valor — mesmo padrão de "preço
    // nunca vem do cliente" já usado acima pros itens. O que o cliente manda
    // (frete, freteServicoId) é só "qual serviço eu escolhi", não "quanto eu
    // vou pagar". O valor de verdade vem de uma nova cotação ao Melhor Envio
    // aqui no servidor, com o CEP e os preços já validados do pedido.
    //
    // Se o subtotal já bate frete grátis, nem cotamos. Senão, cotamos de
    // novo e usamos o preço da opção com o mesmo id que o cliente escolheu
    // (freteServicoId) — ou a mais barata disponível, se o id não bater com
    // nada (cotação mudou, ou o campo não chegou). Só cai pra frete 0/"A
    // combinar" quando não há como cotar de verdade (sem me_token, CEP
    // inválido, Melhor Envio fora do ar) — mesma degradação graciosa que o
    // front já usa nesses casos, pra não travar um checkout legítimo.
    let freteNome = req.body?.freteNome != null ? String(req.body.freteNome).trim() : '';
    let freteEmpresa = req.body?.freteEmpresa != null ? String(req.body.freteEmpresa).trim() : '';
    const freteServicoId = req.body?.freteServicoId != null ? String(req.body.freteServicoId).trim() : '';
    let freteNum = 0;

    // cfgFrete já foi buscada antes do loop de itens (precisava dela ali pra
    // resolver peso/dimensão de cada item) — reaproveitada aqui.
    const freteGratisAplicavel = cfgFrete.freteGratisAtivo && totalNum >= cfgFrete.freteGratisValor;

    if (freteGratisAplicavel) {
      freteNum = 0;
      freteNome = freteNome || 'Frete grátis';
    } else {
      const cepDigitosPedido = cep.replace(/\D/g, '');
      const settingsFrete = await Settings.findOne().lean();
      const meTokenPedido = settingsFrete?.me_token ? String(settingsFrete.me_token).trim() : '';

      let opcoes = [];
      let cepForaDeArea = false;
      if (meTokenPedido && cepDigitosPedido.length === 8) {
        const resultadoFrete = await cotarFreteMelhorEnvio(meTokenPedido, cfgFrete.cepOrigemEfetivo, cepDigitosPedido, itemsParaCotarFrete);
        if (resultadoFrete.ok) {
          opcoes = resultadoFrete.options;
          // Melhor Envio respondeu (ok:true) mas nenhuma opção sobrou depois do
          // filtro de erro: CEP com formato válido, porém fora da área que as
          // transportadoras atendem. Decisão consciente: bloquear o checkout,
          // não cair pra frete 0/"A combinar" — diferente de token ausente ou
          // Melhor Envio fora do ar (ok:false), que continuam com o fallback
          // gracioso abaixo.
          cepForaDeArea = opcoes.length === 0;
        }
      }

      if (cepForaDeArea) {
        await rollbackStock(decrementedForRollback);
        return res.status(400).json({ erro: 'CEP fora da área de entrega das transportadoras disponíveis.' });
      }

      const opcaoEscolhida = freteServicoId ? opcoes.find((o) => o.id === freteServicoId) : null;
      const opcaoFinal = opcaoEscolhida || opcoes[0] || null;

      if (opcaoFinal) {
        freteNum = opcaoFinal.price;
        freteNome = opcaoFinal.name || freteNome;
        freteEmpresa = opcaoFinal.company || freteEmpresa;
      } else {
        freteNum = 0;
        freteNome = freteNome || 'A combinar';
      }
    }
    freteNum = Math.round(freteNum * 100) / 100;

    const totalComFrete = Math.round((totalNum + freteNum) * 100) / 100;

    // Status sempre começa "Pendente" — o cliente não pode definir o status do próprio pedido.
    // A confirmação de pagamento (Pix) deve ser tratada separadamente, ver /api/pix/webhook.
    const order = await Order.create({
      customerName,
      items: itemsForOrder,
      total: totalComFrete,
      cep,
      rua,
      numero,
      complemento,
      bairro,
      cidade,
      estado,
      email,
      telefone,
      cpf,
      frete: freteNum,
      freteNome,
      freteEmpresa,
      status: 'Pendente'
    });

    res.status(201).json({ mensagem: 'Pedido criado!', order });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar pedido', detalhe: err.message });
  }
});


router.get('/orders', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const list = await Order.find().sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar pedidos', detalhe: err.message });
  }
});

// Admin pode marcar manualmente um pedido como pago/cancelado (ex: confirmou o Pix na mão).
router.put('/orders/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const statusPermitido = ['Pendente', 'Pago', 'Cancelado'];
    const status = String(req.body?.status || '').trim();
    if (!statusPermitido.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido. Use: ' + statusPermitido.join(', ') });
    }

    let order;
    if (status === 'Cancelado') {
      const atual = await Order.findById(req.params.id).select('status').lean();
      if (!atual) return res.status(404).json({ erro: 'Pedido não encontrado' });
      if (atual.status === 'Pendente') {
        // Cancelar um pedido ainda Pendente é o mesmo "nunca foi pago, nunca vai
        // ser" que o cron detecta por timeout (ver /api/cron/liberar-estoque-pendente)
        // — devolve o estoque pela mesma rotina idempotente. Pago->Cancelado (ex:
        // reembolso depois do envio) não passa por aqui: só troca o status, sem
        // mexer em estoque, porque não há como saber neste ponto se o item já
        // foi despachado.
        await devolverEstoqueDoPedido(req.params.id, 'Cancelado');
        order = await Order.findById(req.params.id);
      } else {
        order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
      }
    } else {
      order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
    }

    if (!order) return res.status(404).json({ erro: 'Pedido não encontrado' });
    res.json({ mensagem: 'Status atualizado!', order });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar pedido', detalhe: err.message });
  }
});

// Admin pode excluir um pedido (ex: pedido de teste, duplicado, ou cancelado de vez).
router.delete('/orders/:id', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const existente = await Order.findById(req.params.id).select('status estoqueRevertido').lean();
    if (!existente) return res.status(404).json({ erro: 'Pedido não encontrado' });

    if (existente.status === 'Pendente' && !existente.estoqueRevertido) {
      // Hoje este é o único jeito pelo qual o admin "encerra" um pedido Pendente
      // pela UI (não há botão de Cancelar) — excluir um pedido ainda Pendente é
      // abandono na prática, então devolve o estoque pela mesma rotina do
      // cron/cancelamento, o que também protege contra corrida caso o cron
      // esteja processando esse mesmo pedido ao mesmo tempo.
      await devolverEstoqueDoPedido(req.params.id, 'Cancelado');
    }

    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ erro: 'Pedido não encontrado' });
    res.json({ mensagem: 'Pedido excluído!' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir pedido', detalhe: err.message });
  }
});

/** Monta o filtro $or de busca por comprador (CPF e/ou e-mail), compartilhado
 * entre a busca (GET) e a anonimização sob demanda (POST) abaixo — pra nunca
 * divergir quem a busca mostra do que a anonimização de fato afeta. */
function montarFiltroComprador({ cpf, email }) {
  const or = [];
  const cpfDigitos = cpf ? String(cpf).replace(/\D/g, '') : '';
  const emailBusca = email ? String(email).trim().toLowerCase() : '';
  if (cpfDigitos) or.push({ cpf: cpfDigitos });
  if (emailBusca) or.push({ email: { $regex: '^' + escapeRegexEspecial(emailBusca) + '$', $options: 'i' } });
  return or.length ? { $or: or } : null;
}

// Busca os pedidos de um comprador específico (por CPF ou e-mail), pro admin
// conferir quais registros existem ANTES de disparar a anonimização — sem
// isso, o lojista teria que vasculhar a tabela de pedidos manualmente pra
// confirmar que está anonimizando a pessoa certa.
router.get('/admin/orders/buscar-por-comprador', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const filtro = montarFiltroComprador({ cpf: req.query?.cpf, email: req.query?.email });
    if (!filtro) return res.status(400).json({ erro: 'Informe CPF ou e-mail do comprador.' });
    const list = await Order.find(filtro).sort({ createdAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar pedidos do comprador', detalhe: err.message });
  }
});

// Atende um pedido de exclusão (LGPD) de um comprador específico: anonimiza
// TODOS os pedidos dele (qualquer status, qualquer idade — diferente das
// rotinas por idade acima, aqui é sob demanda, disparado pelo lojista) sem
// apagar o histórico de vendas em si (total/itens/data seguem preservados,
// só a identificação do comprador é removida — ver camposAnonimizacaoPedido).
router.post('/admin/orders/anonimizar-comprador', verificarJWT, async (req, res) => {
  if (!(await ensureDbConnected(res))) return;
  try {
    const filtro = montarFiltroComprador({ cpf: req.body?.cpf, email: req.body?.email });
    if (!filtro) return res.status(400).json({ erro: 'Informe CPF ou e-mail do comprador.' });
    const r = await Order.updateMany(
      { ...filtro, anonimizadoEm: null },
      { $set: camposAnonimizacaoPedido() }
    );
    res.json({ mensagem: 'Dados do comprador removidos.', pedidosAfetados: r.modifiedCount });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao anonimizar pedidos do comprador', detalhe: err.message });
  }
});

// Prazo pra considerar um pedido 'Pendente' abandonado. Ajustável: só precisa
// ser longo o bastante pra não cancelar um pagamento genuinamente em andamento
// (Pix ainda não expirou, cliente ainda na tela de cartão).
const HORAS_LIMITE_PEDIDO_PENDENTE = 24;

/**
 * Cron da Vercel (ver vercel.json) — reclama o estoque de pedidos 'Pendente'
 * abandonados há mais de HORAS_LIMITE_PEDIDO_PENDENTE horas (cliente desistiu,
 * fechou a aba, Pix expirou, cartão recusado — nenhum desses casos tem hoje
 * nenhuma rotina de devolução, ver devolverEstoqueDoPedido). Roda sem processo
 * de longa duração porque a Vercel invoca esta rota por agendamento, não um
 * setInterval dentro da função serverless.
 *
 * Protegida por CRON_SECRET: sem isso, seria um endpoint público capaz de
 * mexer em estoque sem autenticação. Falha fechada — sem a env var configurada,
 * ninguém consegue chamar esta rota, nem com o header certo.
 */
router.get('/cron/liberar-estoque-pendente', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  if (!(await ensureDbConnected(res))) return;
  try {
    const limite = new Date(Date.now() - HORAS_LIMITE_PEDIDO_PENDENTE * 60 * 60 * 1000);
    const pedidosExpirados = await Order.find({
      status: 'Pendente',
      estoqueRevertido: { $ne: true },
      createdAt: { $lt: limite }
    }).select('_id').lean();

    let liberados = 0;
    for (const p of pedidosExpirados) {
      const revertido = await devolverEstoqueDoPedido(p._id, 'Cancelado');
      if (revertido) liberados++;
    }

    res.json({ ok: true, verificados: pedidosExpirados.length, liberados });
  } catch (err) {
    console.error('[cron/liberar-estoque-pendente] Erro:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

/**
 * Cron da Vercel (ver vercel.json) — anonimiza pedidos PAGOS mais velhos que
 * o prazo de retenção configurado (painel > RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK,
 * ver mergePublicConfig). Deliberadamente uma rota/agendamento SEPARADO do
 * cron de liberação de estoque acima: liberar estoque é sentido no mesmo dia
 * pelo lojista (produto volta a ficar vendável), enquanto anonimizar é faxina
 * sem urgência — se esta rotina falhar, travar em timeout de função serverless
 * ou ficar lenta numa base grande, isso não pode arrastar a liberação de
 * estoque junto.
 *
 * Não mexe em pedido nunca pago — esse caso já é resolvido no mesmo instante
 * do cancelamento por devolverEstoqueDoPedido, não por idade aqui.
 *
 * Protegida por CRON_SECRET, mesmo padrão de /api/cron/liberar-estoque-pendente.
 *
 * Idempotente: cada pedido processado só se anonimizadoEm ainda for null
 * (trava atômica no próprio updateOne) — rodar duas vezes não afeta de novo
 * quem já foi anonimizado.
 */
router.get('/cron/anonimizar-pedidos-antigos', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, reason: 'UNAUTHORIZED' });
  }
  if (!(await ensureDbConnected(res))) return;
  try {
    const configDoc = await Config.findOne().lean();
    const anosSalvo = configDoc?.retencaoPedidosPagosAnos;
    const anos =
      Number.isFinite(Number(anosSalvo)) && Number(anosSalvo) > 0
        ? Number(anosSalvo)
        : RETENCAO_PEDIDOS_PAGOS_ANOS_FALLBACK;

    const limite = new Date();
    limite.setFullYear(limite.getFullYear() - anos);

    const candidatos = await Order.find({
      status: 'Pago',
      anonimizadoEm: null,
      createdAt: { $lt: limite }
    }).select('_id').lean();

    let anonimizados = 0;
    for (const p of candidatos) {
      const r = await Order.updateOne(
        { _id: p._id, anonimizadoEm: null },
        { $set: camposAnonimizacaoPedido() }
      );
      if (r.modifiedCount) anonimizados++;
    }

    res.json({ ok: true, retencaoAnos: anos, verificados: candidatos.length, anonimizados });
  } catch (err) {
    console.error('[cron/anonimizar-pedidos-antigos] Erro:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

/**
 * Cotação de frete via Melhor Envio pro checkout. Mesmo princípio de "nunca
 * confiar no que o cliente manda" das rotas de pagamento: o preço de cada
 * opção devolvida é sempre o que a API do Melhor Envio cotou de verdade —
 * o front só manda subtotal/produtos pra ajudar a montar a cotação (peso/
 * valor declarado), nunca um preço de frete pronto.
 */
router.post('/frete/calcular', async (req, res) => {
  try {
    const cepDigitos = String(req.body?.cep || '').replace(/\D/g, '');
    if (cepDigitos.length !== 8) {
      return res.status(400).json({ ok: false, reason: 'CEP_INVALIDO', options: [] });
    }

    if (!(await tryConnectDb())) {
      return res.status(503).json({ ok: false, reason: 'DB_UNAVAILABLE', options: [] });
    }

    // Frete grátis: decide isso só com o subtotal + Config, sem gastar uma
    // chamada à API do Melhor Envio.
    const subtotal = Number(req.body?.subtotal) || 0;
    const cfg = await buscarConfigCompleta();
    if (cfg.freteGratisAtivo && subtotal >= cfg.freteGratisValor) {
      return res.json({ ok: true, freeShipping: true, options: [] });
    }

    const settings = await Settings.findOne().lean();
    const meToken = settings?.me_token ? String(settings.me_token).trim() : '';
    if (!meToken) {
      return res.json({ ok: false, reason: 'NO_ME_TOKEN', options: [] });
    }

    // O cliente manda quais produtos/quantidades quer cotar (isso é só uma
    // estimativa antes de fechar o pedido — o valor final é sempre recotado
    // em POST /api/orders), mas peso/dimensão SEMPRE vêm do banco por
    // productId, nunca do que o navegador mandar — mesmo princípio de nunca
    // confiar no cliente já aplicado ao preço/frete. Se o carrinho tiver um
    // item sem peso/dimensão cadastrados (nem padrão da loja), a estimativa
    // já reflete isso em vez de simular uma cotação que não vai fechar depois.
    const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
    const idsSolicitados = rawProducts
      .map((p) => (p?.id != null ? String(p.id) : null))
      .filter(Boolean);
    const produtosDb = idsSolicitados.length
      ? await Produto.find({ _id: { $in: idsSolicitados } }).lean()
      : [];
    const produtoPorId = new Map(produtosDb.map((p) => [String(p._id), p]));

    const itemsParaCotarFrete = [];
    for (const p of rawProducts) {
      const id = p?.id != null ? String(p.id) : null;
      const produtoDb = id ? produtoPorId.get(id) : null;
      if (!produtoDb) {
        return res.json({ ok: false, reason: 'SEM_DADOS_ENVIO', options: [], produtoId: id || '' });
      }
      const dadosEnvio = resolverDadosEnvioProduto(produtoDb, cfg);
      if (!dadosEnvio.ok) {
        return res.json({ ok: false, reason: 'SEM_DADOS_ENVIO', options: [], produtoId: id, produtoNome: produtoDb.nome || '' });
      }
      itemsParaCotarFrete.push({
        id,
        quantity: p?.quantity,
        unitary_value: p?.unitary_value,
        pesoKg: dadosEnvio.pesoKg,
        larguraCm: dadosEnvio.larguraCm,
        alturaCm: dadosEnvio.alturaCm,
        comprimentoCm: dadosEnvio.comprimentoCm
      });
    }

    const resultado = await cotarFreteMelhorEnvio(meToken, cfg.cepOrigemEfetivo, cepDigitos, itemsParaCotarFrete);

    if (!resultado.ok) {
      console.warn('[frete/calcular] Falha ao consultar Melhor Envio:', resultado.reason, resultado.detalhe || '');
      return res.status(502).json({ ok: false, reason: resultado.reason, options: [] });
    }

    return res.json({ ok: true, options: resultado.options, freeShipping: false });
  } catch (e) {
    console.error('[frete/calcular] Erro:', e.message);
    return res.status(500).json({ ok: false, reason: 'ERROR', options: [] });
  }
});

module.exports = router;
