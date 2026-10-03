// ============================================================
// MYDRIVE - DASHBOARD.JS
// ============================================================
// Features
// ============================================================
// 1. Load logged-in user
// 2. Load files
// 3. Image previews
// 4. File icons
// 5. File size formatting
// 6. File upload
// 7. File download
// 8. Professional Share Modal
// 9. Share with MyDrive users
// 10. Viewer / Editor permissions
// 11. Execute permission
// 12. People with access
// 13. Remove user access
// 14. General access - Restricted
// 15. General access - Anyone with the link
// 16. Copy share link
// 17. Logout
// 18. Refresh
// ============================================================


// ============================================================
// GLOBAL SHARE STATE
// ============================================================

let currentShareFileId = null;
let currentShareFolderId = null;
let currentShareFileName = "";
let currentUserId = null;
let currentFolderId = null;
let currentFolderPath = [];
const selectedFiles = new Map();
const selectedFolders = new Map();
let visibleFileCount = 0;
let selectedNonOwnerCount = 0;
const filePreviewObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const image = entry.target;
            image.src = image.dataset.previewSrc;
            observer.unobserve(image);
        });
    }, { rootMargin: "100px" })
    : null;


// ============================================================
// LOAD USER
// ============================================================

async function loadUser() {

    try {

        const response = await fetch(
            "/api/auth/me",
            {
                credentials: "include"
            }
        );

        const data = await response.json();

        if (!response.ok) {

            window.location.href =
                "/login.html";

            return;
        }

        currentUserId = data.user.id;

        const welcomeText =
            document.getElementById(
                "welcomeText"
            );

        if (welcomeText) {

            welcomeText.textContent =
                `Welcome, ${data.user.username}`;

        }

        updateStorageUsage(
            data.user.storage_used,
            data.user.storage_quota
        );

    } catch (error) {

        console.error(
            "Load user error:",
            error
        );

        window.location.href =
            "/login.html";

    }

}


// ============================================================
// LOAD FILES
// ============================================================

async function loadFiles(folderId = currentFolderId) {

    const fileGrid =
        document.getElementById(
            "fileGrid"
        );

    if (!fileGrid) {
        return;
    }

    fileGrid.innerHTML = `
        <div class="loading">
            Loading files...
        </div>
    `;
    visibleFileCount = 0;

    try {

        const response =
            await fetch(
                folderId === null ? "/api/files" : `/api/files?folderId=${encodeURIComponent(folderId)}`,
                {
                    credentials: "include"
                }
            );

        const data =
            await response.json();

        if (!response.ok) {

            if (response.status === 401) {

                window.location.href =
                    "/login.html";

                return;
            }

            fileGrid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">⚠️</div>
                    <h3>Unable to load files</h3>
                    <p>
                        ${escapeHtml(
                            data.message ||
                            "Something went wrong."
                        )}
                    </p>
                </div>
            `;

            return;
        }

        selectedFiles.clear();
        selectedFolders.clear();
        selectedNonOwnerCount = 0;
        currentFolderId = folderId;
        currentFolderPath = data.folderPath || [];
        visibleFileCount = (data.files || []).length + (data.folders || []).length;
        updateSelectionUI();
        renderFolderBreadcrumbs();

        const folders = data.folders || [];
        const files = data.files || [];
        if (folders.length === 0 && files.length === 0) {

            fileGrid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">
                        📁
                    </div>

                    <h3>
                        ${folderId === null ? "No files or folders yet" : "This folder is empty"}
                    </h3>

                    <p>
                        Use + New to create a folder or upload files.
                    </p>
                </div>
            `;

            return;
        }

        fileGrid.innerHTML = "";

        folders.forEach((folder) => {
            fileGrid.appendChild(createFolderCard(folder));
        });

        files.forEach((file) => {
            fileGrid.appendChild(createFileCard(file));
        });

    } catch (error) {

        console.error(
            "Load files error:",
            error
        );

        fileGrid.innerHTML = `
            <div class="empty-state">

                <div class="empty-icon">
                    ⚠️
                </div>

                <h3>
                    Connection error
                </h3>

                <p>
                    Unable to connect to server.
                </p>

            </div>
        `;

    }

}


function createFileCard(file) {

    const card = document.createElement("div");
    card.className = "file-card";

    const fileId = Number(file.id);
    card.dataset.fileId = fileId;
    card.fileData = file;
    const fileName =
        file.original_filename ||
        file.filename ||
        "Unnamed file";

    const isImage =
        file.mime_type &&
        file.mime_type.startsWith("image/") &&
        !String(file.mime_type).toLowerCase().includes("svg");
    const isVideo = String(file.mime_type || "").toLowerCase().startsWith("video/");

    if (isImage || isVideo) {
        card.classList.add("file-card-previewable");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", `${isVideo ? "Play" : "Preview"} ${fileName}`);
        card.addEventListener("click", (event) => {
            if (event.target.closest(".file-select")) return;
            openMediaPreview(file, isVideo);
        });
        card.addEventListener("keydown", (event) => {
            if ((event.key === "Enter" || event.key === " ") && event.target === card) {
                event.preventDefault();
                openMediaPreview(file, isVideo);
            }
        });
    }

    const isOwner =
        file.is_owner === true ||
        Number(file.user_id) === Number(currentUserId);


    const selectLabel = document.createElement("label");
    selectLabel.className = "file-select";
    selectLabel.title = "Select file";
    const selectCheckbox = document.createElement("input");
    selectCheckbox.type = "checkbox";
    selectCheckbox.checked = selectedFiles.has(fileId);
    selectCheckbox.setAttribute("aria-label", `Select ${fileName}`);
    selectCheckbox.addEventListener("click", (event) => event.stopPropagation());
    selectCheckbox.addEventListener("change", () => {
        if (selectCheckbox.checked) {
            selectedFiles.set(fileId, { ...file, is_owner: isOwner });
            if (!isOwner) selectedNonOwnerCount += 1;
        } else if (selectedFiles.has(fileId)) {
            selectedFiles.delete(fileId);
            if (!isOwner) selectedNonOwnerCount -= 1;
        }
        card.classList.toggle("selected", selectCheckbox.checked);
        updateSelectionUI();
    });
    selectLabel.appendChild(selectCheckbox);
    card.appendChild(selectLabel);
    card.classList.toggle("selected", selectedFiles.has(fileId));

    if (isImage) {
        const preview = document.createElement("div");
        preview.className = "file-preview";

        const img = document.createElement("img");
        const previewUrl = `/api/files/${fileId}/preview`;
        img.alt = fileName;
        img.loading = "lazy";
        img.decoding = "async";
        img.fetchPriority = "low";
        img.addEventListener("error", () => {
            img.style.display = "none";
        });
        if (filePreviewObserver) {
            img.dataset.previewSrc = previewUrl;
            filePreviewObserver.observe(img);
        } else {
            img.src = previewUrl;
        }

        preview.appendChild(img);
        card.appendChild(preview);
    } else {
        const icon = document.createElement("div");
        icon.className = "file-icon";
        icon.textContent = getFileIcon(file.mime_type);
        card.appendChild(icon);
    }

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = fileName;
    card.appendChild(name);

    const size = document.createElement("div");
    size.className = "file-size";
    size.textContent = formatFileSize(file.size || 0);
    card.appendChild(size);

    // Selected files use the shared action menu in the toolbar.
    return card;
}

function openMediaPreview(file, isVideo) {
    let dialog = document.getElementById("mediaPreviewDialog");
    if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "mediaPreviewDialog";
        dialog.className = "media-preview-dialog";
        dialog.setAttribute("aria-labelledby", "mediaPreviewTitle");
        dialog.innerHTML = `
            <div class="media-preview-header">
                <h2 id="mediaPreviewTitle"></h2>
                <button type="button" class="media-preview-close" aria-label="Close preview">×</button>
            </div>
            <div class="media-preview-content"></div>
        `;
        dialog.querySelector(".media-preview-close").addEventListener("click", () => dialog.close());
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog.close();
        });
        dialog.addEventListener("close", () => {
            const content = dialog.querySelector(".media-preview-content");
            const video = content.querySelector("video");
            if (video) video.pause();
            content.replaceChildren();
        });
        document.body.appendChild(dialog);
    }

    dialog.querySelector("#mediaPreviewTitle").textContent = file.original_filename || "Preview";
    const content = dialog.querySelector(".media-preview-content");
    content.replaceChildren();
    const media = document.createElement(isVideo ? "video" : "img");
    media.src = `/api/files/${encodeURIComponent(file.id)}/preview`;
    if (isVideo) {
        media.controls = true;
        media.playsInline = true;
        media.preload = "metadata";
        media.setAttribute("aria-label", file.original_filename || "Video preview");
    } else {
        media.alt = file.original_filename || "Photo preview";
    }
    content.appendChild(media);
    if (!dialog.open) dialog.showModal();
}

function createFolderCard(folder) {
    const card = document.createElement("div");
    card.className = "folder-card";
    card.dataset.folderId = Number(folder.id);
    card.folderData = folder;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open folder ${folder.name}`);

    const icon = document.createElement("span");
    icon.className = "folder-card-icon";
    icon.textContent = "📁";
    const name = document.createElement("span");
    name.className = "folder-card-name";
    name.textContent = folder.name;

    const selectLabel = document.createElement("label");
    selectLabel.className = "file-select";
    selectLabel.title = "Select folder";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedFolders.has(Number(folder.id));
    checkbox.setAttribute("aria-label", `Select folder ${folder.name}`);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
        const folderId = Number(folder.id);
        if (checkbox.checked) selectedFolders.set(folderId, folder);
        else selectedFolders.delete(folderId);
        card.classList.toggle("selected", checkbox.checked);
        updateSelectionUI();
    });
    selectLabel.appendChild(checkbox);
    card.append(selectLabel, icon, name);
    card.classList.toggle("selected", selectedFolders.has(Number(folder.id)));
    card.addEventListener("click", (event) => {
        if (event.target.closest(".file-select")) return;
        loadFiles(Number(folder.id));
    });
    card.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === card) {
            event.preventDefault();
            loadFiles(Number(folder.id));
        }
    });
    return card;
}

function renderFolderBreadcrumbs() {
    const breadcrumbs = document.getElementById("folderBreadcrumbs");
    if (!breadcrumbs) return;
    breadcrumbs.replaceChildren();

    const addCrumb = (label, folderId, isCurrent) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = isCurrent;
        button.addEventListener("click", () => loadFiles(folderId));
        breadcrumbs.appendChild(button);
    };

    addCrumb("My Drive", null, currentFolderId === null);
    currentFolderPath.forEach((folder, index) => {
        const separator = document.createElement("span");
        separator.className = "folder-breadcrumb-separator";
        separator.textContent = "/";
        breadcrumbs.appendChild(separator);
        addCrumb(folder.name, Number(folder.id), index === currentFolderPath.length - 1);
    });
}

function updateSelectionUI() {
    const toolbar = document.getElementById("selectionToolbar");
    const selectionMenuButton = document.getElementById("selectionMenuButton");
    const count = document.getElementById("selectedCount");
    const selectAll = document.getElementById("selectAllFiles");
    const selectedCount = selectedFiles.size + selectedFolders.size;

    if (toolbar) toolbar.hidden = selectedCount === 0;
    if (selectionMenuButton) selectionMenuButton.hidden = selectedCount === 0;
    if (count) count.textContent = `${selectedCount} selected`;
    if (selectAll) {
        selectAll.checked = visibleFileCount > 0 && selectedCount === visibleFileCount;
        selectAll.indeterminate = selectedCount > 0 && !selectAll.checked;
    }

    const shareAction = document.querySelector('[data-selection-action="share"]');
    const trashAction = document.getElementById("moveSelectedToTrashButton");
    const openAction = document.querySelector('[data-selection-action="open"]');
    const propertiesAction = document.querySelector('[data-selection-action="properties"]');
    const modifyAction = document.querySelector('[data-selection-action="modify"]');
    const downloadAction = document.querySelector('[data-selection-action="download"]');
    const oneSelectedFile = selectedCount === 1 && selectedFiles.size === 1 ? selectedFiles.values().next().value : null;
    const oneSelectedFolder = selectedCount === 1 && selectedFolders.size === 1 ? selectedFolders.values().next().value : null;
    if (shareAction) shareAction.disabled = selectedCount !== 1 || (
        oneSelectedFile ? oneSelectedFile.is_owner !== true : !oneSelectedFolder || oneSelectedFolder.is_owner === false
    );
    if (trashAction) trashAction.disabled = selectedFolders.size > 0
        ? selectedFolders.size !== 1 || selectedFiles.size > 0 || selectedFolders.values().next().value?.is_owner === false
        : selectedNonOwnerCount > 0;
    if (openAction) openAction.disabled = !oneSelectedFolder;
    if (propertiesAction) propertiesAction.disabled = selectedCount !== 1;
    if (modifyAction) modifyAction.disabled = selectedCount !== 1 || Boolean(
        (oneSelectedFile && !oneSelectedFile.can_write && !oneSelectedFile.is_owner) ||
        (oneSelectedFolder && oneSelectedFolder.is_owner === false)
    );
    if (downloadAction) downloadAction.disabled = selectedFolders.size > 0
        ? selectedFolders.size !== 1 || selectedFiles.size > 0
        : selectedFiles.size === 0;
}

function openItemProperties(item, kind) {
    let dialog = document.getElementById("itemPropertiesDialog");
    if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "itemPropertiesDialog";
        dialog.className = "item-properties-dialog";
        dialog.setAttribute("aria-labelledby", "itemPropertiesTitle");
        dialog.innerHTML = `
            <div class="media-preview-header">
                <h2 id="itemPropertiesTitle"></h2>
                <button type="button" class="media-preview-close" aria-label="Close properties">×</button>
            </div>
            <dl class="item-properties-list"></dl>
        `;
        dialog.querySelector(".media-preview-close").addEventListener("click", () => dialog.close());
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) dialog.close();
        });
        document.body.appendChild(dialog);
    }

    const name = kind === "folder" ? item.name : item.original_filename;
    dialog.querySelector("#itemPropertiesTitle").textContent = name || "Properties";
    const modified = item.updated_at || item.created_at;
    const rows = [
        ["Type", kind === "folder" ? "Folder" : (item.mime_type || "File")],
        ["Size", formatFileSize(item.size || 0)],
        ["Modified", modified ? new Date(modified).toLocaleString() : "Unknown"]
    ];
    const list = dialog.querySelector(".item-properties-list");
    list.replaceChildren();
    for (const [label, value] of rows) {
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        list.append(term, detail);
    }
    if (!dialog.open) dialog.showModal();
}

async function modifySelectedItem(item, kind) {
    const currentName = kind === "folder" ? item.name : item.original_filename;
    const nextName = window.prompt(`Rename ${kind}`, currentName || "");
    if (nextName === null || !nextName.trim() || nextName.trim() === currentName) return;

    try {
        const endpoint = kind === "folder" ? `/api/files/folders/${item.id}` : `/api/files/${item.id}/rename`;
        const response = await fetch(endpoint, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nextName.trim() })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            alert(data.message || `Unable to rename ${kind}.`);
            return;
        }
        await loadFiles(currentFolderId);
    } catch (error) {
        console.error(`Rename ${kind} error:`, error);
        alert(`Unable to rename ${kind}.`);
    }
}

async function moveSelectedToTrash() {
    const selected = Array.from(selectedFiles.values());
    if (!selected.length || selected.some((file) => file.is_owner !== true)) return;
    const count = selected.length;
    const confirmed = await window.showAppConfirm({
        title: "Move to Trash?",
        message: `Move ${count} selected file${count === 1 ? "" : "s"} to Trash? You can restore ${count === 1 ? "it" : "them"} later.`,
        confirmText: "Move to Trash",
        cancelText: "Cancel"
    });
    if (!confirmed) return;

    try {
        for (const file of selected) {
            const response = await fetch(`/api/files/${file.id}/trash`, {
                method: "PATCH",
                credentials: "include"
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                alert(data.message || `Unable to move ${file.original_filename} to Trash.`);
                break;
            }
        }
    } catch (error) {
        console.error("Move to Trash error:", error);
        alert("Unable to connect to server.");
    }

    const menu = document.getElementById("selectionMenu");
    if (menu) menu.hidden = true;
    const menuButton = document.getElementById("selectionMenuButton");
    if (menuButton) menuButton.setAttribute("aria-expanded", "false");
    await loadFiles();
    await loadUser();
}


function updateStorageUsage(used, quota) {

    const progress =
        document.getElementById("storageProgress");

    const text =
        document.getElementById("storageText");

    const usedBytes = Number(used) || 0;
    const quotaBytes = Number(quota) || 0;
    const percent =
        quotaBytes > 0
            ? Math.min(100, (usedBytes / quotaBytes) * 100)
            : 0;

    if (progress) {
        progress.style.width = `${percent}%`;
    }

    if (text) {
        text.textContent =
            `${formatFileSize(usedBytes)} of ${formatFileSize(quotaBytes)} used`;
    }
}


// ============================================================
// FILE ICON
// ============================================================

function getFileIcon(type) {

    if (!type) {

        return "📄";

    }

    if (
        type.startsWith(
            "image/"
        )
    ) {

        return "🖼️";

    }

    if (
        type.startsWith(
            "video/"
        )
    ) {

        return "🎬";

    }

    if (
        type.startsWith(
            "audio/"
        )
    ) {

        return "🎵";

    }

    if (
        type ===
        "application/pdf"
    ) {

        return "📕";

    }

    if (
        type.includes(
            "zip"
        ) ||
        type.includes(
            "compressed"
        )
    ) {

        return "🗜️";

    }

    if (
        type.includes(
            "word"
        )
    ) {

        return "📝";

    }

    if (
        type.includes(
            "excel"
        ) ||
        type.includes(
            "spreadsheet"
        )
    ) {

        return "📊";

    }

    if (
        type.includes(
            "text"
        )
    ) {

        return "📃";

    }

    return "📄";

}


// ============================================================
// FILE SIZE
// ============================================================

function formatFileSize(bytes) {

    bytes =
        Number(bytes) || 0;

    if (bytes === 0) {

        return "0 Bytes";

    }

    const units = [
        "Bytes",
        "KB",
        "MB",
        "GB",
        "TB"
    ];

    const index =
        Math.floor(
            Math.log(bytes) /
            Math.log(1024)
        );

    const safeIndex =
        Math.min(
            index,
            units.length - 1
        );

    return (
        parseFloat(
            (
                bytes /
                Math.pow(
                    1024,
                    safeIndex
                )
            ).toFixed(2)
        )
        +
        " "
        +
        units[safeIndex]
    );

}


// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(value) {

    const div =
        document.createElement(
            "div"
        );

    div.textContent =
        value === null ||
        value === undefined
            ? ""
            : String(value);

    return div.innerHTML;

}


// ============================================================
// JAVASCRIPT STRING ESCAPE
// ============================================================

function escapeJs(value) {

    return String(
        value || ""
    )
        .replace(
            /\\/g,
            "\\\\"
        )
        .replace(
            /'/g,
            "\\'"
        )
        .replace(
            /"/g,
            '\\"'
        )
        .replace(
            /\r?\n/g,
            "\\n"
        );

}


// ============================================================
// UPLOAD FILE
// ============================================================

async function uploadFile(selectedFiles, preserveFolderStructure = false) {

    const message =
        document.getElementById(
            "uploadMessage"
        );

    const files = Array.from(selectedFiles || []);
    if (files.length === 0) {
        return;
    }

    const formData =
        new FormData();

    formData.append("folderId", currentFolderId ?? "");
    files.forEach((file) => {
        const relativePath = preserveFolderStructure
            ? (file.webkitRelativePath || file.name)
            : "";
        formData.append("relativePaths", relativePath);
    });
    files.forEach((file) => formData.append("files", file));
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const status = document.getElementById("uploadStatus");
    const progressBar = document.getElementById("uploadProgressBar");

    const updateProgress = (percent) => {
        const boundedPercent = Math.max(0, Math.min(100, percent));
        const transferredBytes = totalBytes * boundedPercent / 100;
        let completedFiles = 0;
        let cumulativeBytes = 0;

        for (const file of files) {
            cumulativeBytes += file.size;
            if (cumulativeBytes <= transferredBytes) completedFiles += 1;
            else break;
        }

        const currentFile = Math.min(files.length, completedFiles + 1);
        if (message) message.className = "upload-message progress";
        if (progressBar) progressBar.value = boundedPercent;
        if (status) {
            status.textContent =
                `File ${currentFile} of ${files.length} · ${Math.floor(boundedPercent)}% · ${formatFileSize(transferredBytes)} of ${formatFileSize(totalBytes)} sent`;
        }
    };

    updateProgress(0);

    try {

        const { response, data } = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/files/upload");
            xhr.withCredentials = true;
            xhr.upload.addEventListener("progress", (event) => {
                if (event.lengthComputable) {
                    updateProgress(event.total ? event.loaded / event.total * 100 : 0);
                }
            });
            xhr.addEventListener("load", () => {
                let result = {};
                try { result = JSON.parse(xhr.responseText); } catch { /* Non-JSON response */ }
                resolve({ response: { ok: xhr.status >= 200 && xhr.status < 300 }, data: result });
            });
            xhr.addEventListener("error", () => reject(new Error("Upload network error")));
            xhr.addEventListener("abort", () => reject(new Error("Upload was canceled")));
            xhr.send(formData);
        });

        if (!response.ok) {

            if (message) {

                message.className =
                    "upload-message error";

                if (status) status.textContent = data.message || "Upload failed.";

            }

            return;
        }

        if (message) {

            message.className =
                "upload-message success";

            if (progressBar) progressBar.value = 100;
            if (status) status.textContent = `${data.message || "Files uploaded successfully"} · 100%`;

        }

        await loadFiles(currentFolderId);
        await loadUser();

        setTimeout(
            () => {

                if (message) {

                    message.className =
                        "upload-message";

                    if (status) status.textContent = "";
                    if (progressBar) progressBar.value = 0;

                }

            },
            3000
        );

    } catch (error) {

        console.error(
            "Upload error:",
            error
        );

        if (message) {

            message.className =
                "upload-message error";

            if (status) status.textContent = "Upload failed. Check your connection and try again.";

        }

    }

}


// ============================================================
// NEW MENU AND UPLOAD INPUTS
// ============================================================

const fileInput =
    document.getElementById(
        "fileInput"
    );
const folderInput = document.getElementById("folderInput");
const newButton = document.getElementById("newButton");
const newMenu = document.getElementById("newMenu");
const newFolderModal = document.getElementById("newFolderModal");
const newFolderForm = document.getElementById("newFolderForm");
const newFolderName = document.getElementById("newFolderName");
const newFolderError = document.getElementById("newFolderError");

function closeNewMenu() {
    if (newMenu) newMenu.hidden = true;
    if (newButton) newButton.setAttribute("aria-expanded", "false");
}

async function moveSelectedFolderToTrash(folder) {
    if (!folder) return;
    const confirmed = await window.showAppConfirm({
        title: "Move folder to Trash?",
        message: `Move “${folder.name}” and its contents to Trash? You can restore them later.`,
        confirmText: "Move to Trash",
        cancelText: "Cancel"
    });
    if (!confirmed) return;
    try {
        const response = await fetch(`/api/files/folders/${folder.id}/trash`, {
            method: "PATCH",
            credentials: "include"
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            alert(data.message || "Unable to move folder to Trash.");
            return;
        }
        await loadFiles(currentFolderId);
        await loadUser();
    } catch (error) {
        console.error("Move folder to Trash error:", error);
        alert("Unable to move folder to Trash.");
    }
}

async function shareFolderContents(folder) {
    await shareFile(folder.id, folder.name, true);
}

function openNewFolderModal() {
    closeNewMenu();
    if (!newFolderModal) return;
    if (newFolderForm) newFolderForm.reset();
    if (newFolderError) newFolderError.textContent = "";
    newFolderModal.hidden = false;
    newFolderName?.focus();
}

newButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const shouldOpen = newMenu?.hidden;
    if (newMenu) newMenu.hidden = !shouldOpen;
    newButton.setAttribute("aria-expanded", String(Boolean(shouldOpen)));
});

document.getElementById("chooseFilesButton")?.addEventListener("click", () => {
    closeNewMenu();
    fileInput?.click();
});

document.getElementById("chooseFolderButton")?.addEventListener("click", () => {
    closeNewMenu();
    folderInput?.click();
});

document.getElementById("createFolderButton")?.addEventListener("click", openNewFolderModal);

document.addEventListener("click", (event) => {
    if (newMenu && !newMenu.hidden && !event.target.closest(".new-menu-wrap")) closeNewMenu();
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeNewMenu();
        if (newFolderModal) newFolderModal.hidden = true;
    }
});

document.getElementById("cancelNewFolder")?.addEventListener("click", () => {
    if (newFolderModal) newFolderModal.hidden = true;
});

newFolderModal?.addEventListener("click", (event) => {
    if (event.target === newFolderModal) newFolderModal.hidden = true;
});

newFolderForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = newFolderName?.value.trim();
    if (!name) return;
    const submitButton = newFolderForm.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    if (newFolderError) newFolderError.textContent = "";

    try {
        const response = await fetch("/api/files/folders", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, parentId: currentFolderId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Could not create folder.");
        if (newFolderModal) newFolderModal.hidden = true;
        await loadFiles(currentFolderId);
    } catch (error) {
        if (newFolderError) newFolderError.textContent = error.message || "Could not create folder.";
    } finally {
        if (submitButton) submitButton.disabled = false;
    }
});

if (fileInput) {

    fileInput.addEventListener(
        "change",
        event => {

            const files =
                event.target.files;

            if (files && files.length) {

                uploadFile(files, false);

            }

            // Allow selecting same file again
            event.target.value = "";

        }
    );

}

folderInput?.addEventListener("change", (event) => {
    const files = event.target.files;
    if (files?.length) uploadFile(files, true);
    event.target.value = "";
});


// ============================================================
// REFRESH
// ============================================================

const refreshButton =
    document.getElementById(
        "refreshButton"
    );

if (refreshButton) {

    refreshButton.addEventListener(
        "click",
        async () => {

            refreshButton.disabled =
                true;

            try {

                await loadFiles();

            } finally {

                refreshButton.disabled =
                    false;

            }

        }
    );

}

const selectAllFiles = document.getElementById("selectAllFiles");
if (selectAllFiles) {
    selectAllFiles.addEventListener("change", () => {
        selectedFiles.clear();
        selectedFolders.clear();
        selectedNonOwnerCount = 0;
        document.querySelectorAll(".file-card, .folder-card").forEach((card) => {
            if (card.folderData) {
                const checkbox = card.querySelector(".file-select input");
                if (!checkbox) return;
                checkbox.checked = selectAllFiles.checked;
                card.classList.toggle("selected", checkbox.checked);
                if (checkbox.checked) selectedFolders.set(Number(card.folderData.id), card.folderData);
                return;
            }
            const file = card.fileData;
            const checkbox = card.querySelector(".file-select input");
            if (!file || !checkbox) return;
            checkbox.checked = selectAllFiles.checked;
            card.classList.toggle("selected", checkbox.checked);
            if (checkbox.checked) {
                selectedFiles.set(Number(file.id), file);
                if (file.is_owner !== true) selectedNonOwnerCount += 1;
            }
        });
        updateSelectionUI();
    });
}

const selectionMenuButton = document.getElementById("selectionMenuButton");
const selectionMenu = document.getElementById("selectionMenu");
if (selectionMenuButton && selectionMenu) {
    selectionMenuButton.addEventListener("click", () => {
        selectionMenu.hidden = !selectionMenu.hidden;
        selectionMenuButton.setAttribute("aria-expanded", String(!selectionMenu.hidden));
    });

    selectionMenu.addEventListener("click", async (event) => {
        const action = event.target.closest("[data-selection-action]")?.dataset.selectionAction;
        if (!action || event.target.disabled) return;
        const selected = Array.from(selectedFiles.values());
        const selectedFolderList = Array.from(selectedFolders.values());
        const selectedCount = selected.length + selectedFolderList.length;
        selectionMenu.hidden = true;
        selectionMenuButton.setAttribute("aria-expanded", "false");

        if (action === "open" && selectedFolderList.length === 1 && selectedCount === 1) {
            await loadFiles(Number(selectedFolderList[0].id));
        } else if (action === "properties" && selectedCount === 1) {
            const isFolder = selectedFolderList.length === 1;
            openItemProperties(isFolder ? selectedFolderList[0] : selected[0], isFolder ? "folder" : "file");
        } else if (action === "modify" && selectedCount === 1) {
            const isFolder = selectedFolderList.length === 1;
            await modifySelectedItem(isFolder ? selectedFolderList[0] : selected[0], isFolder ? "folder" : "file");
        } else if (action === "download") {
            if (selectedFolders.size === 1 && selectedCount === 1) {
                const link = document.createElement("a");
                link.href = `/api/files/folders/${selectedFolderList[0].id}/download`;
                link.style.display = "none";
                document.body.appendChild(link);
                link.click();
                link.remove();
            } else if (selected.length === 1) {
                await downloadFile(selected[0].id);
            } else if (selected.length > 1) {
                await downloadSelectedFiles(selected.map((file) => file.id));
            }
        } else if (action === "share" && selected.length === 1) {
            await shareFile(selected[0].id, selected[0].original_filename);
        } else if (action === "share" && selectedFolderList.length === 1) {
            await shareFolderContents(selectedFolderList[0]);
        } else if (action === "trash") {
            if (selectedFolderList.length === 1 && selectedCount === 1) {
                await moveSelectedFolderToTrash(selectedFolderList[0]);
            } else {
                await moveSelectedToTrash();
            }
        }
    });
}

function downloadSelectedFiles(fileIds) {
    // Navigate directly from the user's tap so iOS Safari can process one
    // attachment response without creating a sequence of scripted downloads.
    const link = document.createElement("a");
    link.href = `/api/files/download-archive?ids=${encodeURIComponent(fileIds.join(","))}`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
}

document.addEventListener("click", (event) => {
    if (selectionMenu && selectionMenuButton &&
        !selectionMenu.contains(event.target) && !selectionMenuButton.contains(event.target)) {
        selectionMenu.hidden = true;
        selectionMenuButton.setAttribute("aria-expanded", "false");
    }
});


// ============================================================
// DOWNLOAD FILE
// ============================================================

async function downloadFile(fileId) {

    if (!fileId) {
        return;
    }

    try {

        const response =
            await fetch(
                `/api/files/${fileId}/download`,
                {
                    credentials: "include"
                }
            );

        if (!response.ok) {

            let message = "Unable to download file.";

            try {
                const data = await response.json();
                message = data.message || message;
            } catch (error) {
                // Ignore JSON parse errors
            }

            alert(message);
            return;
        }

        const blob = await response.blob();
        const header = response.headers.get("Content-Disposition") || "";
        const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
        const asciiMatch = header.match(/filename="([^"]+)"/i);
        const downloadName = utfMatch
            ? decodeURIComponent(utfMatch[1])
            : (asciiMatch ? asciiMatch[1] : "download");

        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = downloadName;
        link.style.display = "none";

        document.body.appendChild(link);
        link.click();
        link.remove();

        // Safari may begin consuming a Blob URL after the click handler returns.
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);

    } catch (error) {

        console.error("Download error:", error);
        alert("Unable to download file.");

    }

}


// SHARE FILE
// ============================================================

async function shareFile(
    fileId,
    fileName,
    isFolder = false
) {

    if (!fileId) {
        return;
    }

    currentShareFileId = isFolder ? null : fileId;
    currentShareFolderId = isFolder ? fileId : null;

    currentShareFileName =
        fileName ||
        "File";


    // --------------------------------------------------------
    // Get modal
    // --------------------------------------------------------

    const modal =
        document.getElementById(
            "shareModal"
        );

    if (!modal) {

        console.error(
            "shareModal was not found in dashboard.html"
        );

        alert(
            "Share dialog is not available. Please update dashboard.html."
        );

        return;

    }

    modal.classList.toggle("folder-share-mode", isFolder);


    // --------------------------------------------------------
    // Set filename
    // --------------------------------------------------------

    const title =
        document.getElementById(
            "shareFileName"
        );

    if (title) {

        title.textContent =
            currentShareFileName;

    }


    // --------------------------------------------------------
    // Reset fields
    // --------------------------------------------------------

    const emailInput =
        document.getElementById(
            "shareEmail"
        );

    const roleSelect =
        document.getElementById(
            "shareRole"
        );

    const executeCheckbox =
        document.getElementById(
            "shareExecute"
        );

    const message =
        document.getElementById(
            "shareMessage"
        );

    if (emailInput) {

        emailInput.value =
            "";

    }

    if (roleSelect) {

        roleSelect.value =
            "viewer";

    }

    if (executeCheckbox) {

        executeCheckbox.checked =
            false;

    }

    if (message) {

        message.textContent =
            "";

        message.className =
            "share-message";

    }


    // --------------------------------------------------------
    // Open modal
    // --------------------------------------------------------

    modal.classList.add(
        "show"
    );

    document.body.classList.add(
        "modal-open"
    );


    // --------------------------------------------------------
    // Load existing sharing information
    // --------------------------------------------------------

    if (isFolder) {
        await loadFolderShareInformation(fileId);
        await loadGeneralAccess(fileId);
    } else {
        await loadShareInformation(fileId);
    }


    // --------------------------------------------------------
    // Focus email input
    // --------------------------------------------------------

    setTimeout(
        () => {

            if (emailInput) {

                emailInput.focus();

            }

        },
        100
    );

}


// ============================================================
// CLOSE SHARE MODAL
// ============================================================

function closeShareModal() {

    const modal =
        document.getElementById(
            "shareModal"
        );

    if (modal) {

        modal.classList.remove(
            "show"
        );

    }

    document.body.classList.remove(
        "modal-open"
    );

    currentShareFileId =
        null;

    currentShareFolderId = null;

    currentShareFileName =
        "";

    if (modal) modal.classList.remove("folder-share-mode");

}


// ============================================================
// LOAD SHARE INFORMATION
// ============================================================

async function loadShareInformation(
    fileId
) {

    try {

        // ----------------------------------------------------
        // Load people with access
        // ----------------------------------------------------

        const sharesResponse =
            await fetch(
                `/api/files/${fileId}/shares`,
                {
                    credentials:
                        "include"
                }
            );

        const sharesData =
            await sharesResponse.json();


        if (sharesResponse.ok) {

            renderSharedUsers(
                sharesData.shares ||
                []
            );

        } else {

            renderSharedUsers(
                []
            );

        }


        // ----------------------------------------------------
        // Load general access
        // ----------------------------------------------------

        await loadGeneralAccess(
            fileId
        );

    } catch (error) {

        console.error(
            "Load share information error:",
            error
        );

    }

}

async function loadFolderShareInformation(folderId) {
    try {
        const response = await fetch(`/api/files/folders/${folderId}/shares`, {
            credentials: "include"
        });
        const data = await response.json();
        if (!response.ok) {
            showShareMessage(data.message || "Unable to load folder access.", "error");
            renderSharedUsers([]);
            return;
        }
        renderSharedUsers(data.shares || []);
    } catch (error) {
        console.error("Load folder shares error:", error);
        showShareMessage("Unable to load folder access.", "error");
        renderSharedUsers([]);
    }
}


// ============================================================
// RENDER SHARED USERS
// ============================================================

function renderSharedUsers(
    shares
) {

    const container =
        document.getElementById(
            "sharedUsers"
        );

    if (!container) {
        return;
    }


    if (
        !shares ||
        shares.length === 0
    ) {

        container.innerHTML = `
            <div class="no-shared-users">
                <span>👤</span>
                <span>
                    No other users have access
                </span>
            </div>
        `;

        return;

    }


    container.innerHTML =
        "";


    shares.forEach(
        share => {

            const user =
                document.createElement(
                    "div"
                );

            user.className =
                "shared-user";


            const name =
                escapeHtml(
                    share.username ||
                    share.email ||
                    "User"
                );

            const email =
                escapeHtml(
                    share.email ||
                    ""
                );


            const role =
                share.can_write
                    ? "Editor"
                    : "Viewer";


            user.innerHTML = `

                <div class="shared-user-avatar">
                    ${getInitials(
                        share.username ||
                        share.email ||
                        "U"
                    )}
                </div>

                <div class="shared-user-info">

                    <div class="shared-user-name">
                        ${name}
                    </div>

                    <div class="shared-user-email">
                        ${email}
                    </div>

                </div>

                <div class="shared-user-role">
                    ${role}
                </div>

                <button
                    type="button"
                    class="remove-share-button"
                    title="Remove access"
                    onclick="removeShare(${share.id})"
                >
                    ×
                </button>

            `;

            container.appendChild(
                user
            );

        }
    );

}


// ============================================================
// GET INITIALS
// ============================================================

function getInitials(
    value
) {

    const text =
        String(
            value || "U"
        ).trim();

    if (!text) {
        return "U";
    }

    const parts =
        text.split(
            /\s+/
        );

    if (
        parts.length >= 2
    ) {

        return (
            parts[0][0] +
            parts[1][0]
        ).toUpperCase();

    }

    return text
        .substring(
            0,
            2
        )
        .toUpperCase();

}


// ============================================================
// SEND SHARE
// ============================================================

async function sendShare() {

    if (!currentShareFileId && !currentShareFolderId) {

        showShareMessage(
            "No file selected.",
            "error"
        );

        return;

    }


    const emailInput =
        document.getElementById(
            "shareEmail"
        );

    const roleSelect =
        document.getElementById(
            "shareRole"
        );

    const executeCheckbox =
        document.getElementById(
            "shareExecute"
        );

    const sendButton =
        document.getElementById(
            "sendShareButton"
        );


    const email =
        emailInput
            ? emailInput.value.trim()
            : "";


    if (!email) {

        showShareMessage(
            "Please enter an email address.",
            "error"
        );

        if (emailInput) {

            emailInput.focus();

        }

        return;

    }


    // --------------------------------------------------------
    // Determine permissions
    // --------------------------------------------------------

    const role =
        roleSelect
            ? roleSelect.value
            : "viewer";

    const canRead =
        true;

    const canWrite =
        role === "editor";

    const canExecute =
        executeCheckbox
            ? executeCheckbox.checked
            : false;


    // --------------------------------------------------------
    // Disable button
    // --------------------------------------------------------

    if (sendButton) {

        sendButton.disabled =
            true;

        sendButton.dataset.originalText =
            sendButton.textContent;

        sendButton.textContent =
            "Sending...";

    }


    try {

        const shareUrl = currentShareFolderId
            ? `/api/files/folders/${currentShareFolderId}/share`
            : `/api/files/${currentShareFileId}/share`;
        const response =
            await fetch(
                shareUrl,
                {
                    method: "POST",

                    credentials:
                        "include",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            email,
                            canRead,
                            canWrite,
                            canExecute
                        })
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

        showShareMessage(
            data.message ||
            "Unable to share item.",
                "error"
            );

            return;

        }


        // ----------------------------------------------------
        // Success
        // ----------------------------------------------------

        showShareMessage(
            data.message ||
            "Shared successfully.",
            "success"
        );


        if (emailInput) {

            emailInput.value =
                "";

        }

        if (roleSelect) {

            roleSelect.value =
                "viewer";

        }

        if (executeCheckbox) {

            executeCheckbox.checked =
                false;

        }


        // Refresh people list

        if (currentShareFolderId) await loadFolderShareInformation(currentShareFolderId);
        else await loadShareInformation(currentShareFileId);


        setTimeout(
            () => {

                const message =
                    document.getElementById(
                        "shareMessage"
                    );

                if (message) {

                    message.textContent =
                        "";

                    message.className =
                        "share-message";

                }

            },
            3000
        );


    } catch (error) {

        console.error(
            "Share error:",
            error
        );

        showShareMessage(
            "Unable to connect to server.",
            "error"
        );

    } finally {

        if (sendButton) {

            sendButton.disabled =
                false;

            sendButton.textContent =
                sendButton.dataset.originalText ||
                "Send";

        }

    }

}


// ============================================================
// SHOW SHARE MESSAGE
// ============================================================

function showShareMessage(
    message,
    type
) {

    const element =
        document.getElementById(
            "shareMessage"
        );

    if (!element) {
        return;
    }

    element.textContent =
        message;

    element.className =
        `share-message ${type}`;

}


// ============================================================
// REMOVE SHARE
// ============================================================

async function removeShare(
    shareId
) {

    if (!currentShareFileId && !currentShareFolderId) {
        return;
    }

    if (!shareId) {
        return;
    }


    const confirmed = await window.showAppConfirm({
        title: "Remove access?",
        message: currentShareFolderId
            ? "This person will no longer be able to access this folder or its contents."
            : "This person will no longer be able to open this file.",
        confirmText: "Remove access",
        cancelText: "Cancel",
        danger: true
    });


    if (!confirmed) {
        return;
    }


    try {

        const removeUrl = currentShareFolderId
            ? `/api/files/folders/${currentShareFolderId}/share/${shareId}`
            : `/api/files/${currentShareFileId}/share/${shareId}`;
        const response =
            await fetch(
                removeUrl,
                {
                    method: "DELETE",

                    credentials:
                        "include"
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            showShareMessage(
                data.message ||
                "Unable to remove access.",
                "error"
            );

            return;

        }


        showShareMessage(
            data.message ||
            "Access removed.",
            "success"
        );


        if (currentShareFolderId) await loadFolderShareInformation(currentShareFolderId);
        else await loadShareInformation(currentShareFileId);


    } catch (error) {

        console.error(
            "Remove share error:",
            error
        );

        showShareMessage(
            "Unable to connect to server.",
            "error"
        );

    }

}


// ============================================================
// LOAD GENERAL ACCESS
// ============================================================

async function loadGeneralAccess(
    fileId
) {

    const isFolder = Boolean(currentShareFolderId);

    const restrictedRadio =
        document.getElementById(
            "generalRestricted"
        );

    const anyoneRadio =
        document.getElementById(
            "generalAnyone"
        );

    const publicRole =
        document.getElementById(
            "publicRole"
        );

    const executeCheckbox =
        document.getElementById(
            "publicExecute"
        );

    const linkContainer =
        document.getElementById(
            "shareLinkContainer"
        );

    const linkInput =
        document.getElementById(
            "shareLink"
        );


    try {

        const response =
            await fetch(
                isFolder
                    ? `/api/files/folders/${fileId}/general-access`
                    : `/api/files/${fileId}/general-access`,
                {
                    credentials:
                        "include"
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            setGeneralAccessUI(
                false,
                "viewer",
                false
            );

            return;

        }


        const access =
            data.generalAccess ||
            data.data ||
            data;


        const enabled =
            Boolean(
                access.enabled ??
                access.public_access ??
                false
            );


        const canWrite =
            !isFolder &&
            Boolean(
                access.canWrite ??
                access.public_can_write ??
                false
            );


        const canExecute =
            !isFolder &&
            Boolean(
                access.canExecute ??
                access.public_can_execute ??
                false
            );


        if (restrictedRadio) {

            restrictedRadio.checked =
                !enabled;

        }


        if (anyoneRadio) {

            anyoneRadio.checked =
                enabled;

        }


        if (publicRole) {

            publicRole.value =
                canWrite
                    ? "editor"
                    : "viewer";

        }


        if (executeCheckbox) {

            executeCheckbox.checked =
                canExecute;

        }


        if (
            enabled &&
            access.token
        ) {

            const link =
                isFolder
                    ? `${window.location.origin}/shared-folder.html?token=${encodeURIComponent(access.token)}`
                    : `${window.location.origin}/shared/${access.token}`;


            if (linkInput) {

                linkInput.value =
                    link;

            }


            if (linkContainer) {

                linkContainer.style.display =
                    "flex";

            }

        } else {

            if (linkContainer) {

                linkContainer.style.display =
                    "none";

            }

        }


        updateGeneralAccessVisibility();

    } catch (error) {

        console.error(
            "General access error:",
            error
        );

    }

}


// ============================================================
// SET GENERAL ACCESS UI
// ============================================================

function setGeneralAccessUI(
    enabled,
    role,
    execute
) {

    const restrictedRadio =
        document.getElementById(
            "generalRestricted"
        );

    const anyoneRadio =
        document.getElementById(
            "generalAnyone"
        );

    const publicRole =
        document.getElementById(
            "publicRole"
        );

    const executeCheckbox =
        document.getElementById(
            "publicExecute"
        );


    if (restrictedRadio) {

        restrictedRadio.checked =
            !enabled;

    }


    if (anyoneRadio) {

        anyoneRadio.checked =
            enabled;

    }


    if (publicRole) {

        publicRole.value =
            role ||
            "viewer";

    }


    if (executeCheckbox) {

        executeCheckbox.checked =
            Boolean(
                execute
            );

    }


    updateGeneralAccessVisibility();

}


// ============================================================
// GENERAL ACCESS CHANGE
// ============================================================

async function updateGeneralAccess() {

    if (!currentShareFileId && !currentShareFolderId) {
        return;
    }

    const isFolder = Boolean(currentShareFolderId);
    const targetId = currentShareFolderId || currentShareFileId;


    const anyoneRadio =
        document.getElementById(
            "generalAnyone"
        );

    const publicRole =
        document.getElementById(
            "publicRole"
        );

    const executeCheckbox =
        document.getElementById(
            "publicExecute"
        );


    const enabled =
        anyoneRadio
            ? anyoneRadio.checked
            : false;


    const canWrite =
        !isFolder && enabled &&
        publicRole &&
        publicRole.value ===
            "editor";


    const canExecute =
        !isFolder && enabled &&
        executeCheckbox
            ? executeCheckbox.checked
            : false;


    try {

        const response =
            await fetch(
                isFolder
                    ? `/api/files/folders/${targetId}/general-access`
                    : `/api/files/${targetId}/general-access`,
                {
                    method: "PATCH",

                    credentials:
                        "include",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            enabled,
                            canWrite,
                            canExecute,
                            publicAccess: enabled,
                            publicCanWrite: canWrite,
                            publicCanExecute: canExecute
                        })
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            showShareMessage(
                data.message ||
                "Unable to update general access.",
                "error"
            );

            // Reload previous state

            await loadGeneralAccess(targetId);

            return;

        }


        showShareMessage(
            enabled
                ? `Anyone with the link can access this ${isFolder ? "folder" : "file"}.`
                : `${isFolder ? "Folder" : "File"} access is now restricted.`,
            "success"
        );


        // Reload generated token/link

        await loadGeneralAccess(targetId);


    } catch (error) {

        console.error(
            "Update general access error:",
            error
        );

        showShareMessage(
            "Unable to connect to server.",
            "error"
        );

    }

}


// ============================================================
// GENERAL ACCESS UI VISIBILITY
// ============================================================

function updateGeneralAccessVisibility() {

    const anyoneRadio =
        document.getElementById(
            "generalAnyone"
        );

    const publicOptions =
        document.getElementById(
            "publicAccessOptions"
        );

    if (!publicOptions) {
        return;
    }


    const enabled =
        anyoneRadio
            ? anyoneRadio.checked
            : false;


    publicOptions.style.display =
        enabled
            ? "block"
            : "none";

}


// ============================================================
// COPY SHARE LINK
// ============================================================

async function copyShareLink() {

    const linkInput =
        document.getElementById(
            "shareLink"
        );


    if (!linkInput) {

        showShareMessage(
            "Share link is not available.",
            "error"
        );

        return;

    }


    const link =
        linkInput.value.trim();


    if (!link) {

        showShareMessage(
            "Enable 'Anyone with the link' first.",
            "error"
        );

        return;

    }


    try {

        await navigator.clipboard.writeText(
            link
        );


        showShareMessage(
            "Link copied to clipboard.",
            "success"
        );


    } catch (error) {

        console.error(
            "Clipboard error:",
            error
        );


        // Fallback for older browsers

        linkInput.select();

        linkInput.setSelectionRange(
            0,
            99999
        );


        try {

            document.execCommand(
                "copy"
            );

            showShareMessage(
                "Link copied to clipboard.",
                "success"
            );

        } catch (copyError) {

            showShareMessage(
                "Unable to copy link.",
                "error"
            );

        }

    }

}


// ============================================================
// CLOSE MODAL WHEN CLICKING OUTSIDE
// ============================================================

const shareModal =
    document.getElementById(
        "shareModal"
    );

if (shareModal) {

    shareModal.addEventListener(
        "click",
        event => {

            if (
                event.target ===
                shareModal
            ) {

                closeShareModal();

            }

        }
    );

}


// ============================================================
// CLOSE BUTTON
// ============================================================

const closeShareButton =
    document.getElementById(
        "closeShareModal"
    );

if (closeShareButton) {

    closeShareButton.addEventListener(
        "click",
        closeShareModal
    );

}


// ============================================================
// CANCEL BUTTON
// ============================================================

const cancelShareButton =
    document.getElementById(
        "cancelShareButton"
    );

if (cancelShareButton) {

    cancelShareButton.addEventListener(
        "click",
        closeShareModal
    );

}


// ============================================================
// DONE BUTTON
// ============================================================

const doneShareButton =
    document.getElementById(
        "doneShareButton"
    );

if (doneShareButton) {

    doneShareButton.addEventListener(
        "click",
        closeShareModal
    );

}


// ============================================================
// SEND SHARE BUTTON
// ============================================================

const sendShareButton =
    document.getElementById(
        "sendShareButton"
    );

if (sendShareButton) {

    sendShareButton.addEventListener(
        "click",
        sendShare
    );

}


// ============================================================
// EMAIL ENTER KEY
// ============================================================

const shareEmail =
    document.getElementById(
        "shareEmail"
    );

if (shareEmail) {

    shareEmail.addEventListener(
        "keydown",
        event => {

            if (
                event.key ===
                "Enter"
            ) {

                event.preventDefault();

                sendShare();

            }

        }
    );

}


// ============================================================
// GENERAL ACCESS - RESTRICTED
// ============================================================

const generalRestricted =
    document.getElementById(
        "generalRestricted"
    );

if (generalRestricted) {

    generalRestricted.addEventListener(
        "change",
        async () => {

            if (
                !generalRestricted.checked
            ) {
                return;
            }

            await updateGeneralAccess();

        }
    );

}


// ============================================================
// GENERAL ACCESS - ANYONE
// ============================================================

const generalAnyone =
    document.getElementById(
        "generalAnyone"
    );

if (generalAnyone) {

    generalAnyone.addEventListener(
        "change",
        async () => {

            updateGeneralAccessVisibility();

            if (
                generalAnyone.checked
            ) {

                await updateGeneralAccess();

            }

        }
    );

}


// ============================================================
// PUBLIC ROLE CHANGE
// ============================================================

const publicRole =
    document.getElementById(
        "publicRole"
    );

if (publicRole) {

    publicRole.addEventListener(
        "change",
        async () => {

            const anyone =
                document.getElementById(
                    "generalAnyone"
                );

            if (
                anyone &&
                anyone.checked
            ) {

                await updateGeneralAccess();

            }

        }
    );

}


// ============================================================
// PUBLIC EXECUTE CHANGE
// ============================================================

const publicExecute =
    document.getElementById(
        "publicExecute"
    );

if (publicExecute) {

    publicExecute.addEventListener(
        "change",
        async () => {

            const anyone =
                document.getElementById(
                    "generalAnyone"
                );

            if (
                anyone &&
                anyone.checked
            ) {

                await updateGeneralAccess();

            }

        }
    );

}


const copyShareLinkButton =
    document.getElementById(
        "copyShareLinkButton"
    );

if (copyShareLinkButton) {

    copyShareLinkButton.addEventListener(
        "click",
        copyShareLink
    );

}


// ============================================================
// ESC KEY CLOSE MODAL
// ============================================================

document.addEventListener(
    "keydown",
    event => {

        if (
            event.key ===
            "Escape"
        ) {

            const modal =
                document.getElementById(
                    "shareModal"
                );

            if (
                modal &&
                modal.classList.contains(
                    "show"
                )
            ) {

                closeShareModal();

            }

        }

    }
);


// ============================================================
// LOGOUT
// ============================================================

const logoutButton =
    document.getElementById(
        "logoutButton"
    );

if (logoutButton) {

    logoutButton.addEventListener(
        "click",
        async () => {

            logoutButton.disabled =
                true;

            logoutButton.textContent =
                "Logging out...";


            try {

                await fetch(
                    "/api/auth/logout",
                    {
                        method: "POST",

                        credentials:
                            "include"
                    }
                );

            } catch (error) {

                console.error(
                    "Logout error:",
                    error
                );

            }


            window.location.href =
                "/login.html";

        }
    );

}


// ============================================================
// INITIAL LOAD
// ============================================================

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        await loadUser();

        await loadFiles();

        updateGeneralAccessVisibility();

    }
);
