const loginForm =
    document.getElementById("loginForm");

const loginMessage =
    document.getElementById("loginMessage");


loginForm.addEventListener("submit", async (event) => {

    event.preventDefault();

    const email =
        document.getElementById("email").value.trim();

    const password =
        document.getElementById("password").value;


    // Clear previous message

    loginMessage.className = "message";

    loginMessage.textContent = "";


    try {

        const response = await fetch(
            "/api/auth/login",
            {
                method: "POST",

                credentials: "include",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    email,
                    password
                })
            }
        );


        const data =
            await response.json();


        if (!response.ok) {

            loginMessage.className =
                "message error";

            loginMessage.textContent =
                data.message ||
                "Login failed.";

            return;
        }


        loginMessage.className =
            "message success";

        loginMessage.textContent =
            "Login successful!";


        // Go to dashboard

        setTimeout(() => {

            window.location.href =
                "/dashboard.html";

        }, 500);


    } catch (error) {

        console.error(
            "Login error:",
            error
        );

        loginMessage.className =
            "message error";

        loginMessage.textContent =
            "Unable to connect to server.";

    }

});