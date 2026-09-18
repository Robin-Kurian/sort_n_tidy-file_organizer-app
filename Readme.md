# Sort & Tidy

Desktop app that watches a folder and sorts new files into type folders: Documents, Images, Audio, Video, Compressed, Apps, Ebooks, and Others.

Works on **macOS**, **Windows**, and **Ubuntu** (Linux).

## Run

```bash
npm install
npm start
```

Development with extra logging:

```bash
npm run dev
```

The window defaults to your Downloads folder. Pick another folder if you want, then start monitoring. Check **Process existing files** to sort what is already there.

Folders named `Mobiux`, `Personal`, or `Protected` are left alone.

## Build

| Platform | Command | Output |
| --- | --- | --- |
| macOS | `npm run build-mac` | `dist/Sort & Tidy-1.0.0-arm64.dmg` |
| Windows | `npm run build-win` | `dist/Sort & Tidy Setup.exe` |
| Linux | `npm run build-linux` | AppImage and `.deb` in `dist/` |
| Current OS | `npm run build` | Platform default installer |

On a Mac, drag **Sort & Tidy** from the DMG into Applications. The first launch of an unsigned build may need **Right-click → Open**.

## Project layout

```
sort_and_tidy-file_organizer-app/
├── package.json
├── main.js          # Electron main process
├── index.html
├── styles.css
├── icon.png
├── recycle-bin.png
├── assets/
│   └── icon.png     # 1024px build icon
├── .vscode/
│   └── launch.json
└── dist/            # Created after building
```

## Debug

Open DevTools from the `createWindow` function in `main.js`:

```javascript
mainWindow.webContents.openDevTools();
```

Inspect the main process:

```bash
npx electron --inspect=5858 .
```
