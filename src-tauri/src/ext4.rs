//! Read-only ext2/3/4 reader for partition dump files.
//! Finds ext filesystems in an image (whole image, MBR/GPT partitions, or after
//! leading data) and reads directories, files (extent- and block-mapped) and
//! symbolic links. Nothing is ever written to the image.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

const SUPERBLOCK_OFFSET: u64 = 1024;
const EXT_MAGIC: u16 = 0xef53;
const EXTENT_MAGIC: u16 = 0xf30a;
const ROOT_INODE: u32 = 2;

const INCOMPAT_FILETYPE: u32 = 0x0002;
const INCOMPAT_64BIT: u32 = 0x0080;
const FLAG_EXTENTS: u32 = 0x0008_0000;
const FLAG_INLINE_DATA: u32 = 0x1000_0000;

const MODE_TYPE_MASK: u16 = 0xf000;
const MODE_DIR: u16 = 0x4000;
const MODE_FILE: u16 = 0x8000;
const MODE_LINK: u16 = 0xa000;

const SECTOR: u64 = 512;
const EMBEDDED_SCAN_BYTES: u64 = 0x100800;
const GPT_MAX_ENTRIES: u32 = 256;

const MAX_DIR_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTENT_DEPTH: u32 = 5;
const MAX_RUNS: usize = 200000;
const MAX_LINK_BYTES: u64 = 4096;

fn u16(b: &[u8], o: usize) -> u16 {
    if o + 2 <= b.len() {
        u16::from_le_bytes([b[o], b[o + 1]])
    } else {
        0
    }
}
fn u32(b: &[u8], o: usize) -> u32 {
    if o + 4 <= b.len() {
        u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
    } else {
        0
    }
}
fn u64v(b: &[u8], o: usize) -> u64 {
    u32(b, o) as u64 + (u32(b, o + 4) as u64) * 0x1_0000_0000
}
fn cstring(b: &[u8], start: usize, length: usize) -> String {
    let end = (start + length).min(b.len());
    let slice = &b[start.min(b.len())..end];
    let stop = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..stop]).into_owned()
}

// ── Image source (file-backed) ───────────────────────────────────────────────

pub struct ImageSource {
    file: Mutex<File>,
    pub size: u64,
}

impl ImageSource {
    pub fn open(path: &std::path::Path) -> Result<Arc<ImageSource>, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        Ok(Arc::new(ImageSource { file: Mutex::new(file), size }))
    }

    pub fn read(&self, offset: u64, length: usize) -> Vec<u8> {
        if offset >= self.size {
            return Vec::new();
        }
        let wanted = (length as u64).min(self.size - offset) as usize;
        let mut buf = vec![0u8; wanted];
        let mut file = self.file.lock();
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return Vec::new();
        }
        let mut done = 0;
        while done < wanted {
            match file.read(&mut buf[done..]) {
                Ok(0) => break,
                Ok(n) => done += n,
                Err(_) => break,
            }
        }
        buf.truncate(done);
        buf
    }
}

// ── Superblock ───────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Superblock {
    block_size: u64,
    block_count: u64,
    free_blocks: u64,
    inode_count: u32,
    free_inodes: u32,
    first_data_block: u64,
    blocks_per_group: u32,
    inodes_per_group: u32,
    inode_size: u64,
    desc_size: u64,
    incompat: u32,
    volume_name: String,
    last_mounted: String,
}

fn parse_superblock(sb: &[u8]) -> Option<Superblock> {
    if sb.len() < 1024 || u16(sb, 0x38) != EXT_MAGIC {
        return None;
    }
    let log_block_size = u32(sb, 0x18);
    let blocks_per_group = u32(sb, 0x20);
    let inodes_per_group = u32(sb, 0x28);
    if log_block_size > 6 || blocks_per_group == 0 || inodes_per_group == 0 {
        return None;
    }
    let incompat = u32(sb, 0x60);
    let wide = (incompat & INCOMPAT_64BIT) != 0;
    let revision = u32(sb, 0x4c);
    let inode_size: u64 = if revision >= 1 { u16(sb, 0x58) as u64 } else { 128 };
    let desc_size: u64 = if wide { (u16(sb, 0xfe) as u64).max(32) } else { 32 };
    if inode_size < 128 || inode_size > 4096 || desc_size > 1024 {
        return None;
    }
    Some(Superblock {
        block_size: 1024u64 << log_block_size,
        block_count: u32(sb, 0x04) as u64 + if wide { u32(sb, 0x150) as u64 * 0x1_0000_0000 } else { 0 },
        free_blocks: u32(sb, 0x0c) as u64 + if wide { u32(sb, 0x158) as u64 * 0x1_0000_0000 } else { 0 },
        inode_count: u32(sb, 0x00),
        free_inodes: u32(sb, 0x10),
        first_data_block: u32(sb, 0x14) as u64,
        blocks_per_group,
        inodes_per_group,
        inode_size,
        desc_size,
        incompat,
        volume_name: cstring(sb, 0x78, 16),
        last_mounted: cstring(sb, 0x88, 64),
    })
}

fn superblock_at(source: &ImageSource, offset: u64) -> Option<Superblock> {
    if offset + SUPERBLOCK_OFFSET + 1024 > source.size {
        return None;
    }
    parse_superblock(&source.read(offset + SUPERBLOCK_OFFSET, 1024))
}

// ── Public UI types ──────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionCandidate {
    pub offset: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub label: String,
    pub ext: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub inode: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub mode: u16,
    pub modified: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStats {
    pub volume_name: String,
    pub last_mounted: String,
    pub block_size: u64,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub inodes: u32,
    pub free_inodes: u32,
}

fn opt(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn candidate(source: &ImageSource, offset: u64, label: &str, size: Option<u64>) -> PartitionCandidate {
    let sb = superblock_at(source, offset);
    PartitionCandidate { offset, size, label: label.into(), ext: sb.is_some(), volume_name: sb.and_then(|s| opt(s.volume_name)) }
}

/// Finds the partitions of an image, ext filesystems first found first listed.
pub fn probe_partitions(source: &ImageSource) -> Vec<PartitionCandidate> {
    let mut found: Vec<PartitionCandidate> = Vec::new();
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut add = |found: &mut Vec<PartitionCandidate>, entry: PartitionCandidate| {
        if seen.insert(entry.offset) {
            found.push(entry);
        }
    };

    let whole = candidate(source, 0, "Whole image", Some(source.size));
    if whole.ext {
        add(&mut found, whole);
    }

    if source.size >= SECTOR * 2 {
        let first = source.read(0, (SECTOR * 2) as usize);
        if first.len() >= 0x200 && first[0x1fe] == 0x55 && first[0x1ff] == 0xaa {
            for i in 0..4 {
                let entry = 0x1be + i * 16;
                let ptype = first.get(entry + 4).copied().unwrap_or(0);
                let start = u32(&first, entry + 8) as u64 * SECTOR;
                let length = u32(&first, entry + 12) as u64 * SECTOR;
                if ptype != 0 && ptype != 0xee && start > 0 && start < source.size {
                    add(&mut found, candidate(source, start, &format!("MBR partition {}", i + 1), Some(length)));
                }
            }
        }
        if first.len() >= (SECTOR as usize + 8) && &first[SECTOR as usize..SECTOR as usize + 8] == b"EFI PART" {
            let s = SECTOR as usize;
            let table_offset = u64v(&first, s + 72) * SECTOR;
            let count = u32(&first, s + 80).min(GPT_MAX_ENTRIES);
            let entry_size = u32(&first, s + 84) as u64;
            if (128..=1024).contains(&entry_size) && table_offset + count as u64 * entry_size <= source.size {
                let table = source.read(table_offset, (count as u64 * entry_size) as usize);
                for i in 0..count as usize {
                    let base = i * entry_size as usize;
                    let entry = &table[base.min(table.len())..((base + entry_size as usize).min(table.len()))];
                    if entry.len() < 128 || entry[..16].iter().all(|&b| b == 0) {
                        continue;
                    }
                    let start = u64v(entry, 32) * SECTOR;
                    let end = (u64v(entry, 40) + 1) * SECTOR;
                    let name_utf16: Vec<u16> = (56..128).step_by(2).map(|o| u16(entry, o)).take_while(|&c| c != 0).collect();
                    let name = String::from_utf16_lossy(&name_utf16);
                    if start > 0 && start < source.size {
                        let label = if name.is_empty() { format!("GPT partition {}", i + 1) } else { name };
                        add(&mut found, candidate(source, start, &label, Some(end.saturating_sub(start))));
                    }
                }
            }
        }
    }

    if !found.iter().any(|e| e.ext) {
        let limit = EMBEDDED_SCAN_BYTES.min(source.size);
        let head = source.read(0, limit as usize);
        let mut offset = SECTOR;
        while offset + SUPERBLOCK_OFFSET + 1024 <= limit {
            let at = (offset + SUPERBLOCK_OFFSET) as usize;
            if u16(&head, at + 0x38) == EXT_MAGIC {
                if let Some(sb) = parse_superblock(&head[at..(at + 1024).min(head.len())]) {
                    if sb.block_count > 0 && offset + sb.block_size * 2 <= source.size {
                        found.push(PartitionCandidate { offset, size: None, label: "Filesystem after extra data".into(), ext: true, volume_name: opt(sb.volume_name) });
                        break;
                    }
                }
            }
            offset += SECTOR;
        }
    }
    found
}

fn type_of(mode: u16) -> &'static str {
    match mode & MODE_TYPE_MASK {
        MODE_DIR => "dir",
        MODE_FILE => "file",
        MODE_LINK => "link",
        _ => "other",
    }
}

struct Inode {
    number: u32,
    mode: u16,
    size: u64,
    modified: u32,
    flags: u32,
    block: Vec<u8>,
}

#[derive(Clone)]
struct Run {
    logical: u64,
    physical: u64,
    count: u64,
    blank: bool,
}

struct RunState {
    next: u64,
    left: u64,
}

pub struct Ext4Volume {
    source: Arc<ImageSource>,
    base: u64,
    sb: Superblock,
    run_cache: HashMap<u32, Vec<Run>>,
}

impl Ext4Volume {
    pub fn open(source: Arc<ImageSource>, offset: u64) -> Result<Ext4Volume, String> {
        let sb = superblock_at(&source, offset).ok_or("No ext filesystem was found at this position.")?;
        Ok(Ext4Volume { source, base: offset, sb, run_cache: HashMap::new() })
    }

    pub fn stats(&self) -> FsStats {
        FsStats {
            volume_name: self.sb.volume_name.clone(),
            last_mounted: self.sb.last_mounted.clone(),
            block_size: self.sb.block_size,
            total_bytes: self.sb.block_count * self.sb.block_size,
            free_bytes: self.sb.free_blocks * self.sb.block_size,
            inodes: self.sb.inode_count,
            free_inodes: self.sb.free_inodes,
        }
    }

    fn read_blocks(&self, block: u64, count: u64) -> Result<Vec<u8>, String> {
        let offset = self.base + block * self.sb.block_size;
        let length = count * self.sb.block_size;
        if offset + length > self.source.size {
            return Err("The image ends before the data it refers to. The dump may be incomplete.".into());
        }
        Ok(self.source.read(offset, length as usize))
    }

    fn read_inode(&self, number: u32) -> Result<Inode, String> {
        if number < 1 || number > self.sb.inode_count {
            return Err("The image refers to a file record that does not exist.".into());
        }
        let group = (number - 1) / self.sb.inodes_per_group;
        let index = (number - 1) % self.sb.inodes_per_group;
        let table_block = self.sb.first_data_block + 1;
        let desc_offset = self.base + table_block * self.sb.block_size + group as u64 * self.sb.desc_size;
        let desc = self.source.read(desc_offset, self.sb.desc_size as usize);
        if (desc.len() as u64) < self.sb.desc_size {
            return Err("The image ends before its group table. The dump may be incomplete.".into());
        }
        let inode_table = u32(&desc, 0x08) as u64 + if self.sb.desc_size >= 64 { u32(&desc, 0x28) as u64 * 0x1_0000_0000 } else { 0 };
        let offset = self.base + inode_table * self.sb.block_size + index as u64 * self.sb.inode_size;
        let raw = self.source.read(offset, self.sb.inode_size as usize);
        if raw.len() < 128 {
            return Err("The image ends before a file record. The dump may be incomplete.".into());
        }
        let mode = u16(&raw, 0x00);
        let size_high = if (mode & MODE_TYPE_MASK) == MODE_FILE { u32(&raw, 0x6c) as u64 } else { 0 };
        Ok(Inode {
            number,
            mode,
            size: u32(&raw, 0x04) as u64 + size_high * 0x1_0000_0000,
            modified: u32(&raw, 0x10),
            flags: u32(&raw, 0x20),
            block: raw[0x28..0x28 + 60].to_vec(),
        })
    }

    fn walk_extents(&self, node: &[u8], depth_left: u32, runs: &mut Vec<Run>) -> Result<(), String> {
        if u16(node, 0) != EXTENT_MAGIC {
            return Err("A file has a damaged extent map.".into());
        }
        let entries = u16(node, 2) as usize;
        let depth = u16(node, 6) as u32;
        if depth > depth_left || 12 + entries * 12 > node.len() {
            return Err("A file has a damaged extent map.".into());
        }
        for i in 0..entries {
            let entry = 12 + i * 12;
            if depth == 0 {
                let raw_length = u16(node, entry + 4);
                let blank = raw_length > 32768;
                runs.push(Run {
                    logical: u32(node, entry) as u64,
                    physical: u32(node, entry + 8) as u64 + u16(node, entry + 6) as u64 * 0x1_0000_0000,
                    count: if blank { (raw_length - 32768) as u64 } else { raw_length as u64 },
                    blank,
                });
                if runs.len() > MAX_RUNS {
                    return Err("A file is too fragmented to read.".into());
                }
            } else {
                let child = u32(node, entry + 4) as u64 + u16(node, entry + 8) as u64 * 0x1_0000_0000;
                let block = self.read_blocks(child, 1)?;
                self.walk_extents(&block, depth - 1, runs)?;
            }
        }
        Ok(())
    }

    fn walk_indirect(&self, block: u64, level: u32, state: &mut RunState, runs: &mut Vec<Run>) -> Result<(), String> {
        let per_block = self.sb.block_size / 4;
        if block == 0 {
            let skipped = state.left.min(per_block.pow(level));
            state.next += skipped;
            state.left -= skipped;
            return Ok(());
        }
        let table = self.read_blocks(block, 1)?;
        let mut i = 0u64;
        while i < per_block && state.left > 0 {
            let pointer = u32(&table, (i * 4) as usize) as u64;
            if level > 1 {
                self.walk_indirect(pointer, level - 1, state, runs)?;
            } else {
                Self::push_block(pointer, state, runs)?;
            }
            i += 1;
        }
        Ok(())
    }

    fn push_block(physical: u64, state: &mut RunState, runs: &mut Vec<Run>) -> Result<(), String> {
        if physical != 0 {
            if let Some(last) = runs.last_mut() {
                if last.logical + last.count == state.next && last.physical + last.count == physical {
                    last.count += 1;
                    state.next += 1;
                    state.left -= 1;
                    return Ok(());
                }
            }
            runs.push(Run { logical: state.next, physical, count: 1, blank: false });
            if runs.len() > MAX_RUNS {
                return Err("A file is too fragmented to read.".into());
            }
        }
        state.next += 1;
        state.left -= 1;
        Ok(())
    }

    fn runs_of(&mut self, inode: &Inode) -> Result<Vec<Run>, String> {
        if let Some(cached) = self.run_cache.get(&inode.number) {
            return Ok(cached.clone());
        }
        let mut runs: Vec<Run> = Vec::new();
        if inode.flags & FLAG_EXTENTS != 0 {
            let block = inode.block.clone();
            self.walk_extents(&block, MAX_EXTENT_DEPTH, &mut runs)?;
            runs.sort_by_key(|r| r.logical);
        } else {
            let mut state = RunState { next: 0, left: inode.size.div_ceil(self.sb.block_size) };
            let mut i = 0;
            while i < 12 && state.left > 0 {
                Self::push_block(u32(&inode.block, i * 4) as u64, &mut state, &mut runs)?;
                i += 1;
            }
            for level in 1..=3u32 {
                if state.left == 0 {
                    break;
                }
                self.walk_indirect(u32(&inode.block, ((11 + level) * 4) as usize) as u64, level, &mut state, &mut runs)?;
            }
        }
        if self.run_cache.len() > 64 {
            self.run_cache.clear();
        }
        self.run_cache.insert(inode.number, runs.clone());
        Ok(runs)
    }

    fn read_range(&mut self, inode: &Inode, position: u64, length: u64) -> Result<Vec<u8>, String> {
        let end = inode.size.min(position + length);
        if end <= position {
            return Ok(Vec::new());
        }
        if inode.flags & FLAG_INLINE_DATA != 0 {
            return Err("This file is stored inside its record, which is not supported.".into());
        }
        let out_len = (end - position) as usize;
        let mut out = vec![0u8; out_len];
        let block_size = self.sb.block_size;
        for run in self.runs_of(inode)? {
            let run_start = run.logical * block_size;
            let run_end = run_start + run.count * block_size;
            let from = position.max(run_start);
            let to = end.min(run_end);
            if from >= to || run.blank {
                continue;
            }
            let offset = self.base + run.physical * block_size + (from - run_start);
            if offset + (to - from) > self.source.size {
                return Err("The image ends before this file. The dump may be incomplete.".into());
            }
            let data = self.source.read(offset, (to - from) as usize);
            let dest = (from - position) as usize;
            out[dest..dest + data.len()].copy_from_slice(&data);
        }
        Ok(out)
    }

    fn link_target(&mut self, inode: &Inode) -> Result<String, String> {
        let length = inode.size.min(MAX_LINK_BYTES);
        if inode.size < 60 && inode.flags & FLAG_EXTENTS == 0 {
            return Ok(String::from_utf8_lossy(&inode.block[..length as usize]).into_owned());
        }
        let bytes = self.read_range(inode, 0, length)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn entries_of(&mut self, directory: &Inode) -> Result<Vec<(String, u32)>, String> {
        if directory.mode & MODE_TYPE_MASK != MODE_DIR {
            return Err("This is not a folder.".into());
        }
        if directory.size > MAX_DIR_BYTES {
            return Err("This folder is too large to list.".into());
        }
        let data = self.read_range(directory, 0, directory.size)?;
        let mut out: Vec<(String, u32)> = Vec::new();
        let block_size = self.sb.block_size as usize;
        let filetype = self.sb.incompat & INCOMPAT_FILETYPE != 0;
        let mut block_start = 0usize;
        while block_start + 8 <= data.len() {
            let block_end = (block_start + block_size).min(data.len());
            let mut offset = block_start;
            while offset + 8 <= block_end {
                let inode = u32(&data, offset);
                let record_length = u16(&data, offset + 4) as usize;
                if record_length < 8 || offset + record_length > block_end {
                    break;
                }
                let name_length = if filetype { data[offset + 6] as usize } else { u16(&data, offset + 6) as usize };
                if inode != 0 && name_length > 0 && 8 + name_length <= record_length {
                    let name = String::from_utf8_lossy(&data[offset + 8..offset + 8 + name_length]).into_owned();
                    if name != "." && name != ".." {
                        out.push((name, inode));
                    }
                }
                offset += record_length;
            }
            block_start += block_size;
        }
        Ok(out)
    }

    fn resolve(&mut self, path: &str) -> Result<Inode, String> {
        let mut current = self.read_inode(ROOT_INODE)?;
        for part in path.split('/').filter(|s| !s.is_empty()) {
            let entries = self.entries_of(&current)?;
            let m = entries.iter().find(|(name, _)| name == part).ok_or_else(|| format!("\u{201c}{part}\u{201d} was not found."))?;
            current = self.read_inode(m.1)?;
        }
        Ok(current)
    }

    fn describe(&mut self, name: &str, inode: &Inode) -> FsEntry {
        let kind = type_of(inode.mode);
        let target = if kind == "link" { self.link_target(inode).ok() } else { None };
        FsEntry {
            name: name.into(),
            inode: inode.number,
            kind: kind.into(),
            size: inode.size,
            mode: inode.mode,
            modified: inode.modified,
            target,
            inline: if inode.flags & FLAG_INLINE_DATA != 0 { Some(true) } else { None },
        }
    }

    pub fn list(&mut self, path: &str) -> Result<Vec<FsEntry>, String> {
        let directory = self.resolve(path)?;
        let raw = self.entries_of(&directory)?;
        let mut entries: Vec<FsEntry> = Vec::new();
        for (name, inode_num) in raw {
            match self.read_inode(inode_num) {
                Ok(inode) => entries.push(self.describe(&name, &inode)),
                Err(_) => entries.push(FsEntry { name, inode: inode_num, kind: "other".into(), size: 0, mode: 0, modified: 0, target: None, inline: None }),
            }
        }
        entries.sort_by(|a, b| {
            let rank = |e: &FsEntry| if e.kind == "dir" { 0 } else { 1 };
            rank(a).cmp(&rank(b)).then_with(|| a.name.cmp(&b.name))
        });
        Ok(entries)
    }

    pub fn stat(&mut self, path: &str) -> Result<FsEntry, String> {
        let name = path.split('/').filter(|s| !s.is_empty()).next_back().unwrap_or("/").to_string();
        let inode = self.resolve(path)?;
        Ok(self.describe(&name, &inode))
    }

    pub fn read_head(&mut self, path: &str, limit: u64) -> Result<Vec<u8>, String> {
        let inode = self.resolve(path)?;
        if inode.mode & MODE_TYPE_MASK != MODE_FILE {
            return Err("This is not a regular file.".into());
        }
        self.read_range(&inode, 0, limit)
    }

    /// Streams a whole file to `sink`, a chunk at a time. Returns file size.
    pub fn read_file(&mut self, path: &str, mut sink: impl FnMut(&[u8]) -> Result<(), String>) -> Result<u64, String> {
        const CHUNK: u64 = 4 * 1024 * 1024;
        let inode = self.resolve(path)?;
        if inode.mode & MODE_TYPE_MASK != MODE_FILE {
            return Err("This is not a regular file.".into());
        }
        let mut position = 0;
        while position < inode.size {
            let chunk = self.read_range(&inode, position, CHUNK)?;
            sink(&chunk)?;
            position += CHUNK;
        }
        Ok(inode.size)
    }
}
