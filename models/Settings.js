const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema(
  {
    mp_token: { type: String, default: '' },
    mp_public_key: { type: String, default: '' },
    me_token: { type: String, default: '' },
    pix_key: { type: String, default: '' },
    // Segredo do webhook (Mercado Pago → Sua integração → Webhooks). Usado só
    // pra validar o header x-signature em /api/pix/webhook — nunca devolvido
    // ao front (mesmo padrão de mp_token/me_token, ver mergePublicSettings).
    mp_webhook_secret: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
