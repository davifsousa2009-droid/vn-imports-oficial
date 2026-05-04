const express = require("express");
const router = express.Router();
const Product = require("../models/Product");

// Criar produto
router.post("/", async (req, res) => {
  try {
    const product = new Product(req.body);
    await product.save();
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Listar produtos
router.get("/", async (req, res) => {
  const products = await Product.find();
  res.json(products);
});

module.exports = router;