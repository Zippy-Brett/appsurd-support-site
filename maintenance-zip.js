// Small stored-ZIP writer. No external dependency or remotely executed extension code.
const encoder = new TextEncoder();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function websiteZIP(files) {
  const local = [], central = [];
  let offset = 0;
  for (const {name, bytes} of files) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(name) || name.includes("..")) throw new Error("Invalid ZIP path.");
    const filename = encoder.encode(name), crc = crc32(bytes);
    const header = new Uint8Array(30 + filename.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, filename.length, true); header.set(filename, 30);
    local.push(header, bytes);
    const entry = new Uint8Array(46 + filename.length), cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true); cv.setUint16(28, filename.length, true); cv.setUint32(42, offset, true); entry.set(filename, 46);
    central.push(entry); offset += header.length + bytes.length;
  }
  const centralSize = central.reduce((size, part) => size + part.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], {type: "application/zip"});
}
