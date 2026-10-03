"use strict";

const token = window.location.pathname.split("/").filter(Boolean).at(-1);
const fileName = document.getElementById("fileName");
const fileDetails = document.getElementById("fileDetails");
const errorMessage = document.getElementById("sharedError");
const preview = document.getElementById("filePreview");
const download = document.getElementById("downloadFile");

function formatSize(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} Bytes`;
    const units = ["KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
    return `${(bytes / (1024 ** exponent)).toFixed(2)} ${units[exponent - 1]}`;
}

async function loadSharedFile() {
    if (!token) {
        showError("This share link is invalid.");
        return;
    }

    try {
        const response = await fetch(`/api/files/public/${encodeURIComponent(token)}`);
        const data = await response.json();
        if (!response.ok || !data.file) {
            showError(data.message || "This file is unavailable or the link has expired.");
            return;
        }

        const file = data.file;
        fileName.textContent = file.original_filename || "Shared file";
        fileDetails.textContent = `${formatSize(file.size)} · ${file.mime_type || "Unknown file type"}`;
        const mime = String(file.mime_type || "").toLowerCase();
        const canPreview = !/(svg|html|xml)/.test(mime) && (
            /^(image\/(jpeg|png|gif|webp|bmp)|application\/pdf|text\/plain|audio\/|video\/)/.test(mime)
        );
        if (canPreview) {
            preview.src = `/api/files/public/${encodeURIComponent(token)}/preview`;
            preview.hidden = false;
        }
        download.href = `/api/files/public/${encodeURIComponent(token)}/download`;
        download.hidden = false;
    } catch (error) {
        console.error("Load shared file error:", error);
        showError("Unable to connect to the server.");
    }
}

function showError(message) {
    fileName.textContent = "Shared file unavailable";
    errorMessage.textContent = message;
    errorMessage.hidden = false;
}

loadSharedFile();
