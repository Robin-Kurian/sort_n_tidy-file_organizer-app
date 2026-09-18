const fs = require("fs");
const path = require("path");
const os = require("os");
const chokidar = require("chokidar"); // You'll need to install this package
const readline = require("readline");

// Get the Downloads folder path (Windows, macOS, and Linux)
const downloadsPath = path.join(os.homedir(), "Downloads");

// Add this constant near the top of the file with other constants
const PROTECTED_FOLDERS = ["Mobiux", "Personal", "Protected"];

// Function to create folder if it doesn't exist
function createFolderIfNotExists(folderPath) {
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
}

// Function to move file to appropriate folder
function moveFile(filePath) {
  try {
    // Skip if it's a directory
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
      archives: ["zip", "rar", "7z", "tar", "gz"],
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
      ],
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

    const destinationFolder = path.join(downloadsPath, targetFolder);

    // Create folder if it doesn't exist
    createFolderIfNotExists(destinationFolder);

    // Construct destination path
    const destinationPath = path.join(destinationFolder, fileName);

    // Move the file (EXDEV happens when source and dest are on different volumes)
    try {
      fs.renameSync(filePath, destinationPath);
    } catch (moveError) {
      if (moveError.code !== "EXDEV") {
        throw moveError;
      }
      fs.copyFileSync(filePath, destinationPath);
      fs.unlinkSync(filePath);
    }
    console.log(`Moved ${fileName} to ${targetFolder} folder`);
  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
  }
}

// Function to process existing files
async function processExistingFiles() {
  console.log("Processing existing files in Downloads folder...");
  const files = fs.readdirSync(downloadsPath);
  for (const file of files) {
    const filePath = path.join(downloadsPath, file);
    // Skip protected folders and their contents
    if (PROTECTED_FOLDERS.includes(file)) {
      continue;
    }
    if (fs.statSync(filePath).isFile()) {
      moveFile(filePath);
    }
  }
  console.log("Finished processing existing files.");
}

// Ask user for preference
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question(
  "Do you want to organize existing files? (yes/no): ",
  async (answer) => {
    if (answer.toLowerCase() === "yes") {
      await processExistingFiles();
    }

    // Initialize watcher for new files
    console.log("Starting to monitor for new downloads...");
    const watcher = chokidar.watch(downloadsPath, {
      ignored: [
        /(^|[\/\\])\../, // ignore hidden files
        "**/Documents/**",
        "**/Images/**",
        "**/Audio/**",
        "**/Video/**",
        "**/Archives/**",
        "**/Apps/**",
        "**/Ebooks/**",
        "**/Others/**",
        ...PROTECTED_FOLDERS.map((folder) => `**/${folder}/**`), // ignore protected folders
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 0, // Only watch the root of Downloads folder, ignore subfolders
    });

    // Watch for new files
    watcher
      .on("add", (filePath) => {
        // Wait a bit to ensure file is completely downloaded
        setTimeout(() => moveFile(filePath), 1000);
      })
      .on("error", (error) => console.error(`Watcher error: ${error}`));

    console.log(`Monitoring Downloads folder: ${downloadsPath}`);

    rl.close();
  }
);
