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
    tipo: { type: String, enum: ['roupa', 'joia', 'outro'], default: 'outro' },
    // Categoria-pai (ex: "Roupas" dentro de "Masculino"). null = categoria de
    // topo (era o único caso possível antes deste campo existir — toda
    // categoria já cadastrada continua de topo, sem precisar de migração).
    // Profundidade fica limitada a 2 níveis (topo -> filha direta) de
    // propósito: é o que o front já sabe renderizar hoje sem mudança nenhuma
    // (montarColunasMegaMenu em vn-nav.js, flattenCategoryTree em
    // vn-filters-sort.js — os dois só andam um nível). Validado nas rotas de
    // escrita (POST/PUT em routes/categorias.js): só aceita como pai uma
    // categoria que ela mesma seja de topo (parent:null) — sem limite de
    // QUANTOS filhos um pai pode ter (Masculino com Roupas E Joias é o caso
    // normal).
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.Category || mongoose.model('Category', CategorySchema);
