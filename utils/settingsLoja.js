function mergePublicSettings(doc) {
  return {
    pix_key: doc?.pix_key != null ? String(doc.pix_key).trim() : '',
    // mp_public_key é, por natureza, uma chave pública (usada no SDK do MP
    // direto no navegador pra tokenizar cartão) — diferente de mp_token/
    // me_token, que são credenciais e nunca devem sair daqui.
    mp_public_key: doc?.mp_public_key != null ? String(doc.mp_public_key).trim() : ''
  };
}

function temMpTokenSalvo(doc) {
  if (!doc) return false;
  const mp = doc?.mp_token != null ? String(doc.mp_token).trim() : '';
  return mp.length > 0;
}

module.exports = { mergePublicSettings, temMpTokenSalvo };
