// @vitest-environment node

import { describe, expect, it } from "vitest";
import totpSetupFixture from "../../tests/fixtures/sky-account-v1-totp-setup.json";
import {
  alignmentPositions,
  dataCodewords,
  encodeQr,
  formatInformation,
  gfMultiply,
  penaltyScore,
  qrPath,
  reedSolomonGenerator,
  reedSolomonRemainder,
  smallestVersion,
  versionInformation,
} from "@/lib/qr";
import type { QrCode, QrErrorCorrection } from "@/lib/qr";

/* ---------- Independent reference material (ISO/IEC 18004 tables and published vectors) ---------- */

/** Alignment pattern centre coordinates, Table E.1. */
const standardAlignment: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
  9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
  20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102],
  24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118],
  28: [6, 26, 50, 74, 98, 122], 29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
  31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142],
  34: [6, 34, 62, 90, 118, 146], 35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166],
  40: [6, 30, 58, 86, 114, 142, 170],
};

/** Format information strings (level, mask) → 15 bits, Table C.1. */
const standardFormat: Array<[QrErrorCorrection, number, string]> = [
  ["L", 0, "111011111000100"], ["L", 1, "111001011110011"], ["L", 2, "111110110101010"], ["L", 3, "111100010011101"],
  ["L", 4, "110011000101111"], ["L", 5, "110001100011000"], ["L", 6, "110110001000001"], ["L", 7, "110100101110110"],
  ["M", 0, "101010000010010"], ["M", 1, "101000100100101"], ["M", 2, "101111001111100"], ["M", 3, "101101101001011"],
  ["M", 4, "100010111111001"], ["M", 5, "100000011001110"], ["M", 6, "100111110010111"], ["M", 7, "100101010100000"],
  ["Q", 0, "011010101011111"], ["Q", 1, "011000001101000"], ["Q", 2, "011111100110001"], ["Q", 3, "011101000000110"],
  ["Q", 4, "010010010110100"], ["Q", 5, "010000110000011"], ["Q", 6, "010111011011010"], ["Q", 7, "010101111101101"],
  ["H", 0, "001011010001001"], ["H", 1, "001001110111110"], ["H", 2, "001110011100111"], ["H", 3, "001100111010000"],
  ["H", 4, "000011101100010"], ["H", 5, "000001001010101"], ["H", 6, "000110100001100"], ["H", 7, "000100000111011"],
];

/** Version information strings, Table D.1 (a sample). */
const standardVersion: Array<[number, string]> = [
  [7, "000111110010010100"], [8, "001000010110111100"], [9, "001001101010011001"], [10, "001010010011010011"],
  [40, "101000110001101001"],
];

/** Data codewords per version and level for the versions the page can reach, Table 9. */
const standardDataCodewords: Array<[number, QrErrorCorrection, number]> = [
  [1, "L", 19], [1, "M", 16], [1, "Q", 13], [1, "H", 9],
  [2, "L", 34], [2, "M", 28], [2, "Q", 22], [2, "H", 16],
  [3, "L", 55], [3, "M", 44], [3, "Q", 34], [3, "H", 26],
  [4, "L", 80], [4, "M", 64], [4, "Q", 48], [4, "H", 36],
  [5, "L", 108], [5, "M", 86], [5, "Q", 62], [5, "H", 46],
  [6, "L", 136], [6, "M", 108], [6, "Q", 76], [6, "H", 60],
  [7, "L", 156], [7, "M", 124], [7, "Q", 88], [7, "H", 66],
  [8, "L", 194], [8, "M", 154], [8, "Q", 110], [8, "H", 86],
  [9, "L", 232], [9, "M", 182], [9, "Q", 132], [9, "H", 100],
  [10, "L", 274], [10, "M", 216], [10, "Q", 154], [10, "H", 122],
  [40, "L", 2956], [40, "M", 2334], [40, "Q", 1666], [40, "H", 1276],
];

/** The worked "HELLO WORLD" 1-M example: 16 data codewords and their 10 error-correction codewords. */
const helloWorldData = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const helloWorldEcc = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];

/** GF(2^8) powers of α computed independently of the module's tables. */
function alphaPower(exponent: number) {
  let value = 1;
  for (let index = 0; index < exponent; index += 1) {
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  return value;
}

function referenceMultiply(left: number, right: number) {
  let product = 0;
  let a = left;
  for (let b = right; b > 0; b >>>= 1) {
    if (b & 1) product ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return product;
}

/* ---------- Test-side decoder ---------- */

const levelOfFormatBits: Record<number, QrErrorCorrection> = { 1: "L", 0: "M", 3: "Q", 2: "H" };
const eccPerBlock: Record<QrErrorCorrection, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const blocksPerVersion: Record<QrErrorCorrection, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const totalCodewords = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

function bchRemainder(value: number, generator: number, degree: number, length: number) {
  let remainder = value;
  for (let index = length - 1; index >= degree; index -= 1) {
    if ((remainder >>> index) & 1) remainder ^= generator << (index - degree);
  }
  return remainder;
}

function referenceMask(mask: number, x: number, y: number) {
  const table = [
    (x + y) % 2 === 0,
    y % 2 === 0,
    x % 3 === 0,
    (x + y) % 3 === 0,
    (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    ((x * y) % 2) + ((x * y) % 3) === 0,
    (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  return table[mask]!;
}

function functionModuleMap(version: number) {
  const size = 17 + 4 * version;
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && x < size && y >= 0 && y < size) map[y]![x] = true;
  };
  for (let index = 0; index < 8; index += 1) {
    for (let other = 0; other < 8; other += 1) {
      mark(index, other);
      mark(size - 1 - index, other);
      mark(index, size - 1 - other);
    }
  }
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  const positions = standardAlignment[version]!;
  positions.forEach((x, column) => {
    positions.forEach((y, row) => {
      const corner = (column === 0 && row === 0) ||
        (column === 0 && row === positions.length - 1) ||
        (column === positions.length - 1 && row === 0);
      if (corner) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(x + dx, y + dy);
    });
  });
  for (let index = 0; index < 9; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(size - 1 - index, 8);
    mark(8, size - 1 - index);
  }
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return map;
}

function readFormat(code: QrCode) {
  const size = code.size;
  const at = (x: number, y: number) => (code.modules[y]![x] ? 1 : 0);
  let first = 0;
  for (let index = 0; index <= 5; index += 1) first |= at(8, index) << index;
  first |= at(8, 7) << 6;
  first |= at(8, 8) << 7;
  first |= at(7, 8) << 8;
  for (let index = 9; index < 15; index += 1) first |= at(14 - index, 8) << index;
  let second = 0;
  for (let index = 0; index < 8; index += 1) second |= at(size - 1 - index, 8) << index;
  for (let index = 8; index < 15; index += 1) second |= at(8, size - 15 + index) << index;
  expect(second).toBe(first);
  const unmasked = first ^ 0x5412;
  expect(bchRemainder(unmasked, 0x537, 10, 15)).toBe(0);
  const data = unmasked >>> 10;
  return { level: levelOfFormatBits[data >>> 3]!, mask: data & 7 };
}

function readVersion(code: QrCode) {
  let bits = 0;
  for (let index = 0; index < 18; index += 1) {
    const a = code.size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    const first = code.modules[b]![a] ? 1 : 0;
    const second = code.modules[a]![b] ? 1 : 0;
    expect(second).toBe(first);
    bits |= first << index;
  }
  expect(bchRemainder(bits, 0x1f25, 12, 18)).toBe(0);
  return bits >>> 12;
}

function readCodewords(code: QrCode, mask: number, isFunction: boolean[][]) {
  const size = code.size;
  const bits: number[] = [];
  for (let column = size - 1; column >= 1; column -= 2) {
    const right = column <= 6 ? column - 1 : column;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (isFunction[y]![x]) continue;
        const dark = code.modules[y]![x]! !== referenceMask(mask, x, y);
        bits.push(dark ? 1 : 0);
      }
    }
  }
  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[index + bit]!;
    codewords.push(value);
  }
  return codewords;
}

function syndromesVanish(block: number[], eccLength: number) {
  for (let power = 0; power < eccLength; power += 1) {
    const root = alphaPower(power);
    let value = 0;
    for (const coefficient of block) value = referenceMultiply(value, root) ^ coefficient;
    if (value !== 0) return false;
  }
  return true;
}

/** Decodes a byte-mode symbol produced by `encodeQr`, verifying every structural layer on the way. */
function decodeQr(code: QrCode) {
  const version = (code.size - 17) / 4;
  expect(Number.isInteger(version)).toBe(true);
  expect(version).toBe(code.version);
  const format = readFormat(code);
  expect(format.level).toBe(code.errorCorrection);
  expect(format.mask).toBe(code.mask);
  if (version >= 7) expect(readVersion(code)).toBe(version);
  expect(code.modules[code.size - 8]![8]).toBe(true);
  for (let index = 8; index < code.size - 8; index += 1) {
    expect(code.modules[6]![index]).toBe(index % 2 === 0);
    expect(code.modules[index]![6]).toBe(index % 2 === 0);
  }

  const raw = readCodewords(code, format.mask, functionModuleMap(version));
  const total = totalCodewords[version]!;
  expect(raw.length).toBe(total);
  const blockCount = blocksPerVersion[format.level]![version]!;
  const eccLength = eccPerBlock[format.level]![version]!;
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);
  const blocks: number[][] = Array.from({ length: blockCount }, () => []);
  let position = 0;
  const dataLength = (block: number) => shortLength - eccLength + (block < shortBlocks ? 0 : 1);
  const longestData = shortLength - eccLength + 1;
  for (let column = 0; column < longestData; column += 1) {
    for (let block = 0; block < blockCount; block += 1) {
      if (column < dataLength(block)) blocks[block]!.push(raw[position++]!);
    }
  }
  for (let column = 0; column < eccLength; column += 1) {
    for (let block = 0; block < blockCount; block += 1) blocks[block]!.push(raw[position++]!);
  }
  expect(position).toBe(total);
  const data: number[] = [];
  blocks.forEach((block, index) => {
    expect(syndromesVanish(block, eccLength), `block ${index} error correction`).toBe(true);
    data.push(...block.slice(0, dataLength(index)));
  });

  let offset = 0;
  const bit = () => {
    const value = (data[offset >>> 3]! >>> (7 - (offset & 7))) & 1;
    offset += 1;
    return value;
  };
  const read = (length: number) => {
    let value = 0;
    for (let index = 0; index < length; index += 1) value = (value << 1) | bit();
    return value;
  };
  expect(read(4)).toBe(0b0100);
  const count = read(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) bytes[index] = read(8);
  const capacity = data.length * 8;
  const terminator = Math.min(4, capacity - offset);
  expect(read(terminator)).toBe(0);
  while (offset % 8 !== 0) expect(bit()).toBe(0);
  for (let pad = 0xec; offset < capacity; pad ^= 0xec ^ 0x11) expect(read(8)).toBe(pad);
  return { version, level: format.level, mask: format.mask, bytes, text: new TextDecoder().decode(bytes) };
}

/* ---------- Tests ---------- */

describe("QR structural tables", () => {
  it("places alignment patterns exactly where ISO/IEC 18004 Table E.1 does", () => {
    for (let version = 1; version <= 40; version += 1) {
      expect(alignmentPositions(version), `version ${version}`).toEqual(standardAlignment[version]);
    }
  });

  it("derives the data codeword capacities of Table 9 from the block tables", () => {
    for (const [version, level, expected] of standardDataCodewords) {
      expect(dataCodewords(version, level), `version ${version}-${level}`).toBe(expected);
    }
  });

  it("chooses the smallest fitting version for byte-mode data", () => {
    expect(smallestVersion(0, "M")).toBe(1);
    expect(smallestVersion(14, "M")).toBe(1);
    expect(smallestVersion(15, "M")).toBe(2);
    expect(smallestVersion(17, "L")).toBe(1);
    expect(smallestVersion(18, "L")).toBe(2);
    expect(smallestVersion(213, "M")).toBe(10);
    expect(smallestVersion(214, "M")).toBe(11);
    expect(smallestVersion(2953, "L")).toBe(40);
    expect(smallestVersion(2954, "L")).toBeNull();
  });
});

describe("QR error correction and information bits", () => {
  it("multiplies in GF(2^8) like the reference peasant multiplication", () => {
    for (const [left, right] of [[0x53, 0xca], [0xff, 0xff], [0x02, 0x80], [0x1d, 0x1d], [0, 0x77], [1, 0xab]]) {
      expect(gfMultiply(left!, right!)).toBe(referenceMultiply(left!, right!));
    }
  });

  it("builds the published degree-7 generator polynomial", () => {
    expect(reedSolomonGenerator(7)).toEqual([87, 229, 146, 149, 238, 102, 21].map(alphaPower));
  });

  it("reproduces the HELLO WORLD 1-M error-correction codewords", () => {
    expect(reedSolomonRemainder(helloWorldData, 10)).toEqual(helloWorldEcc);
    expect(syndromesVanish([...helloWorldData, ...helloWorldEcc], 10)).toBe(true);
    expect(syndromesVanish([...helloWorldData, ...helloWorldEcc.slice(0, 9), helloWorldEcc[9]! ^ 1], 10)).toBe(false);
  });

  it("matches the format information strings of Table C.1", () => {
    for (const [level, mask, bits] of standardFormat) {
      expect(formatInformation(level, mask).toString(2).padStart(15, "0"), `${level} ${mask}`).toBe(bits);
    }
  });

  it("matches the version information strings of Table D.1 and stays a valid BCH(18,6) codeword", () => {
    for (const [version, bits] of standardVersion) {
      expect(versionInformation(version).toString(2).padStart(18, "0"), `version ${version}`).toBe(bits);
    }
    for (let version = 7; version <= 40; version += 1) {
      const bits = versionInformation(version);
      expect(bits >>> 12, `version ${version}`).toBe(version);
      expect(bchRemainder(bits, 0x1f25, 12, 18), `version ${version}`).toBe(0);
    }
    expect(() => versionInformation(6)).toThrow(RangeError);
  });
});

describe("encodeQr", () => {
  const otpauthUri = totpSetupFixture.otpauthUri;

  it("encodes the TOTP setup URI so that an independent decoder reads it back byte for byte", () => {
    const code = encodeQr(otpauthUri);
    expect(code.errorCorrection).toBe("M");
    expect(code.size).toBe(17 + 4 * code.version);
    expect(code.version).toBe(smallestVersion(new TextEncoder().encode(otpauthUri).length, "M"));
    const decoded = decodeQr(code);
    expect(decoded.text).toBe(otpauthUri);
    expect(decoded.bytes).toEqual(new TextEncoder().encode(otpauthUri));
  });

  it.each(["L", "M", "Q", "H"] as const)("round-trips every error-correction level (%s) across version boundaries", (level) => {
    // The reference decoder tables stop at version 10; the largest sample fills exactly that version.
    const largest = Math.floor((dataCodewords(10, level) * 8 - 20) / 8);
    const samples = [
      "",
      "A",
      "otpauth://totp/SKY%20LAB:a?secret=ABCDEFGHIJKLMNOP&issuer=SKY%20LAB",
      "Ünlü harfler ve 🔐 emoji byte modunda UTF-8 olarak taşınır.",
      "x".repeat(dataCodewords(1, level) - 2),
      "y".repeat(dataCodewords(1, level) - 1),
      "w".repeat(largest - 40),
      "z".repeat(largest),
    ];
    const versions = new Set<number>();
    for (const sample of samples) {
      const code = encodeQr(sample, { errorCorrection: level });
      expect(code.errorCorrection).toBe(level);
      versions.add(code.version);
      const decoded = decodeQr(code);
      expect(decoded.text, `${level} ${sample.length}`).toBe(sample);
      expect(decoded.level).toBe(level);
    }
    expect(versions.has(1)).toBe(true);
    expect(versions.has(2)).toBe(true);
    expect(versions.has(10)).toBe(true);
    expect(() => encodeQr("z".repeat(largest + 1), { errorCorrection: level, minVersion: 1 })).not.toThrow();
    expect(encodeQr("z".repeat(largest + 1), { errorCorrection: level }).version).toBe(11);
  });

  it("round-trips a forced mask, a raised minimum version and the 16-bit count field", () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const code = encodeQr(otpauthUri, { mask });
      expect(code.mask).toBe(mask);
      expect(decodeQr(code).text).toBe(otpauthUri);
    }
    const large = encodeQr("v", { minVersion: 10 });
    expect(large.version).toBe(10);
    expect(decodeQr(large).text).toBe("v");
    const bytes = new Uint8Array([0, 255, 128, 1, 2, 3]);
    expect(decodeQr(encodeQr(bytes)).bytes).toEqual(bytes);
  });

  it("selects the lowest-penalty mask and is deterministic", () => {
    const first = encodeQr(otpauthUri);
    const second = encodeQr(otpauthUri);
    expect(second).toEqual(first);
    const penalties = Array.from({ length: 8 }, (_, mask) => penaltyScore(encodeQr(otpauthUri, { mask }).modules));
    expect(penaltyScore(first.modules)).toBe(Math.min(...penalties));
  });

  it("draws the finder patterns, separators and quiet zone the way scanners expect", () => {
    const code = encodeQr("SKY LAB");
    expect(code.version).toBe(1);
    expect(code.size).toBe(21);
    const finder = [
      "1111111",
      "1000001",
      "1011101",
      "1011101",
      "1011101",
      "1000001",
      "1111111",
    ];
    for (const [x, y] of [[0, 0], [14, 0], [0, 14]] as const) {
      for (let row = 0; row < 7; row += 1) {
        const actual = code.modules[y + row]!.slice(x, x + 7).map((dark) => (dark ? "1" : "0")).join("");
        expect(actual, `finder at ${x},${y} row ${row}`).toBe(finder[row]);
      }
    }
    // Separators: the light band between each finder and the rest of the symbol.
    for (let index = 0; index < 8; index += 1) {
      expect(code.modules[7]![index]).toBe(false);
      expect(code.modules[index]![7]).toBe(false);
      expect(code.modules[7]![20 - index]).toBe(false);
      expect(code.modules[index]![13]).toBe(false);
      expect(code.modules[13]![index]).toBe(false);
      expect(code.modules[20 - index]![7]).toBe(false);
    }
    const path = qrPath(code);
    const dark = code.modules.flat().filter(Boolean).length;
    expect(path.split("z").filter(Boolean)).toHaveLength(dark);
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
    expect(qrPath(code, 0).startsWith("M0 0h1v1h-1z")).toBe(true);
  });

  it("refuses data that does not fit and invalid masks", () => {
    expect(() => encodeQr("q".repeat(2_954), { errorCorrection: "L" })).toThrow(/too long/);
    expect(() => encodeQr("q", { mask: 8 })).toThrow(RangeError);
    expect(() => encodeQr("q", { minVersion: 41 })).toThrow(RangeError);
  });
});
