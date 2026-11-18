const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const CATEGORIES = Object.fromEntries(Object.entries({
  Documents: 'pdf doc docx txt rtf odt xls xlsx ppt pptx pages numbers key csv md markdown log tsv ods odp odg docm dot dotx dotm xlsm xlsb xlt xltx xltm pptm pps ppsx ppsm pot potx potm tex rst wps',
  Images: 'jpg jpeg png gif psd ico icns bmp tiff tif webp svg heic heif avif jfif jpe jxl apng dib heics heifs raw dng cr2 cr3 nef nrw arw raf orf rw2 pef srw',
  Audio: 'mp3 wav ogg flac m4a aac aiff wma aif aifc opus oga alac ape amr ac3 mid midi m4b',
  Video: 'mp4 avi mkv mov wmv flv webm m4v mpeg mpg mpe m2v mpv 3gp 3g2 mts m2ts vob ogv asf mxf f4v',
  Compressed: 'zip rar 7z tar gz tgz bz2 xz bz tbz tbz2 txz zst tzst lz lzma lz4 z cab',
  Apps: 'exe msi bat cmd dmg pkg app deb rpm appimage snap flatpak apk msix msixbundle appx appxbundle msu msp flatpakref flatpakrepo aab apks xapk ipa run',
  Ebooks: 'epub mobi azw azw3 fb2 lit azw4 kfx cbz cbr cb7 cbt cba djvu djv',
  Code: 'js jsx ts tsx py java c h cpp cs go rs swift kt php rb html css scss sql sh ps1',
  Data: 'json jsonl ndjson xml yaml yml toml ini sqlite sqlite3 db parquet arrow',
  Design: 'ai eps sketch fig xd indd idml afdesign afphoto afpub xcf kra',
  '3D & CAD': 'blend fbx obj stl 3mf gltf glb usd usdz dwg dxf step stp',
  Fonts: 'ttf otf woff woff2 ttc',
  Subtitles: 'srt vtt ass ssa sub sbv',
  'Disk Images': 'iso img vhd vhdx vmdk qcow2',
  Others: '',
}).map(([category, extensions]) => [category, extensions.split(' ').filter(Boolean)]));
const CATEGORY_FOLDERS = Object.keys(CATEGORIES);
const PROTECTED_FOLDERS = ['Mobiux', 'Personal', 'Protected'];
const INCOMPLETE = new Set('crdownload part download tmp temp partial filepart opdownload'.split(' '));
const PACKAGES = new Map([['app', 'Apps'], ['pages', 'Documents'], ['numbers', 'Documents'], ['key', 'Documents']]);
const EXTENSIONS = new Map(Object.entries(CATEGORIES).flatMap(([category, extensions]) => extensions.map(ext => [ext, category])));
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ELOCKED']);

function classify(name, stats) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (stats.isSymbolicLink() || name.startsWith('.') || name.startsWith('~$') || INCOMPLETE.has(ext)) return null;
  if (stats.isDirectory()) return PACKAGES.get(ext) || null;
  if (!stats.isFile()) return null;
  return EXTENSIONS.get(ext) || 'Others';
}

// Detect writes during a cross-volume copy before deleting its source.
async function sourceSnapshot(source) {
  const stats = await fs.lstat(source);
  const own = [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs];
  if (!stats.isDirectory()) return JSON.stringify(own);
  const children = [];
  for (const entry of (await fs.readdir(source)).sort()) {
    children.push([entry, await sourceSnapshot(path.join(source, entry))]);
  }
  return JSON.stringify([own, children]);
}

// Reserve the destination atomically: never replace a file created by another process.
async function moveExclusive(source, destination, stats, cancelled = () => false) {
  const ext = path.extname(destination);
  const base = destination.slice(0, destination.length - ext.length);
  for (let index = 0; !cancelled(); index++) {
    const target = index ? `${base} (${index})${ext}` : destination;
    let owned = false;
    let copied = false;
    let snapshot;
    try {
      if (stats.isDirectory()) {
        await fs.mkdir(target);
        owned = true;
        if (cancelled()) {
          await fs.rm(target, { recursive: true, force: true });
          return null;
        }
        try {
          // POSIX replaces only our empty reservation, preserving package metadata and live writes.
          await fs.rename(source, target);
          return target;
        } catch (error) {
          const windowsReservation = process.platform === 'win32' && ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code);
          if (error.code !== 'EXDEV' && !windowsReservation) throw error;
        }
        snapshot = await sourceSnapshot(source);
        for (const entry of await fs.readdir(source)) {
          if (cancelled()) break;
          await fs.cp(path.join(source, entry), path.join(target, entry), {
            recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
          });
        }
      } else {
        try {
          await fs.link(source, target);
        } catch (error) {
          if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
          snapshot = await sourceSnapshot(source);
          await fs.copyFile(source, target, constants.COPYFILE_EXCL);
        }
        owned = true;
      }
      if (snapshot !== undefined && snapshot !== await sourceSnapshot(source)) {
        throw new Error('Source changed during copy; left the original in place');
      }
      if (cancelled()) {
        await fs.rm(target, { recursive: true, force: true });
        return null;
      }
      copied = true;
      // Once deletion starts, let this move finish before acknowledging Stop.
      await fs.rm(source, { recursive: stats.isDirectory() });
      return target;
    } catch (error) {
      // Preserve both copies if source deletion failed; never delete a possibly unique copy.
      if (owned && !copied) await fs.rm(target, { recursive: true, force: true });
      if (copied) error.message += `; copy retained at ${target}`;
      if (error.code === 'EEXIST' && !owned) continue;
      if (copied) error.destinationRetained = true;
      throw error;
    }
  }
  return null;
}

class Organizer {
  constructor(root, log = () => {}) {
    this.root = root;
    this.log = log;
    this.cancelled = false;
    this.tail = Promise.resolve();
    this.pending = new Set();
    this.overflow = new Map();
  }
  enqueue(source, fromOthers = false) {
    if (this.cancelled || this.pending.has(source) || this.overflow.has(source)) return this.tail;
    // Limit queued promises; deferred arrivals retain only their path and origin.
    if (this.pending.size >= 512) {
      this.overflow.set(source, fromOthers);
      return this.tail;
    }
    this.pending.add(source);
    this.tail = this.tail.then(async () => {
      if (this.cancelled) return;
      for (let attempt = 0; attempt < 5 && !this.cancelled; attempt++) {
        try {
          const stats = await fs.lstat(source);
          const name = path.basename(source);
          if (CATEGORY_FOLDERS.includes(name) || PROTECTED_FOLDERS.includes(name)) return;
          const category = classify(name, stats);
          if (!category || (fromOthers && category === 'Others') || this.cancelled) return;
          const folder = path.join(this.root, category);
          await fs.mkdir(folder, { recursive: true });
          // Refuse category symlinks: sorting must stay inside the selected folder.
          if (!(await fs.lstat(folder)).isDirectory()) throw new Error(`Destination is not a directory: ${folder}`);
          const moved = await moveExclusive(source, path.join(folder, name), stats, () => this.cancelled);
          if (moved) this.log(`Moved ${name} to ${category} folder`);
          return;
        } catch (error) {
          if (error.code === 'ENOENT') return;
          if (error.destinationRetained || !RETRYABLE.has(error.code) || attempt === 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      }
    }).catch(error => this.log(`Error processing file: ${error.message}`)).finally(() => {
      this.pending.delete(source);
      if (!this.cancelled && this.overflow.size) {
        const [next, fromOthers] = this.overflow.entries().next().value;
        this.overflow.delete(next);
        this.enqueue(next, fromOthers);
      }
    });
    return this.tail;
  }
  async scan(includeOthers = false) {
    this.log(`Processing existing files in ${this.root}...`);
    try {
      for (const entry of await fs.readdir(this.root)) {
        if (this.cancelled) return;
        await this.enqueue(path.join(this.root, entry));
      }
      if (includeOthers && !this.cancelled) {
        const others = path.join(this.root, 'Others');
        try {
          if (!(await fs.lstat(others)).isDirectory()) throw new Error('Others must be a real directory');
          for (const entry of await fs.readdir(others)) {
            if (this.cancelled) return;
            await this.enqueue(path.join(others, entry), true);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!this.cancelled) this.log('Finished processing existing files.');
    } catch (error) { this.log(`Error scanning folder: ${error.message}`); }
  }
  async stop() {
    this.cancelled = true;
    this.overflow.clear();
    await this.tail;
  }
}
module.exports = { CATEGORIES, CATEGORY_FOLDERS, PROTECTED_FOLDERS, classify, moveExclusive, Organizer };
