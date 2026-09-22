/**
 * A small QR Code (ISO/IEC 18004) encoder for the TOTP setup step: byte-mode
 * segments, versions 1–40, the four error-correction levels, automatic mask
 * selection, no third-party code. The page renders the returned module
 * matrix as inline SVG so the `otpauth://` URI (and with it the shared
 * secret) never leaves the browser or reaches a third-party image service.
 * The structure follows the standard's tables; the encoder is verified by a
 * test-side decoder and by published Reed–Solomon and format-bit vectors.
 */

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

export type QrCode = {
  version: number;
  errorCorrection: QrErrorCorrection;
  mask: number;
  size: number;
  /** `modules[y][x]` is `true` for a dark module. */
  modules: boolean[][];
};

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/** Format-information bits of each level (ISO/IEC 18004 Table 12). */
const formatBits: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };
const levelIndex: Record<QrErrorCorrection, number> = { L: 0, M: 1, Q: 2, H: 3 };

/** Error-correction codewords per block, indexed `[level][version]` (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK: ReadonlyArray<ReadonlyArray<number>> = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

/** Number of error-correction blocks, indexed `[level][version]` (index 0 unused). */
const NUM_ERROR_CORRECTION_BLOCKS: ReadonlyArray<ReadonlyArray<number>> = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ---------- GF(256) arithmetic and Reed–Solomon (primitive polynomial 0x11D) ---------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) GF_EXP[index] = GF_EXP[index - 255]!;
}

/** Multiplies two field elements of GF(2^8) with reducing polynomial x^8 + x^4 + x^3 + x^2 + 1. */
export function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left]! + GF_LOG[right]!]!;
}

/** The generator polynomial of the given degree (coefficients from the highest power down, leading 1 omitted). */
export function reedSolomonGenerator(degree: number): number[] {
  if (!Number.isInteger(degree) || degree < 1 || degree > 255) throw new RangeError("Degree out of range.");
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let round = 0; round < degree; round += 1) {
    for (let index = 0; index < result.length; index += 1) {
      result[index] = gfMultiply(result[index]!, root);
      if (index + 1 < result.length) result[index]! ^= result[index + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The Reed–Solomon error-correction codewords of `data` for a code with `degree` ECC codewords. */
export function reedSolomonRemainder(data: ArrayLike<number>, degree: number): number[] {
  const divisor = reedSolomonGenerator(degree);
  const result = new Array<number>(divisor.length).fill(0);
  for (let position = 0; position < data.length; position += 1) {
    const factor = data[position]! ^ result.shift()!;
    result.push(0);
    for (let index = 0; index < divisor.length; index += 1) {
      result[index]! ^= gfMultiply(divisor[index]!, factor);
    }
  }
  return result;
}

/* ---------- Structural helpers ---------- */

/** Number of modules available for data and error correction after all function patterns. */
export function rawDataModules(version: number): number {
  assertVersion(version);
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Number of data codewords (excluding error correction) a version holds at a level. */
export function dataCodewords(version: number, level: QrErrorCorrection): number {
  const index = levelIndex[level];
  return Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[index]![version]! * NUM_ERROR_CORRECTION_BLOCKS[index]![version]!;
}

/** Centre positions of the alignment patterns along one axis (ISO/IEC 18004 Table E.1). */
export function alignmentPositions(version: number): number[] {
  assertVersion(version);
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = 17 + 4 * version;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

/** Character-count field width of a byte-mode segment. */
function byteCountBits(version: number) {
  return version <= 9 ? 8 : 16;
}

/** The 15 format bits: level and mask, BCH(15,5) protected, XOR-masked (ISO/IEC 18004 Annex C). */
export function formatInformation(level: QrErrorCorrection, mask: number): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError("Mask out of range.");
  const data = (formatBits[level] << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18 version bits (versions 7+), BCH(18,6) protected (ISO/IEC 18004 Annex D). */
export function versionInformation(version: number): number {
  if (version < 7) throw new RangeError("Version information exists from version 7.");
  let remainder = version;
  for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

/** Whether the mask darkens the module at (x, y) (column, row). */
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError("Mask out of range.");
  }
}

function assertVersion(version: number) {
  if (!Number.isInteger(version) || version < QR_MIN_VERSION || version > QR_MAX_VERSION) {
    throw new RangeError("QR version out of range.");
  }
}

/* ---------- Encoding ---------- */

class BitBuffer {
  readonly bits: number[] = [];

  append(value: number, length: number) {
    if (length < 0 || length > 31 || value >>> length !== 0) throw new RangeError("Value out of range.");
    for (let index = length - 1; index >= 0; index -= 1) this.bits.push((value >>> index) & 1);
  }
}

/** The smallest version whose data capacity holds `byteLength` bytes at `level`, or `null` when none does. */
export function smallestVersion(byteLength: number, level: QrErrorCorrection): number | null {
  for (let version = QR_MIN_VERSION; version <= QR_MAX_VERSION; version += 1) {
    const needed = 4 + byteCountBits(version) + byteLength * 8;
    if (needed <= dataCodewords(version, level) * 8) return version;
  }
  return null;
}

/** Splits data codewords into blocks, appends error correction and interleaves them (ISO/IEC 18004 §7.6). */
export function interleaveCodewords(data: ArrayLike<number>, version: number, level: QrErrorCorrection): number[] {
  const index = levelIndex[level];
  const blockCount = NUM_ERROR_CORRECTION_BLOCKS[index]![version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[index]![version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);
  if (data.length !== rawCodewords - eccLength * blockCount) throw new RangeError("Data length mismatch.");

  const blocks: number[][] = [];
  let offset = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const length = shortLength - eccLength + (block < shortBlocks ? 0 : 1);
    const chunk = Array.from({ length }, (_, position) => data[offset + position]!);
    offset += length;
    const ecc = reedSolomonRemainder(chunk, eccLength);
    if (block < shortBlocks) chunk.push(0);
    blocks.push([...chunk, ...ecc]);
  }

  const result: number[] = [];
  for (let position = 0; position < blocks[0]!.length; position += 1) {
    blocks.forEach((block, blockIndex) => {
      if (position !== shortLength - eccLength || blockIndex >= shortBlocks) result.push(block[position]!);
    });
  }
  return result;
}

/** Builds the padded data codewords of a single byte-mode segment. */
export function byteModeCodewords(bytes: Uint8Array, version: number, level: QrErrorCorrection): number[] {
  const capacity = dataCodewords(version, level) * 8;
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4);
  buffer.append(bytes.length, byteCountBits(version));
  if (buffer.bits.length + bytes.length * 8 > capacity) throw new RangeError("Data does not fit the version.");
  for (const byte of bytes) buffer.append(byte, 8);
  buffer.append(0, Math.min(4, capacity - buffer.bits.length));
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);
  for (let pad = 0xec; buffer.bits.length < capacity; pad ^= 0xec ^ 0x11) buffer.append(pad, 8);
  const result: number[] = [];
  for (let index = 0; index < buffer.bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | buffer.bits[index + bit]!;
    result.push(value);
  }
  return result;
}

type Grid = { modules: boolean[][]; isFunction: boolean[][]; size: number };

function grid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(target: Grid, x: number, y: number, dark: boolean) {
  target.modules[y]![x] = dark;
  target.isFunction[y]![x] = true;
}

function drawFinder(target: Grid, x: number, y: number) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const column = x + dx;
      const row = y + dy;
      if (column >= 0 && column < target.size && row >= 0 && row < target.size) {
        setFunction(target, column, row, distance !== 2 && distance !== 4);
      }
    }
  }
}

function drawAlignment(target: Grid, x: number, y: number) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(target, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormat(target: Grid, level: QrErrorCorrection, mask: number) {
  const bits = formatInformation(level, mask);
  const bit = (index: number) => ((bits >>> index) & 1) === 1;
  const size = target.size;
  for (let index = 0; index <= 5; index += 1) setFunction(target, 8, index, bit(index));
  setFunction(target, 8, 7, bit(6));
  setFunction(target, 8, 8, bit(7));
  setFunction(target, 7, 8, bit(8));
  for (let index = 9; index < 15; index += 1) setFunction(target, 14 - index, 8, bit(index));
  for (let index = 0; index < 8; index += 1) setFunction(target, size - 1 - index, 8, bit(index));
  for (let index = 8; index < 15; index += 1) setFunction(target, 8, size - 15 + index, bit(index));
  setFunction(target, 8, size - 8, true);
}

function drawVersion(target: Grid, version: number) {
  if (version < 7) return;
  const bits = versionInformation(version);
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >>> index) & 1) === 1;
    const a = target.size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    setFunction(target, a, b, dark);
    setFunction(target, b, a, dark);
  }
}

function drawFunctionPatterns(target: Grid, version: number, level: QrErrorCorrection) {
  const size = target.size;
  for (let index = 0; index < size; index += 1) {
    setFunction(target, 6, index, index % 2 === 0);
    setFunction(target, index, 6, index % 2 === 0);
  }
  drawFinder(target, 3, 3);
  drawFinder(target, size - 4, 3);
  drawFinder(target, 3, size - 4);
  const positions = alignmentPositions(version);
  positions.forEach((x, column) => {
    positions.forEach((y, row) => {
      const corner = (column === 0 && row === 0) ||
        (column === 0 && row === positions.length - 1) ||
        (column === positions.length - 1 && row === 0);
      if (!corner) drawAlignment(target, x, y);
    });
  });
  drawFormat(target, level, 0);
  drawVersion(target, version);
}

/** Places the codeword bits in the zigzag order of ISO/IEC 18004 §7.7.3. */
function drawCodewords(target: Grid, codewords: number[]) {
  const size = target.size;
  const total = codewords.length * 8;
  let index = 0;
  for (let column = size - 1; column >= 1; column -= 2) {
    // The vertical timing pattern at column 6 is skipped: the pair shifts one column left.
    const right = column <= 6 ? column - 1 : column;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!target.isFunction[y]![x] && index < total) {
          target.modules[y]![x] = ((codewords[index >>> 3]! >>> (7 - (index & 7))) & 1) === 1;
          index += 1;
        }
      }
    }
  }
}

function applyMask(target: Grid, mask: number) {
  for (let y = 0; y < target.size; y += 1) {
    for (let x = 0; x < target.size; x += 1) {
      if (!target.isFunction[y]![x] && maskBit(mask, x, y)) target.modules[y]![x] = !target.modules[y]![x];
    }
  }
}

/** The four penalty rules of ISO/IEC 18004 §7.8.3, used to pick the mask with the best readability. */
export function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let result = 0;
  const line = (at: (index: number) => boolean) => {
    let runColour = false;
    let runLength = 0;
    // The last seven run lengths, most recent first; a light border of `size` pads both ends.
    const history = [0, 0, 0, 0, 0, 0, 0];
    const addHistory = (length: number) => {
      const padded = history[0] === 0 ? length + size : length;
      history.pop();
      history.unshift(padded);
    };
    const countPatterns = () => {
      const core = history[1]!;
      const finderLike = core > 0 &&
        history[2] === core && history[4] === core && history[5] === core && history[3] === core * 3;
      return (finderLike && history[0]! >= core * 4 && history[6]! >= core ? 1 : 0) +
        (finderLike && history[6]! >= core * 4 && history[0]! >= core ? 1 : 0);
    };
    for (let index = 0; index < size; index += 1) {
      const dark = at(index);
      if (dark === runColour) {
        runLength += 1;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result += 1;
      } else {
        addHistory(runLength);
        if (!runColour) result += countPatterns() * PENALTY_N3;
        runColour = dark;
        runLength = 1;
      }
    }
    if (runColour) {
      addHistory(runLength);
      runLength = 0;
    }
    addHistory(runLength + size);
    result += countPatterns() * PENALTY_N3;
  };
  for (let y = 0; y < size; y += 1) line((x) => modules[y]![x]!);
  for (let x = 0; x < size; x += 1) line((y) => modules[y]![x]!);
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const colour = modules[y]![x];
      if (colour === modules[y]![x + 1] && colour === modules[y + 1]![x] && colour === modules[y + 1]![x + 1]) {
        result += PENALTY_N2;
      }
    }
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const total = size * size;
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, deviation) * PENALTY_N4;
  return result;
}

export type EncodeOptions = {
  errorCorrection?: QrErrorCorrection;
  /** Forces a mask (0–7) instead of choosing the lowest-penalty one; for tests and vectors. */
  mask?: number;
  /** Lowest version to use; the encoder still grows the version when the data needs it. */
  minVersion?: number;
};

/** Encodes UTF-8 text (or raw bytes) as a byte-mode QR symbol. Throws when the data does not fit version 40. */
export function encodeQr(input: string | Uint8Array, options: EncodeOptions = {}): QrCode {
  const level = options.errorCorrection ?? "M";
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const minimum = options.minVersion ?? QR_MIN_VERSION;
  assertVersion(minimum);
  const fitted = smallestVersion(bytes.length, level);
  if (fitted === null) throw new RangeError("Data is too long for a QR Code.");
  const version = Math.max(minimum, fitted);
  const size = 17 + 4 * version;
  const codewords = interleaveCodewords(byteModeCodewords(bytes, version, level), version, level);

  const target = grid(size);
  drawFunctionPatterns(target, version, level);
  drawCodewords(target, codewords);

  let chosen = options.mask ?? -1;
  if (chosen === -1) {
    let best = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask += 1) {
      applyMask(target, mask);
      drawFormat(target, level, mask);
      const penalty = penaltyScore(target.modules);
      if (penalty < best) {
        best = penalty;
        chosen = mask;
      }
      applyMask(target, mask);
    }
  } else if (!Number.isInteger(chosen) || chosen < 0 || chosen > 7) {
    throw new RangeError("Mask out of range.");
  }
  applyMask(target, chosen);
  drawFormat(target, level, chosen);
  return { version, errorCorrection: level, mask: chosen, size, modules: target.modules };
}

/** An SVG path (`M x y h1 v1 h-1 z` per dark module) for the symbol with a `quietZone`-module margin. */
export function qrPath(code: QrCode, quietZone = 4): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
    });
  });
  return parts.join("");
}
