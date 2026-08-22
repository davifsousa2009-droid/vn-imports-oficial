const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    // Classifica o TIPO de medida dos produtos desta categoria — não é
    // hierarquia (categorias continuam flat, ver MAPA_DO_PROJETO.md seção 6),
    // é só o que o filtro da vitrine usa pra decidir se mostra "Tamanho de
    // Roupa" (aro/letra P-GG) ou "Medida de Joia" (aro em mm) pros produtos
    // dessa categoria — sem isso os dois tipos de medida ficavam misturados
    // numa lista só. 'outro' é o default pra categoria que não é nenhum dos
    // dois (ex: acessórios sem medida).
    tipo: { type: String, enum: ['roupa', 'joia', 'outro'], default: 'outro' }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Category || mongoose.model('Category', CategorySchema);
