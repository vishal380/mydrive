function requireAuth(req, res, next) {

    if (!req.session || !req.session.user) {

        return res.status(401).json({
            success: false,
            message: "Authentication required"
        });

    }

    next();
}

module.exports = requireAuth;