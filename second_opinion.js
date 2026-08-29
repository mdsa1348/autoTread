/**
 * Second opinion: a separately trained local net (direction, not TP/SL)
 * plus an optional HTTP model. Weights from GitHub PyTorch models cannot
 * load here; we can only use their *response* if you point SECOND_OPINION_URL
 * at a sidecar that wraps them.
 */
const fs = require('fs');
const tf = require('@tensorflow/tfjs');
const { NN_MODEL_B_FILE } = require('./paths');

const cache = new Map();
let modelB = null;
let modelBReady = false;
let modelBInit = null;

function buildNet() {
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [15] }));
  model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
  model.compile({ optimizer: tf.train.adam(0.008), loss: 'binaryCrossentropy' });
  return model;
}

async function loadModelB() {
  if (modelBInit) return modelBInit;
  modelBInit = (async () => {
    if (!fs.existsSync(NN_MODEL_B_FILE)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(NN_MODEL_B_FILE, 'utf8'));
      const buf = Buffer.from(raw.weightData, 'base64');
      const weightData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      modelB = await tf.loadLayersModel(tf.io.fromMemory({
        modelTopology: raw.modelTopology,
        weightSpecs: raw.weightSpecs,
        weightData
      }));
      modelB.compile({ optimizer: tf.train.adam(0.008), loss: 'binaryCrossentropy' });
      modelBReady = true;
      console.log('[OPINION-B] Loaded nn_model_b.json (direction second opinion)');
    } catch (err) {
      console.error('[OPINION-B] Load failed:', err.message);
    }
  })();
  return modelBInit;
}

async function saveModelB(model) {
  await model.save(tf.io.withSaveHandler(async (artifacts) => {
    fs.writeFileSync(NN_MODEL_B_FILE, JSON.stringify({
      modelTopology: artifacts.modelTopology,
      weightSpecs: artifacts.weightSpecs,
      weightData: Buffer.from(artifacts.weightData).toString('base64'),
      role: 'second-opinion-direction',
      savedAt: new Date().toISOString()
    }));
    return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
  }));
  modelB = model;
  modelBReady = true;
}

function predictLocalB(features) {
  if (!modelBReady || !modelB || !Array.isArray(features) || features.length !== 15) return null;
  try {
    const xs = tf.tensor2d([features]);
    const pred = modelB.predict(xs);
    const p = pred.dataSync()[0];
    xs.dispose();
    pred.dispose();
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

async function queryExternal(symbol, closes) {
  const url = process.env.SECOND_OPINION_URL;
  if (!url || !symbol) return null;
  const key = `${symbol}:${closes && closes.length ? closes[closes.length - 1] : ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 400);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        interval: '1m',
        closes: (closes || []).slice(-80)
      }),
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = await res.json();
    const pBull = Number(body.pBull ?? body.prob ?? body.bullish);
    if (!Number.isFinite(pBull)) return null;
    const value = { pBull, source: body.source || 'external' };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function consult(features, symbol, closes) {
  const votes = [];
  const local = predictLocalB(features);
  if (local != null) votes.push({ pBull: local, source: 'local-B' });

  const ext = cache.get(`${symbol}:${closes && closes.length ? closes[closes.length - 1] : ''}`);
  if (ext && Date.now() - ext.at < 30000) votes.push(ext.value);

  if (!votes.length) {
    return {
      ready: modelBReady,
      pBull: null,
      side: 'NONE',
      summary: modelBReady ? 'no vote' : '2nd model not trained yet',
      agreeLong: null,
      agreeShort: null,
      veto: false,
      sources: []
    };
  }

  const pBull = votes.reduce((s, v) => s + v.pBull, 0) / votes.length;
  const side = pBull >= 0.55 ? 'LONG' : pBull <= 0.45 ? 'SHORT' : 'HOLD';
  return {
    ready: true,
    pBull,
    side,
    summary: `${side} ${(pBull * 100).toFixed(0)}% (${votes.map(v => v.source).join('+')})`,
    agreeLong: pBull >= 0.55,
    agreeShort: pBull <= 0.45,
    veto: (pBull < 0.38) || (pBull > 0.62),
    sources: votes.map(v => v.source)
  };
}

module.exports = {
  buildNet,
  loadModelB,
  saveModelB,
  predictLocalB,
  queryExternal,
  consult,
  isReady: () => modelBReady
};
