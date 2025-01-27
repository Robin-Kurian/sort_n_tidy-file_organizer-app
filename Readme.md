Here's a step-by-step guide to test, debug, and create an installer for your app:

1. First, install the required development dependencies:

```bash
npm install electron-builder --save-dev
npm install electron --save-dev
```

2. Update your package.json

```bash
{
  "name": "file-organizer",
  "version": "1.0.0",
  "main": "main.electron.js",
  "scripts": {
    "start": "electron .",
    "dev": "electron . --debug",
    "build": "electron-builder",
    "build-win": "electron-builder --win"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "dependencies": {
    "chokidar": "^4.0.3",
    "electron-log": "^5.2.4"
  },
  "description": "",
  "build": {
    "appId": "com.fileorganizer.app",
    "productName": "File Organizer",
    "win": {
      "target": "nsis",
      "icon": "assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  },
  "devDependencies": {
    "electron": "^34.0.1",
    "electron-builder": "^25.1.8"
  }
}

```

3. To test and debug:

```bash
# Run in development mode
npm run dev

# To open Chrome DevTools in the app, add this line to main.electron.js in the createWindow function:
mainWindow.webContents.openDevTools();
```

4. To build the installer:

```bash
# For Windows
npm run build-win
```

The installer will be created in the `dist` folder.

Debug Tips:

1. Add console logs in your code:

```javascript
// In main.electron.js
console.log("Debug:", someVariable);

// In index.html script
console.log("UI Debug:", someValue);
```

2. Enable more detailed logging by adding this to main.electron.js:

```javascript
// Add near the top of main.electron.js
process.env.NODE_ENV = "development";

// Add in createWindow function
if (process.env.NODE_ENV === "development") {
  mainWindow.webContents.openDevTools();
}
```

3. To debug the main process:

```javascript
// Add to package.json scripts
"debug-main": "electron --inspect=5858 ."
```

Then run:

```bash
npm run debug-main
```

File Structure should look like:

```
your-app/
├── package.json
├── main.electron.js
├── index.html
├── assets/
│   └── icon.ico
├── node_modules/
└── dist/            # Created after building
```

To test the complete workflow:

1. Development Testing:

```bash
# Install dependencies
npm install

# Run in dev mode
npm run dev
```

2. Build and Test Installer:

```bash
# Create installer
npm run build-win

# Go to dist folder
# Run the .exe installer
```

3. Common issues to check:

- Test folder selection
- Test file monitoring
- Test file organization
- Check if protected folders are respected
- Verify all file types are sorted correctly
- Test start/stop functionality
- Check if logs are displaying correctly

4. To create a production build:

```bash
# Set NODE_ENV to production in package.json
"build-win": "set NODE_ENV=production && electron-builder --win"

# Then build
npm run build-win
```

The installer will be in `dist/File Organizer Setup.exe`. Users can:

1. Run the installer
2. Choose installation directory
3. Create desktop/start menu shortcuts
4. Launch the app
5. Uninstall through Windows Control Panel if needed
