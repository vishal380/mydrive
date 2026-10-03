"use strict";

(function () {
    const overlay = document.createElement("div");
    overlay.className = "app-confirm-overlay";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");

    const dialog = document.createElement("section");
    dialog.className = "app-confirm-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.className = "app-confirm-title";
    title.id = "appConfirmTitle";
    dialog.setAttribute("aria-labelledby", title.id);

    const message = document.createElement("p");
    message.className = "app-confirm-message";

    const actions = document.createElement("div");
    actions.className = "app-confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "app-confirm-cancel";

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "app-confirm-accept";

    actions.append(cancel, accept);
    dialog.append(title, message, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    window.showAppConfirm = function ({
        title: titleText = "Are you sure?",
        message: messageText = "",
        confirmText = "Confirm",
        cancelText = "Cancel",
        danger = false
    } = {}) {
        return new Promise((resolve) => {
            const previousFocus = document.activeElement;
            let finished = false;

            const finish = (confirmed) => {
                if (finished) return;
                finished = true;
                overlay.hidden = true;
                overlay.setAttribute("aria-hidden", "true");
                document.body.classList.remove("confirm-open");
                document.removeEventListener("keydown", onKeyDown);
                if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
                resolve(confirmed);
            };

            const onKeyDown = (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    finish(false);
                }
            };

            title.textContent = titleText;
            message.textContent = messageText;
            cancel.textContent = cancelText;
            accept.textContent = confirmText;
            accept.classList.toggle("danger", danger);
            cancel.onclick = () => finish(false);
            accept.onclick = () => finish(true);
            overlay.onclick = (event) => {
                if (event.target === overlay) finish(false);
            };

            overlay.hidden = false;
            overlay.setAttribute("aria-hidden", "false");
            document.body.classList.add("confirm-open");
            document.addEventListener("keydown", onKeyDown);
            cancel.focus();
        });
    };
})();
