![YT Music Manager](https://res.cloudinary.com/itsrobin/image/upload/v1790092653/sort_n_tidy_asrvwv.png)

# Sort N Tidy

Desktop app that watches a folder and sorts new files into Documents, Images, Audio, Video, Compressed, Apps, Ebooks, Code, Data, Design, 3D & CAD, Fonts, Subtitles, Disk Images, and Others.

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

Check **Re-sort recognized files in Others** to recover files sorted with the older mapping. Unknown formats stay in Others. This option also processes existing files in the selected folder.

Classification uses case-insensitive filename extensions. `.ts` defaults to TypeScript in Code; `.obj` defaults to a 3D model in 3D & CAD; `.sub` defaults to Subtitles; `.key` defaults to an Apple Keynote document. CSV stays in Documents. File contents are not inspected. Unknown and extensionless files go to Others. Ordinary directories and symbolic links are skipped; `.app`, `.pages`, `.numbers`, and `.key` package directories are supported.

Stop cancels queued work and waits for the active move to settle. A file already being copied is preserved at its source when cancellation is observed before source deletion. Duplicate names receive numbered suffixes without overwriting existing destinations. If a source changes during a copy, sorting leaves it in place and reports the error. Activity history keeps the latest 500 entries.

Folders named `Mobiux`, `Personal`, or `Protected` are left alone.

## Build

| Platform | Command | Output |
| --- | --- | --- |
| macOS | `npm run build-mac` | `dist/Sort N Tidy-1.0.1-arm64.dmg` |
| Windows | `npm run build-win` | `dist/Sort N Tidy Setup.exe` |
| Linux | `npm run build-linux` | AppImage and `.deb` in `dist/` |
| Current OS | `npm run build` | Platform default installer |

On a Mac, drag **Sort N Tidy** from the DMG into Applications. The first launch of an unsigned build may need **Right-click → Open**.

## Project layout

```
sort_n_tidy-file_organizer-app/
├── package.json
├── main.js          # Electron main process
├── organizer.js     # Categories, safe moves, and cancellable work queue
├── test/            # Filesystem regression tests
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

## Tests

Run `npm test` with Node.js 20 or newer. Tests use temporary folders and do not require Electron or access your Downloads folder.
