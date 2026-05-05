const SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9_]+/g,
  /whsec_[A-Za-z0-9_]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi
];

function sanitize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message),
      code: value.code || undefined
    };
  }

  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce(
      (text, pattern) => text.replace(pattern, "[redacted]"),
      value
    );
  }

  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === "object") {
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (/secret|password|token|key|database_url/i.test(key)) {
        clean[key] = "[redacted]";
      } else {
        clean[key] = sanitize(item);
      }
    }
    return clean;
  }

  return value;
}

function write(level, message, meta) {
  const payload = meta === undefined ? "" : sanitize(meta);
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}`;

  if (level === "error") {
    console.error(line, payload);
  } else if (level === "warn") {
    console.warn(line, payload);
  } else {
    console.log(line, payload);
  }
}

module.exports = {
  sanitize,
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta)
};
