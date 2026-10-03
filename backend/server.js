require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const cors = require("cors");
const crypto = require("crypto");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);

const transporter = require("./config/mail");
const pool = require("./config/database");

const requireAuth =
    require("./middleware/authMiddleware");

const fileRoutes =
    require("./routes/files");

const {
    allowAttempt,
    isValidEmail,
    hashOtp,
    otpsEqual,
    clientKey
} = require("./utils/security");
const { auditLog, actorFromRequest } = require("./utils/audit");

const app = express();

if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required");
}

const storageRoot = path.resolve(
    process.env.STORAGE_PATH ||
    path.join(__dirname, "storage")
);

process.env.STORAGE_PATH = storageRoot;
fs.mkdirSync(storageRoot, { recursive: true });

pool.ensureDatabaseSchema?.().catch((error) => {
    console.error("Database initialization failed:", error);
});


// ========================================
// CONFIGURATION
// ========================================

const PORT = process.env.PORT || 3000;

const frontendPath =
    path.join(__dirname, "../frontend");


// ========================================
// BASIC MIDDLEWARE
// ========================================

app.use(helmet());

const allowedOrigins = String(process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

function isAllowedOrigin(origin, req) {
    let parsedOrigin;
    try {
        parsedOrigin = new URL(origin);
    } catch {
        return false;
    }

    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
        return false;
    }

    const isLocalhost =
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    const isConfiguredOrigin = allowedOrigins.some((allowedOrigin) => {
        try {
            return new URL(allowedOrigin).origin === parsedOrigin.origin;
        } catch {
            return false;
        }
    });
    const requestHost = req.get("host");
    const isSameHost = requestHost &&
        parsedOrigin.host.toLowerCase() === requestHost.toLowerCase();

    return Boolean(isLocalhost || isConfiguredOrigin || isSameHost);
}

// The app serves its own frontend, so same-origin requests should work on
// localhost and through a tunnel. Separate frontends still need an exact
// FRONTEND_ORIGIN allowlist entry.
app.use((req, res, next) => {
    const origin = req.get("Origin");
    if (origin && !isAllowedOrigin(origin, req)) {
        return res.status(403).json({
            success: false,
            message: "Origin not allowed"
        });
    }
    next();
});

app.use(cors({ origin: true, credentials: true }));

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);


// ========================================
// SESSION
// IMPORTANT:
// Session MUST come before protected routes
// ========================================

app.use(
    session({

        store: new pgSession({
            pool: pool,
            tableName: "session"
        }),

        secret: process.env.SESSION_SECRET,

        resave: false,

        saveUninitialized: false,

        cookie: {
            httpOnly: true,

            secure:
                process.env.COOKIE_SECURE === "true" ||
                process.env.NODE_ENV === "production",

            sameSite: "lax",

            maxAge:
                1000 *
                60 *
                60 *
                24
        }

    })
);


// ========================================
// SERVE FRONTEND
// ========================================

app.use(
    express.static(frontendPath)
);


// ========================================
// FILE ROUTES
// IMPORTANT:
// This MUST be AFTER session middleware
// ========================================

app.use(
    "/api/files",
    fileRoutes
);


// ========================================
// HOME
// ========================================

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            frontendPath,
            "index.html"
        )
    );

});

app.get("/shared/:token", (req, res) => {

    res.sendFile(
        path.join(
            frontendPath,
            "shared.html"
        )
    );

});


// ========================================
// DATABASE HEALTH CHECK
// ========================================

app.get(
    "/api/health",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    "SELECT NOW()"
                );

            res.json({

                status: "OK",

                message:
                    "MyDrive server is running",

                database:
                    "PostgreSQL connected",

                time:
                    result.rows[0].now

            });

        } catch (error) {

            console.error(
                "Database error:",
                error
            );

            res.status(500).json({

                status: "ERROR",

                message:
                    "Database connection failed"

            });

        }

    }
);


// ========================================
// REGISTER
// ========================================

app.post("/api/auth/register/send-otp", async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, message: "A valid email address is required" });
        }

        if (!allowAttempt(`register-otp:${clientKey(req)}`, { max: 8 }) ||
            !allowAttempt(`register-otp-email:${email}`, { max: 3 })) {
            return res.status(429).json({ success: false, message: "Too many verification requests. Try again later." });
        }

        const existingUser = await pool.query(
            "SELECT id FROM users WHERE LOWER(email) = $1",
            [email]
        );
        if (existingUser.rows.length) {
            return res.status(409).json({ success: false, message: "An account with this email already exists" });
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        await pool.query(
            `INSERT INTO registration_otps (email, otp_hash, expires_at, attempts)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (email) DO UPDATE SET
                otp_hash = EXCLUDED.otp_hash,
                expires_at = EXCLUDED.expires_at,
                attempts = 0,
                created_at = CURRENT_TIMESTAMP`,
            [email, hashOtp(otp), new Date(Date.now() + 10 * 60 * 1000)]
        );

        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to: email,
            subject: "MyDrive email verification code",
            text: `Your MyDrive registration verification code is ${otp}. It expires in 10 minutes.`
        });

        res.json({ success: true, message: "Verification code sent. Check your email." });
    } catch (error) {
        console.error("Registration OTP error:", error);
        res.status(500).json({ success: false, message: "Unable to send verification code" });
    }
});

app.post(
    "/api/auth/register",
    async (req, res) => {

        try {

            const username =
                String(req.body.username || "").trim();

            const email =
                String(req.body.email || "").trim().toLowerCase();

            const password =
                req.body.password;

            const otp =
                String(req.body.otp || "").trim();


            if (
                !username ||
                !email ||
                !password ||
                !otp
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Username, email, password and verification code are required"

                });

            }

            if (!isValidEmail(email)) {

                return res.status(400).json({

                    success: false,

                    message:
                        "A valid email address is required"

                });

            }

            if (!/^\d{6}$/.test(otp)) {
                return res.status(400).json({
                    success: false,
                    message: "Enter the 6-digit verification code"
                });
            }


            // --------------------------------
            // Validate username
            // --------------------------------

            if (username.length < 3) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Username must be at least 3 characters"

                });

            }


            // --------------------------------
            // Validate password
            // --------------------------------

            if (password.length < 8) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Password must be at least 8 characters"

                });

            }


            // --------------------------------
            // Check existing user
            // --------------------------------

            const existingUser =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE username = $1
                       OR email = $2
                    `,
                    [
                        username,
                        email
                    ]
                );


            if (
                existingUser.rows.length > 0
            ) {

                return res.status(409).json({

                    success: false,

                    message:
                        "Username or email already exists"

                });

            }

            const otpResult = await pool.query(
                `SELECT otp_hash, expires_at, attempts
                 FROM registration_otps
                 WHERE email = $1`,
                [email]
            );
            const registrationOtp = otpResult.rows[0];
            if (!registrationOtp || new Date(registrationOtp.expires_at) <= new Date() || registrationOtp.attempts >= 5) {
                return res.status(400).json({ success: false, message: "Verification code is missing or expired. Request a new code." });
            }
            if (!otpsEqual(registrationOtp.otp_hash, otp)) {
                await pool.query(
                    "UPDATE registration_otps SET attempts = attempts + 1 WHERE email = $1",
                    [email]
                );
                return res.status(400).json({ success: false, message: "Invalid verification code" });
            }


            // --------------------------------
            // Hash password
            // --------------------------------

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );


            // --------------------------------
            // Insert user
            // --------------------------------

            const result =
                await pool.query(
                    `
                    INSERT INTO users
                    (
                        username,
                        email,
                        password_hash
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3
                    )
                    RETURNING
                        id,
                        username,
                        email,
                        role,
                        storage_quota,
                        created_at
                    `,
                    [
                        username,
                        email,
                        passwordHash
                    ]
                );


            const user =
                result.rows[0];

            await pool.query("DELETE FROM registration_otps WHERE email = $1", [email]);

            auditLog("auth.registration_succeeded", {
                userId: user.id,
                username: user.username,
                email: user.email,
                ip: clientKey(req)
            });


            // --------------------------------
            // Create storage folder
            // --------------------------------

            const storagePath =
                path.join(
                    process.env.STORAGE_PATH,
                    "users",
                    String(user.id)
                );


            fs.mkdirSync(
                storagePath,
                {
                    recursive: true
                }
            );


            console.log(
                "User storage created:",
                storagePath
            );


            // --------------------------------
            // Response
            // --------------------------------

            res.status(201).json({

                success: true,

                message:
                    "Registration successful",

                user: {

                    id: user.id,

                    username:
                        user.username,

                    email:
                        user.email,

                    role:
                        user.role,

                    storage_quota:
                        user.storage_quota,

                    created_at:
                        user.created_at

                }

            });

        } catch (error) {

            console.error(
                "Registration error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Internal server error"

            });

        }

    }
);


// ========================================
// FORGOT PASSWORD
// SEND OTP
// ========================================

app.post(
    "/api/auth/forgot-password",
    async (req, res) => {

        try {

            const email =
                String(req.body.email || "").trim().toLowerCase();

            if (!email || !isValidEmail(email)) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email is required"

                });

            }

            if (
                !allowAttempt(
                    `forgot:${clientKey(req)}`,
                    { max: 8 }
                ) ||
                !allowAttempt(
                    `forgot-email:${email}`,
                    { max: 3 }
                )
            ) {

                return res.status(429).json({

                    success: false,

                    message:
                        "Too many password reset requests. Try again later."

                });

            }


            // --------------------------------
            // Find user
            // --------------------------------

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email
                    FROM users
                    WHERE LOWER(email) = $1
                    `,
                    [email]
                );


            // Don't reveal whether email exists
            if (
                result.rows.length === 0
            ) {

                return res.json({

                    success: true,

                    message:
                        "If the email exists, an OTP has been sent."

                });

            }


            const user =
                result.rows[0];


            // --------------------------------
            // Generate OTP
            // --------------------------------

            const otp =
                crypto
                    .randomInt(
                        100000,
                        1000000
                    )
                    .toString();


            // --------------------------------
            // Hash OTP
            // --------------------------------

            const otpHash = hashOtp(otp);


            // --------------------------------
            // Expiration
            // --------------------------------

            const expiresAt =
                new Date(
                    Date.now() +
                    10 * 60 * 1000
                );


            // --------------------------------
            // Invalidate old OTPs
            // --------------------------------

            await pool.query(
                `
                UPDATE password_reset_otps
                SET used = TRUE
                WHERE user_id = $1
                  AND used = FALSE
                `,
                [user.id]
            );


            // --------------------------------
            // Save OTP
            // --------------------------------

            await pool.query(
                `
                INSERT INTO password_reset_otps
                (
                    user_id,
                    otp_hash,
                    expires_at
                )
                VALUES
                (
                    $1,
                    $2,
                    $3
                )
                `,
                [
                    user.id,
                    otpHash,
                    expiresAt
                ]
            );


            // --------------------------------
            // Send email
            // --------------------------------

            await transporter.sendMail({

                from:
                    process.env.EMAIL_FROM,

                to:
                    user.email,

                subject:
                    "MyDrive Password Reset OTP",

                text:
`Hello ${user.username},

Your MyDrive password reset OTP is:

${otp}

This OTP will expire in 10 minutes.

If you did not request a password reset, please ignore this email.

MyDrive`

            });


            console.log(
                `Password reset OTP sent to ${user.email}`
            );


            res.json({

                success: true,

                message:
                    "If the email exists, an OTP has been sent."

            });

        } catch (error) {

            console.error(
                "Forgot password error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Unable to process password reset"

            });

        }

    }
);


// ========================================
// VERIFY OTP
// ========================================

app.post(
    "/api/auth/verify-otp",
    async (req, res) => {

        try {

            const {
                email: rawEmail,
                otp
            } = req.body;

            const email =
                String(rawEmail || "").trim().toLowerCase();


            if (
                !email ||
                !otp
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email and OTP are required"

                });

            }

            if (
                !allowAttempt(
                    `otp:${clientKey(req)}:${email}`,
                    { max: 15 }
                )
            ) {

                return res.status(429).json({

                    success: false,

                    message:
                        "Too many OTP attempts"

                });

            }


            // --------------------------------
            // Find user
            // --------------------------------

            const userResult =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(email) = $1
                    `,
                    [email]
                );


            if (
                userResult.rows.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid OTP"

                });

            }


            const userId =
                userResult.rows[0].id;


            // --------------------------------
            // Hash submitted OTP
            // --------------------------------

            const otpResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        otp_hash,
                        attempts
                    FROM password_reset_otps
                    WHERE user_id = $1
                      AND used = FALSE
                      AND expires_at > CURRENT_TIMESTAMP
                    ORDER BY created_at DESC
                    LIMIT 1
                    `,
                    [userId]
                );


            if (
                otpResult.rows.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid or expired OTP"

                });

            }


            const otpRecord =
                otpResult.rows[0];


            if (
                otpRecord.attempts >= 5
            ) {

                return res.status(429).json({

                    success: false,

                    message:
                        "Too many OTP attempts"

                });

            }


            if (
                !otpsEqual(
                    otpRecord.otp_hash,
                    otp
                )
            ) {

                await pool.query(
                    `
                    UPDATE password_reset_otps
                    SET attempts = attempts + 1
                    WHERE id = $1
                    `,
                    [otpRecord.id]
                );

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid or expired OTP"

                });

            }


            res.json({

                success: true,

                message:
                    "OTP verified successfully"

            });

        } catch (error) {

            console.error(
                "OTP verification error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "OTP verification failed"

            });

        }

    }
);


// ========================================
// RESET PASSWORD
// ========================================

app.post(
    "/api/auth/reset-password",
    async (req, res) => {

        try {

            const email =
                String(req.body.email || "").trim().toLowerCase();

            const otp =
                req.body.otp;

            const newPassword =
                req.body.newPassword;


            if (
                !email ||
                !otp ||
                !newPassword
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email, OTP and new password are required"

                });

            }


            if (
                newPassword.length < 8
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Password must be at least 8 characters"

                });

            }


            // --------------------------------
            // Find user
            // --------------------------------

            const userResult =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(email) = $1
                    `,
                    [email]
                );


            if (
                userResult.rows.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid reset request"

                });

            }


            const userId =
                userResult.rows[0].id;


            // --------------------------------
            // Hash OTP
            // --------------------------------

            const otpResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        otp_hash,
                        attempts
                    FROM password_reset_otps
                    WHERE user_id = $1
                      AND used = FALSE
                      AND expires_at > CURRENT_TIMESTAMP
                    ORDER BY created_at DESC
                    LIMIT 1
                    `,
                    [userId]
                );


            if (
                otpResult.rows.length === 0 ||
                otpResult.rows[0].attempts >= 5 ||
                !otpsEqual(
                    otpResult.rows[0].otp_hash,
                    otp
                )
            ) {

                if (otpResult.rows[0]?.id) {

                    await pool.query(
                        `
                        UPDATE password_reset_otps
                        SET attempts = attempts + 1
                        WHERE id = $1
                        `,
                        [otpResult.rows[0].id]
                    );

                }

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid or expired OTP"

                });

            }


            const otpId =
                otpResult.rows[0].id;


            // --------------------------------
            // Hash new password
            // --------------------------------

            const passwordHash =
                await bcrypt.hash(
                    newPassword,
                    12
                );


            // --------------------------------
            // Update password
            // --------------------------------

            await pool.query(
                `
                UPDATE users
                SET password_hash = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                `,
                [
                    passwordHash,
                    userId
                ]
            );


            // --------------------------------
            // Mark OTP used
            // --------------------------------

            await pool.query(
                `
                UPDATE password_reset_otps
                SET used = TRUE
                WHERE id = $1
                `,
                [otpId]
            );

            await pool.query(
                `
                DELETE FROM session
                WHERE sess #>> '{user,id}' = $1
                `,
                [String(userId)]
            );


            res.json({

                success: true,

                message:
                    "Password reset successfully. You can now login."

            });

        } catch (error) {

            console.error(
                "Reset password error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Password reset failed"

            });

        }

    }
);


// ========================================
// LOGIN
// ========================================

app.post(
    "/api/auth/login",
    async (req, res) => {

        try {

            const email =
                String(req.body.email || "").trim().toLowerCase();

            const password =
                req.body.password;


            if (
                !email ||
                !password
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email and password are required"

                });

            }

            if (
                !allowAttempt(
                    `login:${clientKey(req)}:${email}`,
                    { max: 10 }
                )
            ) {

                return res.status(429).json({

                    success: false,

                    message:
                        "Too many login attempts. Try again later."

                });

            }


            // --------------------------------
            // Find user
            // --------------------------------

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        username,
                        email,
                        password_hash,
                        role,
                        storage_quota
                    FROM users
                    WHERE LOWER(email) = $1
                    `,
                    [email]
                );


            if (
                result.rows.length === 0
            ) {

                auditLog("auth.login_failed", {
                    email,
                    reason: "unknown_account",
                    ip: clientKey(req)
                });

                return res.status(401).json({

                    success: false,

                    message:
                        "Invalid email or password"

                });

            }


            const user =
                result.rows[0];


            // --------------------------------
            // Check password
            // --------------------------------

            const passwordMatch =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );


            if (!passwordMatch) {

                auditLog("auth.login_failed", {
                    userId: user.id,
                    email: user.email,
                    reason: "invalid_password",
                    ip: clientKey(req)
                });

                return res.status(401).json({

                    success: false,

                    message:
                        "Invalid email or password"

                });

            }


            // --------------------------------
            // Regenerate session
            // --------------------------------
            // Prevent session fixation

            req.session.regenerate(
                (error) => {

                    if (error) {

                        console.error(
                            "Session regeneration error:",
                            error
                        );

                        return res.status(500).json({

                            success: false,

                            message:
                                "Login failed"

                        });

                    }


                    req.session.user = {

                        id:
                            user.id,

                        username:
                            user.username,

                        email:
                            user.email,

                        role:
                            user.role,

                        storage_quota:
                            user.storage_quota

                    };


                    req.session.save(
                        (saveError) => {

                            if (saveError) {

                                console.error(
                                    "Session save error:",
                                    saveError
                                );

                                return res.status(500).json({

                                    success: false,

                                    message:
                                        "Login failed"

                                });

                            }


                            res.json({

                                success: true,

                                message:
                                    "Login successful",

                                user:
                                    req.session.user

                            });

                            auditLog("auth.login_succeeded", {
                                userId: user.id,
                                username: user.username,
                                email: user.email,
                                ip: clientKey(req)
                            });

                        }
                    );

                }
            );

        } catch (error) {

            console.error(
                "Login error:",
                error
            );

            res.status(500).json({

                success: false,

                message:
                    "Login failed"

            });

        }

    }
);


// ========================================
// CURRENT USER
// ========================================

app.get(
    "/api/auth/me",
    requireAuth,
    async (req, res) => {

        try {

            const usageResult =
                await pool.query(
                    `
                    SELECT
                        u.id,
                        u.username,
                        u.email,
                        u.role,
                        u.storage_quota,
                        COALESCE(SUM(f.size), 0)::bigint AS storage_used
                    FROM users u
                    LEFT JOIN files f
                        ON f.user_id = u.id
                    WHERE u.id = $1
                    GROUP BY
                        u.id,
                        u.username,
                        u.email,
                        u.role,
                        u.storage_quota
                    `,
                    [req.session.user.id]
                );

            const user =
                usageResult.rows[0];

            if (!user) {

                return res.status(401).json({
                    success: false,
                    message: "Authentication required"
                });

            }

            req.session.user = {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                storage_quota: user.storage_quota,
                storage_used: Number(user.storage_used)
            };

            res.json({
                success: true,
                user: req.session.user
            });

        } catch (error) {

            console.error("Current user error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to load user"
            });

        }

    }
);


// ========================================
// LOGOUT
// ========================================

app.post(
    "/api/auth/logout",
    (req, res) => {

        auditLog("auth.logout", actorFromRequest(req));

        req.session.destroy(
            (error) => {

                if (error) {

                    console.error(
                        "Logout error:",
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            "Logout failed"

                    });

                }


                res.clearCookie(
                    "connect.sid"
                );


                res.json({

                    success: true,

                    message:
                        "Logout successful"

                });

            }
        );

    }
);


// ========================================
// 404 API HANDLER
// ========================================

app.use(
    "/api",
    (req, res) => {

        res.status(404).json({

            success: false,

            message:
                "API endpoint not found"

        });

    }
);


// ========================================
// GLOBAL ERROR HANDLER
// ========================================

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled server error:",
            error
        );


        if (res.headersSent) {

            return next(error);

        }


        res.status(500).json({

            success: false,

            message:
                "Internal server error"

        });

    }
);


// ========================================
// START SERVER
// ========================================

app.listen(
    PORT,
    () => {

        console.log(
            "----------------------------------"
        );

        console.log(
            "MyDrive Server"
        );

        console.log(
            "----------------------------------"
        );

        console.log(
            `Server running on http://localhost:${PORT}`
        );

        console.log(
            "----------------------------------"
        );

    }
);
