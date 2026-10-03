const crypto = require("crypto");

const buckets = new Map();

function allowAttempt(key, { windowMs = 15 * 60 * 1000, max = 10 } = {}) {
    const now = Date.now();
    const current = buckets.get(key);

    if (!current || now - current.startedAt >= windowMs) {
        buckets.set(key, { startedAt: now, count: 1 });
        return true;
    }

    current.count += 1;
    return current.count <= max;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function hashOtp(otp) {
    return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

function otpsEqual(storedHex, submittedOtp) {
    const stored = Buffer.from(String(storedHex || ""), "hex");
    const computed = Buffer.from(hashOtp(submittedOtp), "hex");

    if (stored.length !== computed.length || stored.length === 0) {
        return false;
    }

    return crypto.timingSafeEqual(stored, computed);
}

function clientKey(req) {
    return req.ip || req.socket?.remoteAddress || "unknown";
}

module.exports = {
    allowAttempt,
    isValidEmail,
    hashOtp,
    otpsEqual,
    clientKey
};
