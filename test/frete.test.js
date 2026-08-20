'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { testables } = require('./setup.js');
const { resolverDadosEnvioProduto } = testables;

// Ver comentário equivalente em pix.test.js — fecha a conexão Mongo que
// server.js abre ao ser carregado (não usada por estes testes) sem recorrer
// a process.exit(), que quebraria o relatório individual de cada teste.
after(async () => {
  await mongoose.disconnect().catch(() => {});
});

test('produto com peso/dimensão próprios: usa os valores do produto, ignora o padrão da loja', () => {
  const produto = { pesoKg: 1.2, larguraCm: 20, alturaCm: 10, comprimentoCm: 30 };
  const cfgFrete = { pesoKgPadrao: 99, larguraCmPadrao: 99, alturaCmPadrao: 99, comprimentoCmPadrao: 99 };
  const r = resolverDadosEnvioProduto(produto, cfgFrete);
  assert.deepEqual(r, { ok: true, pesoKg: 1.2, larguraCm: 20, alturaCm: 10, comprimentoCm: 30 });
});

test('produto sem nenhum campo próprio: usa o padrão da loja inteiro', () => {
  const produto = {};
  const cfgFrete = { pesoKgPadrao: 0.5, larguraCmPadrao: 15, alturaCmPadrao: 8, comprimentoCmPadrao: 25 };
  const r = resolverDadosEnvioProduto(produto, cfgFrete);
  assert.deepEqual(r, { ok: true, pesoKg: 0.5, larguraCm: 15, alturaCm: 8, comprimentoCm: 25 });
});

test('sem dado próprio nem padrão da loja em campo nenhum: ok:false, nunca inventa número', () => {
  const r = resolverDadosEnvioProduto({}, {});
  assert.equal(r.ok, false);
  // nenhum campo de medida deve vir junto de ok:false
  assert.equal(r.pesoKg, undefined);
});

test('falta só UM campo (sem padrão da loja pra cobrir): produto inteiro fica ok:false, não parcial', () => {
  const produto = { pesoKg: 1, larguraCm: 20, alturaCm: 10 }; // comprimentoCm ausente
  const cfgFrete = {}; // sem padrão nenhum
  const r = resolverDadosEnvioProduto(produto, cfgFrete);
  assert.equal(r.ok, false);
});

test('mistura: alguns campos vêm do produto, outros do padrão da loja, item a item', () => {
  const produto = { pesoKg: 2, alturaCm: 12 }; // larguraCm e comprimentoCm ausentes
  const cfgFrete = { larguraCmPadrao: 18, comprimentoCmPadrao: 22 };
  const r = resolverDadosEnvioProduto(produto, cfgFrete);
  assert.deepEqual(r, { ok: true, pesoKg: 2, larguraCm: 18, alturaCm: 12, comprimentoCm: 22 });
});

test('campo do produto zerado ou negativo é tratado como ausente, cai pro padrão da loja', () => {
  const produto = { pesoKg: 0, larguraCm: -5, alturaCm: 10, comprimentoCm: 30 };
  const cfgFrete = { pesoKgPadrao: 1.5, larguraCmPadrao: 12 };
  const r = resolverDadosEnvioProduto(produto, cfgFrete);
  assert.deepEqual(r, { ok: true, pesoKg: 1.5, larguraCm: 12, alturaCm: 10, comprimentoCm: 30 });
});
