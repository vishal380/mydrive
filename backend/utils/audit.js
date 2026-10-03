const fs = require("fs");
const path = require("path");

const logDirectory = path.join(__dirname, "..", "logs");
const auditLogPath = path.join(logDirectory, "audit.log");

function auditLog(event, details = {}) {
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...details
    });

    try {
        fs.mkdirSync(logDirectory, { recursive: true });
        fs.appendFileSync(auditLogPath, `${line}\n`, "utf8");
    } catch (error) {
        console.error("Unable to write audit log file:", error);
    }

    console.info(line);
}

function actorFromRequest(req) {
    const user = req.session?.user;
    return {
        actorId: user?.id ?? null,
        actorUsername: user?.username ?? null,
        actorEmail: user?.email ?? null,
        ip: req.ip || req.socket?.remoteAddress || "unknown"
    };
}

module.exports = { auditLog, actorFromRequest };
