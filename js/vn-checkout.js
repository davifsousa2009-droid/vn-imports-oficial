// Checkout + pagamento — extraído de VN_IMPORTS.html (Estágio 2, última
// etapa da divisão). Cotação de frete (Melhor Envio), preenchimento de
// endereço via ViaCEP, criação de pedido, pagamento por cartão/Pix
// (Mercado Pago) com fallback manual de Pix, polling de status e os
// modais de confirmação/Pix. Depende de vn-core.js (cart, S, R$,
// showToast, API_URL, limparCarrinhoPosPedido, persistCart/saveC) e de
// renderCart/syncDots (js/vn-cart-wishlist.js + js/cart.js). Único ponto
// de entrada externo: checkout(), acionado pelo botão "Finalizar
// Compra" do HTML.

let __vnPayPollTimer = null;

function stopPaymentPolling() {
  if (__vnPayPollTimer) {
    clearInterval(__vnPayPollTimer);
    __vnPayPollTimer = null;
  }
}

function closeVnPayOverlay() {
  stopPaymentPolling();
  const o = document.getElementById('pixModalOverlayVn');
  if (o) o.remove();
}

function formatBRL(n) {
  return 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function showPaymentConfirmation(orderId, total) {
  closeVnPayOverlay();
  limparCarrinhoPosPedido();
  const darkOverlay = document.createElement('div');
  darkOverlay.id = 'pixModalOverlayVn';
  darkOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(6px);z-index:2000;display:flex;align-items:center;justify-content:center';
  darkOverlay.innerHTML = `
    <div style="width:min(480px,94vw);background:#0F0F0F;border:1px solid rgba(16,63,99,.35);border-radius:16px;box-shadow:0 18px 70px rgba(0,0,0,.55);padding:28px 24px;text-align:center;font-family:var(--sans)">
      <div style="font-size:42px;margin-bottom:12px;color:#2E6B47"><i class="fa-solid fa-circle-check ui-ico" aria-hidden="true"></i></div>
      <div style="font-family:var(--serif);font-size:22px;color:#F7F4F0;margin-bottom:8px">Pagamento confirmado</div>
      <div style="font-size:13px;color:rgba(247,244,240,.6);line-height:1.7;margin-bottom:18px">
        Recebemos seu pagamento${total != null ? ' de <strong style="color:#103F63">' + formatBRL(total) + '</strong>' : ''}.
        ${orderId ? '<br>Pedido <span style="color:#F7F4F0">' + String(orderId).slice(-8).toUpperCase() + '</span>' : ''}
      </div>
      <button class="btn-fill" style="width:100%" type="button" onclick="closeVnPayOverlay()">Continuar comprando</button>
    </div>`;
  document.body.appendChild(darkOverlay);
  darkOverlay.addEventListener('click', (e) => { if (e.target === darkOverlay) closeVnPayOverlay(); });
  showToast('success', 'Pagamento aprovado!');
}

function startPaymentPolling(orderId, total) {
  stopPaymentPolling();
  if (!orderId) return;
  const tick = async () => {
    try {
      const r = await fetch(API_URL + '/payment/status/' + encodeURIComponent(orderId));
      const d = await r.json().catch(() => ({}));
      if (r.ok && (d.approved || d.status === 'Pago')) {
        stopPaymentPolling();
        showPaymentConfirmation(orderId, total != null ? total : d.total);
      }
    } catch { /* próximo ciclo */ }
  };
  tick();
  __vnPayPollTimer = setInterval(tick, 5000);
}

function loadMercadoPagoSdk() {
  return new Promise((resolve, reject) => {
    if (window.MercadoPago) return resolve(window.MercadoPago);
    const s = document.createElement('script');
    s.src = 'https://sdk.mercadopago.com/js/v2';
    s.onload = () => resolve(window.MercadoPago);
    s.onerror = () => reject(new Error('Falha ao carregar SDK Mercado Pago'));
    document.head.appendChild(s);
  });
}

/** Cotação Melhor Envio via backend (/api/frete/calcular). */
async function cotarFreteMelhorEnvio(cep, subtotal) {
  const cepLimpo = String(cep || '').replace(/\D/g, '');
  if (cepLimpo.length !== 8) return { ok: false, options: [], reason: 'CEP_INVALIDO' };
  try {
    const r = await fetch(API_URL + '/frete/calcular', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cep: cepLimpo,
        subtotal: Number(subtotal) || 0,
        products: (cart || []).map((it) => ({
          id: it._id || it.productId || it.id,
          name: it.name,
          quantity: it.qty || 1,
          unitary_value: it.price
        }))
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d?.ok) {
      return { ok: false, options: [], reason: d?.reason || 'FRETE_FAIL', freeShipping: !!d?.freeShipping };
    }
    return {
      ok: true,
      options: Array.isArray(d.options) ? d.options : [],
      freeShipping: !!d.freeShipping
    };
  } catch {
    return { ok: false, options: [], reason: 'NETWORK' };
  }
}

async function fallbackPixSemMp(orderId, orderTotal, pixKeyFallback) {
  // Chegar aqui já implica pedido criado — diferente do Pix via Mercado
  // Pago, esse caminho manual não tem confirmação automática pra travar a
  // limpeza (sem token do MP não há como consultar status de pagamento).
  if (orderId) {
    limparCarrinhoPosPedido();
    try {
      const ccR = await fetch(API_URL + '/pix/copia-cola', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId })
      });
      const ccD = await ccR.json().catch(() => ({}));
      if (ccR.ok && ccD?.ok && ccD?.copiaECola) {
        showPixModal(ccD.copiaECola, false, Number(ccD.valor) || orderTotal, true);
        return;
      }
    } catch { /* segue */ }
  }
  const raw = (pixKeyFallback && String(pixKeyFallback).trim())
    || (S.chavePix && String(S.chavePix).trim())
    || '';
  if (!raw) { showPixModal('', true, orderTotal); return; }
  if (/^https?:\/\//i.test(raw)) { window.open(raw, '_blank'); closeVnPayOverlay(); return; }
  if (/^www\./i.test(raw)) { window.open('https://' + raw, '_blank'); closeVnPayOverlay(); return; }
  showPixModal(raw, false, orderTotal);
}

/**
 * Checkout completo: Melhor Envio (CEP/frete) + Mercado Pago (Pix/Cartão).
 * Total pago = produtos + frete. Valor cobrado no MP vem de order.total no backend.
 */
async function checkout() {
  if (!cart.length) {
    showToast('warning', 'Seu carrinho está vazio.');
    return;
  }

  const subtotal = cart.reduce((s, i) => s + i.price * i.qty, 0);
  closeCart();
  closeVnPayOverlay();

  let payConfig = { hasMpToken: false, mpPublicKey: '', pixKeyFallback: '' };
  try {
    const cfgR = await fetch(API_URL + '/payment/config');
    payConfig = await cfgR.json().catch(() => payConfig);
  } catch { /* fallback */ }

  const canCard = !!(payConfig.hasMpToken && payConfig.mpPublicKey);
  const freteGratisAtivo = !!window.S_freteGratisAtivo;
  const freteGratisValor = Number(window.S_freteGratisValor) || Number(S.frete) || 0;

  let freteSelecionado = { price: 0, name: 'A calcular', id: '', company: '' };
  let freteOptions = [];

  // Pedido já criado nesta sessão de checkout (POST /api/orders), ainda sem
  // pagamento confirmado. Uma recusa de cartão não invalida o pedido — só o
  // pagamento —, então uma nova tentativa deve reaproveitar esse mesmo pedido
  // em vez de criar outro (o primeiro já decrementou estoque; criar um segundo
  // deixaria o primeiro órfão até o cron de liberação rodar).
  let pedidoAtualId = '';
  let pedidoAtualTotal = 0;

  // Troca o frete escolhido e, se já existir um pedido pendente (retentativa
  // após recusa), invalida o reaproveitamento — o pedido antigo foi criado
  // com o frete anterior, então precisa nascer um novo pedido pra refletir o
  // valor certo, em vez de cobrar o frete desatualizado no reaproveitado.
  const definirFrete = (novo) => {
    freteSelecionado = novo;
    if (pedidoAtualId) { pedidoAtualId = ''; pedidoAtualTotal = 0; }
  };

  const darkOverlay = document.createElement('div');
  darkOverlay.id = 'pixModalOverlayVn';
  darkOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(6px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px';

  const renderTotais = () => {
    const frete = Number(freteSelecionado.price) || 0;
    const total = Math.round((subtotal + frete) * 100) / 100;
    const elSub = document.getElementById('vnCkSub');
    const elFrete = document.getElementById('vnCkFreteVal');
    const elTotal = document.getElementById('vnCkTotal');
    const btn = document.getElementById('vnCkSubmit');
    if (elSub) elSub.textContent = formatBRL(subtotal);
    if (elFrete) elFrete.textContent = formatBRL(frete);
    if (elTotal) elTotal.textContent = formatBRL(total);
    if (btn) btn.textContent = 'Pagar ' + formatBRL(total);
    return total;
  };

  darkOverlay.innerHTML = `
    <div id="pixModalVn" style="width:min(560px,94vw);max-height:92vh;overflow:auto;background:#0F0F0F;border:1px solid rgba(16,63,99,.35);border-radius:16px;box-shadow:0 18px 70px rgba(0,0,0,.55)">
      <div style="padding:18px 20px;border-bottom:1px solid rgba(16,63,99,.25);display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-family:var(--sans);font-size:12px;color:rgba(16,63,99,.9);letter-spacing:.12em;text-transform:uppercase">Checkout</div>
          <div style="font-family:var(--serif);font-size:18px;color:#F7F4F0">Finalizar compra</div>
        </div>
        <button type="button" id="vnCkClose" style="width:34px;height:34px;border-radius:10px;border:1px solid rgba(247,244,240,.18);background:transparent;color:#F7F4F0;cursor:pointer"><i class="fa-solid fa-xmark ui-ico" aria-hidden="true"></i></button>
      </div>
      <form id="vnCheckoutForm" style="padding:18px 20px;font-family:var(--sans)">
        <div style="display:flex;justify-content:space-between;font-size:13px;color:rgba(247,244,240,.7);margin-bottom:6px"><span>Produtos</span><span id="vnCkSub">${formatBRL(subtotal)}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:rgba(247,244,240,.7);margin-bottom:6px"><span>Frete</span><span id="vnCkFreteVal">${formatBRL(0)}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:18px;color:#103F63;font-weight:700;margin-bottom:16px"><span>Total</span><span id="vnCkTotal">${formatBRL(subtotal)}</span></div>

        <label for="vnCkName" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Nome completo</label>
        <input id="vnCkName" required autocomplete="name" placeholder="Seu nome" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">

        <label for="vnCkEmail" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">E-mail</label>
        <input id="vnCkEmail" type="email" required autocomplete="email" placeholder="voce@email.com" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">

        <label for="vnCkTelefone" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Telefone</label>
        <input id="vnCkTelefone" required inputmode="numeric" autocomplete="tel" placeholder="(00) 00000-0000" maxlength="15" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">

        <label for="vnCkCpf" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">CPF</label>
        <input id="vnCkCpf" required inputmode="numeric" placeholder="000.000.000-00" maxlength="14" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">

        <label for="vnCkCep" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">CEP (Melhor Envio)</label>
        <div class="vn-ck-pair" style="margin-bottom:10px">
          <input id="vnCkCep" required inputmode="numeric" placeholder="00000-000" maxlength="9" style="flex:1;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          <button type="button" id="vnCkFreteBtn" class="btn-fill" style="white-space:nowrap;padding:12px 14px">Calcular frete</button>
        </div>
        <div id="vnCkFreteOpts" style="margin-bottom:14px;font-size:13px;color:rgba(247,244,240,.55)">Informe o CEP para cotar o frete.</div>

        <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:rgba(247,244,240,.45);margin-bottom:10px">Endereço de entrega</div>
        <div id="vnCkEnderecoHint" style="display:none;margin-bottom:10px;font-size:12px;color:rgba(247,244,240,.45)">Endereço preenchido pelo CEP — confira e corrija se precisar.</div>
        <div class="vn-ck-pair" style="margin-bottom:12px">
          <div style="flex:2">
            <label for="vnCkRua" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Rua / Avenida</label>
            <input id="vnCkRua" required autocomplete="address-line1" placeholder="Rua, avenida..." style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          </div>
          <div style="flex:1">
            <label for="vnCkNumero" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Número</label>
            <input id="vnCkNumero" required inputmode="numeric" placeholder="Nº" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          </div>
        </div>
        <label for="vnCkComplemento" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Complemento (opcional)</label>
        <input id="vnCkComplemento" autocomplete="address-line2" placeholder="Apto, bloco, ponto de referência..." style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
        <div class="vn-ck-pair" style="margin-bottom:14px">
          <div style="flex:2">
            <label for="vnCkBairro" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Bairro</label>
            <input id="vnCkBairro" required autocomplete="address-level3" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          </div>
          <div style="flex:2">
            <label for="vnCkCidade" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Cidade</label>
            <input id="vnCkCidade" required autocomplete="address-level2" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          </div>
          <div style="flex:0 0 64px">
            <label for="vnCkEstado" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">UF</label>
            <input id="vnCkEstado" required autocomplete="address-level1" maxlength="2" placeholder="UF" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0;text-transform:uppercase">
          </div>
        </div>

        <div style="font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:rgba(247,244,240,.45);margin-bottom:10px">Forma de pagamento</div>
        <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
          <label style="flex:1;min-width:120px;border:1px solid rgba(16,63,99,.35);border-radius:12px;padding:12px;cursor:pointer;color:#F7F4F0">
            <input type="radio" name="vnPayMethod" value="pix" checked style="margin-right:8px"> Pix
          </label>
          <label style="flex:1;min-width:120px;border:1px solid rgba(16,63,99,.35);border-radius:12px;padding:12px;cursor:pointer;color:#F7F4F0;${canCard ? '' : 'opacity:.45'}">
            <input type="radio" name="vnPayMethod" value="card" ${canCard ? '' : 'disabled'} style="margin-right:8px"> Cartão
          </label>
        </div>
        ${canCard ? '' : '<div style="font-size:12px;color:rgba(247,244,240,.45);margin:-8px 0 14px">Cartão disponível após cadastrar a <em>mp_public_key</em> no Admin.</div>'}

        <div id="vnCardFields" style="display:none;margin-bottom:14px">
          <label for="vnCardNumber" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Número do cartão</label>
          <input id="vnCardNumber" autocomplete="cc-number" placeholder="•••• •••• •••• ••••" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          <div class="vn-ck-pair">
            <div style="flex:1">
              <label for="vnCardExp" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Validade</label>
              <input id="vnCardExp" autocomplete="cc-exp" placeholder="MM/AA" maxlength="5" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
            </div>
            <div style="flex:1">
              <label for="vnCardCvv" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">CVV</label>
              <input id="vnCardCvv" autocomplete="cc-csc" placeholder="•••" maxlength="4" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
            </div>
          </div>
          <label for="vnCardName" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin:10px 0 6px">Nome no cartão</label>
          <input id="vnCardName" autocomplete="cc-name" placeholder="Como impresso no cartão" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:rgba(255,255,255,.04);color:#F7F4F0">
          <label for="vnCardInstallments" style="display:block;font-size:11px;color:rgba(247,244,240,.55);margin-bottom:6px">Parcelas</label>
          <select id="vnCardInstallments" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid rgba(16,63,99,.25);background:#1a1a1a;color:#F7F4F0">
            <option value="1">1x sem juros</option>
          </select>
        </div>

        <button type="submit" id="vnCkSubmit" class="btn-fill" style="width:100%">Pagar ${formatBRL(subtotal)}</button>
        <div id="vnCkErr" style="display:none;margin-top:12px;font-size:13px;color:#c45c5c"></div>
      </form>
    </div>`;

  document.body.appendChild(darkOverlay);

  const syncMethodUI = () => {
    const method = (document.querySelector('input[name="vnPayMethod"]:checked') || {}).value || 'pix';
    const cardBox = document.getElementById('vnCardFields');
    if (cardBox) cardBox.style.display = method === 'card' ? 'block' : 'none';
  };
  darkOverlay.querySelectorAll('input[name="vnPayMethod"]').forEach((el) => el.addEventListener('change', syncMethodUI));
  syncMethodUI();

  document.getElementById('vnCkClose')?.addEventListener('click', () => closeVnPayOverlay());
  darkOverlay.addEventListener('click', (e) => { if (e.target === darkOverlay) closeVnPayOverlay(); });

  document.getElementById('vnCkTelefone')?.addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    if (v.length > 10) v = v.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
    else if (v.length > 6) v = v.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    else if (v.length > 2) v = v.replace(/(\d{2})(\d{0,5})/, '($1) $2');
    e.target.value = v;
  });

  document.getElementById('vnCkCpf')?.addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    if (v.length > 9) v = v.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
    else if (v.length > 6) v = v.replace(/(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
    else if (v.length > 3) v = v.replace(/(\d{3})(\d{0,3})/, '$1.$2');
    e.target.value = v;
  });

  document.getElementById('vnCkEstado')?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  });

  // Preenche o endereço a partir do CEP (ViaCEP) — o cliente sempre pode
  // corrigir depois, e número/complemento nunca vêm do CEP de jeito nenhum,
  // então continuam sempre manuais.
  let vnCkEnderecoBuscadoPara = '';
  // Remove a marca visual de "preenchido pelo CEP" assim que o cliente edita
  // o campo na mão — depois disso é um valor dele, não mais um autofill.
  function limparAutofillEndereco(el) {
    el?.classList.remove('vn-ck-autofill');
  }
  ['vnCkRua', 'vnCkBairro', 'vnCkCidade', 'vnCkEstado'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', (e) => limparAutofillEndereco(e.target));
  });

  async function preencherEnderecoPorCep(cepDigitos) {
    if (cepDigitos.length !== 8 || cepDigitos === vnCkEnderecoBuscadoPara) return;
    vnCkEnderecoBuscadoPara = cepDigitos;

    const rua = document.getElementById('vnCkRua');
    const bairro = document.getElementById('vnCkBairro');
    const cidade = document.getElementById('vnCkCidade');
    const estado = document.getElementById('vnCkEstado');
    const hint = document.getElementById('vnCkEnderecoHint');
    // Esconde de novo a cada tentativa nova — se um CEP anterior tinha
    // preenchido e esse aqui falhar, o aviso não pode ficar preso mostrando
    // "preenchido pelo CEP" pra um endereço que não veio de lugar nenhum.
    if (hint) hint.style.display = 'none';

    try {
      const r = await fetch(`https://viacep.com.br/ws/${cepDigitos}/json/`);
      if (!r.ok) {
        console.warn('[checkout] ViaCEP respondeu', r.status, '— endereço não preenchido automaticamente.');
        return;
      }
      const d = await r.json().catch(() => ({}));
      if (!d || d.erro) {
        console.warn('[checkout] ViaCEP não encontrou o CEP', cepDigitos, '— cliente preenche o endereço na mão.');
        return;
      }
      if (rua && d.logradouro) { rua.value = d.logradouro; rua.classList.add('vn-ck-autofill'); }
      if (bairro && d.bairro) { bairro.value = d.bairro; bairro.classList.add('vn-ck-autofill'); }
      if (cidade && d.localidade) { cidade.value = d.localidade; cidade.classList.add('vn-ck-autofill'); }
      if (estado && d.uf) { estado.value = d.uf; estado.classList.add('vn-ck-autofill'); }
      if (hint && (d.logradouro || d.bairro || d.localidade)) hint.style.display = 'block';
    } catch (e) {
      // Antes engolido em silêncio — inclusive bloqueios de CSP (connect-src)
      // caem aqui como falha de rede, sem erro nenhum visível. Logar é o que
      // torna esse tipo de falha diagnosticável da próxima vez.
      console.error('[checkout] Falha ao consultar ViaCEP para preencher o endereço:', e);
    }
  }

  document.getElementById('vnCkCep')?.addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 8);
    if (v.length > 5) v = v.replace(/(\d{5})(\d{0,3})/, '$1-$2');
    e.target.value = v;
    if (v.replace(/\D/g, '').length === 8) preencherEnderecoPorCep(v.replace(/\D/g, ''));
  });

  const renderFreteOptions = () => {
    const box = document.getElementById('vnCkFreteOpts');
    if (!box) return;
    if (!freteOptions.length) {
      box.innerHTML = '<span style="color:rgba(247,244,240,.45)">Nenhuma opção de frete. Tente outro CEP ou cadastre o me_token no Admin.</span>';
      return;
    }
    box.innerHTML = freteOptions.map((opt, idx) => `
      <label style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;margin-bottom:8px;border:1px solid rgba(16,63,99,.25);border-radius:10px;cursor:pointer;color:#F7F4F0">
        <span style="display:flex;align-items:center;gap:8px">
          <input type="radio" name="vnFreteOpt" value="${idx}" ${idx === 0 ? 'checked' : ''}>
          <span>${opt.company ? opt.company + ' — ' : ''}${opt.name || 'Frete'}${opt.delivery_time ? ' · ' + opt.delivery_time + ' dias' : ''}</span>
        </span>
        <strong style="color:#103F63">${formatBRL(opt.price)}</strong>
      </label>`).join('');
    definirFrete(freteOptions[0]);
    box.querySelectorAll('input[name="vnFreteOpt"]').forEach((el) => {
      el.addEventListener('change', () => {
        const i = Number(el.value);
        definirFrete(freteOptions[i] || freteOptions[0]);
        renderTotais();
        updateParcelas();
      });
    });
    renderTotais();
    updateParcelas();
  };

  const updateParcelas = () => {
    const total = renderTotais();
    const parcMax = Math.max(1, Number(S.parc) || Number(window.S_parcelamentoMax) || 1);
    const selParc = document.getElementById('vnCardInstallments');
    if (!selParc) return;
    selParc.innerHTML = '';
    for (let i = 1; i <= parcMax; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = i + 'x de ' + formatBRL(total / i);
      selParc.appendChild(opt);
    }
  };
  updateParcelas();

  document.getElementById('vnCkFreteBtn')?.addEventListener('click', async () => {
    const cep = document.getElementById('vnCkCep')?.value || '';
    const box = document.getElementById('vnCkFreteOpts');
    const btn = document.getElementById('vnCkFreteBtn');
    if (box) box.textContent = 'Calculando frete…';
    if (btn) btn.disabled = true;
    preencherEnderecoPorCep(cep.replace(/\D/g, ''));

    // Frete grátis por regra da loja
    if (freteGratisAtivo && freteGratisValor > 0 && subtotal >= freteGratisValor) {
      freteOptions = [{ id: 'gratis', name: 'Frete Grátis', company: 'Loja', price: 0, delivery_time: null }];
      definirFrete(freteOptions[0]);
      renderFreteOptions();
      if (btn) btn.disabled = false;
      return;
    }

    const quote = await cotarFreteMelhorEnvio(cep, subtotal);
    if (btn) btn.disabled = false;

    if (quote.freeShipping) {
      freteOptions = [{ id: 'gratis', name: 'Frete Grátis', company: 'Loja', price: 0, delivery_time: null }];
    } else if (quote.ok && quote.options.length) {
      freteOptions = quote.options.map((o) => ({
        id: o.id || o.service_id || '',
        name: o.name || o.service || 'Frete',
        company: o.company || o.company_name || '',
        price: Number(o.price ?? o.custom_price ?? o.valor ?? 0) || 0,
        delivery_time: o.delivery_time || o.custom_delivery_time || o.prazo || null
      }));
    } else {
      freteOptions = [];
      if (box) {
        box.innerHTML = quote.reason === 'CEP_INVALIDO'
          ? 'CEP inválido. Use 8 dígitos.'
          : 'Não foi possível cotar agora. Você pode seguir com frete a combinar (R$ 0) ou tentar de novo.';
      }
      definirFrete({ price: 0, name: 'A combinar', id: '', company: '' });
      renderTotais();
      return;
    }
    renderFreteOptions();
  });

  document.getElementById('vnCheckoutForm')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errEl = document.getElementById('vnCkErr');
    const btn = document.getElementById('vnCkSubmit');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    const payerName = (document.getElementById('vnCkName')?.value || '').trim();
    const payerEmail = (document.getElementById('vnCkEmail')?.value || '').trim();
    const payerTelefone = (document.getElementById('vnCkTelefone')?.value || '').replace(/\D/g, '');
    const payerCpf = (document.getElementById('vnCkCpf')?.value || '').replace(/\D/g, '');
    const cep = (document.getElementById('vnCkCep')?.value || '').replace(/\D/g, '');
    const rua = (document.getElementById('vnCkRua')?.value || '').trim();
    const numero = (document.getElementById('vnCkNumero')?.value || '').trim();
    const complemento = (document.getElementById('vnCkComplemento')?.value || '').trim();
    const bairro = (document.getElementById('vnCkBairro')?.value || '').trim();
    const cidade = (document.getElementById('vnCkCidade')?.value || '').trim();
    const estado = (document.getElementById('vnCkEstado')?.value || '').trim().toUpperCase();
    const method = (document.querySelector('input[name="vnPayMethod"]:checked') || {}).value || 'pix';
    const freteValor = Number(freteSelecionado.price) || 0;
    const totalEstimado = Math.round((subtotal + freteValor) * 100) / 100;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
      if (errEl) { errEl.textContent = 'Informe um e-mail válido.'; errEl.style.display = 'block'; }
      return;
    }
    if (payerTelefone.length < 10) {
      if (errEl) { errEl.textContent = 'Informe um telefone válido.'; errEl.style.display = 'block'; }
      return;
    }
    if (payerCpf.length !== 11) {
      if (errEl) { errEl.textContent = 'Informe um CPF válido.'; errEl.style.display = 'block'; }
      return;
    }
    if (cep.length !== 8) {
      if (errEl) { errEl.textContent = 'Informe um CEP válido para o frete.'; errEl.style.display = 'block'; }
      return;
    }
    if (!rua || !numero || !bairro || !cidade || estado.length !== 2) {
      if (errEl) { errEl.textContent = 'Preencha o endereço completo de entrega (rua, número, bairro, cidade e UF).'; errEl.style.display = 'block'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Processando…'; }

    try {
      const payload = {
        customerName: payerName || 'Cliente',
        items: cart.map((it) => ({
          name: it.name,
          qty: it.qty ?? 1,
          price: it.price,
          tamanhoSelecionado: (it.tamanhoSelecionado || '').trim(),
          productId: it._id || it.productId || undefined
        })),
        payerEmail,
        payerTelefone,
        payerCpf,
        cep,
        rua,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        frete: freteValor,
        freteNome: freteSelecionado.name || '',
        freteEmpresa: freteSelecionado.company || '',
        freteServicoId: freteSelecionado.id || '',
        totalEstimado
      };

      let orderId = pedidoAtualId;
      let orderTotal = pedidoAtualTotal;

      if (!orderId) {
        // Só cria um pedido novo se não há um pendente desta mesma sessão de
        // checkout — uma recusa de cartão não invalida o pedido, só o
        // pagamento, então uma nova tentativa reaproveita o pedido acima em
        // vez de gerar outro (evita órfão consumindo estoque, ver comentário
        // na declaração de pedidoAtualId).
        const r = await fetch(API_URL + '/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          // Item ficou sem peso/dimensão depois de já estar no carrinho (ex:
          // lojista apagou o dado, ou nunca teve) — o carrinho é do
          // navegador, não é confiável, então o servidor pega isso na hora
          // de criar o pedido (ver POST /api/orders). Remove o item específico
          // em vez de só mostrar um erro genérico, pra não deixar o cliente
          // preso tentando pagar um carrinho que nunca vai fechar.
          if (d?.motivo === 'SEM_DADOS_ENVIO' && d?.produtoId) {
            const idxRemover = cart.findIndex((it) => String(it._id || it.productId) === String(d.produtoId));
            if (idxRemover !== -1) {
              cart.splice(idxRemover, 1);
              saveC();
              renderCart();
              syncDots();
            }
            throw new Error('Um item do seu carrinho ficou indisponível e foi removido. Revise seu carrinho e tente novamente.');
          }
          // Cobre carrinho salvo no navegador ANTES desta correção, com um
          // tamanho vazio ou herdado de outro produto (ver o bug corrigido
          // em addCart/renderQuickAddAction) — remove o item específico em
          // vez de deixar o cliente preso tentando pagar um pedido que o
          // servidor nunca vai aceitar.
          if (d?.motivo === 'TAMANHO_INVALIDO' && d?.produtoId) {
            const idxRemover = cart.findIndex((it) => String(it._id || it.productId) === String(d.produtoId));
            if (idxRemover !== -1) {
              cart.splice(idxRemover, 1);
              saveC();
              renderCart();
              syncDots();
            }
            throw new Error('Um item do seu carrinho estava sem tamanho válido e foi removido. Adicione-o de novo escolhendo o tamanho.');
          }
          throw new Error(d?.erro || d?.message || 'Falha ao criar pedido.');
        }

        orderId = d?.order?._id ? String(d.order._id) : '';
        orderTotal = d?.order?.total != null ? Number(d.order.total) : totalEstimado;
        if (!orderId) throw new Error('Pedido criado sem ID.');
        pedidoAtualId = orderId;
        pedidoAtualTotal = orderTotal;
      }

      // O carrinho só é esvaziado quando o pagamento é de fato confirmado
      // (showPaymentConfirmation) — não aqui. Uma recusa de cartão (saldo,
      // CVV, antifraude) é comum, e o cliente precisa poder tentar de novo
      // com o carrinho intacto, sem "items vazios" numa nova tentativa.

      if (!payConfig.hasMpToken) {
        await fallbackPixSemMp(orderId, orderTotal, payConfig.pixKeyFallback);
        return;
      }

      if (method === 'card') {
        if (!payConfig.mpPublicKey) throw new Error('Chave pública do Mercado Pago não configurada.');

        const cardNumber = (document.getElementById('vnCardNumber')?.value || '').replace(/\s/g, '');
        const exp = (document.getElementById('vnCardExp')?.value || '').trim();
        const [expMonth, expYearRaw] = exp.split('/');
        const expYear = String(expYearRaw || '').trim();
        const securityCode = (document.getElementById('vnCardCvv')?.value || '').trim();
        const cardholderName = (document.getElementById('vnCardName')?.value || payerName).trim();
        const installments = Number(document.getElementById('vnCardInstallments')?.value) || 1;

        if (!cardNumber || !expMonth || !expYear || !securityCode) {
          throw new Error('Preencha os dados do cartão.');
        }

        await loadMercadoPagoSdk();
        const mp = new window.MercadoPago(payConfig.mpPublicKey, { locale: 'pt-BR' });
        const tokenRes = await mp.createCardToken({
          cardNumber,
          cardholderName,
          cardExpirationMonth: String(expMonth).padStart(2, '0'),
          cardExpirationYear: expYear.length === 2 ? ('20' + expYear) : expYear,
          securityCode,
          identificationType: 'CPF',
          identificationNumber: payerCpf
        });
        const token = tokenRes?.id || tokenRes?.token;
        if (!token) throw new Error('Não foi possível tokenizar o cartão.');

        let payment_method_id = 'visa';
        try {
          const methods = await mp.getPaymentMethods({ bin: cardNumber.slice(0, 6) });
          payment_method_id = methods?.results?.[0]?.id || payment_method_id;
        } catch { /* default */ }

        const payR = await fetch(API_URL + '/payment/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'card',
            orderId,
            payerEmail,
            payerName,
            payerCpf,
            token,
            installments,
            payment_method_id,
            total: orderTotal
          })
        });
        const payD = await payR.json().catch(() => ({}));
        if (!payR.ok || !payD.ok) {
          console.error('[checkout] Pagamento com cartão recusado pelo Mercado Pago:', payD);
          throw new Error(payD?.mpError?.message || payD?.reason || 'Pagamento com cartão recusado.');
        }
        if (payD.approved || payD.status === 'approved') {
          showPaymentConfirmation(orderId, orderTotal);
        } else {
          showToast('warning', 'Pagamento em análise: ' + (payD.status || 'pendente'));
          startPaymentPolling(orderId, orderTotal);
          // Não usar closeVnPayOverlay() aqui: ele chama stopPaymentPolling()
          // internamente e mataria o polling que acabou de começar — só
          // remove o modal do formulário, a checagem de status continua.
          document.getElementById('pixModalOverlayVn')?.remove();
        }
        return;
      }

      // Pix — Mercado Pago
      const payR = await fetch(API_URL + '/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'pix',
          orderId,
          payerEmail,
          payerName,
          payerCpf,
          total: orderTotal
        })
      });
      const payD = await payR.json().catch(() => ({}));
      if (payR.ok && payD.ok) {
        showMpPixModal({
          qrCode: payD.qr_code || payD.qrCode || '',
          qrCodeBase64: payD.qr_code_base64 || payD.qrCodeBase64 || '',
          orderTotal: payD.total != null ? Number(payD.total) : orderTotal,
          orderId
        });
        return;
      }
      console.error('[checkout] Pix via Mercado Pago falhou — caindo para fallback manual.', payD);
      await fallbackPixSemMp(orderId, orderTotal, payConfig.pixKeyFallback);
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message || 'Erro no checkout.';
        errEl.style.display = 'block';
      }
      showToast('warning', e.message || 'Erro no checkout.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Pagar ' + formatBRL(Math.round((subtotal + (Number(freteSelecionado.price) || 0)) * 100) / 100);
      }
    }
  });
}



function showMpPixModal({ qrCode, qrCodeBase64, orderTotal, orderId }) {
  closeVnPayOverlay();
  const copia = String(qrCode || '').trim();
  const b64 = String(qrCodeBase64 || '').trim();
  const imgSrc = b64 ? (b64.startsWith('data:') ? b64 : ('data:image/png;base64,' + b64)) : '';

  const darkOverlay = document.createElement('div');
  darkOverlay.id = 'pixModalOverlayVn';
  darkOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(6px);z-index:2000;display:flex;align-items:center;justify-content:center';

  const styles = `
    .vn-pix-header{padding:18px 20px;border-bottom:1px solid rgba(16,63,99,.25);display:flex;align-items:center;justify-content:space-between}
    .vn-pix-title{font-family:var(--serif);font-size:18px;font-weight:400;color:#F7F4F0}
    .vn-pix-sub{font-family:var(--sans);font-size:12px;color:rgba(16,63,99,.9);letter-spacing:.12em;text-transform:uppercase}
    .vn-pix-body{padding:18px 20px}
    .vn-pix-label{font-family:var(--sans);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:rgba(247,244,240,.45);margin-bottom:10px}
    .vn-pix-value{font-family:var(--sans);font-size:13px;color:#F7F4F0;word-break:break-all;background:rgba(16,63,99,.08);border:1px solid rgba(16,63,99,.25);padding:12px;border-radius:12px;margin-bottom:16px;max-height:96px;overflow:auto}
    .vn-pix-actions{display:flex;gap:10px;flex-wrap:wrap}
    .vn-pix-btn{border:none;cursor:pointer;font-family:var(--sans);letter-spacing:.08em;text-transform:uppercase;font-size:11px;font-weight:800;padding:12px 14px;border-radius:12px}
    .vn-pix-btn.primary{background:#16598A;color:#fff}
    .vn-pix-btn.ghost{background:transparent;color:#F7F4F0;border:1px solid rgba(247,244,240,.18)}
    .vn-pix-close{width:34px;height:34px;border-radius:10px;border:1px solid rgba(247,244,240,.18);background:transparent;color:#F7F4F0;cursor:pointer}
    .vn-pix-qr{display:flex;justify-content:center;margin:0 0 16px}
    .vn-pix-qr img{width:200px;height:200px;border-radius:12px;background:#fff;padding:10px;box-sizing:border-box}
    .vn-pix-wait{font-family:var(--sans);font-size:12px;color:rgba(16,63,99,.95);text-align:center;margin-top:14px}
  `;

  darkOverlay.innerHTML = `
    <div id="pixModalVn" style="width:min(560px,94vw);background:#0F0F0F;border:1px solid rgba(16,63,99,.35);border-radius:16px;box-shadow:0 18px 70px rgba(0,0,0,.55);overflow:hidden">
      <style>${styles}</style>
      <div class="vn-pix-header">
        <div>
          <div class="vn-pix-sub">Pagamento Pix</div>
          <div class="vn-pix-title">Escaneie ou copie o código</div>
        </div>
        <button class="vn-pix-close" type="button" id="vnPixCloseBtn"><i class="fa-solid fa-xmark ui-ico" aria-hidden="true"></i></button>
      </div>
      <div class="vn-pix-body">
        ${imgSrc ? `<div class="vn-pix-qr"><img src="${imgSrc}" alt="QR Code Pix"></div>` : ''}
        <div class="vn-pix-label">Valor total</div>
        <div class="vn-pix-value">${formatBRL(orderTotal)}</div>
        <div class="vn-pix-label">Pix Copia e Cola</div>
        <div class="vn-pix-value">${copia || '—'}</div>
        <div class="vn-pix-actions">
          <button class="vn-pix-btn primary" id="vnPixCopyBtn" ${copia ? '' : 'disabled style="opacity:.5;cursor:not-allowed"'}>Copiar código Pix</button>
          <button class="vn-pix-btn ghost" type="button" id="vnPixCloseBtn2">Fechar</button>
        </div>
        <div class="vn-pix-wait">Aguardando confirmação do pagamento…</div>
      </div>
    </div>`;

  document.body.appendChild(darkOverlay);
  const close = () => closeVnPayOverlay();
  document.getElementById('vnPixCloseBtn')?.addEventListener('click', close);
  document.getElementById('vnPixCloseBtn2')?.addEventListener('click', close);
  darkOverlay.addEventListener('click', (e) => { if (e.target === darkOverlay) close(); });

  if (copia) {
    document.getElementById('vnPixCopyBtn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copia);
        showToast('success', 'Código Pix copiado!');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = copia;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('✓', 'Código Pix copiado!');
      }
    });
  }
  if (orderId) startPaymentPolling(orderId, orderTotal);
}

function showPixModal(pixValue, isEmpty, cartTotal, isCopiaECola){
  closeVnPayOverlay();

  const darkOverlay = document.createElement('div');
  darkOverlay.id = 'pixModalOverlayVn';
  darkOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(6px);z-index:2000;display:flex;align-items:center;justify-content:center';

  const styles = `
    .vn-pix-header{padding:18px 20px;border-bottom:1px solid rgba(16,63,99,.25);display:flex;align-items:center;justify-content:space-between}
    .vn-pix-title{font-family:var(--serif);font-size:18px;font-weight:400;color:#F7F4F0}
    .vn-pix-sub{font-family:var(--sans);font-size:12px;color:rgba(16,63,99,.9);letter-spacing:.12em;text-transform:uppercase}
    .vn-pix-body{padding:18px 20px}
    .vn-pix-label{font-family:var(--sans);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:rgba(247,244,240,.45);margin-bottom:10px}
    .vn-pix-value{font-family:var(--sans);font-size:14px;color:#F7F4F0;word-break:break-word;background:rgba(16,63,99,.08);border:1px solid rgba(16,63,99,.25);padding:12px;border-radius:12px;margin-bottom:16px}
    .vn-pix-actions{display:flex;gap:10px;flex-wrap:wrap}
    .vn-pix-btn{border:none;cursor:pointer;font-family:var(--sans);letter-spacing:.08em;text-transform:uppercase;font-size:11px;font-weight:800;padding:12px 14px;border-radius:12px}
    .vn-pix-btn.primary{background:#16598A;color:#fff}
    .vn-pix-btn.ghost{background:transparent;color:#F7F4F0;border:1px solid rgba(247,244,240,.18)}
    .vn-pix-close{width:34px;height:34px;border-radius:10px;border:1px solid rgba(247,244,240,.18);background:transparent;color:#F7F4F0;cursor:pointer}
  `;

  darkOverlay.innerHTML = `
    <div id="pixModalVn" style="width:min(560px,94vw);background:#0F0F0F;border:1px solid rgba(16,63,99,.35);border-radius:16px;box-shadow:0 18px 70px rgba(0,0,0,.55);overflow:hidden">
      <style>${styles}</style>
      <div class="vn-pix-header">
        <div>
          <div class="vn-pix-sub">Pagamento Seguro</div>
          <div class="vn-pix-title">Finalize seu Pagamento</div>
        </div>
        <button class="vn-pix-close" type="button" id="vnPixCloseBtn"><i class="fa-solid fa-xmark ui-ico" aria-hidden="true"></i></button>
      </div>
      <div class="vn-pix-body">
        <div class="vn-pix-label">${isCopiaECola ? 'Pix Copia e Cola — valor já travado' : 'Chave Pix para pagamento'}</div>
        <div class="vn-pix-value">${isEmpty ? '— (não configurada)' : String(pixValue)}</div>
        <div class="vn-pix-label" style="margin-top:6px">Valor total (pagamento)</div>
        <div class="vn-pix-value">${cartTotal != null ? formatBRL(cartTotal) : '—'}</div>
        ${isCopiaECola ? '<div style="font-family:var(--sans);font-size:12px;color:rgba(247,244,240,.55);margin:-8px 0 16px">Cole este código na opção "Pix Copia e Cola" do seu banco — o valor já vem preenchido.</div>' : ''}
        <div class="vn-pix-actions">
          <button class="vn-pix-btn primary" id="vnPixCopyBtn" ${isEmpty ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>${isCopiaECola ? 'Copiar Código Pix' : 'Copiar Chave Pix'}</button>
          <button class="vn-pix-btn ghost" type="button" id="vnPixCloseBtn2">Fechar</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(darkOverlay);
  const close = () => closeVnPayOverlay();
  document.getElementById('vnPixCloseBtn')?.addEventListener('click', close);
  document.getElementById('vnPixCloseBtn2')?.addEventListener('click', close);
  darkOverlay.addEventListener('click', (e) => { if (e.target === darkOverlay) close(); });

  if (!isEmpty) {
    const msgCopiado = isCopiaECola ? 'Código Pix copiado!' : 'Chave Pix copiada!';
    document.getElementById('vnPixCopyBtn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(pixValue));
        showToast('success', msgCopiado);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = String(pixValue);
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('success', msgCopiado);
      }
    });
  }
}
