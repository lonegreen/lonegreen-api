function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function countLinks(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 0;
  const matches = text.match(/\bhttps?:\/\/[^\s<>"']+/g);
  return matches ? matches.length : 0;
}

function repeatedWordRatio(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 0;
  const words = text.match(/[a-z0-9]{2,}/g) || [];
  if (!words.length) return 0;
  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  let top = 0;
  for (const count of counts.values()) {
    if (count > top) top = count;
  }
  return top / words.length;
}

function suspiciousKeywordCount(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 0;
  const keywords = [
    "guaranteed profit",
    "wire transfer",
    "crypto only",
    "click here now",
    "limited time offer",
    "adult service",
    "escort",
    "casino",
    "forex signal",
    "pump and dump"
  ];
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) count += 1;
  }
  return count;
}

function hasScriptLikePayload(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return false;
  return /<\s*script\b|<\s*img\b[^>]*onerror\s*=|javascript\s*:|onload\s*=|onerror\s*=/.test(text);
}

function getModerationSignals(value, options = {}) {
  const text = normalizeText(value);
  const maxLength = Number.isFinite(Number(options.maxLength)) ? Number(options.maxLength) : 2000;
  const maxLinks = Number.isFinite(Number(options.maxLinks)) ? Number(options.maxLinks) : 3;
  const links = countLinks(text);
  const repeats = repeatedWordRatio(text);
  const keywordHits = suspiciousKeywordCount(text);
  const nearLengthLimit = text.length > Math.floor(maxLength * 0.9);

  return {
    tooLong: text.length > maxLength,
    hasScriptPayload: hasScriptLikePayload(text),
    tooManyLinks: links > maxLinks,
    borderlineManyLinks: links === maxLinks,
    repeatedWords: repeats >= 0.45,
    suspiciousKeywordBurst: keywordHits >= 2,
    nearLengthLimit
  };
}

function hasSuspiciousContent(value, options = {}) {
  const signals = getModerationSignals(value, options);
  return signals.tooLong || signals.hasScriptPayload || signals.tooManyLinks;
}

function hasBorderlineContent(value, options = {}) {
  const signals = getModerationSignals(value, options);
  if (signals.tooLong || signals.hasScriptPayload || signals.tooManyLinks) {
    return false;
  }
  return signals.borderlineManyLinks || signals.repeatedWords || signals.suspiciousKeywordBurst || signals.nearLengthLimit;
}

function rejectSuspiciousContent(res) {
  return res.status(400).json({ error: "Content failed safety validation" });
}

function validateMarketplaceContent(req, res, next) {
  const title = normalizeText(req.body && req.body.title);
  const description = normalizeText(req.body && req.body.description);
  const message = normalizeText(req.body && req.body.message);

  const titleOptions = { maxLength: 180, maxLinks: 1 };
  const bodyOptions = { maxLength: 2000, maxLinks: 3 };
  const blocked = [
    hasSuspiciousContent(title, titleOptions),
    hasSuspiciousContent(description, bodyOptions),
    hasSuspiciousContent(message, bodyOptions)
  ].some(Boolean);

  if (blocked) {
    return rejectSuspiciousContent(res);
  }
  if (
    hasBorderlineContent(title, titleOptions)
    || hasBorderlineContent(description, bodyOptions)
    || hasBorderlineContent(message, bodyOptions)
  ) {
    res.locals.moderationFlagged = true;
  }
  return next();
}

function validateMessageContent(req, res, next) {
  const messageText = normalizeText(req.body && req.body.message_text);
  const options = { maxLength: 4000, maxLinks: 3 };
  if (hasSuspiciousContent(messageText, options)) {
    return rejectSuspiciousContent(res);
  }
  if (hasBorderlineContent(messageText, options)) {
    res.locals.moderationFlagged = true;
  }
  return next();
}

function validateReviewContent(req, res, next) {
  const reviewText = normalizeText(req.body && req.body.review_text);
  const options = { maxLength: 1500, maxLinks: 2 };
  if (hasSuspiciousContent(reviewText, options)) {
    return rejectSuspiciousContent(res);
  }
  if (hasBorderlineContent(reviewText, options)) {
    res.locals.moderationFlagged = true;
  }
  return next();
}

module.exports = {
  hasSuspiciousContent,
  hasBorderlineContent,
  getModerationSignals,
  validateMarketplaceContent,
  validateMessageContent,
  validateReviewContent
};

