const registerForm =
    document.getElementById("registerForm");

const registerMessage =
    document.getElementById("registerMessage");
const sendOtpButton =
    document.getElementById("sendRegistrationOtp");

sendOtpButton.addEventListener("click", async () => {
    const email = document.getElementById("email").value.trim();
    registerMessage.className = "message";
    registerMessage.textContent = "";

    if (!email || !document.getElementById("email").checkValidity()) {
        registerMessage.className = "message error";
        registerMessage.textContent = "Enter a valid email address first.";
        return;
    }

    sendOtpButton.disabled = true;
    sendOtpButton.textContent = "Sending…";
    try {
        const response = await fetch("/api/auth/register/send-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        registerMessage.className = response.ok ? "message success" : "message error";
        registerMessage.textContent = data.message || "Unable to send verification code.";
    } catch (error) {
        console.error("Registration OTP error:", error);
        registerMessage.className = "message error";
        registerMessage.textContent = "Unable to connect to server.";
    } finally {
        sendOtpButton.disabled = false;
        sendOtpButton.textContent = "Send code";
    }
});


registerForm.addEventListener("submit", async (event) => {

    event.preventDefault();

    const username =
        document.getElementById("username").value.trim();

    const email =
        document.getElementById("email").value.trim();

    const password =
        document.getElementById("password").value;

    const confirmPassword =
        document.getElementById("confirmPassword").value;
    const otp =
        document.getElementById("registrationOtp").value.trim();


    // Clear previous message

    registerMessage.className = "message";

    registerMessage.textContent = "";


    // Check passwords

    if (password !== confirmPassword) {

        registerMessage.className =
            "message error";

        registerMessage.textContent =
            "Passwords do not match.";

        return;
    }


    try {

        const response = await fetch(
            "/api/auth/register",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    username,
                    email,
                    password,
                    otp
                })
            }
        );


        const data =
            await response.json();


        if (!response.ok) {

            registerMessage.className =
                "message error";

            registerMessage.textContent =
                data.message ||
                "Registration failed.";

            return;
        }


        registerMessage.className =
            "message success";

        registerMessage.textContent =
            "Account created successfully!";


        registerForm.reset();


        // Go to login after 1.5 seconds

        setTimeout(() => {

            window.location.href =
                "/login.html";

        }, 1500);


    } catch (error) {

        console.error(error);

        registerMessage.className =
            "message error";

        registerMessage.textContent =
            "Unable to connect to server.";

    }

});
