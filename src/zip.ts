import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";

interface ZipSource {
  name: string;
  path: string;
}

interface PreparedSource extends ZipSource {
  bytes: number;
  crc32: number;
  offset: number;
}

const UTF8_FLAG = 0x0800;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** Write a portable, uncompressed ZIP without buffering its entries in memory. */
export async function writeStoredZip(
  destination: string,
  sources: readonly ZipSource[],
): Promise<void> {
  if (sources.length === 0 || sources.length > 0xffff) throw new Error("invalid ZIP entry count");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.part`;
  const output = createWriteStream(temporary, { flags: "wx" });
  let offset = 0;
  const prepared: PreparedSource[] = [];
  try {
    for (const source of sources) {
      const name = Buffer.from(source.name, "utf8");
      if (name.length === 0 || name.length > 0xffff) throw new Error("ZIP entry name is too long");
      const inspected = await inspect(source.path);
      if (inspected.bytes > 0xffffffff || offset > 0xffffffff) {
        throw new Error("bundle exceeds the ZIP32 size limit");
      }
      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL_SIGNATURE, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(UTF8_FLAG, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt32LE(inspected.crc32, 14);
      header.writeUInt32LE(inspected.bytes, 18);
      header.writeUInt32LE(inspected.bytes, 22);
      header.writeUInt16LE(name.length, 26);
      await write(output, header);
      await write(output, name);
      const localOffset = offset;
      offset += header.length + name.length;
      for await (const raw of createReadStream(source.path)) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        await write(output, chunk);
        offset += chunk.length;
      }
      prepared.push({ ...source, ...inspected, offset: localOffset });
    }

    const centralOffset = offset;
    for (const source of prepared) {
      const name = Buffer.from(source.name, "utf8");
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      header.writeUInt16LE(0x0314, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt32LE(source.crc32, 16);
      header.writeUInt32LE(source.bytes, 20);
      header.writeUInt32LE(source.bytes, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(source.offset, 42);
      await write(output, header);
      await write(output, name);
      offset += header.length + name.length;
    }
    const centralBytes = offset - centralOffset;
    if (centralBytes > 0xffffffff) throw new Error("ZIP central directory is too large");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD_SIGNATURE, 0);
    end.writeUInt16LE(prepared.length, 8);
    end.writeUInt16LE(prepared.length, 10);
    end.writeUInt32LE(centralBytes, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(output, end);
    output.end();
    await once(output, "close");
    await rename(temporary, destination);
  } catch (error) {
    output.destroy();
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true });
    throw error;
  }
}

async function inspect(path: string): Promise<{ bytes: number; crc32: number }> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("bundle entry is not a regular file");
  let crc = 0xffffffff;
  let bytes = 0;
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    crc = updateCrc32(crc, chunk);
  }
  return { bytes, crc32: (crc ^ 0xffffffff) >>> 0 };
}

async function write(output: ReturnType<typeof createWriteStream>, body: Buffer): Promise<void> {
  if (!output.write(body)) await once(output, "drain");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function updateCrc32(initial: number, body: Buffer): number {
  let value = initial;
  for (const byte of body) value = (value >>> 8) ^ (CRC_TABLE[(value ^ byte) & 0xff] ?? 0);
  return value >>> 0;
}
