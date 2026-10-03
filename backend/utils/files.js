const path = require("path");
const crypto = require("crypto");

function storageRoot() {
    return path.resolve(process.env.STORAGE_PATH);
}

function safeOriginalName(originalname) {
    const base = path.basename(String(originalname || "file")).replace(/[\u0000-\u001f<>:"|?*]/g, "_");
    return base.slice(0, 200) || "file";
}

function storedFilename(originalname) {
    const ext = path.extname(safeOriginalName(originalname)).slice(0, 12);
    const safeExt = /^\.[a-zA-Z0-9.]+$/.test(ext) ? ext : "";
    return `${Date.now()}-${crypto.randomBytes(16).toString("hex")}${safeExt}`;
}

function resolveStoredPath(storagePath) {
    const root = storageRoot();
    const resolved = path.resolve(String(storagePath || ""));
    const relative = path.relative(root, resolved);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return null;
    }

    return resolved;
}

function contentDisposition(filename, type = "attachment") {
    const fallback = safeOriginalName(filename).replace(/[^\x20-\x7E]/g, "_") || "download";
    const encoded = encodeURIComponent(filename || "download");
    return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function isSafeInlineMime(mime) {
    const value = String(mime || "").toLowerCase();

    if (!value || value.includes("svg") || value.includes("html") || value.includes("xml")) {
        return false;
    }

    return (
        value.startsWith("image/jpeg") ||
        value.startsWith("image/png") ||
        value.startsWith("image/gif") ||
        value.startsWith("image/webp") ||
        value.startsWith("image/bmp") ||
        value === "application/pdf" ||
        value.startsWith("text/plain") ||
        value.startsWith("audio/") ||
        value.startsWith("video/")
    );
}

function toClientFile(row) {
    return {
        id: row.id,
        user_id: row.user_id,
        original_filename: row.original_filename,
        mime_type: row.mime_type,
        size: row.size,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_owner: row.is_owner === true,
        can_read: row.can_read === true || row.is_owner === true,
        can_write: row.can_write === true || row.is_owner === true,
        can_execute: row.can_execute === true || row.is_owner === true
    };
}

module.exports = {
    storageRoot,
    safeOriginalName,
    storedFilename,
    resolveStoredPath,
    contentDisposition,
    isSafeInlineMime,
    toClientFile
};
