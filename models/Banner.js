const mongoose = require('mongoose');

const BannerSchema = new mongoose.Schema(
  {
    imagem: { type: String, required: true, trim: true },
    ordem: { type: Number, default: 0 },
    eyebrow: { type: String, trim: true, default: '' },
    titulo: { type: String, trim: true, default: '' },
    subtitulo: { type: String, trim: true, default: '' },
    textoBotao: { type: String, trim: true, default: '' },
    linkBotao: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Banner || mongoose.model('Banner', BannerSchema);
