const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("node:path");
const fs = require("fs");
const os = require("os");
const chokidar = require("chokidar");

const APP_NAME = "Sort & Tidy";
app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
});

let mainWindow;
let watcher;
let selectedPath = null;
let inFlightMoves = 0;
let processExistingRunning = false;
let watcherGeneration = 0;
let debugMemTimer = null;
let logSendCount = 0;

// #region agent log
function debugLog(location, message, data, hypothesisId) {
  const mem = process.memoryUsage();
  fetch("http://127.0.0.1:7547/ingest/d0098482-1d27-4250-980b-13a312dcffc3", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "390797",
    },
    body: JSON.stringify({
      sessionId: "390797",
      location,
      message,
      data: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        inFlightMoves,
        processExistingRunning,
        watcherGeneration,
        hasWatcher: Boolean(watcher),
        logSendCount,
        ...data,
      },
      timestamp: Date.now(),
      hypothesisId,
    }),
  }).catch(() => {});
}
function startDebugMemTimer() {
  if (debugMemTimer) {
    clearInterval(debugMemTimer);
  }
  debugMemTimer = setInterval(() => {
    debugLog("main.js:debugMemTimer", "periodic-memory", {}, "H5");
  }, 4000);
}
function stopDebugMemTimer() {
  if (debugMemTimer) {
    clearInterval(debugMemTimer);
    debugMemTimer = null;
  }
}
// #endregion

if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (!app.isPackaged) {
    app.commandLine.appendSwitch("no-sandbox");
  }
}

const PROTECTED_FOLDERS = ["Mobiux", "Personal", "Protected"];
const CATEGORY_FOLDERS = [
  "Documents",
  "Images",
  "Audio",
  "Video",
  "Compressed",
  "Apps",
  "Ebooks",
  "Others",
];
const INCOMPLETE_EXTENSIONS = new Set([
  "crdownload",
  "part",
  "download",
  "tmp",
  "temp",
  "partial",
  "filepart",
  "opdownload",
]);
const RETRYABLE_MOVE_ERRORS = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
  "EAGAIN",
  "ENOENT",
  "ELOCKED",
]);

const fileCategories = {
  documents: [
    "pdf",
    "doc",
    "docx",
    "txt",
    "rtf",
    "odt",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "pages",
    "numbers",
    "key",
    "csv",
  ],
  images: [
    "jpg",
    "jpeg",
    "png",
    "gif",
    "psd",
    "ico",
    "icns",
    "bmp",
    "tiff",
    "tif",
    "webp",
    "svg",
    "heic",
    "heif",
    "avif",
  ],
  audio: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "aiff", "wma"],
  video: ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg"],
  compressed: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"],
  apps: [
    "exe",
    "msi",
    "bat",
    "cmd",
    "dmg",
    "pkg",
    "app",
    "deb",
    "rpm",
    "appimage",
    "snap",
    "flatpak",
    "apk",
  ],
  ebooks: ["epub", "mobi", "azw", "azw3", "fb2", "lit"],
};

function getDefaultWatchPath() {
  let downloadsPath;
  try {
    downloadsPath = app.getPath("downloads");
  } catch {
    downloadsPath = path.join(os.homedir(), "Downloads");
  }

  if (fs.existsSync(downloadsPath)) {
    return downloadsPath;
  }

  try {
    fs.mkdirSync(downloadsPath, { recursive: true });
    return downloadsPath;
  } catch {
    return os.homedir();
  }
}

function sendLog(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    logSendCount += 1;
    mainWindow.webContents.send("log", message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFolderIfNotExists(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
}

function isIncompleteDownload(fileName) {
  const lowerName = fileName.toLowerCase();
  const ext = path.extname(lowerName).slice(1);
  return (
    fileName.startsWith(".") ||
    fileName.startsWith("~$") ||
    INCOMPLETE_EXTENSIONS.has(ext)
  );
}

function uniqueDestinationPath(destinationPath) {
  if (!fs.existsSync(destinationPath)) {
    return destinationPath;
  }

  const dir = path.dirname(destinationPath);
  const ext = path.extname(destinationPath);
  const base = path.basename(destinationPath, ext);
  let index = 1;
  let candidate;

  do {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  } while (fs.existsSync(candidate));

  return candidate;
}

function getFileCategory(filePath, stats) {
  const ext = path.extname(filePath).slice(1).toLowerCase();

  if (stats.isDirectory()) {
    return ext === "app" ? "Apps" : null;
  }

  for (const [category, extensions] of Object.entries(fileCategories)) {
    if (extensions.includes(ext)) {
      return category.charAt(0).toUpperCase() + category.slice(1);
    }
  }

  return "Others";
}

async function movePathSafely(sourcePath, destinationPath) {
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      try {
        fs.renameSync(sourcePath, destinationPath);
      } catch (error) {
        if (error.code !== "EXDEV") {
          throw error;
        }
        fs.cpSync(sourcePath, destinationPath, { recursive: true });
        fs.rmSync(sourcePath, { recursive: true, force: true });
      }
      return;
    } catch (error) {
      if (!RETRYABLE_MOVE_ERRORS.has(error.code) || attempt === maxAttempts - 1) {
        throw error;
      }
      await delay(400);
    }
  }
}

async function moveFile(filePath) {
  inFlightMoves += 1;
  // #region agent log
  if (inFlightMoves > 1 || logSendCount % 10 === 0) {
    debugLog(
      "main.js:moveFile:entry",
      "move-start",
      { fileName: path.basename(filePath) },
      "H3"
    );
  }
  // #endregion
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const parentFolder = path.basename(path.dirname(filePath));

    if (PROTECTED_FOLDERS.includes(parentFolder)) {
      return;
    }

    if (CATEGORY_FOLDERS.includes(fileName) || PROTECTED_FOLDERS.includes(fileName)) {
      return;
    }

    if (isIncompleteDownload(fileName)) {
      return;
    }

    const targetFolder = getFileCategory(filePath, stats);
    if (!targetFolder) {
      return;
    }

    if (stats.isDirectory() && targetFolder !== "Apps") {
      return;
    }

    const destinationFolder = path.join(selectedPath, targetFolder);
    createFolderIfNotExists(destinationFolder);

    const destinationPath = uniqueDestinationPath(
      path.join(destinationFolder, fileName)
    );

    if (path.resolve(filePath) === path.resolve(destinationPath)) {
      return;
    }

    await movePathSafely(filePath, destinationPath);
    sendLog(`Moved ${fileName} to ${targetFolder} folder`);
  } catch (error) {
    sendLog(`Error processing file: ${error.message}`);
  } finally {
    inFlightMoves -= 1;
  }
}

async function processExistingFiles() {
  processExistingRunning = true;
  // #region agent log
  debugLog("main.js:processExistingFiles:start", "process-existing-start", {}, "H4");
  // #endregion
  try {
  if (!selectedPath || !fs.existsSync(selectedPath)) {
    sendLog("Selected folder does not exist.");
    return;
  }

  sendLog(`Processing existing files in ${selectedPath} folder...`);
  const files = fs.readdirSync(selectedPath);
  // #region agent log
  debugLog(
    "main.js:processExistingFiles:readdir",
    "process-existing-listing",
    { fileCount: files.length },
    "H4"
  );
  // #endregion

  for (const file of files) {
    if (PROTECTED_FOLDERS.includes(file) || CATEGORY_FOLDERS.includes(file)) {
      continue;
    }

    const filePath = path.join(selectedPath, file);
    try {
      await moveFile(filePath);
    } catch (error) {
      sendLog(`Error processing ${file}: ${error.message}`);
    }
  }

  sendLog("Finished processing existing files.");
  } finally {
    processExistingRunning = false;
    // #region agent log
    debugLog("main.js:processExistingFiles:end", "process-existing-end", {}, "H4");
    // #endregion
  }
}

function startWatcher() {
  if (watcher) {
    const oldWatcher = watcher;
    const oldGeneration = watcherGeneration;
    // #region agent log
    debugLog(
      "main.js:startWatcher:close-old",
      "closing-old-watcher-without-await",
      { oldGeneration, addListeners: oldWatcher.listenerCount("add") },
      "H2"
    );
    // #endregion
    const closeResult = oldWatcher.close();
    if (closeResult && typeof closeResult.then === "function") {
      closeResult.then(() => {
        // #region agent log
        debugLog(
          "main.js:startWatcher:old-closed",
          "old-watcher-close-resolved",
          { oldGeneration, stillSameInstance: watcher === oldWatcher },
          "H2"
        );
        // #endregion
      }).catch(() => {});
    }
  }

  if (!selectedPath || !fs.existsSync(selectedPath)) {
    sendLog("Cannot monitor: selected folder does not exist.");
    return;
  }

  watcher = chokidar.watch(selectedPath, {
    ignored: [
      /(^|[\\/])\../,
      "**/Documents/**",
      "**/Images/**",
      "**/Audio/**",
      "**/Video/**",
      "**/Compressed/**",
      "**/Apps/**",
      "**/Ebooks/**",
      "**/Others/**",
      ...PROTECTED_FOLDERS.map((folder) => `**/${folder}/**`),
    ],
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    ignorePermissionErrors: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 200,
    },
  });

  watcher
    .on("add", (filePath) => {
      moveFile(filePath);
    })
    .on("addDir", (dirPath) => {
      if (path.resolve(dirPath) !== path.resolve(selectedPath)) {
        moveFile(dirPath);
      }
    })
    .on("error", (error) => {
      sendLog(`Watcher error: ${error}`);
    });

  watcherGeneration += 1;
  startDebugMemTimer();
  sendLog(`Monitoring folder: ${selectedPath}`);
  // #region agent log
  debugLog(
    "main.js:startWatcher:created",
    "watcher-created",
    { addListeners: watcher.listenerCount("add") },
    "H2"
  );
  // #endregion
}

function setupApplicationMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `About ${APP_NAME}` },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${APP_NAME}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${APP_NAME}` },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      role: "window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getWindowOptions() {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  const options = {
    width: 460,
    height: 600,
    useContentSize: true,
    show: false,
    backgroundColor: "#00000000",
    roundedCorners: true,
    hasShadow: true,
    acceptFirstMouse: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: !isMac,
    resizable: false,
  };

  if (isMac) {
    options.vibrancy = "fullscreen-ui";
    options.visualEffectState = "active";
    options.titleBarStyle = "hiddenInset";
    options.trafficLightPosition = { x: 16, y: 18 };
  } else if (isWin) {
    options.backgroundMaterial = "acrylic";
  }

  return options;
}

function createWindow() {
  mainWindow = new BrowserWindow(getWindowOptions());
  mainWindow.setBackgroundColor("#00000000");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("folder-path", selectedPath);
  });

  mainWindow.loadFile("index.html");
}

function closeWatcher() {
  if (watcher) {
    const closing = watcher;
    watcher = null;
    stopDebugMemTimer();
    // #region agent log
    debugLog("main.js:closeWatcher", "close-watcher-called", {}, "H2");
    // #endregion
    const closeResult = closing.close();
    if (closeResult && typeof closeResult.then === "function") {
      closeResult.then(() => {
        // #region agent log
        debugLog("main.js:closeWatcher:resolved", "watcher-close-resolved", {}, "H2");
        // #endregion
      }).catch(() => {});
    }
  }
}

app.whenReady().then(() => {
  selectedPath = getDefaultWatchPath();
  console.log(`Default folder (${process.platform}/${process.arch}): ${selectedPath}`);
  setupApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
});

app.on("window-all-closed", () => {
  closeWatcher();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  closeWatcher();
});

ipcMain.handle("get-selected-folder", () => selectedPath);

ipcMain.on("start-monitoring", (event, processExisting) => {
  // #region agent log
  debugLog(
    "main.js:start-monitoring",
    "start-monitoring-ipc",
    { processExisting },
    "H4"
  );
  // #endregion
  if (processExisting) {
    processExistingFiles();
  }
  startWatcher();
  // #region agent log
  debugLog(
    "main.js:start-monitoring:after-start",
    "watcher-started-maybe-overlap",
    { processExisting },
    "H4"
  );
  // #endregion
});

ipcMain.on("stop-monitoring", () => {
  if (watcher) {
    closeWatcher();
    sendLog("Stopped monitoring");
  }
});

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: selectedPath || os.homedir(),
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    selectedPath = result.filePaths[0];
    closeWatcher();
    sendLog(`Selected ${selectedPath} folder`);
    return selectedPath;
  }

  return null;
});
