import { appendText, nowIso, tailFile } from './util.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(paths, { echo = true } = {}) {
    this.paths = paths;
    this.echo = echo;
    this.queue = Promise.resolve();
    this.ring = [];
    this.ringLimit = 120;
  }

  async log(level, code, message, data) {
    const record = {
      at: nowIso(),
      level,
      code: code || 'event',
      message: String(message ?? ''),
      ...(data === undefined ? {} : { data }),
    };
    this.ring.push(record);
    if (this.ring.length > this.ringLimit) this.ring.shift();
    if (this.echo) {
      const suffix = data === undefined ? '' : ` ${safeJson(data)}`;
      console.log(`${record.at} [${level.toUpperCase()}] [${record.code}] ${record.message}${suffix}`);
    }
    const line = `${record.at} [${level.toUpperCase()}] [${record.code}] ${record.message}${data === undefined ? '' : ` ${safeJson(data)}`}\n`;
    const eventLine = `${JSON.stringify(record)}\n`;
    this.queue = this.queue
      .then(async () => {
        await appendText(this.paths.logPath, line);
        await appendText(this.paths.eventsPath, eventLine, 20 * 1024 * 1024);
      })
      .catch(() => {});
    return this.queue;
  }

  debug(code, message, data) {
    return this.log('debug', code, message, data);
  }

  info(code, message, data) {
    return this.log('info', code, message, data);
  }

  warn(code, message, data) {
    return this.log('warn', code, message, data);
  }

  error(code, message, data) {
    return this.log('error', code, message, data);
  }

  async flush() {
    await this.queue.catch(() => {});
  }

  async tailLines(count = 40) {
    const text = await tailFile(this.paths.logPath, 128 * 1024);
    return text.split(/\r?\n/).filter(Boolean).slice(-count);
  }

  recent(count = 30) {
    return this.ring.slice(-count);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
