const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

module.exports = {
  DATA_DIR,
  DATA_FILE: path.join(DATA_DIR, 'data_store.json'),
  DATA_BACKUP_FILE: path.join(DATA_DIR, 'data_store.pre-restart.json'),
  NN_MODEL_FILE: path.join(DATA_DIR, 'nn_model.json'),
  NN_MODEL_LIVE_FILE: path.join(DATA_DIR, 'nn_model.live.json'),
  NN_MODEL_B_FILE: path.join(DATA_DIR, 'nn_model_b.json'),
  RL_POLICY_FILE: path.join(DATA_DIR, 'rl_policy.json'),
  MINUTE_LOG_FILE: path.join(DATA_DIR, 'minute_analysis.json')
};
