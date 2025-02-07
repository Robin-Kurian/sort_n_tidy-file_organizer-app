// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("node:path");
const fs = require("fs");
const chokidar = require("chokidar");

let mainWindow;
let watcher;
let selectedPath = path.join(process.env.USERPROFILE, "Downloads"); // Default path
const PROTECTED_FOLDERS = ["Mobiux", "Personal", "Protected"];

// Create folder if it doesn't exist
function createFolderIfNotExists(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath);
  }
}

// Function to move file to appropriate folder
function moveFile(filePath) {
  try {
    if (fs.statSync(filePath).isDirectory()) {
      return;
    }

    const fileName = path.basename(filePath);
    const parentFolder = path.basename(path.dirname(filePath));

    // Skip if file is in a protected folder
    if (PROTECTED_FOLDERS.includes(parentFolder)) {
      return;
    }

    const fileExt = path.extname(filePath).slice(1).toLowerCase();

    // Skip if it's a temporary file
    if (!fileExt || fileName.startsWith(".")) return;

    // Define file type categories
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
      ],
      images: [
        "jpg",
        "jpeg",
        "png",
        "gif",
        "psd",
        "ico",
        "bmp",
        "tiff",
        "webp",
        "svg",
        "heic",
      ],
      audio: ["mp3", "wav", "ogg", "flac", "m4a", "aac"],
      video: ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm"],
      compressed: ["zip", "rar", "7z", "tar", "gz"],
      apps: ["exe", "msi", "bat", "cmd"],
      ebooks: ["epub", "mobi", "azw", "azw3", "fb2", "lit"],
    };

    // Find the category for this file
    let targetFolder = "Others";
    for (const [category, extensions] of Object.entries(fileCategories)) {
      if (extensions.includes(fileExt)) {
        targetFolder = category.charAt(0).toUpperCase() + category.slice(1);
        break;
      }
    }

    const destinationFolder = path.join(selectedPath, targetFolder);

    // Create folder if it doesn't exist
    createFolderIfNotExists(destinationFolder);

    // Construct destination path
    const destinationPath = path.join(destinationFolder, fileName);

    // Move the file
    fs.renameSync(filePath, destinationPath);
    mainWindow.webContents.send(
      "log",
      `Moved ${fileName} to ${targetFolder} folder`
    );
  } catch (error) {
    mainWindow.webContents.send(
      "log",
      `Error processing file: ${error.message}`
    );
  }
}

// Function to process existing files
async function processExistingFiles() {
  mainWindow.webContents.send(
    "log",
    `Processing existing files in ${selectedPath} folder...`
  );
  const files = fs.readdirSync(selectedPath);
  for (const file of files) {
    const filePath = path.join(selectedPath, file);
    // Skip protected folders and their contents
    if (PROTECTED_FOLDERS.includes(file)) {
      continue;
    }
    if (fs.statSync(filePath).isFile()) {
      moveFile(filePath);
    }
  }
  mainWindow.webContents.send("log", "Finished processing existing files.");
}

function startWatcher() {
  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(selectedPath, {
    ignored: [
      /(^|[\/\\])\../, // ignore hidden files
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
  });

  watcher
    .on("add", (filePath) => {
      setTimeout(() => moveFile(filePath), 1000);
    })
    .on("error", (error) => {
      mainWindow.webContents.send("log", `Watcher error: ${error}`);
    });

  mainWindow.webContents.send("log", `Monitoring folder: ${selectedPath}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 550,
    webPreferences: {
      // preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
      // enableRemoteModule: false,
    },
    icon: path.join(__dirname, "icon.png"), // Set the app icon
    resizable: false, // Make the window non-resizable
  });
  mainWindow.loadFile("index.html");
  // Open the DevTools.
  // mainWindow.webContents.openDevTools();
}

// Remove the default menu
Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);

// Quit when all windows are closed
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Handle start monitoring
ipcMain.on("start-monitoring", (event, processExisting) => {
  if (processExisting) {
    processExistingFiles();
  }
  startWatcher();
});

// Handle stop monitoring
ipcMain.on("stop-monitoring", (event) => {
  if (watcher) {
    watcher.close();
    mainWindow.webContents.send("log", "Stopped monitoring");
  }
});

// Add folder selection handler
ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    selectedPath = result.filePaths[0];
    if (watcher) {
      watcher.close();
      mainWindow.webContents.send("log", "Stopped monitoring previous folder");
    }
    return selectedPath;
  }
  return null;
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
