/**
 * REINFORCE policy: state (15 features) → HOLD / LONG / SHORT.
 * Reward is closed-trade PnL (or a counterfactual HOLD reward).
 * This is policy-gradient RL, not PPO and not a guarantee of profit.
 */
const fs = require('fs');
const tf = require('@tensorflow/tfjs');
const { RL_POLICY_FILE } = require('./paths');

const ACTIONS = ['HOLD', 'LONG', 'SHORT'];

function buildPolicy() {
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 32, activation: 'tanh', inputShape: [15] }));
  model.add(tf.layers.dense({ units: 3, activation: 'softmax' }));
  return model;
}

class RLPolicy {
  constructor() {
    this.model = null;
    this.ready = false;
    this.optimizer = tf.train.adam(0.002);
    this.baseline = 0;
    this.updates = 0;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.model && this.ready) return;
    this.model = buildPolicy();
    if (fs.existsSync(RL_POLICY_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(RL_POLICY_FILE, 'utf8'));
        const buf = Buffer.from(raw.weightData, 'base64');
        const weightData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        this.model = await tf.loadLayersModel(tf.io.fromMemory({
          modelTopology: raw.modelTopology,
          weightSpecs: raw.weightSpecs,
          weightData
        }));
        this.ready = true;
        this.baseline = Number(raw.baseline) || 0;
        this.updates = Number(raw.updates) || 0;
        console.log(`[RL] Loaded policy from rl_policy.json (updates=${this.updates})`);
        return;
      } catch (err) {
        console.error('[RL] Load failed, using fresh policy:', err.message);
        this.model = buildPolicy();
      }
    }
    this.ready = true;
    console.log('[RL] Fresh HOLD/LONG/SHORT policy (untrained until first rewards)');
  }

  act(features) {
    if (!this.model || !Array.isArray(features) || features.length !== 15) {
      return { action: 'HOLD', index: 0, probs: [1, 0, 0] };
    }
    const xs = tf.tensor2d([features]);
    const pred = this.model.predict(xs);
    const probs = Array.from(pred.dataSync());
    xs.dispose();
    pred.dispose();
    let index = 0;
    for (let i = 1; i < 3; i++) if (probs[i] > probs[index]) index = i;
    return { action: ACTIONS[index], index, probs };
  }

  learn(features, actionName, reward) {
    if (!this.model || !Array.isArray(features) || features.length !== 15) return;
    const actionIdx = Math.max(0, ACTIONS.indexOf(actionName));
    const r = Math.max(-0.06, Math.min(0.06, Number(reward) || 0));
    this.queue = this.queue.then(() => this._step(features, actionIdx, r)).catch((err) => {
      console.error('[RL] Learn error:', err.message);
    });
    return this.queue;
  }

  async _step(features, actionIdx, reward) {
    this.updates += 1;
    this.baseline += (reward - this.baseline) / Math.min(this.updates, 200);
    const advantage = reward - this.baseline;
    const xs = tf.tensor2d([features]);
    const adv = tf.scalar(advantage);
    this.optimizer.minimize(() => {
      const probs = this.model.apply(xs, { training: true });
      const chosen = tf.sum(probs.mul(tf.oneHot(tf.tensor1d([actionIdx], 'int32'), 3)), 1);
      return chosen.add(1e-8).log().neg().mul(adv).mean();
    });
    xs.dispose();
    adv.dispose();
    if (this.updates % 5 === 0) await this.save();
  }

  async save() {
    if (!this.model) return;
    await this.model.save(tf.io.withSaveHandler(async (artifacts) => {
      fs.writeFileSync(RL_POLICY_FILE, JSON.stringify({
        modelTopology: artifacts.modelTopology,
        weightSpecs: artifacts.weightSpecs,
        weightData: Buffer.from(artifacts.weightData).toString('base64'),
        baseline: this.baseline,
        updates: this.updates,
        savedAt: new Date().toISOString()
      }));
      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
    }));
  }
}

const rlPolicy = new RLPolicy();

module.exports = { RLPolicy, rlPolicy, ACTIONS, buildPolicy };
