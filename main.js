const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("node:path");
const fs = require("fs");
const os = require("os");
const chokidar = require("chokidar");

const APP_NAME = "Sort N Tidy";
app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
});

let mainWindow;
let watcher;
let selectedPath = null;
let session;
let scanPromise;
let transition = Promise.resolve();
const { Organizer, CATEGORY_FOLDERS, PROTECTED_FOLDERS } = require('./organizer');

if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  if (!app.isPackaged) {
    app.commandLine.appendSwitch("no-sandbox");
  }
}

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
    mainWindow.webContents.send("log", message);
  }
}

async function closeWatcher() {
  const closing = watcher;
  watcher = null;
  const stopping = session;
  session = null;
  const stopped = stopping ? stopping.stop() : Promise.resolve();
  await Promise.all([closing ? closing.close() : Promise.resolve(), stopped, scanPromise]);
  scanPromise = null;
}

async function startWatcher(options) {
  await closeWatcher();
  if (!selectedPath || !(await fs.promises.stat(selectedPath)).isDirectory()) {
    throw new Error('Selected folder is not a directory.');
  }
  const root = selectedPath;
  const current = new Organizer(root, sendLog);
  session = current;
  watcher = chokidar.watch(root, {
    ignored: (entry) => {
      const relative = path.relative(root, entry);
      if (!relative) return false;
      const first = relative.split(path.sep)[0];
      return first.startsWith('.') || CATEGORY_FOLDERS.includes(first) || PROTECTED_FOLDERS.includes(first);
    },
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });
  watcher.on('add', entry => current.enqueue(entry))
    .on('addDir', entry => { if (entry !== root) current.enqueue(entry); })
    .on('error', error => sendLog(`Watcher error: ${error.message}`));
  // Wait for initial discovery before scanning, so new arrivals are not missed.
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { watcher.removeListener('ready', onReady); reject(error); };
      const onReady = () => { watcher.removeListener('error', onError); resolve(); };
      watcher.once('ready', onReady).once('error', onError);
    });
  } catch (error) {
    await closeWatcher();
    throw error;
  }
  sendLog(`Monitoring folder: ${root}`);
  if (options.processExisting || options.resortOthers) {
    scanPromise = current.scan(options.resortOthers);
  }
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
    height: 650,
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

app.on('window-all-closed', () => {
  transition = transition.then(closeWatcher).finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  transition = transition.then(closeWatcher).finally(() => { quitting = true; app.quit(); });
});

ipcMain.handle('get-selected-folder', () => selectedPath);
function changeState(action) {
  const result = transition.then(action);
  transition = result.catch(() => {});
  return result.then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
}
ipcMain.handle('start-monitoring', (event, options = {}) => changeState(() => startWatcher({
  processExisting: options.processExisting === true,
  resortOthers: options.resortOthers === true,
})));
ipcMain.handle('stop-monitoring', () => changeState(async () => {
  await closeWatcher();
  sendLog('Stopped monitoring');
}));
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: selectedPath || os.homedir(), properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  await changeState(async () => {
    await closeWatcher();
    selectedPath = result.filePaths[0];
    sendLog(`Selected ${selectedPath} folder`);
  });
  return selectedPath;
});
