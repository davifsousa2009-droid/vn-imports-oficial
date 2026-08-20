'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { testables } = require('./setup.js');
const { validarAssinaturaWebhookMp } = testables;

// Ver comentário equivalente em pix.test.js — fecha a conexão Mongo que
// server.js abre ao ser carregado (não usada por estes testes) sem recorrer
// a process.exit(), que quebraria o relatório individual de cada teste.
after(async () => {
  await mongoose.disconnect().catch(() => {});
});

const SECRET = 'segredo-de-teste-do-webhook';

// Constrói um x-signature válido do jeito que o Mercado Pago realmente monta
// (fórmula documentada pelo MP, replicada aqui só pra montar o caso de teste
// — a validação de verdade está inteiramente em validarAssinaturaWebhookMp).
function assinar({ dataId, requestId, ts, secret = SECRET }) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

test('formato legado (sem data.id na query): devolve null, não false — "sem como avaliar" != "inválido"', () => {
  const req = { query: {}, headers: {} };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), null);
});

test('formato novo sem os headers de assinatura: devolve false', () => {
  const req = { query: { 'data.id': 'PAY123' }, headers: {} };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), false);
});

test('assinatura corretamente calculada: devolve true', () => {
  const req = {
    query: { 'data.id': 'PAY123' },
    headers: {
      'x-signature': assinar({ dataId: 'PAY123', requestId: 'req-abc', ts: '1700000000' }),
      'x-request-id': 'req-abc'
    }
  };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), true);
});

test('data.id da query em caixa alta ainda bate (manifest usa lowercase) — assinado com o id original', () => {
  const req = {
    query: { 'data.id': 'PAY123' },
    headers: {
      // assinado com o dataId já em minúsculo, como o MP realmente faz
      'x-signature': assinar({ dataId: 'pay123', requestId: 'req-abc', ts: '1700000000' }),
      'x-request-id': 'req-abc'
    }
  };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), true);
});

test('v1 adulterado (1 caractere trocado): devolve false', () => {
  const boa = assinar({ dataId: 'PAY123', requestId: 'req-abc', ts: '1700000000' });
  const [tsPart, v1Part] = boa.split(',');
  const v1 = v1Part.slice(3);
  const v1Adulterado = (v1[0] === '0' ? '1' : '0') + v1.slice(1);
  const req = {
    query: { 'data.id': 'PAY123' },
    headers: { 'x-signature': `${tsPart},v1=${v1Adulterado}`, 'x-request-id': 'req-abc' }
  };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), false);
});

test('request-id diferente do usado na assinatura: devolve false (manifest muda, hash não bate)', () => {
  const req = {
    query: { 'data.id': 'PAY123' },
    headers: {
      'x-signature': assinar({ dataId: 'PAY123', requestId: 'req-original', ts: '1700000000' }),
      'x-request-id': 'req-outro'
    }
  };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), false);
});

test('v1 com formato inválido (não-hex): devolve false em vez de lançar exceção', () => {
  const req = {
    query: { 'data.id': 'PAY123' },
    headers: { 'x-signature': 'ts=1700000000,v1=isso-nao-e-hexadecimal', 'x-request-id': 'req-abc' }
  };
  assert.doesNotThrow(() => validarAssinaturaWebhookMp(req, SECRET));
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), false);
});

test('assinado com segredo diferente do configurado: devolve false', () => {
  const req = {
    query: { 'data.id': 'PAY123' },
    headers: {
      'x-signature': assinar({ dataId: 'PAY123', requestId: 'req-abc', ts: '1700000000', secret: 'segredo-errado' }),
      'x-request-id': 'req-abc'
    }
  };
  assert.equal(validarAssinaturaWebhookMp(req, SECRET), false);
});
