'use strict';

// A .zip of a folder's files, stored as they are (not compressed), for the browser helper's
// download. Small and dependency-free: the extension is a few small text files.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function filesIn(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesIn(full, base);
    return e.isFile() ? [[path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full)]] : [];
  });
}

// files: [[name, Buffer]], put under a top folder so unzipping gives one folder to load.
function zip(files, top) {
  const parts = [];
  const central = [];
  let offset = 0;
  // 1 January 2026, so the same files always give the same zip.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [n, data] of files) {
    const name = Buffer.from(`${top}/${n}`);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

const zipFolder = (dir, top) => zip(filesIn(dir), top);

module.exports = { zip, zipFolder };
