"use strict";

const list = document.getElementById("trashList");
const message = document.getElementById("trashMessage");
const emptyTrashButton = document.getElementById("emptyTrashButton");

function sizeLabel(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} Bytes`;
    const units = ["KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
    return `${(bytes / (1024 ** index)).toFixed(2)} ${units[index - 1]}`;
}

async function loadTrash() {
    try {
        const response = await fetch("/api/files/trash", { credentials: "include" });
        const data = await response.json();
        if (response.status === 401) {
            window.location.href = "/login.html";
            return;
        }
        if (!response.ok) throw new Error(data.message || "Unable to load Trash");

        list.replaceChildren();
        const files = data.files || [];
        const folders = data.folders || [];
        if (!files.length && !folders.length) {
            message.textContent = "Trash is empty.";
            emptyTrashButton.disabled = true;
            return;
        }
        emptyTrashButton.disabled = false;
        const total = files.length + folders.length;
        message.textContent = `${total} item${total === 1 ? "" : "s"} in Trash`;

        folders.forEach((folder) => {
            const item = document.createElement("article");
            item.className = "trash-item";
            const info = document.createElement("div");
            const name = document.createElement("div");
            name.className = "trash-name";
            name.textContent = `📁 ${folder.name}`;
            const meta = document.createElement("div");
            meta.className = "trash-meta";
            meta.textContent = `${sizeLabel(folder.size)} · Moved ${new Date(folder.trashed_at).toLocaleString()}`;
            info.append(name, meta);
            const actions = document.createElement("div");
            actions.className = "trash-actions";
            const restore = document.createElement("button");
            restore.type = "button";
            restore.textContent = "Restore";
            restore.addEventListener("click", () => updateTrashItem(folder.id, "restore", "folder"));
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "permanent-delete";
            remove.textContent = "Delete permanently";
            remove.addEventListener("click", () => updateTrashItem(folder.id, "delete", "folder"));
            actions.append(restore, remove);
            item.append(info, actions);
            list.appendChild(item);
        });

        files.forEach((file) => {
            const item = document.createElement("article");
            item.className = "trash-item";
            const info = document.createElement("div");
            const name = document.createElement("div");
            name.className = "trash-name";
            name.textContent = file.original_filename || "Unnamed file";
            const meta = document.createElement("div");
            meta.className = "trash-meta";
            meta.textContent = `${sizeLabel(file.size)} · Moved ${new Date(file.trashed_at).toLocaleString()}`;
            info.append(name, meta);

            const actions = document.createElement("div");
            actions.className = "trash-actions";
            const restore = document.createElement("button");
            restore.type = "button";
            restore.textContent = "Restore";
            restore.addEventListener("click", () => updateTrashItem(file.id, "restore"));
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "permanent-delete";
            remove.textContent = "Delete permanently";
            remove.addEventListener("click", () => updateTrashItem(file.id, "delete"));
            actions.append(restore, remove);
            item.append(info, actions);
            list.appendChild(item);
        });
    } catch (error) {
        console.error("Trash load error:", error);
        message.textContent = error.message || "Unable to load Trash.";
    }
}

emptyTrashButton.addEventListener("click", async () => {
    const confirmed = await window.showAppConfirm({
        title: "Empty Trash?",
        message: "All files in Trash will be permanently deleted and cannot be restored.",
        confirmText: "Empty Trash",
        cancelText: "Cancel",
        danger: true
    });
    if (!confirmed) return;

    emptyTrashButton.disabled = true;
    try {
        const response = await fetch("/api/files/trash", {
            method: "DELETE",
            credentials: "include"
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Unable to empty Trash");
        await loadTrash();
    } catch (error) {
        console.error("Empty Trash error:", error);
        await loadTrash();
        message.textContent = error.message || "Unable to empty Trash.";
    }
});

async function updateTrashItem(fileId, action, kind = "file") {
    if (action === "delete") {
        const confirmed = await window.showAppConfirm({
            title: `Delete ${kind} permanently?`,
            message: kind === "folder"
                ? "This folder and all its contents will be permanently deleted and cannot be restored."
                : "This file will be permanently deleted and cannot be restored.",
            confirmText: "Delete permanently",
            cancelText: "Cancel",
            danger: true
        });
        if (!confirmed) return;
    }
    try {
        const url = kind === "folder"
            ? `/api/files/folders/${fileId}${action === "restore" ? "/restore" : ""}`
            : (action === "restore" ? `/api/files/${fileId}/restore` : `/api/files/${fileId}`);
        const response = await fetch(url, {
            method: action === "restore" ? "PATCH" : "DELETE",
            credentials: "include"
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Unable to update file");
        await loadTrash();
    } catch (error) {
        console.error("Trash update error:", error);
        message.textContent = error.message || "Unable to update file.";
    }
}

loadTrash();
