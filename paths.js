const fs = require('fs');
const path = require('path');

/**
 * Path resolver.
 *
 * DATA_DIR  — small / fast state (data_store.json, models).
 *             Default: project root (C:\xampp\htdocs\AutoTread)
 *             Override: set DATA_DIR env var (e.g. in .env or Docker)
 *
 * LARGE_DATA_DIR — large, ever-growing files (minute_analysis.json, archive).
 *             Default: D:\AutoTread_data  (keeps C drive lean)
 *             Override: set LARGE_DATA_DIR env var
 *
 * Both directories are auto-created if they don't exist.
 */
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LARGE_DATA_DIR = process.env.LARGE_DATA_DIR
  || (fs.existsSync('D:\\') ? 'D:\\AutoTread_data' : DATA_DIR);
if (!fs.existsSync(LARGE_DATA_DIR)) fs.mkdirSync(LARGE_DATA_DIR, { recursive: true });

module.exports = {
  DATA_DIR,
  LARGE_DATA_DIR,
  DATA_FILE:          path.join(DATA_DIR,       'data_store.json'),
  DATA_BACKUP_FILE:   path.join(DATA_DIR,       'data_store.pre-restart.json'),
  NN_MODEL_FILE:      path.join(DATA_DIR,       'nn_model.json'),
  NN_MODEL_LIVE_FILE: path.join(DATA_DIR,       'nn_model.live.json'),
  NN_MODEL_B_FILE:    path.join(DATA_DIR,       'nn_model_b.json'),
  RL_POLICY_FILE:     path.join(DATA_DIR,       'rl_policy.json'),
  MINUTE_LOG_FILE:    path.join(LARGE_DATA_DIR, 'minute_analysis.json'),  // lives on D:
  ARCHIVE_DIR:        path.join(LARGE_DATA_DIR, 'archive'),               // corrupt files land here
};
