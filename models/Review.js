const mongoose = require('mongoose');

const ReviewSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true },
    comentario: { type: String, required: true, trim: true },
    estrelas: { type: Number, required: true, min: 1, max: 5 },
    data: { type: Date, default: Date.now },
    aprovado: { type: Boolean, default: false }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Review || mongoose.model('Review', ReviewSchema);
