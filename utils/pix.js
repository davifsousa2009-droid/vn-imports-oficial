const crypto = require('crypto');

/**
 * Geração do "Pix Copia e Cola" (BR Code), padrão EMV definido pelo Banco Central.
 * Com o campo 54 (valor) preenchido, o app do banco do cliente já abre a tela de
 * pagamento com o valor travado (o cliente só confirma, não digita/edita o valor).
 * Não depende de nenhuma API externa — é só montagem de string + checksum CRC16.
 */
function removerAcentosEEspeciais(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^ -~]/g, '')
    .trim();
}

/**
 * Sanitiza a chave Pix para leitura segura em QR Code / Copia e Cola.
 * Remove parênteses, espaços, traços, pontos e qualquer caractere que
 * não seja dígito, letra, '@', '.' ou '+' (caracteres permitidos pelo
 * padrão BR Code do Banco Central para chaves Pix).
 * Ex: "(35) 99774-0622" → "35997740622" (telefone limpo).
 */
function sanitizarChavePix(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^!-~]/g, '')
    .replace(/[^\w@.+-]/g, '')
    .trim();
}

function tlv(id, value) {
  const v = String(value);
  const len = String(v.length).padStart(2, '0');
  return `${id}${len}${v}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — exigido pelo padrão do Pix. */
function crc16ccitt(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function gerarPixCopiaCola({ chave, valor, nome, cidade, txid }) {
  const chaveSanit = sanitizarChavePix(chave).slice(0, 77);
  const nomeSanit = (removerAcentosEEspeciais(nome).toUpperCase().slice(0, 25) || 'LOJA').trim();
  const cidadeSanit = (removerAcentosEEspeciais(cidade).toUpperCase().slice(0, 15) || 'SAO PAULO').trim();
  const txidSanit =
    (removerAcentosEEspeciais(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***').trim();
  const valorFormatado = Number(valor).toFixed(2);

  const merchantAccountInfo = tlv('00', 'br.gov.bcb.pix') + tlv('01', chaveSanit);
  const additionalData = tlv('05', txidSanit);

  let payload =
    tlv('00', '01') + // Payload Format Indicator
    tlv('01', '12') + // Point of Initiation Method: 12 = pagamento único com valor fixo
    tlv('26', merchantAccountInfo) + // Merchant Account Info (chave Pix)
    tlv('52', '0000') + // Merchant Category Code
    tlv('53', '986') + // Moeda: BRL
    tlv('54', valorFormatado) + // Valor — é isso que trava o valor no app do banco
    tlv('58', 'BR') + // País
    tlv('59', nomeSanit) + // Nome do recebedor
    tlv('60', cidadeSanit) + // Cidade do recebedor
    tlv('62', additionalData); // Identificador da transação (txid)

  payload += '6304'; // id+tamanho do campo CRC (o valor do CRC vem a seguir)
  const crc = crc16ccitt(payload).toString(16).toUpperCase().padStart(4, '0');
  return payload + crc;
}

/**
 * Valida o header x-signature que o MP assina em cada notificação de webhook,
 * usando o segredo configurado em Sua integração → Webhooks (Settings.mp_webhook_secret).
 * Fórmula documentada pelo MP: HMAC-SHA256 de "id:{data.id};request-id:{x-request-id};ts:{ts};"
 * — data.id sempre vem da query string (nunca do body), minúsculo.
 *
 * Só se aplica ao formato novo de notificação (query ?data.id=...), o único
 * que o MP documenta assinatura pra ele — o formato legado (?id=&topic=payment)
 * não tem x-signature nenhum pra validar. Por isso devolve null (em vez de
 * false) quando data.id não está na query: significa "sem como avaliar", não
 * "inválido". Essa distinção importa porque uma notificação legítima em
 * formato legado, se tratada como "inválida", pararia de confirmar pagamento
 * sozinha e silenciosamente — bem pior que o abuso que essa validação existe
 * pra mitigar.
 */
function validarAssinaturaWebhookMp(req, secret) {
  const dataId = req.query?.['data.id'];
  if (!dataId) return null; // formato legado — nada pra validar aqui

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  if (!xSignature || !xRequestId) return false;

  const partes = {};
  for (const par of String(xSignature).split(',')) {
    const [k, v] = par.split('=');
    if (k && v) partes[k.trim()] = v.trim();
  }
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${ts};`;
  const hashEsperado = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hashEsperado, 'hex'), Buffer.from(v1, 'hex'));
  } catch {
    return false; // v1 com formato/tamanho inesperado
  }
}

module.exports = {
  removerAcentosEEspeciais,
  sanitizarChavePix,
  tlv,
  crc16ccitt,
  gerarPixCopiaCola,
  validarAssinaturaWebhookMp
};
