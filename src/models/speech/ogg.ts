// Lifted from packages/speech/src/ogg.ts (zygstinct 940a0c6d5) so every SDK host gets Marley's speech providers natively.
import { SpeechError } from "./types.js";

export type OggOpusInfo = {
  channels: number;
  preSkip: number;
  durationSec: number;
};

const OPUS_RATE = 48000;

/**
 * Reads the OpusHead packet and the last granule position of an Ogg Opus file.
 * Throws when the bytes are not Ogg Opus.
 */
export function inspectOggOpus(data: Buffer): OggOpusInfo {
  if (data.length < 47 || data.toString("latin1", 0, 4) !== "OggS") {
    throw new SpeechError("unsupported-audio", "audio is not an Ogg container");
  }
  let offset = 0;
  let channels = 0;
  let preSkip = 0;
  let lastGranule = 0n;
  let first = true;
  while (offset + 27 <= data.length) {
    if (data.toString("latin1", offset, offset + 4) !== "OggS") break;
    const segments = data[offset + 26]!;
    const headerLen = 27 + segments;
    if (offset + headerLen > data.length) break;
    let bodyLen = 0;
    for (let i = 0; i < segments; i += 1) bodyLen += data[offset + 27 + i]!;
    const granule = data.readBigUInt64LE(offset + 6);
    if (first) {
      const body = offset + headerLen;
      if (data.toString("latin1", body, body + 8) !== "OpusHead") {
        throw new SpeechError("unsupported-audio", "Ogg stream is not Opus");
      }
      channels = data[body + 9]!;
      preSkip = data.readUInt16LE(body + 10);
      first = false;
    } else if (granule !== 0xffffffffffffffffn) {
      lastGranule = granule;
    }
    offset += headerLen + bodyLen;
  }
  if (first) throw new SpeechError("unsupported-audio", "no Ogg pages found");
  const samples = Number(lastGranule) - preSkip;
  return { channels, preSkip, durationSec: Math.max(0, samples) / OPUS_RATE };
}

/** Throws unless the bytes are mono Ogg Opus, the only Ogg form WhatsApp accepts as a voice note. */
export function assertWhatsAppVoice(data: Buffer): OggOpusInfo {
  const info = inspectOggOpus(data);
  if (info.channels !== 1) {
    throw new SpeechError("unsupported-audio", `Opus audio has ${info.channels} channels, WhatsApp needs mono`);
  }
  return info;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg page checksum: CRC-32 with polynomial 0x04c11db7, no reflection, over the page with its CRC field zeroed. */
export function oggCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i += 1) {
    const byte = i >= 22 && i < 26 ? 0 : page[i]!;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc;
}

type Page = { bytes: Buffer; granule: bigint };

function readPages(data: Buffer): Page[] {
  const pages: Page[] = [];
  let offset = 0;
  while (offset + 27 <= data.length && data.toString("latin1", offset, offset + 4) === "OggS") {
    const segments = data[offset + 26]!;
    let bodyLen = 0;
    for (let i = 0; i < segments; i += 1) bodyLen += data[offset + 27 + i]!;
    const end = offset + 27 + segments + bodyLen;
    if (end > data.length) break;
    pages.push({ bytes: Buffer.from(data.subarray(offset, end)), granule: data.readBigUInt64LE(offset + 6) });
    offset = end;
  }
  return pages;
}

/**
 * Joins mono Ogg Opus files into one stream: the first file's header pages, then every file's audio pages with
 * renumbered sequence numbers, shifted granule positions and fresh checksums.
 */
export function concatOggOpus(parts: Buffer[]): Buffer {
  if (parts.length === 0) throw new SpeechError("bad-request", "nothing to join");
  if (parts.length === 1) return parts[0]!;
  const infos = parts.map((p) => inspectOggOpus(p));
  const serial = parts[0]!.readUInt32LE(14);
  const out: Buffer[] = [];
  let sequence = 0;
  let offsetSamples = BigInt(infos[0]!.preSkip);
  parts.forEach((part, index) => {
    const pages = readPages(part);
    const info = infos[index]!;
    const lastIndex = pages.length - 1;
    pages.forEach((page, pageIndex) => {
      if (pageIndex < 2) {
        if (index > 0) return;
      }
      const bytes = page.bytes;
      const isLastOfAll = index === parts.length - 1 && pageIndex === lastIndex;
      bytes.writeUInt32LE(serial, 14);
      bytes.writeUInt32LE(sequence, 18);
      sequence += 1;
      if (pageIndex >= 2) {
        if (page.granule !== 0xffffffffffffffffn) {
          bytes.writeBigUInt64LE(page.granule - BigInt(info.preSkip) + offsetSamples, 6);
        }
        bytes[5] = (bytes[5]! & ~0x04) | (isLastOfAll ? 0x04 : 0);
      }
      bytes.writeUInt32LE(oggCrc(bytes), 22);
      out.push(bytes);
    });
    offsetSamples += BigInt(Math.round(info.durationSec * OPUS_RATE));
  });
  return Buffer.concat(out);
}

type OpusPacket = { data: Buffer; samples: number };

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716, section 3.1). */
function opusPacketSamples(packet: Buffer): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const config = toc >> 3;
  let frame: number;
  if (config < 12) frame = [480, 960, 1920, 2880][config % 4]!;
  else if (config < 16) frame = config % 2 === 0 ? 480 : 960;
  else frame = [120, 240, 480, 960][config % 4]!;
  const code = toc & 3;
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3) frames = packet.length > 1 ? packet[1]! & 0x3f : 0;
  return frame * frames;
}

function readPackets(data: Buffer): { packets: OpusPacket[]; head: Buffer; tags: Buffer; serial: number; preSkip: number } {
  const pages = readPages(data);
  if (pages.length < 3) throw new SpeechError("unsupported-audio", "Ogg Opus file has no audio pages");
  const packets: OpusPacket[] = [];
  let partial: Buffer[] = [];
  const headBody = (page: Page) => page.bytes.subarray(27 + page.bytes[26]!);
  pages.slice(2).forEach((page) => {
    const segments = page.bytes[26]!;
    let offset = 27 + segments;
    for (let i = 0; i < segments; i += 1) {
      const len = page.bytes[27 + i]!;
      partial.push(page.bytes.subarray(offset, offset + len));
      offset += len;
      if (len < 255) {
        const packet = Buffer.concat(partial);
        packets.push({ data: packet, samples: opusPacketSamples(packet) });
        partial = [];
      }
    }
  });
  return {
    packets,
    head: Buffer.from(headBody(pages[0]!)),
    tags: Buffer.from(headBody(pages[1]!)),
    serial: data.readUInt32LE(14),
    preSkip: inspectOggOpus(data).preSkip,
  };
}

function buildPage(serial: number, sequence: number, flags: number, granule: bigint, packets: Buffer[]): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "latin1");
  header[5] = flags;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  lacing.forEach((value, i) => {
    header[27 + i] = value;
  });
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

const MAX_PACKETS_PER_PAGE = 25;

/**
 * Cuts mono Ogg Opus into standalone files of about chunkSec seconds. Each file starts overlapSec before the end of
 * the previous one so words on a boundary appear whole in at least one chunk.
 */
export function splitOggOpus(data: Buffer, chunkSec: number, overlapSec: number): { audio: Buffer; startSec: number; durationSec: number }[] {
  if (!(chunkSec > 0) || !(overlapSec >= 0) || overlapSec >= chunkSec) throw new SpeechError("bad-request", "invalid chunk size or overlap");
  const { packets, head, tags, serial, preSkip } = readPackets(data);
  const starts: number[] = [];
  let total = 0;
  for (const p of packets) {
    starts.push(total);
    total += p.samples;
  }
  const chunkSamples = Math.round(chunkSec * OPUS_RATE);
  const stepSamples = Math.max(1, chunkSamples - Math.round(overlapSec * OPUS_RATE));
  const out: { audio: Buffer; startSec: number; durationSec: number }[] = [];
  for (let startSample = 0; startSample < total; startSample += stepSamples) {
    const first = starts.findIndex((s, i) => s + packets[i]!.samples > startSample);
    let endIndex = first;
    let samples = 0;
    while (endIndex < packets.length && samples < chunkSamples) {
      samples += packets[endIndex]!.samples;
      endIndex += 1;
    }
    const slice = packets.slice(first, endIndex);
    const pages: Buffer[] = [buildPage(serial, 0, 2, 0n, [head]), buildPage(serial, 1, 0, 0n, [tags])];
    let sequence = 2;
    let granule = BigInt(preSkip);
    for (let i = 0; i < slice.length; i += MAX_PACKETS_PER_PAGE) {
      const group = slice.slice(i, i + MAX_PACKETS_PER_PAGE);
      granule += BigInt(group.reduce((sum, p) => sum + p.samples, 0));
      const last = i + MAX_PACKETS_PER_PAGE >= slice.length;
      pages.push(buildPage(serial, sequence++, last ? 4 : 0, granule, group.map((p) => p.data)));
    }
    out.push({ audio: Buffer.concat(pages), startSec: starts[first]! / OPUS_RATE, durationSec: samples / OPUS_RATE });
    if (endIndex >= packets.length) break;
  }
  return out;
}
