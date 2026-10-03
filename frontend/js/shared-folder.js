"use strict";

const token = new URLSearchParams(window.location.search).get("token");
const folderName = document.getElementById("folderName");
const folderDetails = document.getElementById("folderDetails");
const folderError = document.getElementById("folderError");
const folderFiles = document.getElementById("folderFiles");
const downloadFolder = document.getElementById("downloadFolder");

function formatSize(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} Bytes`;
    const units = ["KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
    return `${(bytes / (1024 ** exponent)).toFixed(2)} ${units[exponent - 1]}`;
}

async function loadFolder() {
    if (!token) return showError("This share link is invalid.");
    try {
        const response = await fetch(`/api/files/public-folder/${encodeURIComponent(token)}`);
        const data = await response.json();
        if (!response.ok || !data.folder) return showError(data.message || "This folder is unavailable or its link has expired.");

        folderName.textContent = data.folder.name || "Shared folder";
        const files = Array.isArray(data.files) ? data.files : [];
        const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
        folderDetails.textContent = `${files.length} ${files.length === 1 ? "file" : "files"} · ${formatSize(total)}`;
        downloadFolder.href = `/api/files/public-folder/${encodeURIComponent(token)}/download`;
        downloadFolder.hidden = false;
        folderFiles.replaceChildren();
        if (!files.length) {
            const empty = document.createElement("li");
            empty.textContent = "This folder is empty.";
            folderFiles.append(empty);
            return;
        }
        for (const file of files) {
            const row = document.createElement("li");
            const info = document.createElement("span");
            info.className = "public-folder-file";
            info.textContent = `${file.folder_path ? `${file.folder_path}/` : ""}${file.original_filename || "File"}`;
            const size = document.createElement("small");
            size.textContent = formatSize(file.size);
            info.append(size);
            row.append(info);
            folderFiles.append(row);
        }
    } catch (error) {
        console.error("Load public folder error:", error);
        showError("Unable to connect to the server.");
    }
}

function showError(message) {
    folderName.textContent = "Shared folder unavailable";
    folderError.textContent = message;
    folderError.hidden = false;
}

loadFolder();
