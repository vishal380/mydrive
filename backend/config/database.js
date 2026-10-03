const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

const storageRoot = path.resolve(
    process.env.STORAGE_PATH ||
    path.join(__dirname, "..", "storage")
);

process.env.STORAGE_PATH = storageRoot;
fs.mkdirSync(storageRoot, { recursive: true });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

pool.on("connect", () => {
    console.log("PostgreSQL connected");
});

pool.on("error", (err) => {
    console.error("PostgreSQL error:", err);
});

async function ensureDatabaseSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) NOT NULL UNIQUE,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'user',
            storage_quota BIGINT NOT NULL DEFAULT 10737418240,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS session (
            sid VARCHAR(255) PRIMARY KEY,
            sess JSON NOT NULL,
            expire TIMESTAMP(6) NOT NULL
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS password_reset_otps (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            otp_hash TEXT NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            used BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS folders (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
            name VARCHAR(150) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            trashed_at TIMESTAMP WITH TIME ZONE,
            public_access BOOLEAN NOT NULL DEFAULT FALSE,
            public_token VARCHAR(255)
        );
    `);

    await pool.query(`
        ALTER TABLE folders
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS public_access BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS public_token VARCHAR(255);
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_root_name
        ON folders(user_id, LOWER(name))
        WHERE parent_id IS NULL;
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_parent_name
        ON folders(user_id, parent_id, LOWER(name))
        WHERE parent_id IS NOT NULL;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS registration_otps (
            email VARCHAR(255) PRIMARY KEY,
            otp_hash TEXT NOT NULL,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS files (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            filename VARCHAR(255) NOT NULL,
            original_filename VARCHAR(255) NOT NULL,
            storage_path TEXT NOT NULL,
            mime_type VARCHAR(255),
            size BIGINT NOT NULL DEFAULT 0,
            public_access BOOLEAN NOT NULL DEFAULT FALSE,
            public_can_write BOOLEAN NOT NULL DEFAULT FALSE,
            public_can_execute BOOLEAN NOT NULL DEFAULT FALSE,
            public_token VARCHAR(255),
            trashed_at TIMESTAMP WITH TIME ZONE,
            folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS file_shares (
            id SERIAL PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            can_read BOOLEAN NOT NULL DEFAULT TRUE,
            can_write BOOLEAN NOT NULL DEFAULT FALSE,
            can_execute BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(file_id, shared_with_user_id)
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS folder_shares (
            id SERIAL PRIMARY KEY,
            folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            can_read BOOLEAN NOT NULL DEFAULT TRUE,
            can_write BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(folder_id, shared_with_user_id)
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_files_user_id
        ON files(user_id);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_password_reset_otps_user_id
        ON password_reset_otps(user_id);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_file_shares_file_id
        ON file_shares(file_id);
    `);

    await pool.query(`
        ALTER TABLE files
            ADD COLUMN IF NOT EXISTS public_access BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS public_can_write BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS public_can_execute BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS public_token VARCHAR(255),
            ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_files_public_token
        ON files(public_token)
        WHERE public_token IS NOT NULL;
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_public_token
        ON folders(public_token)
        WHERE public_token IS NOT NULL;
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_session_expire
        ON session(expire);
    `);

    console.log("Database schema ensured");
}

pool.ensureDatabaseSchema = ensureDatabaseSchema;
module.exports = pool;
