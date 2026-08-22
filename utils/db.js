const mongoose = require('mongoose');

// ── CONEXÃO COM MONGODB (singleton) ────────────────────
// Na Vercel, o mesmo código pode ser executado em múltiplas invocações.
// Guardamos a conexão/promise para evitar reconectar a cada request (causa comum de 503).
let isConnected = false;
let connectPromise = null;

async function connectDB() {
  // Se já conectou e a conexão está ativa, não reconecta.
  if (mongoose.connection.readyState === 1 && isConnected) return;
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }

  // Se uma conexão já está em andamento, reaproveita a promise.
  if (connectPromise) return connectPromise;

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI não definido no ambiente.');
  }

  connectPromise = mongoose
    .connect(mongoUri, {
      // aumenta timeout para reduzir falhas em cold start / Atlas instável
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      w: 'majority',
      // pool pequeno para reduzir agressividade; singleton evita reconexões
      maxPoolSize: 1,
      minPoolSize: 0
    })
    .then(() => {
      isConnected = true;
      console.log('MongoDB conectado');
      return mongoose;
    })
    .catch((err) => {
      // libera promise para próximas tentativas
      isConnected = false;
      connectPromise = null;
      throw err;
    })
    .finally(() => {
      // mantém isConnected, mas não prende connectPromise após sucesso
      connectPromise = null;
    });

  return connectPromise;
}

async function tryConnectDb() {
  try {
    await connectDB();
    return mongoose.connection.readyState === 1;
  } catch (err) {
    console.warn('MongoDB:', err.message);
    return false;
  }
}

async function ensureDbConnected(res) {
  try {
    await connectDB();
    if (mongoose.connection.readyState !== 1) {
      res.status(503).json({ erro: 'Banco de dados indisponível no momento.' });
      return false;
    }
    return true;
  } catch (err) {
    res.status(503).json({
      erro: 'Não foi possível conectar ao banco de dados.',
      detalhe: err.message
    });
    return false;
  }
}

module.exports = { connectDB, tryConnectDb, ensureDbConnected };
