const configPadrao = require('../config');

/**
 * Resolve o peso/dimensões REAIS de um produto pro cálculo de frete: primeiro
 * o que está cadastrado no próprio produto, campo a campo; qualquer campo
 * ausente cai pro padrão da loja (Config), também campo a campo. Se depois
 * disso ainda faltar algum dos quatro, ok:false — o produto não pode ser
 * vendido (ver decisão registrada nos comentários do schema de Produto).
 * Nunca inventa um número: é essa garantia que corrige o bug de frete fixo
 * (0,3kg/11x2x16 pra qualquer produto) que existia antes desta função.
 */
function resolverDadosEnvioProduto(produto, cfgFrete) {
  const resolverCampo = (valorProduto, valorPadrao) => {
    const p = Number(valorProduto);
    if (Number.isFinite(p) && p > 0) return p;
    const d = Number(valorPadrao);
    if (Number.isFinite(d) && d > 0) return d;
    return null;
  };
  const pesoKg = resolverCampo(produto?.pesoKg, cfgFrete?.pesoKgPadrao);
  const larguraCm = resolverCampo(produto?.larguraCm, cfgFrete?.larguraCmPadrao);
  const alturaCm = resolverCampo(produto?.alturaCm, cfgFrete?.alturaCmPadrao);
  const comprimentoCm = resolverCampo(produto?.comprimentoCm, cfgFrete?.comprimentoCmPadrao);
  if (!pesoKg || !larguraCm || !alturaCm || !comprimentoCm) return { ok: false };
  return { ok: true, pesoKg, larguraCm, alturaCm, comprimentoCm };
}

/**
 * Consulta o Melhor Envio de verdade e devolve as opções de frete disponíveis
 * pro CEP/produtos informados. Compartilhada entre /api/frete/calcular
 * (cotação exibida no checkout) e POST /api/orders (revalidação do frete
 * escolhido antes de fechar o pedido — ver comentário lá).
 *
 * cepOrigem é passado pelo chamador (não lido daqui) — cada chamador já busca
 * a Config completa pra outra coisa (frete grátis) e usa cfg.cepOrigemEfetivo
 * de lá, que resolve painel > .env > config.js > fallback fixo (ver
 * mergePublicConfig). Resolver aqui de novo seria uma segunda fonte de
 * verdade pro mesmo valor.
 *
 * NUNCA lança exceção — qualquer falha (rede, timeout, resposta inesperada)
 * volta como { ok:false }. Isso é proposital: quem chama em /api/orders já
 * decrementou estoque antes de chegar aqui, então um erro não tratado aqui
 * não pode derrubar a criação do pedido inteira.
 */
async function cotarFreteMelhorEnvio(meToken, cepOrigem, cepDigitos, rawProducts) {
  // rawProducts já chega com peso/dimensões REAIS resolvidos por quem chamou
  // (ver resolverDadosEnvioProduto) — cada item da lista é um produto do
  // carrinho, e a Melhor Envio calcula o frete da remessa combinada a partir
  // dessa lista sozinha; não precisamos somar/aproximar caixa nenhuma aqui.
  if (!rawProducts.length) return { ok: false, reason: 'SEM_ITENS', options: [] };
  const produtosParaEnvio = rawProducts.map((p) => ({
    id: p?.id != null ? String(p.id) : undefined,
    width: Number(p?.larguraCm) || 0,
    height: Number(p?.alturaCm) || 0,
    length: Number(p?.comprimentoCm) || 0,
    weight: Number(p?.pesoKg) || 0,
    insurance_value: Number(p?.unitary_value) || 0,
    quantity: Math.max(1, Number(p?.quantity) || 1)
  }));

  try {
    const meRes = await fetch('https://melhorenvio.com.br/api/v2/me/shipment/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Exigido pela API do Melhor Envio — requisições sem User-Agent identificando
        // a aplicação/contato costumam ser rejeitadas.
        'User-Agent': `${configPadrao.nomeLoja} (${configPadrao.emailContato})`,
        Authorization: `Bearer ${meToken}`
      },
      body: JSON.stringify({
        from: { postal_code: cepOrigem },
        to: { postal_code: cepDigitos },
        products: produtosParaEnvio
      }),
      signal: AbortSignal.timeout(8000)
    });

    const meJson = await meRes.json().catch(() => ([]));

    if (!meRes.ok) {
      return { ok: false, reason: 'ME_CALCULATE_FAILED', options: [] };
    }

    const lista = Array.isArray(meJson) ? meJson : [];
    const options = lista
      .filter((opt) => !opt?.error)
      .map((opt) => ({
        id: opt?.id != null ? String(opt.id) : '',
        name: opt?.name || '',
        company: opt?.company?.name || '',
        price: Number(opt?.price) || 0,
        delivery_time: Number(opt?.delivery_time ?? opt?.delivery_range?.min) || 0
      }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    return { ok: true, options };
  } catch (e) {
    return { ok: false, reason: 'ME_CALCULATE_FAILED', options: [], detalhe: e.message };
  }
}

module.exports = { resolverDadosEnvioProduto, cotarFreteMelhorEnvio };
