const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  nome: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, lowercase: true, index: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  ordem: { type: Number, default: 0 },
  ativo: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.models.Category || mongoose.model('Category', CategorySchema);
