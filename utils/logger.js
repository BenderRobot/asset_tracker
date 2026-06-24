const levels = { debug: 10, info: 20, warn: 30, error: 40, off: 50 };

function detectDefaultLevel() {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'development') return 'debug';
    if (typeof process !== 'undefined' && process.env && process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  } catch (e) {}
  if (typeof window !== 'undefined') {
    if (window.DEBUG_LOGGER) return 'debug';
    if (window.LOG_LEVEL) return window.LOG_LEVEL;
  }
  return 'info';
}

let currentLevel = detectDefaultLevel();

function setLevel(level) {
  if (level && levels[level] !== undefined) currentLevel = level;
}

function shouldLog(level) {
  return levels[level] >= levels[currentLevel];
}

function formatPrefix(level, name) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}]${name ? ` [${name}]` : ''}`;
}

function _log(level, name, args) {
  if (!shouldLog(level)) return;
  const prefix = formatPrefix(level, name);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  try {
    fn.call(console, prefix, ...args);
  } catch (e) {
    // Fallback in case console methods are not callable
    console.log(prefix, ...args);
  }
}

const logger = {
  setLevel,
  getLevel: () => currentLevel,
  debug: (...args) => _log('debug', null, args),
  info: (...args) => _log('info', null, args),
  warn: (...args) => _log('warn', null, args),
  error: (...args) => _log('error', null, args),
  create: (name) => ({
    debug: (...args) => _log('debug', name, args),
    info: (...args) => _log('info', name, args),
    warn: (...args) => _log('warn', name, args),
    error: (...args) => _log('error', name, args),
  }),
};

export default logger;
export { logger };
