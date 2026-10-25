'use strict';

/**
 * Minimal structured logger. No payload dumps, no session identifiers, no
 * personal data beyond what is operationally required (event names, counts).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(name = 'app', level = process.env.LOG_LEVEL || 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (levelName, message, meta) => {
    if (LEVELS[levelName] < threshold) return;
    const line = {
      t: new Date().toISOString(),
      level: levelName,
      scope: name,
      msg: message,
    };
    if (meta && typeof meta === 'object') {
      for (const [key, value] of Object.entries(meta)) {
        if (value === undefined) continue;
        line[key] = value;
      }
    }
    const target = levelName === 'error' || levelName === 'warn' ? console.error : console.log;
    target(JSON.stringify(line));
  };

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child: (scope) => createLogger(`${name}:${scope}`, level),
  };
}

module.exports = { createLogger };
