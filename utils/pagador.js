/**
 * O Mercado Pago exige payer.first_name e payer.last_name pra criar um
 * pagamento (cartão ou Pix) — sem os dois, a criação é recusada. O checkout
 * só coleta um campo de nome completo, então quem separa em nome/sobrenome é
 * o servidor, uma vez só, reaproveitado pelas duas rotas que criam pagamento
 * — em vez de cada front-end tentar adivinhar a mesma lógica sozinho.
 * Sem sobrenome informado, repete o primeiro nome nos dois campos: pior que
 * um sobrenome duplicado é a criação do pagamento ser recusada de novo.
 */
function dividirNomePagador(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return { first_name: 'Cliente', last_name: 'Cliente' };
  if (partes.length === 1) return { first_name: partes[0], last_name: partes[0] };
  return { first_name: partes[0], last_name: partes.slice(1).join(' ') };
}

// Formato simples, não é validação exaustiva de RFC 5322 — só o suficiente
// pra recusar antes de gastar uma chamada ao MP (que rejeitaria mesmo assim,
// só que sem essa mensagem clara e sem essa rejeição ser rápida).
function emailPagadorValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

module.exports = { dividirNomePagador, emailPagadorValido };
