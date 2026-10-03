const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { ZipArchive } = require("archiver");

const pool = require("../config/database");
const requireAuth = require("../middleware/authMiddleware");
const {
    storedFilename,
    safeOriginalName,
    resolveStoredPath,
    contentDisposition,
    isSafeInlineMime,
    toClientFile
} = require("../utils/files");
const { auditLog, actorFromRequest } = require("../utils/audit");

const router = express.Router();
const MAX_UPLOAD_FILE_SIZE = 5 * 1024 * 1024 * 1024;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userId = req.session?.user?.id;

        if (!userId) {
            cb(new Error("Authentication required"));
            return;
        }

        const userFolder = path.join(
            process.env.STORAGE_PATH,
            "users",
            String(userId)
        );

        fs.mkdirSync(userFolder, { recursive: true });
        cb(null, userFolder);
    },

    filename: (req, file, cb) => {
        cb(null, storedFilename(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: MAX_UPLOAD_FILE_SIZE
    }
});

function handleUpload(req, res, next) {
    upload.array("files")(req, res, (error) => {
        if (!error) {
            next();
            return;
        }

        (req.files || []).forEach((file) => fs.unlink(file.path, () => {}));

        console.error("Upload receive error:", error);
        auditLog("file.upload_failed", {
            ...actorFromRequest(req),
            stage: "receive",
            errorCode: error.code || "UPLOAD_ERROR"
        });

        if (error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                success: false,
                message: "File too large. Maximum size is 5 GB."
            });
        }

        return res.status(400).json({
            success: false,
            message: "File upload failed"
        });
    });
}

async function getStorageUsage(userId) {
    const result = await pool.query(
        `
        SELECT
            COALESCE(SUM(size), 0)::bigint AS used,
            (
                SELECT storage_quota
                FROM users
                WHERE id = $1
            ) AS quota
        FROM files
        WHERE user_id = $1
        `,
        [userId]
    );

    return {
        used: Number(result.rows[0].used || 0),
        quota: Number(result.rows[0].quota || 0)
    };
}

function parseFolderId(value) {
    if (value === undefined || value === null || value === "") return null;
    const folderId = Number(value);
    return Number.isSafeInteger(folderId) && folderId > 0 ? folderId : NaN;
}

function validateFolderName(value) {
    const name = String(value || "").trim();
    if (!name || name.length > 150 || /[\\/\u0000-\u001f]/.test(name) || name === "." || name === "..") {
        return null;
    }
    return name;
}

async function getOwnedFolder(userId, folderId) {
    if (folderId === null) return true;
    if (!Number.isSafeInteger(folderId) || folderId <= 0) return false;
    const result = await pool.query(
        "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL",
        [folderId, userId]
    );
    return result.rows.length > 0;
}

async function getAccessibleFolder(userId, folderId, requireWrite = false) {
    if (!Number.isSafeInteger(Number(folderId)) || Number(folderId) <= 0) return false;
    const result = await pool.query(
        `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM folders WHERE id = $1 AND trashed_at IS NULL
             UNION ALL
             SELECT parent.id, parent.parent_id FROM folders parent
             JOIN ancestors child ON child.parent_id = parent.id
             WHERE parent.trashed_at IS NULL
         )
         SELECT f.id FROM folders f
         WHERE f.id = $1 AND f.trashed_at IS NULL
           AND (f.user_id = $2 OR EXISTS (
               SELECT 1 FROM folder_shares fs
               WHERE fs.shared_with_user_id = $2
                 AND fs.folder_id IN (SELECT id FROM ancestors)
                 AND fs.can_read = TRUE
                 AND ($3 = FALSE OR fs.can_write = TRUE)
           ))`,
        [folderId, userId, requireWrite]
    );
    return result.rows.length > 0;
}

async function findOrCreateFolder(userId, parentId, name) {
    const existing = await pool.query(
        `SELECT id FROM folders
         WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND LOWER(name) = LOWER($3)`,
        [userId, parentId, name]
    );
    if (existing.rows.length) return existing.rows[0].id;

    const inserted = await pool.query(
        `INSERT INTO folders (user_id, parent_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, parentId, name]
    );
    if (inserted.rows.length) return inserted.rows[0].id;

    const retry = await pool.query(
        `SELECT id FROM folders
         WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND LOWER(name) = LOWER($3)`,
        [userId, parentId, name]
    );
    return retry.rows[0]?.id;
}

async function ensureUploadFolders(userId, baseFolderId, relativePath) {
    const parts = String(relativePath || "").split(/[\\/]/).filter(Boolean).slice(0, -1);
    let parentId = baseFolderId;
    for (const rawPart of parts) {
        const name = validateFolderName(rawPart);
        if (!name) throw new Error("Folder upload contains an invalid folder name");
        parentId = await findOrCreateFolder(userId, parentId, name);
        if (!parentId) throw new Error("Unable to create an upload folder");
    }
    return parentId;
}

async function findAccessibleFile(fileId, userId) {
    const result = await pool.query(
        `
        SELECT
            f.id,
            f.user_id,
            f.original_filename,
            f.storage_path,
            f.mime_type,
            f.size,
            f.created_at,
            CASE WHEN f.user_id = $2 THEN TRUE ELSE FALSE END AS is_owner,
            COALESCE(fs.can_read, folder_access.can_read, FALSE) AS can_read,
            COALESCE(fs.can_write, folder_access.can_write, FALSE) AS can_write,
            COALESCE(fs.can_execute, FALSE) AS can_execute
        FROM files f
        LEFT JOIN file_shares fs
            ON fs.file_id = f.id
           AND fs.shared_with_user_id = $2
        LEFT JOIN LATERAL (
            WITH RECURSIVE ancestors AS (
                SELECT id, parent_id FROM folders WHERE id = f.folder_id AND trashed_at IS NULL
                UNION ALL
                SELECT parent.id, parent.parent_id FROM folders parent
                JOIN ancestors child ON child.parent_id = parent.id
                WHERE parent.trashed_at IS NULL
            )
            SELECT BOOL_OR(fs.can_read) AS can_read, BOOL_OR(fs.can_write) AS can_write
            FROM folder_shares fs
            WHERE fs.shared_with_user_id = $2 AND fs.folder_id IN (SELECT id FROM ancestors)
        ) folder_access ON TRUE
        WHERE f.id = $1
          AND f.trashed_at IS NULL
        LIMIT 1
        `,
        [fileId, userId]
    );

    return result.rows[0] || null;
}

async function findPublicFile(token) {
    const result = await pool.query(
        `
        SELECT
            id,
            user_id,
            original_filename,
            storage_path,
            mime_type,
            size,
            created_at,
            public_access,
            public_can_write,
            public_can_execute
        FROM files
        WHERE public_token = $1
          AND public_access = TRUE
          AND trashed_at IS NULL
        LIMIT 1
        `,
        [token]
    );

    return result.rows[0] || null;
}

function sendStoredFile(res, file, asDownload, auditDetails = {}) {
    const storedPath = resolveStoredPath(file.storage_path);

    if (!storedPath || !fs.existsSync(storedPath)) {
        res.status(404).json({
            success: false,
            message: "Physical file not found"
        });
        return;
    }

    const filename = file.original_filename || "download";

    if (asDownload || !isSafeInlineMime(file.mime_type)) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", contentDisposition(filename, "attachment"));
    } else {
        res.setHeader("Content-Type", file.mime_type);
        res.setHeader("Content-Disposition", contentDisposition(filename, "inline"));
    }

    if (asDownload) {
        res.once("finish", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                auditLog("file.downloaded", {
                    ...auditDetails,
                    fileId: file.id,
                    fileName: filename,
                    ownerId: file.user_id ?? null,
                    size: Number(file.size) || 0
                });
            }
        });
    }

    res.sendFile(storedPath);
}

router.post("/upload", requireAuth, handleUpload, async (req, res) => {
    const uploadedFiles = req.files || [];
    try {
        if (uploadedFiles.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Choose at least one file to upload"
            });
        }

        const userId = req.session.user.id;
        const baseFolderId = parseFolderId(req.body.folderId);
        if (Number.isNaN(baseFolderId) || !(await getOwnedFolder(userId, baseFolderId))) {
            uploadedFiles.forEach((file) => fs.unlink(file.path, () => {}));
            return res.status(400).json({ success: false, message: "Destination folder not found" });
        }

        const usage = await getStorageUsage(userId);
        const totalUploadSize = uploadedFiles.reduce((total, file) => total + file.size, 0);

        if (usage.used + totalUploadSize > usage.quota) {
            uploadedFiles.forEach((file) => fs.unlink(file.path, () => {}));
            auditLog("file.upload_failed", {
                ...actorFromRequest(req),
                stage: "quota_check",
                reason: "storage_quota_exceeded",
                fileCount: uploadedFiles.length,
                totalSize: totalUploadSize
            });
            return res.status(413).json({
                success: false,
                message: "Storage quota exceeded. None of the selected files were saved."
            });
        }

        const suppliedPaths = req.body.relativePaths;
        const relativePaths = Array.isArray(suppliedPaths)
            ? suppliedPaths
            : (suppliedPaths ? [suppliedPaths] : []);
        const destinationFolderIds = await Promise.all(uploadedFiles.map((file, index) =>
            ensureUploadFolders(userId, baseFolderId, relativePaths[index])
        ));

        const values = [];
        const tuples = uploadedFiles.map((file, index) => {
            const offset = index * 7;
            values.push(
                userId,
                file.filename,
                safeOriginalName(file.originalname),
                file.path,
                file.mimetype,
                file.size,
                destinationFolderIds[index]
            );
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
        });

        const result = await pool.query(
            `INSERT INTO files
                (user_id, filename, original_filename, storage_path, mime_type, size, folder_id)
             VALUES ${tuples.join(", ")}
             RETURNING id, user_id, original_filename, mime_type, size, folder_id, created_at`,
            values
        );

        const files = result.rows;
        files.forEach((file) => auditLog("file.uploaded", {
            ...actorFromRequest(req),
            fileId: file.id,
            fileName: file.original_filename,
            size: Number(file.size) || 0
        }));

        res.status(201).json({
            success: true,
            message: `${files.length} file${files.length === 1 ? "" : "s"} uploaded successfully`,
            files: files.map((file) => ({
                ...file,
                is_owner: true,
                can_read: true,
                can_write: true,
                can_execute: true
            })),
            file: files[0]
        });
    } catch (error) {
        console.error("Upload error:", error);

        auditLog("file.upload_failed", {
            ...actorFromRequest(req),
            stage: "save",
            errorCode: error.code || error.name || "UPLOAD_ERROR",
            fileCount: uploadedFiles.length
        });

        uploadedFiles.forEach((file) => fs.unlink(file.path, () => {}));

        res.status(500).json({
            success: false,
            message: "File upload failed"
        });
    }
});

router.get("/usage", requireAuth, async (req, res) => {
    try {
        const usage = await getStorageUsage(req.session.user.id);

        res.json({
            success: true,
            used: usage.used,
            quota: usage.quota
        });
    } catch (error) {
        console.error("Storage usage error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load storage usage"
        });
    }
});

router.post("/folders", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const name = validateFolderName(req.body.name);
        const parentId = parseFolderId(req.body.parentId);
        if (!name) return res.status(400).json({ success: false, message: "Enter a valid folder name" });
        if (Number.isNaN(parentId) || !(await getOwnedFolder(userId, parentId))) {
            return res.status(404).json({ success: false, message: "Parent folder not found" });
        }

        const folderId = await findOrCreateFolder(userId, parentId, name);
        auditLog("folder.created", {
            ...actorFromRequest(req),
            folderId,
            folderName: name,
            parentId
        });
        res.status(201).json({ success: true, folder: { id: folderId, name, parent_id: parentId } });
    } catch (error) {
        console.error("Create folder error:", error);
        res.status(500).json({ success: false, message: "Unable to create folder" });
    }
});

router.patch("/folders/:id", requireAuth, async (req, res) => {
    try {
        const name = validateFolderName(req.body?.name);
        if (!name) return res.status(400).json({ success: false, message: "Enter a valid folder name" });
        const result = await pool.query(
            `UPDATE folders SET name = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND user_id = $3
             RETURNING id, name, parent_id, created_at, updated_at`,
            [name, req.params.id, req.session.user.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: "Folder not found" });
        res.json({ success: true, folder: result.rows[0] });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, message: "A folder with that name already exists here" });
        console.error("Rename folder error:", error);
        res.status(500).json({ success: false, message: "Unable to rename folder" });
    }
});

router.post("/folders/:id/share", requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const email = String(req.body?.email || "").trim();
        if (!email) return res.status(400).json({ success: false, message: "User email is required" });
        const folder = await client.query(
            "SELECT id, name FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL",
            [req.params.id, req.session.user.id]
        );
        if (!folder.rows.length) return res.status(404).json({ success: false, message: "Folder not found" });
        const recipient = await client.query("SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)", [email]);
        if (!recipient.rows.length) return res.status(404).json({ success: false, message: "User with this email does not exist" });
        if (Number(recipient.rows[0].id) === Number(req.session.user.id)) {
            return res.status(400).json({ success: false, message: "You cannot share a folder with yourself" });
        }

        await client.query("BEGIN");
        await client.query(
            `INSERT INTO folder_shares (folder_id, shared_with_user_id, can_read, can_write)
             VALUES ($1, $2, TRUE, $3)
             ON CONFLICT (folder_id, shared_with_user_id)
             DO UPDATE SET can_read = TRUE, can_write = EXCLUDED.can_write`,
            [req.params.id, recipient.rows[0].id, req.body?.canWrite === true]
        );
        await client.query("COMMIT");
        auditLog("folder.shared", {
            ...actorFromRequest(req),
            folderId: folder.rows[0].id,
            folderName: folder.rows[0].name,
            recipientId: recipient.rows[0].id,
            recipientEmail: recipient.rows[0].email,
            canWrite: req.body?.canWrite === true
        });
        res.json({
            success: true,
            message: `Folder “${folder.rows[0].name}” is shared with ${recipient.rows[0].email}`
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Share folder contents error:", error);
        res.status(500).json({ success: false, message: "Unable to share folder contents" });
    } finally {
        client.release();
    }
});

router.get("/folders/:id/shares", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT fs.id, u.username, u.email, fs.can_read, fs.can_write, fs.created_at
             FROM folder_shares fs
             JOIN users u ON u.id = fs.shared_with_user_id
             JOIN folders f ON f.id = fs.folder_id
             WHERE fs.folder_id = $1 AND f.user_id = $2
             ORDER BY fs.created_at DESC`,
            [req.params.id, req.session.user.id]
        );
        res.json({ success: true, shares: result.rows });
    } catch (error) {
        console.error("Load folder shares error:", error);
        res.status(500).json({ success: false, message: "Unable to load folder access" });
    }
});

router.delete("/folders/:folderId/share/:shareId", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `DELETE FROM folder_shares fs
             USING folders f
             WHERE fs.id = $1 AND fs.folder_id = $2
               AND f.id = fs.folder_id AND f.user_id = $3
             RETURNING fs.shared_with_user_id`,
            [req.params.shareId, req.params.folderId, req.session.user.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: "Folder access not found" });
        res.json({ success: true, message: "Folder access removed" });
    } catch (error) {
        console.error("Remove folder share error:", error);
        res.status(500).json({ success: false, message: "Unable to remove folder access" });
    }
});

router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const folderId = parseFolderId(req.query.folderId);
        if (Number.isNaN(folderId) || (folderId !== null && !(await getAccessibleFolder(userId, folderId)))) {
            return res.status(404).json({ success: false, message: "Folder not found" });
        }

        const [result, foldersResult, pathResult] = await Promise.all([pool.query(
            `
            SELECT
                f.id,
                f.user_id,
                f.folder_id,
                f.original_filename,
                f.mime_type,
                f.size,
                f.created_at,
                f.updated_at,
                CASE WHEN f.user_id = $1 THEN TRUE ELSE FALSE END AS is_owner,
                CASE WHEN f.user_id = $1 THEN TRUE
                     ELSE COALESCE(fs.can_read, folder_access.can_read, FALSE) END AS can_read,
                CASE WHEN f.user_id = $1 THEN TRUE
                     ELSE COALESCE(fs.can_write, folder_access.can_write, FALSE) END AS can_write,
                CASE WHEN f.user_id = $1 THEN TRUE
                     ELSE COALESCE(fs.can_execute, FALSE) END AS can_execute
            FROM files f
            LEFT JOIN file_shares fs
                ON fs.file_id = f.id
               AND fs.shared_with_user_id = $1
            LEFT JOIN LATERAL (
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id FROM folders WHERE id = f.folder_id AND trashed_at IS NULL
                    UNION ALL
                    SELECT parent.id, parent.parent_id FROM folders parent
                    JOIN ancestors child ON child.parent_id = parent.id
                    WHERE parent.trashed_at IS NULL
                )
                SELECT BOOL_OR(fs.can_read) AS can_read, BOOL_OR(fs.can_write) AS can_write
                FROM folder_shares fs
                WHERE fs.shared_with_user_id = $1 AND fs.folder_id IN (SELECT id FROM ancestors)
            ) folder_access ON TRUE
            WHERE f.trashed_at IS NULL
              AND ((f.user_id = $1 AND f.folder_id IS NOT DISTINCT FROM $2)
                   OR ($2 IS NULL AND fs.shared_with_user_id = $1 AND fs.can_read = TRUE)
                   OR ($2 IS NOT NULL AND f.folder_id = $2
                       AND (f.user_id = $1 OR folder_access.can_read = TRUE OR fs.can_read = TRUE)))
            ORDER BY f.created_at DESC
            `,
            [userId, folderId]
        ), pool.query(
            `SELECT folder.id, folder.name, folder.parent_id, folder.created_at, folder.updated_at,
                    (folder.user_id = $1) AS is_owner,
                    COALESCE((WITH RECURSIVE descendants AS (
                                  SELECT id FROM folders WHERE id = folder.id AND user_id = folder.user_id
                                  UNION ALL
                                  SELECT child.id FROM folders child
                                  JOIN descendants parent ON child.parent_id = parent.id
                                  WHERE child.user_id = folder.user_id
                              )
                              SELECT SUM(file.size) FROM files file
                              JOIN descendants ON descendants.id = file.folder_id
                              WHERE file.trashed_at IS NULL), 0)::bigint AS size
             FROM folders folder
             WHERE folder.trashed_at IS NULL AND (
                   (folder.user_id = $1 AND folder.parent_id IS NOT DISTINCT FROM $2)
                   OR ($2 IS NULL AND EXISTS (
                       SELECT 1 FROM folder_shares fs
                       WHERE fs.folder_id = folder.id AND fs.shared_with_user_id = $1 AND fs.can_read = TRUE
                   ))
                   OR ($2 IS NOT NULL AND folder.parent_id = $2 AND EXISTS (
                       SELECT 1 FROM folders parent WHERE parent.id = $2 AND parent.user_id = folder.user_id
                   ))
             )
             ORDER BY LOWER(folder.name)`,
            [userId, folderId]
        ), folderId === null ? Promise.resolve({ rows: [] }) : pool.query(
            `WITH RECURSIVE ancestors AS (
                 SELECT id, name, parent_id, 0 AS depth
                 FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL
                 SELECT parent.id, parent.name, parent.parent_id, child.depth + 1
                 FROM folders parent JOIN ancestors child ON child.parent_id = parent.id
                 WHERE parent.user_id = $2
             )
             SELECT id, name FROM ancestors ORDER BY depth DESC`,
            [folderId, userId]
        )]);

        res.json({
            success: true,
            files: result.rows.map((row) => toClientFile(row)),
            folders: foldersResult.rows,
            folderPath: pathResult.rows
        });
    } catch (error) {
        console.error("File list error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load files"
        });
    }
});

router.get("/folders/:id/download", requireAuth, async (req, res) => {
    try {
        if (!(await getAccessibleFolder(req.session.user.id, req.params.id))) {
            return res.status(404).json({ success: false, message: "Folder not found" });
        }
        const folderResult = await pool.query(
            "SELECT id, name, user_id FROM folders WHERE id = $1 AND trashed_at IS NULL",
            [req.params.id]
        );
        if (!folderResult.rows.length) return res.status(404).json({ success: false, message: "Folder not found" });

        const filesResult = await pool.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL SELECT child.id FROM folders child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2 AND child.trashed_at IS NULL
             )
             SELECT files.id, files.user_id, files.original_filename, files.storage_path, files.size
             FROM files JOIN descendants ON descendants.id = files.folder_id
             WHERE files.user_id = $2 AND files.trashed_at IS NULL
             ORDER BY files.original_filename`,
            [req.params.id, folderResult.rows[0].user_id]
        );
        const entries = filesResult.rows.map((file) => ({ file, storedPath: resolveStoredPath(file.storage_path) }));
        if (entries.some(({ storedPath }) => !storedPath || !fs.existsSync(storedPath))) {
            return res.status(404).json({ success: false, message: "A file in this folder could not be found" });
        }

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", contentDisposition(`${folderResult.rows[0].name}.zip`, "attachment"));
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.on("warning", (error) => { if (error.code !== "ENOENT") res.destroy(error); });
        archive.on("error", (error) => res.destroy(error));
        archive.pipe(res);
        const nameCounts = new Map();
        for (const { file, storedPath } of entries) {
            const baseName = safeOriginalName(file.original_filename || "download");
            const key = baseName.toLowerCase();
            const count = (nameCounts.get(key) || 0) + 1;
            nameCounts.set(key, count);
            const ext = path.extname(baseName);
            const name = count === 1 ? baseName : `${path.basename(baseName, ext)} (${count})${ext}`;
            archive.file(storedPath, { name });
        }
        res.once("finish", () => {
            for (const { file } of entries) {
                auditLog("file.downloaded", {
                    ...actorFromRequest(req),
                    fileId: file.id,
                    fileName: file.original_filename,
                    ownerId: file.user_id,
                    size: Number(file.size) || 0,
                    source: "folder-archive"
                });
            }
        });
        archive.finalize();
    } catch (error) {
        console.error("Folder archive download error:", error);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Unable to download folder" });
        else res.destroy(error);
    }
});

router.get("/shared", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;

        const result = await pool.query(
            `
            SELECT
                f.id,
                f.user_id,
                f.original_filename,
                f.mime_type,
                f.size,
                f.created_at,
                FALSE AS is_owner,
                fs.can_read,
                fs.can_write,
                fs.can_execute
            FROM file_shares fs
            JOIN files f
                ON f.id = fs.file_id
            WHERE f.trashed_at IS NULL
              AND fs.shared_with_user_id = $1
              AND fs.can_read = TRUE
            ORDER BY f.created_at DESC
            `,
            [userId]
        );

        res.json({
            success: true,
            files: result.rows.map((row) => toClientFile(row))
        });
    } catch (error) {
        console.error("Shared file list error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load shared files"
        });
    }
});

router.get("/trash", requireAuth, async (req, res) => {
    try {
        const [result, foldersResult] = await Promise.all([pool.query(
            `SELECT id, original_filename, mime_type, size, trashed_at
             FROM files
             WHERE user_id = $1 AND trashed_at IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM folders parent
                   WHERE parent.id = files.folder_id AND parent.trashed_at IS NOT NULL
               )
             ORDER BY trashed_at DESC`,
            [req.session.user.id]
        ), pool.query(
            `SELECT folder.id, folder.name, folder.trashed_at,
                    COALESCE((WITH RECURSIVE descendants AS (
                                  SELECT id FROM folders WHERE id = folder.id
                                  UNION ALL SELECT child.id FROM folders child
                                  JOIN descendants parent ON child.parent_id = parent.id
                              )
                              SELECT SUM(file.size) FROM files file
                              JOIN descendants ON descendants.id = file.folder_id
                              WHERE file.trashed_at IS NOT NULL), 0)::bigint AS size
             FROM folders folder
             WHERE folder.user_id = $1 AND folder.trashed_at IS NOT NULL
               AND (folder.parent_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM folders parent
                    WHERE parent.id = folder.parent_id AND parent.trashed_at IS NOT NULL
               ))
             ORDER BY folder.trashed_at DESC`,
            [req.session.user.id]
        )]);
        res.json({ success: true, files: result.rows, folders: foldersResult.rows });
    } catch (error) {
        console.error("Trash list error:", error);
        res.status(500).json({ success: false, message: "Unable to load Trash" });
    }
});

router.patch("/folders/:id/trash", requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const root = await client.query(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL FOR UPDATE",
            [req.params.id, req.session.user.id]
        );
        if (!root.rows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "Folder not found" });
        }
        await client.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL SELECT child.id FROM folders child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2
             )
             UPDATE folders SET trashed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id IN (SELECT id FROM descendants)`,
            [req.params.id, req.session.user.id]
        );
        await client.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL SELECT child.id FROM folders child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2
             )
             UPDATE files SET trashed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $2 AND trashed_at IS NULL AND folder_id IN (SELECT id FROM descendants)`,
            [req.params.id, req.session.user.id]
        );
        await client.query("COMMIT");
        res.json({ success: true, message: "Folder moved to Trash" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Move folder to Trash error:", error);
        res.status(500).json({ success: false, message: "Unable to move folder to Trash" });
    } finally {
        client.release();
    }
});

router.patch("/folders/:id/restore", requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const root = await client.query(
            "SELECT id, trashed_at FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NOT NULL FOR UPDATE",
            [req.params.id, req.session.user.id]
        );
        if (!root.rows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "Folder not found in Trash" });
        }
        await client.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL SELECT child.id FROM folders child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2
             )
             UPDATE folders SET trashed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id IN (SELECT id FROM descendants) AND trashed_at IS NOT DISTINCT FROM $3`,
            [req.params.id, req.session.user.id, root.rows[0].trashed_at]
        );
        await client.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL SELECT child.id FROM folders child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2
             )
             UPDATE files SET trashed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $2 AND trashed_at IS NOT DISTINCT FROM $3
               AND folder_id IN (SELECT id FROM descendants)`,
            [req.params.id, req.session.user.id, root.rows[0].trashed_at]
        );
        await client.query("COMMIT");
        res.json({ success: true, message: "Folder restored" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Restore folder error:", error);
        res.status(500).json({ success: false, message: "Unable to restore folder" });
    } finally {
        client.release();
    }
});

router.get("/public/:token", async (req, res) => {
    try {
        const file = await findPublicFile(req.params.token);

        if (!file) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        res.json({
            success: true,
            file: {
                original_filename: file.original_filename,
                mime_type: file.mime_type,
                size: file.size,
                created_at: file.created_at,
                can_write: file.public_can_write === true,
                can_execute: file.public_can_execute === true
            }
        });
    } catch (error) {
        console.error("Public file error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load file"
        });
    }
});

router.get("/public/:token/preview", async (req, res) => {
    try {
        const file = await findPublicFile(req.params.token);

        if (!file) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        sendStoredFile(res, file, false);
    } catch (error) {
        console.error("Public preview error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to preview file"
        });
    }
});

router.get("/public/:token/download", async (req, res) => {
    try {
        const file = await findPublicFile(req.params.token);

        if (!file) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        sendStoredFile(res, file, true, {
            actorId: null,
            actorUsername: "public-link",
            actorEmail: null,
            ip: req.ip || req.socket?.remoteAddress || "unknown"
        });
    } catch (error) {
        console.error("Public download error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to download file"
        });
    }
});

router.get("/:id/preview", requireAuth, async (req, res) => {
    try {
        const file = await findAccessibleFile(req.params.id, req.session.user.id);

        if (!file) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        if (!file.is_owner && !file.can_read) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to view this file"
            });
        }

        sendStoredFile(res, file, false);
    } catch (error) {
        console.error("Preview error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to preview file"
        });
    }
});

router.get("/:id/download", requireAuth, async (req, res) => {
    try {
        const file = await findAccessibleFile(req.params.id, req.session.user.id);

        if (!file) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        if (!file.is_owner && !file.can_read) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to download this file"
            });
        }

        sendStoredFile(res, file, true, actorFromRequest(req));
    } catch (error) {
        console.error("Download error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to download file"
        });
    }
});

router.patch("/:id/trash", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE files SET trashed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL
             RETURNING id, original_filename`,
            [req.params.id, req.session.user.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: "File not found or already in Trash" });
        }
        auditLog("file.moved_to_trash", {
            ...actorFromRequest(req),
            fileId: result.rows[0].id,
            fileName: result.rows[0].original_filename
        });
        res.json({ success: true, message: "File moved to Trash" });
    } catch (error) {
        console.error("Move file to Trash error:", error);
        res.status(500).json({ success: false, message: "Unable to move file to Trash" });
    }
});

async function findPublicFolder(token) {
    const result = await pool.query(
        `SELECT id, user_id, name, updated_at
         FROM folders
         WHERE public_token = $1 AND public_access = TRUE AND trashed_at IS NULL
         LIMIT 1`,
        [token]
    );
    return result.rows[0] || null;
}

router.get("/public-folder/:token", async (req, res) => {
    try {
        const folder = await findPublicFolder(req.params.token);
        if (!folder) return res.status(404).json({ success: false, message: "Folder not found" });
        const files = await pool.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id, name, parent_id, 0 AS depth FROM folders
                 WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL
                 UNION ALL
                 SELECT child.id, child.name, child.parent_id, parent.depth + 1
                 FROM folders child JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2 AND child.trashed_at IS NULL
             ), paths AS (
                 SELECT id, name, parent_id, name::text AS relative_path FROM descendants WHERE id = $1
                 UNION ALL
                 SELECT child.id, child.name, child.parent_id,
                        paths.relative_path || '/' || child.name
                 FROM descendants child JOIN paths ON child.parent_id = paths.id
             )
             SELECT f.id, f.original_filename, f.mime_type, f.size, f.updated_at,
                    COALESCE((SELECT p.relative_path FROM paths p WHERE p.id = f.folder_id), '') AS folder_path
             FROM files f JOIN descendants d ON d.id = f.folder_id
             WHERE f.user_id = $2 AND f.trashed_at IS NULL
             ORDER BY folder_path, f.original_filename`,
            [folder.id, folder.user_id]
        );
        res.json({ success: true, folder: { name: folder.name, updated_at: folder.updated_at }, files: files.rows });
    } catch (error) {
        console.error("Public folder error:", error);
        res.status(500).json({ success: false, message: "Unable to load folder" });
    }
});

router.get("/public-folder/:token/download", async (req, res) => {
    try {
        const folder = await findPublicFolder(req.params.token);
        if (!folder) return res.status(404).json({ success: false, message: "Folder not found" });
        const files = await pool.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id, parent_id, name, name::text AS relative_path FROM folders
                 WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL
                 UNION ALL SELECT child.id, child.parent_id, child.name,
                                descendants.relative_path || '/' || child.name
                 FROM folders child JOIN descendants ON child.parent_id = descendants.id
                 WHERE child.user_id = $2 AND child.trashed_at IS NULL
             )
             SELECT f.id, f.user_id, f.original_filename, f.storage_path, f.size, f.folder_id,
                    d.relative_path AS folder_path
             FROM files f JOIN descendants d ON d.id = f.folder_id
             WHERE f.user_id = $2 AND f.trashed_at IS NULL ORDER BY f.id`,
            [folder.id, folder.user_id]
        );
        const entries = files.rows.map((file) => ({ file, storedPath: resolveStoredPath(file.storage_path) }));
        if (entries.some(({ storedPath }) => !storedPath || !fs.existsSync(storedPath))) {
            return res.status(404).json({ success: false, message: "A file in this folder could not be found" });
        }
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", contentDisposition(`${folder.name}.zip`, "attachment"));
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.on("warning", (error) => { if (error.code !== "ENOENT") res.destroy(error); });
        archive.on("error", (error) => res.destroy(error));
        archive.pipe(res);
        for (const { file, storedPath } of entries) {
            const prefix = file.folder_path === folder.name ? "" : `${file.folder_path.slice(folder.name.length + 1)}/`;
            archive.file(storedPath, { name: `${prefix}${safeOriginalName(file.original_filename || "download")}` });
        }
        archive.finalize();
    } catch (error) {
        console.error("Public folder download error:", error);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Unable to download folder" });
        else res.destroy(error);
    }
});

router.get("/folders/:id/general-access", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT public_access, public_token FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL`,
            [req.params.id, req.session.user.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: "Folder not found" });
        res.json({ success: true, generalAccess: { enabled: result.rows[0].public_access, token: result.rows[0].public_token } });
    } catch (error) {
        console.error("Get folder general access error:", error);
        res.status(500).json({ success: false, message: "Unable to load general access" });
    }
});

router.patch("/folders/:id/general-access", requireAuth, async (req, res) => {
    try {
        const enabled = Boolean(req.body.publicAccess ?? req.body.enabled);
        const current = await pool.query(
            `SELECT public_token FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NULL`,
            [req.params.id, req.session.user.id]
        );
        if (!current.rows.length) return res.status(404).json({ success: false, message: "Folder not found" });
        const token = enabled ? (current.rows[0].public_token || crypto.randomBytes(32).toString("hex")) : null;
        await pool.query(
            `UPDATE folders SET public_access = $1, public_token = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND user_id = $4`,
            [enabled, token, req.params.id, req.session.user.id]
        );
        auditLog("folder.public_access_changed", { ...actorFromRequest(req), folderId: req.params.id, enabled });
        res.json({ success: true, generalAccess: { enabled, token } });
    } catch (error) {
        console.error("Folder general access error:", error);
        res.status(500).json({ success: false, message: "Unable to update general access" });
    }
});

router.patch("/:id/rename", requireAuth, async (req, res) => {
    try {
        const name = safeOriginalName(req.body?.name);
        if (!name || name === "file") return res.status(400).json({ success: false, message: "Enter a valid file name" });
        const result = await pool.query(
            `UPDATE files f SET original_filename = $1, updated_at = CURRENT_TIMESTAMP
             WHERE f.id = $2 AND f.trashed_at IS NULL
               AND (f.user_id = $3 OR EXISTS (
                    SELECT 1 FROM file_shares fs
                    WHERE fs.file_id = f.id AND fs.shared_with_user_id = $3 AND fs.can_write = TRUE
               ) OR EXISTS (
                    WITH RECURSIVE ancestors AS (
                        SELECT id, parent_id FROM folders WHERE id = f.folder_id AND trashed_at IS NULL
                        UNION ALL
                        SELECT parent.id, parent.parent_id FROM folders parent
                        JOIN ancestors child ON child.parent_id = parent.id
                        WHERE parent.trashed_at IS NULL
                    )
                    SELECT 1 FROM folder_shares fs
                    WHERE fs.shared_with_user_id = $3 AND fs.can_write = TRUE
                      AND fs.folder_id IN (SELECT id FROM ancestors)
               ))
             RETURNING f.id, f.original_filename, f.size, f.mime_type, f.updated_at`,
            [name, req.params.id, req.session.user.id]
        );
        if (!result.rows.length) return res.status(404).json({ success: false, message: "File not found or you cannot modify it" });
        res.json({ success: true, file: result.rows[0] });
    } catch (error) {
        console.error("Rename file error:", error);
        res.status(500).json({ success: false, message: "Unable to rename file" });
    }
});

router.get("/download-archive", requireAuth, async (req, res) => {
    try {
        const ids = typeof req.query.ids === "string"
            ? [...new Set(req.query.ids.split(",").filter((id) => /^\d+$/.test(id)))].slice(0, 100)
            : [];
        if (!ids.length) {
            return res.status(400).json({ success: false, message: "Select at least one file to download" });
        }

        const files = await Promise.all(ids.map((id) => findAccessibleFile(id, req.session.user.id)));
        if (files.some((file) => !file || (!file.is_owner && !file.can_read))) {
            return res.status(403).json({ success: false, message: "One or more files cannot be downloaded" });
        }

        const entries = files.map((file) => ({ file, storedPath: resolveStoredPath(file.storage_path) }));
        if (entries.some(({ storedPath }) => !storedPath || !fs.existsSync(storedPath))) {
            return res.status(404).json({ success: false, message: "One or more physical files were not found" });
        }

        res.status(200);
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", contentDisposition("my-drive-files.zip", "attachment"));
        const archive = new ZipArchive({ zlib: { level: 6 } });
        archive.on("warning", (error) => {
            if (error.code !== "ENOENT") res.destroy(error);
        });
        archive.on("error", (error) => res.destroy(error));
        archive.pipe(res);

        const nameCounts = new Map();
        for (const { file, storedPath } of entries) {
            const baseName = safeOriginalName(file.original_filename || "download");
            const count = (nameCounts.get(baseName.toLowerCase()) || 0) + 1;
            nameCounts.set(baseName.toLowerCase(), count);
            const ext = path.extname(baseName);
            const archiveName = count === 1 ? baseName : `${path.basename(baseName, ext)} (${count})${ext}`;
            archive.file(storedPath, { name: archiveName });
        }
        res.once("finish", () => {
            for (const { file } of entries) {
                auditLog("file.downloaded", {
                    ...actorFromRequest(req),
                    fileId: file.id,
                    fileName: file.original_filename,
                    ownerId: file.user_id ?? null,
                    size: Number(file.size) || 0
                });
            }
        });
        archive.finalize();
    } catch (error) {
        console.error("Archive download error:", error);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Unable to download selected files" });
        else res.destroy(error);
    }
});

router.patch("/:id/restore", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE files SET trashed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2 AND trashed_at IS NOT NULL
             RETURNING id, original_filename`,
            [req.params.id, req.session.user.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: "File not found in Trash" });
        }
        auditLog("file.restored", {
            ...actorFromRequest(req),
            fileId: result.rows[0].id,
            fileName: result.rows[0].original_filename
        });
        res.json({ success: true, message: "File restored" });
    } catch (error) {
        console.error("Restore file error:", error);
        res.status(500).json({ success: false, message: "Unable to restore file" });
    }
});

router.delete("/trash", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, original_filename, storage_path
             FROM files
             WHERE user_id = $1 AND trashed_at IS NOT NULL`,
            [req.session.user.id]
        );

        let deletedCount = 0;
        let failedCount = 0;
        for (const file of result.rows) {
            try {
                const storedPath = resolveStoredPath(file.storage_path);
                if (!storedPath) throw new Error("Stored path is outside the storage directory");

                try {
                    await fs.promises.unlink(storedPath);
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }

                const deleted = await pool.query(
                    `DELETE FROM files
                     WHERE id = $1 AND user_id = $2 AND trashed_at IS NOT NULL
                     RETURNING id`,
                    [file.id, req.session.user.id]
                );
                if (!deleted.rows.length) continue;

                deletedCount += 1;
                auditLog("file.deleted_permanently", {
                    ...actorFromRequest(req),
                    fileId: file.id,
                    fileName: file.original_filename,
                    source: "empty_trash"
                });
            } catch (error) {
                failedCount += 1;
                console.error("Empty Trash file cleanup error:", error);
                auditLog("file.permanent_delete_failed", {
                    ...actorFromRequest(req),
                    fileId: file.id,
                    fileName: file.original_filename,
                    source: "empty_trash",
                    errorCode: error.code || error.name || "DELETE_ERROR"
                });
            }
        }

        try {
            const removedFolders = await pool.query(
                `DELETE FROM folders folder
                 WHERE folder.user_id = $1 AND folder.trashed_at IS NOT NULL
                   AND (folder.parent_id IS NULL OR NOT EXISTS (
                       SELECT 1 FROM folders parent
                       WHERE parent.id = folder.parent_id AND parent.trashed_at IS NOT NULL
                   ))
                 RETURNING id`,
                [req.session.user.id]
            );
            deletedCount += removedFolders.rowCount;
        } catch (error) {
            failedCount += 1;
            console.error("Empty Trash folder cleanup error:", error);
        }

        res.status(failedCount ? 500 : 200).json({
            success: failedCount === 0,
            deletedCount,
            failedCount,
            message: failedCount
                ? `${deletedCount} file${deletedCount === 1 ? "" : "s"} deleted; ${failedCount} could not be removed and remain in Trash.`
                : `${deletedCount} file${deletedCount === 1 ? "" : "s"} permanently deleted`
        });
    } catch (error) {
        console.error("Empty Trash error:", error);
        res.status(500).json({ success: false, message: "Unable to empty Trash" });
    }
});

router.delete("/folders/:id", requireAuth, async (req, res) => {
    const client = await pool.connect();
    let storedFiles = [];
    try {
        await client.query("BEGIN");
        const root = await client.query(
            "SELECT id FROM folders WHERE id = $1 AND user_id = $2 AND trashed_at IS NOT NULL FOR UPDATE",
            [req.params.id, req.session.user.id]
        );
        if (!root.rows.length) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "Folder not found in Trash" });
        }
        const files = await client.query(
            `WITH RECURSIVE descendants AS (
                 SELECT id FROM folders WHERE id = $1 AND user_id = $2
                 UNION ALL SELECT child.id FROM folders child
                 JOIN descendants parent ON child.parent_id = parent.id
                 WHERE child.user_id = $2
             )
             DELETE FROM files
             WHERE user_id = $2 AND folder_id IN (SELECT id FROM descendants)
             RETURNING storage_path`,
            [req.params.id, req.session.user.id]
        );
        storedFiles = files.rows;
        await client.query("DELETE FROM folders WHERE id = $1 AND user_id = $2", [req.params.id, req.session.user.id]);
        await client.query("COMMIT");
        for (const file of storedFiles) {
            const storedPath = resolveStoredPath(file.storage_path);
            if (storedPath) await fs.promises.unlink(storedPath).catch((error) => {
                if (error.code !== "ENOENT") console.error("Permanent folder delete cleanup error:", error);
            });
        }
        res.json({ success: true, message: "Folder permanently deleted" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Permanent folder deletion error:", error);
        res.status(500).json({ success: false, message: "Unable to permanently delete folder" });
    } finally {
        client.release();
    }
});

router.delete("/:id", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `DELETE FROM files
             WHERE id = $1 AND user_id = $2 AND trashed_at IS NOT NULL
             RETURNING storage_path, original_filename, id`,
            [req.params.id, req.session.user.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ success: false, message: "File not found in Trash" });
        }
        const file = result.rows[0];
        const storedPath = resolveStoredPath(file.storage_path);
        if (storedPath) fs.unlink(storedPath, () => {});
        auditLog("file.deleted_permanently", {
            ...actorFromRequest(req),
            fileId: file.id,
            fileName: file.original_filename
        });
        res.json({ success: true, message: "File permanently deleted" });
    } catch (error) {
        console.error("Permanent file deletion error:", error);
        res.status(500).json({ success: false, message: "Unable to permanently delete file" });
    }
});

router.post("/:id/share", requireAuth, async (req, res) => {
    try {
        const fileId = req.params.id;
        const ownerId = req.session.user.id;
        const { email, canRead, canWrite, canExecute } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "User email is required"
            });
        }

        const fileResult = await pool.query(
            `
            SELECT id, original_filename
            FROM files
            WHERE id = $1
              AND user_id = $2
            `,
            [fileId, ownerId]
        );

        if (fileResult.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "Only the file owner can share this file"
            });
        }

        const userResult = await pool.query(
            `
            SELECT id, username, email
            FROM users
            WHERE LOWER(email) = LOWER($1)
            `,
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User with this email does not exist"
            });
        }

        const recipient = userResult.rows[0];

        if (Number(recipient.id) === Number(ownerId)) {
            return res.status(400).json({
                success: false,
                message: "You cannot share a file with yourself"
            });
        }

        const result = await pool.query(
            `
            INSERT INTO file_shares
            (
                file_id,
                shared_with_user_id,
                can_read,
                can_write,
                can_execute
            )
            VALUES
            ($1, $2, $3, $4, $5)
            ON CONFLICT (file_id, shared_with_user_id)
            DO UPDATE SET
                can_read = EXCLUDED.can_read,
                can_write = EXCLUDED.can_write,
                can_execute = EXCLUDED.can_execute
            RETURNING
                id,
                file_id,
                shared_with_user_id,
                can_read,
                can_write,
                can_execute,
                created_at
            `,
            [
                fileId,
                recipient.id,
                canRead !== false,
                canWrite === true,
                canExecute === true
            ]
        );

        auditLog("file.shared", {
            ...actorFromRequest(req),
            fileId: fileId,
            fileName: fileResult.rows[0].original_filename,
            recipientId: recipient.id,
            recipientEmail: recipient.email,
            canRead: canRead !== false,
            canWrite: canWrite === true,
            canExecute: canExecute === true
        });

        res.json({
            success: true,
            message: `File shared with ${recipient.email}`,
            share: result.rows[0]
        });
    } catch (error) {
        console.error("Share error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to share file"
        });
    }
});

router.get("/:id/shares", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                fs.id,
                u.username,
                u.email,
                fs.can_read,
                fs.can_write,
                fs.can_execute,
                fs.created_at
            FROM file_shares fs
            JOIN users u
                ON u.id = fs.shared_with_user_id
            JOIN files f
                ON f.id = fs.file_id
            WHERE fs.file_id = $1
              AND f.user_id = $2
            ORDER BY fs.created_at DESC
            `,
            [req.params.id, req.session.user.id]
        );

        res.json({
            success: true,
            shares: result.rows
        });
    } catch (error) {
        console.error("List shares error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load shares"
        });
    }
});

router.delete("/:fileId/share/:shareId", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `
            DELETE FROM file_shares fs
            USING files f
            WHERE fs.id = $1
              AND fs.file_id = $2
              AND f.id = fs.file_id
              AND f.user_id = $3
            RETURNING fs.id, fs.shared_with_user_id
            `,
            [req.params.shareId, req.params.fileId, req.session.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Share not found"
            });
        }

        auditLog("file.share_removed", {
            ...actorFromRequest(req),
            fileId: req.params.fileId,
            shareId: result.rows[0].id,
            recipientId: result.rows[0].shared_with_user_id
        });

        res.json({
            success: true,
            message: "File share removed"
        });
    } catch (error) {
        console.error("Remove share error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to remove share"
        });
    }
});

router.get("/:id/general-access", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                public_access,
                public_can_write,
                public_can_execute,
                public_token
            FROM files
            WHERE id = $1
              AND user_id = $2
            `,
            [req.params.id, req.session.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        const file = result.rows[0];

        res.json({
            success: true,
            generalAccess: {
                enabled: file.public_access === true,
                canWrite: file.public_can_write === true,
                canExecute: file.public_can_execute === true,
                token: file.public_token || null
            }
        });
    } catch (error) {
        console.error("Get general access error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to load general access"
        });
    }
});

router.patch("/:id/general-access", requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const publicAccess = Boolean(
            req.body.publicAccess ?? req.body.enabled
        );
        const publicCanWrite = Boolean(
            req.body.publicCanWrite ?? req.body.canWrite
        );
        const publicCanExecute = Boolean(
            req.body.publicCanExecute ?? req.body.canExecute
        );

        const ownerResult = await pool.query(
            `
            SELECT id, public_token
            FROM files
            WHERE id = $1
              AND user_id = $2
            `,
            [req.params.id, userId]
        );

        if (ownerResult.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: "Only the file owner can change general access"
            });
        }

        let publicToken = ownerResult.rows[0].public_token;

        if (publicAccess && !publicToken) {
            publicToken = crypto.randomBytes(32).toString("hex");
        }

        if (!publicAccess) {
            publicToken = null;
        }

        const result = await pool.query(
            `
            UPDATE files
            SET
                public_access = $1,
                public_can_write = $2,
                public_can_execute = $3,
                public_token = $4,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
              AND user_id = $6
            RETURNING
                public_access,
                public_can_write,
                public_can_execute,
                public_token
            `,
            [
                publicAccess,
                publicAccess && publicCanWrite,
                publicAccess && publicCanExecute,
                publicToken,
                req.params.id,
                userId
            ]
        );

        const file = result.rows[0];

        auditLog("file.public_access_changed", {
            ...actorFromRequest(req),
            fileId: req.params.id,
            enabled: file.public_access,
            canWrite: file.public_can_write,
            canExecute: file.public_can_execute
        });

        res.json({
            success: true,
            message: publicAccess
                ? "Anyone with the link can access this file."
                : "File is now restricted.",
            generalAccess: {
                enabled: file.public_access,
                canWrite: file.public_can_write,
                canExecute: file.public_can_execute,
                token: file.public_token
            }
        });
    } catch (error) {
        console.error("General access error:", error);
        res.status(500).json({
            success: false,
            message: "Unable to update general access"
        });
    }
});

module.exports = router;
