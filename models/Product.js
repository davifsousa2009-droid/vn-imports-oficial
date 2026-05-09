const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema({
  name: String,
  price: Number,
  image: String,
  description: String,
  category: String,
  // Array de tamanhos disponíveis (ex: ['P','M','G','GG','38','40','XG'])
  sizes: { type: [String], default: [] }
});

module.exports = mongoose.model("Product", ProductSchema);
