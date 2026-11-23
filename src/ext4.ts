/**
 * Read-only ext2/3/4 reader for partition dump files, with the partition
 * search AirForge's partition explorer uses (it is meant for "cali", "factory"
 * and similar dumps taken from an aircraft).
 *
 * Where a filesystem is looked for, in order:
 *   1. at the start of the file;
 *   2. in each MBR partition (table at 0x1BE, signature 55 AA at 0x1FE);
 *   3. in each GPT partition ("EFI PART" header in sector 1);
 *   4. anywhere in the first megabyte on a 512-byte boundary, for a dump that
 *      has extra data in front of the filesystem.
 *
 * Reading covers extent-mapped and block-mapped files, directories (hashed
 * ones included, since their blocks still hold ordinary entries) and symbolic
 * links. Nothing is ever written to the image. Files stored inline in the
 * inode are reported but not read, as in AirForge. AirForge's editing side
 * (patch, import, rename, delete) is not ported.
 */

/** Random-access bytes of an image file. */
export interface ImageSource {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface PartitionCandidate {
  /** Byte offset of the partition inside the image. */
  offset: number;
  /** Byte length, when the partition table states one. */
  size?: number;
  label: string;
  /** True when an ext filesystem was found at the offset. */
  ext: boolean;
  volumeName?: string;
}

export type EntryType = 'dir' | 'file' | 'link' | 'other';

export interface FsEntry {
  name: string;
  inode: number;
  type: EntryType;
  size: number;
  /** Unix mode bits, e.g. 0o100644. */
  mode: number;
  /** Modification time, epoch seconds. */
  modified: number;
  /** Target of a symbolic link. */
  target?: string;
  /** True when the data sits inside the inode and cannot be read here. */
  inline?: boolean;
}

export interface FsStats {
  volumeName: string;
  lastMounted: string;
  blockSize: number;
  totalBytes: number;
  freeBytes: number;
  inodes: number;
  freeInodes: number;
}

const SUPERBLOCK_OFFSET = 1024;
const EXT_MAGIC = 0xef53;
const EXTENT_MAGIC = 0xf30a;
const ROOT_INODE = 2;

const INCOMPAT_FILETYPE = 0x0002;
const INCOMPAT_64BIT = 0x0080;

const FLAG_EXTENTS = 0x00080000;
const FLAG_INLINE_DATA = 0x10000000;

const MODE_TYPE_MASK = 0xf000;
const MODE_DIR = 0x4000;
const MODE_FILE = 0x8000;
const MODE_LINK = 0xa000;

const SECTOR = 512;
const EMBEDDED_SCAN_BYTES = 0x100800;
const GPT_MAX_ENTRIES = 256;

/** Limits that keep a damaged image from running away. */
const MAX_DIR_BYTES = 64 * 1024 * 1024;
const MAX_EXTENT_DEPTH = 5;
const MAX_RUNS = 200000;
const MAX_LINK_BYTES = 4096;

const u64 = (buffer: Buffer, offset: number): number =>
  buffer.readUInt32LE(offset) + buffer.readUInt32LE(offset + 4) * 0x100000000;

const cString = (buffer: Buffer, start: number, length: number): string => {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
};

interface Superblock {
  blockSize: number;
  blockCount: number;
  freeBlocks: number;
  inodeCount: number;
  freeInodes: number;
  firstDataBlock: number;
  blocksPerGroup: number;
  inodesPerGroup: number;
  inodeSize: number;
  descSize: number;
  incompat: number;
  volumeName: string;
  lastMounted: string;
}

/** Parses a superblock; null when the bytes are not a plausible one. */
function parseSuperblock(sb: Buffer): Superblock | null {
  if (sb.length < 1024 || sb.readUInt16LE(0x38) !== EXT_MAGIC) {
    return null;
  }
  const logBlockSize = sb.readUInt32LE(0x18);
  const blocksPerGroup = sb.readUInt32LE(0x20);
  const inodesPerGroup = sb.readUInt32LE(0x28);
  if (logBlockSize > 6 || blocksPerGroup === 0 || inodesPerGroup === 0) {
    return null;
  }
  const incompat = sb.readUInt32LE(0x60);
  const wide = (incompat & INCOMPAT_64BIT) !== 0;
  const revision = sb.readUInt32LE(0x4c);
  const inodeSize = revision >= 1 ? sb.readUInt16LE(0x58) : 128;
  const descSize = wide ? Math.max(32, sb.readUInt16LE(0xfe)) : 32;
  if (inodeSize < 128 || inodeSize > 4096 || descSize > 1024) {
    return null;
  }
  return {
    blockSize: 1024 << logBlockSize,
    blockCount: sb.readUInt32LE(0x04) + (wide ? sb.readUInt32LE(0x150) * 0x100000000 : 0),
    freeBlocks: sb.readUInt32LE(0x0c) + (wide ? sb.readUInt32LE(0x158) * 0x100000000 : 0),
    inodeCount: sb.readUInt32LE(0x00),
    freeInodes: sb.readUInt32LE(0x10),
    firstDataBlock: sb.readUInt32LE(0x14),
    blocksPerGroup,
    inodesPerGroup,
    inodeSize,
    descSize,
    incompat,
    volumeName: cString(sb, 0x78, 16),
    lastMounted: cString(sb, 0x88, 64),
  };
}

async function superblockAt(source: ImageSource, offset: number): Promise<Superblock | null> {
  if (offset < 0 || offset + SUPERBLOCK_OFFSET + 1024 > source.size) {
    return null;
  }
  return parseSuperblock(await source.read(offset + SUPERBLOCK_OFFSET, 1024));
}

async function candidate(
  source: ImageSource,
  offset: number,
  label: string,
  size?: number,
): Promise<PartitionCandidate> {
  const sb = await superblockAt(source, offset);
  return { offset, size, label, ext: sb !== null, volumeName: sb?.volumeName || undefined };
}

/** Finds the partitions of an image, ext filesystems first found first listed. */
export async function probePartitions(source: ImageSource): Promise<PartitionCandidate[]> {
  const found: PartitionCandidate[] = [];
  const seen = new Set<number>();
  const add = (entry: PartitionCandidate): void => {
    if (!seen.has(entry.offset)) {
      seen.add(entry.offset);
      found.push(entry);
    }
  };

  const whole = await candidate(source, 0, 'Whole image', source.size);
  if (whole.ext) {
    add(whole);
  }

  if (source.size >= SECTOR * 2) {
    const first = await source.read(0, SECTOR * 2);
    if (first[0x1fe] === 0x55 && first[0x1ff] === 0xaa) {
      for (let i = 0; i < 4; i += 1) {
        const entry = 0x1be + i * 16;
        const type = first[entry + 4];
        const start = first.readUInt32LE(entry + 8) * SECTOR;
        const length = first.readUInt32LE(entry + 12) * SECTOR;
        if (type !== 0 && type !== 0xee && start > 0 && start < source.size) {
          add(await candidate(source, start, `MBR partition ${i + 1}`, length));
        }
      }
    }
    if (first.subarray(SECTOR, SECTOR + 8).toString('latin1') === 'EFI PART') {
      const tableOffset = u64(first, SECTOR + 72) * SECTOR;
      const count = Math.min(first.readUInt32LE(SECTOR + 80), GPT_MAX_ENTRIES);
      const entrySize = first.readUInt32LE(SECTOR + 84);
      if (entrySize >= 128 && entrySize <= 1024 && tableOffset + count * entrySize <= source.size) {
        const table = await source.read(tableOffset, count * entrySize);
        for (let i = 0; i < count; i += 1) {
          const entry = table.subarray(i * entrySize, (i + 1) * entrySize);
          if (entry.subarray(0, 16).every((byte) => byte === 0)) {
            continue;
          }
          const start = u64(entry, 32) * SECTOR;
          const end = (u64(entry, 40) + 1) * SECTOR;
          const name = entry.subarray(56, 128).toString('utf16le').replace(/\0+$/, '');
          if (start > 0 && start < source.size) {
            add(await candidate(source, start, name || `GPT partition ${i + 1}`, Math.max(0, end - start)));
          }
        }
      }
    }
  }

  if (!found.some((entry) => entry.ext)) {
    const limit = Math.min(EMBEDDED_SCAN_BYTES, source.size);
    const head = await source.read(0, limit);
    for (let offset = SECTOR; offset + SUPERBLOCK_OFFSET + 1024 <= limit; offset += SECTOR) {
      if (head.readUInt16LE(offset + SUPERBLOCK_OFFSET + 0x38) !== EXT_MAGIC) {
        continue;
      }
      const sb = parseSuperblock(head.subarray(offset + SUPERBLOCK_OFFSET, offset + SUPERBLOCK_OFFSET + 1024));
      if (sb && sb.blockCount > 0 && offset + sb.blockSize * 2 <= source.size) {
        add({ offset, label: 'Filesystem after extra data', ext: true, volumeName: sb.volumeName || undefined });
        break;
      }
    }
  }
  return found;
}

interface Inode {
  number: number;
  mode: number;
  size: number;
  modified: number;
  flags: number;
  /** The 60-byte block map / extent root / fast-link text. */
  block: Buffer;
}

/** A run of consecutive file blocks and where they sit in the filesystem. */
interface Run {
  logical: number;
  physical: number;
  count: number;
  /** True for a preallocated extent, which reads as zeros. */
  blank: boolean;
}

const typeOf = (mode: number): EntryType => {
  const kind = mode & MODE_TYPE_MASK;
  return kind === MODE_DIR ? 'dir' : kind === MODE_FILE ? 'file' : kind === MODE_LINK ? 'link' : 'other';
};

/** One mounted ext filesystem inside an image. */
export class Ext4Volume {
  private readonly runCache = new Map<number, Run[]>();

  private constructor(
    private readonly source: ImageSource,
    private readonly base: number,
    private readonly sb: Superblock,
  ) {}

  static async open(source: ImageSource, offset: number): Promise<Ext4Volume> {
    const sb = await superblockAt(source, offset);
    if (!sb) {
      throw new Error('No ext filesystem was found at this position.');
    }
    return new Ext4Volume(source, offset, sb);
  }

  get stats(): FsStats {
    return {
      volumeName: this.sb.volumeName,
      lastMounted: this.sb.lastMounted,
      blockSize: this.sb.blockSize,
      totalBytes: this.sb.blockCount * this.sb.blockSize,
      freeBytes: this.sb.freeBlocks * this.sb.blockSize,
      inodes: this.sb.inodeCount,
      freeInodes: this.sb.freeInodes,
    };
  }

  private async readBlocks(block: number, count: number): Promise<Buffer> {
    const offset = this.base + block * this.sb.blockSize;
    const length = count * this.sb.blockSize;
    if (block < 0 || offset + length > this.source.size) {
      throw new Error('The image ends before the data it refers to. The dump may be incomplete.');
    }
    return this.source.read(offset, length);
  }

  private async readInode(number: number): Promise<Inode> {
    if (!Number.isInteger(number) || number < 1 || number > this.sb.inodeCount) {
      throw new Error('The image refers to a file record that does not exist.');
    }
    const group = Math.floor((number - 1) / this.sb.inodesPerGroup);
    const index = (number - 1) % this.sb.inodesPerGroup;
    const tableBlock = this.sb.firstDataBlock + 1;
    const descOffset = this.base + tableBlock * this.sb.blockSize + group * this.sb.descSize;
    const desc = await this.source.read(descOffset, this.sb.descSize);
    if (desc.length < this.sb.descSize) {
      throw new Error('The image ends before its group table. The dump may be incomplete.');
    }
    const inodeTable =
      desc.readUInt32LE(0x08) + (this.sb.descSize >= 64 ? desc.readUInt32LE(0x28) * 0x100000000 : 0);
    const offset = this.base + inodeTable * this.sb.blockSize + index * this.sb.inodeSize;
    const raw = await this.source.read(offset, this.sb.inodeSize);
    if (raw.length < 128) {
      throw new Error('The image ends before a file record. The dump may be incomplete.');
    }
    const mode = raw.readUInt16LE(0x00);
    const sizeHigh = (mode & MODE_TYPE_MASK) === MODE_FILE ? raw.readUInt32LE(0x6c) : 0;
    return {
      number,
      mode,
      size: raw.readUInt32LE(0x04) + sizeHigh * 0x100000000,
      modified: raw.readUInt32LE(0x10),
      flags: raw.readUInt32LE(0x20),
      block: Buffer.from(raw.subarray(0x28, 0x28 + 60)),
    };
  }

  /** Walks an extent tree node, appending its leaf extents to `runs`. */
  private async walkExtents(node: Buffer, depthLeft: number, runs: Run[]): Promise<void> {
    if (node.readUInt16LE(0) !== EXTENT_MAGIC) {
      throw new Error('A file has a damaged extent map.');
    }
    const entries = node.readUInt16LE(2);
    const depth = node.readUInt16LE(6);
    if (depth > depthLeft || 12 + entries * 12 > node.length) {
      throw new Error('A file has a damaged extent map.');
    }
    for (let i = 0; i < entries; i += 1) {
      const entry = 12 + i * 12;
      if (depth === 0) {
        const rawLength = node.readUInt16LE(entry + 4);
        const blank = rawLength > 32768;
        runs.push({
          logical: node.readUInt32LE(entry),
          physical: node.readUInt32LE(entry + 8) + node.readUInt16LE(entry + 6) * 0x100000000,
          count: blank ? rawLength - 32768 : rawLength,
          blank,
        });
        if (runs.length > MAX_RUNS) {
          throw new Error('A file is too fragmented to read.');
        }
      } else {
        const child = node.readUInt32LE(entry + 4) + node.readUInt16LE(entry + 8) * 0x100000000;
        await this.walkExtents(await this.readBlocks(child, 1), depth - 1, runs);
      }
    }
  }

  /** Appends the blocks an indirect block points to, `level` levels deep. */
  private async walkIndirect(block: number, level: number, state: { next: number; left: number }, runs: Run[]): Promise<void> {
    const perBlock = this.sb.blockSize / 4;
    if (block === 0) {
      const skipped = Math.min(state.left, perBlock ** level);
      state.next += skipped;
      state.left -= skipped;
      return;
    }
    const table = await this.readBlocks(block, 1);
    for (let i = 0; i < perBlock && state.left > 0; i += 1) {
      const pointer = table.readUInt32LE(i * 4);
      if (level > 1) {
        await this.walkIndirect(pointer, level - 1, state, runs);
      } else {
        this.pushBlock(pointer, state, runs);
      }
    }
  }

  private pushBlock(physical: number, state: { next: number; left: number }, runs: Run[]): void {
    if (physical !== 0) {
      const last = runs[runs.length - 1];
      if (last && last.logical + last.count === state.next && last.physical + last.count === physical) {
        last.count += 1;
      } else {
        runs.push({ logical: state.next, physical, count: 1, blank: false });
        if (runs.length > MAX_RUNS) {
          throw new Error('A file is too fragmented to read.');
        }
      }
    }
    state.next += 1;
    state.left -= 1;
  }

  private async runsOf(inode: Inode): Promise<Run[]> {
    const cached = this.runCache.get(inode.number);
    if (cached) {
      return cached;
    }
    const runs: Run[] = [];
    if (inode.flags & FLAG_EXTENTS) {
      await this.walkExtents(inode.block, MAX_EXTENT_DEPTH, runs);
      runs.sort((a, b) => a.logical - b.logical);
    } else {
      const state = { next: 0, left: Math.ceil(inode.size / this.sb.blockSize) };
      for (let i = 0; i < 12 && state.left > 0; i += 1) {
        this.pushBlock(inode.block.readUInt32LE(i * 4), state, runs);
      }
      for (let level = 1; level <= 3 && state.left > 0; level += 1) {
        await this.walkIndirect(inode.block.readUInt32LE((11 + level) * 4), level, state, runs);
      }
    }
    if (this.runCache.size > 64) {
      this.runCache.clear();
    }
    this.runCache.set(inode.number, runs);
    return runs;
  }

  /** Reads `length` bytes of a file from `position`; holes read as zeros. */
  private async readRange(inode: Inode, position: number, length: number): Promise<Buffer> {
    const end = Math.min(inode.size, position + length);
    const out = Buffer.alloc(Math.max(0, end - position));
    if (out.length === 0) {
      return out;
    }
    if (inode.flags & FLAG_INLINE_DATA) {
      throw new Error('This file is stored inside its record, which is not supported.');
    }
    const blockSize = this.sb.blockSize;
    for (const run of await this.runsOf(inode)) {
      const runStart = run.logical * blockSize;
      const runEnd = runStart + run.count * blockSize;
      const from = Math.max(position, runStart);
      const to = Math.min(end, runEnd);
      if (from >= to || run.blank) {
        continue;
      }
      const offset = this.base + run.physical * blockSize + (from - runStart);
      if (offset + (to - from) > this.source.size) {
        throw new Error('The image ends before this file. The dump may be incomplete.');
      }
      const data = await this.source.read(offset, to - from);
      data.copy(out, from - position);
    }
    return out;
  }

  private async linkTarget(inode: Inode): Promise<string> {
    const length = Math.min(inode.size, MAX_LINK_BYTES);
    if (inode.size < 60 && !(inode.flags & FLAG_EXTENTS)) {
      return inode.block.subarray(0, length).toString('utf8');
    }
    return (await this.readRange(inode, 0, length)).toString('utf8');
  }

  private async entriesOf(directory: Inode): Promise<{ name: string; inode: number }[]> {
    if ((directory.mode & MODE_TYPE_MASK) !== MODE_DIR) {
      throw new Error('This is not a folder.');
    }
    if (directory.size > MAX_DIR_BYTES) {
      throw new Error('This folder is too large to list.');
    }
    const data = await this.readRange(directory, 0, directory.size);
    const out: { name: string; inode: number }[] = [];
    const blockSize = this.sb.blockSize;
    for (let blockStart = 0; blockStart + 8 <= data.length; blockStart += blockSize) {
      let offset = blockStart;
      const blockEnd = Math.min(blockStart + blockSize, data.length);
      while (offset + 8 <= blockEnd) {
        const inode = data.readUInt32LE(offset);
        const recordLength = data.readUInt16LE(offset + 4);
        if (recordLength < 8 || offset + recordLength > blockEnd) {
          break;
        }
        const nameLength =
          this.sb.incompat & INCOMPAT_FILETYPE ? data[offset + 6] : data.readUInt16LE(offset + 6);
        if (inode !== 0 && nameLength > 0 && 8 + nameLength <= recordLength) {
          const name = data.subarray(offset + 8, offset + 8 + nameLength).toString('utf8');
          if (name !== '.' && name !== '..') {
            out.push({ name, inode });
          }
        }
        offset += recordLength;
      }
    }
    return out;
  }

  /** Resolves an absolute path ("/", "/etc/fstab") to its inode. */
  private async resolve(path: string): Promise<Inode> {
    let current = await this.readInode(ROOT_INODE);
    for (const part of path.split('/').filter((segment) => segment.length > 0)) {
      const match = (await this.entriesOf(current)).find((entry) => entry.name === part);
      if (!match) {
        throw new Error(`“${part}” was not found.`);
      }
      current = await this.readInode(match.inode);
    }
    return current;
  }

  private async describe(name: string, inode: Inode): Promise<FsEntry> {
    const type = typeOf(inode.mode);
    return {
      name,
      inode: inode.number,
      type,
      size: inode.size,
      mode: inode.mode,
      modified: inode.modified,
      target: type === 'link' ? await this.linkTarget(inode).catch((): undefined => undefined) : undefined,
      inline: (inode.flags & FLAG_INLINE_DATA) !== 0 || undefined,
    };
  }

  /** Lists a folder: folders first, then files, each by name. */
  async list(path: string): Promise<FsEntry[]> {
    const directory = await this.resolve(path);
    const entries: FsEntry[] = [];
    for (const entry of await this.entriesOf(directory)) {
      try {
        entries.push(await this.describe(entry.name, await this.readInode(entry.inode)));
      } catch {
        entries.push({ name: entry.name, inode: entry.inode, type: 'other', size: 0, mode: 0, modified: 0 });
      }
    }
    return entries.sort(
      (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
    );
  }

  async stat(path: string): Promise<FsEntry> {
    const name = path.split('/').filter(Boolean).pop() ?? '/';
    return this.describe(name, await this.resolve(path));
  }

  /** Reads the first `limit` bytes of a file. */
  async readHead(path: string, limit: number): Promise<Buffer> {
    const inode = await this.resolve(path);
    if ((inode.mode & MODE_TYPE_MASK) !== MODE_FILE) {
      throw new Error('This is not a regular file.');
    }
    return this.readRange(inode, 0, limit);
  }

  /** Streams a whole file to `sink`, a chunk at a time. */
  async readFile(path: string, sink: (chunk: Buffer) => Promise<void>, chunkBytes = 4 * 1024 * 1024): Promise<number> {
    const inode = await this.resolve(path);
    if ((inode.mode & MODE_TYPE_MASK) !== MODE_FILE) {
      throw new Error('This is not a regular file.');
    }
    for (let position = 0; position < inode.size; position += chunkBytes) {
      await sink(await this.readRange(inode, position, chunkBytes));
    }
    return inode.size;
  }
}

/** Renders mode bits the way `ls -l` does, e.g. "drwxr-xr-x". */
export function modeString(mode: number): string {
  const kind = mode & MODE_TYPE_MASK;
  const lead = kind === MODE_DIR ? 'd' : kind === MODE_LINK ? 'l' : kind === MODE_FILE ? '-' : '?';
  const bits = 'rwxrwxrwx';
  let out = lead;
  for (let i = 0; i < 9; i += 1) {
    out += mode & (0o400 >> i) ? bits[i] : '-';
  }
  return out;
}
