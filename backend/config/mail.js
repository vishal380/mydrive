const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 587),
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

transporter.verify()
    .then(() => {
        console.log("Gmail SMTP connection successful");
    })
    .catch((error) => {
        console.error("Gmail SMTP connection failed:");
        console.error(error);
    });

module.exports = transporter;