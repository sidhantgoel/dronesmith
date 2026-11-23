//! Partition image explorer glue. Result types, text/hex preview helpers, and
//! recursive extraction over an Ext4Volume.

use crate::ext4::{Ext4Volume, FsEntry, FsStats, PartitionCandidate};
use serde::Serialize;
use std::io::Write;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partitions: Option<Vec<PartitionCandidate>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMountResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<FsStats>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageListResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<FsEntry>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreview {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExtractResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExtractProgress {
    pub files: u64,
    pub bytes: u64,
    pub name: String,
}

pub const PREVIEW_BYTES: u64 = 64 * 1024;
pub const HEX_PREVIEW_BYTES: usize = 2048;

const RESERVED: &[&str] = &["con", "prn", "aux", "nul"];

/// A name that is safe to create on this computer.
pub fn safe_name(name: &str) -> String {
    let printable: String = name.chars().map(|c| if (c as u32) < 32 { '_' } else { c }).collect();
    let cleaned: String = printable.chars().map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "_".into();
    }
    let lower = cleaned.to_lowercase();
    let stem = lower.split('.').next().unwrap_or(&lower);
    let reserved = RESERVED.contains(&stem) || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0');
    if reserved {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

pub fn looks_textual(data: &[u8]) -> bool {
    if data.is_empty() {
        return true;
    }
    let mut odd = 0;
    for &byte in data {
        if byte == 0 {
            return false;
        }
        if byte < 9 || (byte > 13 && byte < 32) {
            odd += 1;
        }
    }
    (odd as f64) / (data.len() as f64) < 0.02
}

pub fn hex_dump(data: &[u8]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let row = &data[offset..(offset + 16).min(data.len())];
        let hex = row.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
        let text: String = row.iter().map(|&b| if (32..127).contains(&b) { b as char } else { '.' }).collect();
        lines.push(format!("{:06x}  {:<47}  {text}", offset, hex));
        offset += 16;
    }
    lines.join("\n")
}

fn join_path(folder: &str, name: &str) -> String {
    format!("{}/{name}", folder.trim_end_matches('/'))
}

/// Streams one file out of the image, reporting bytes via `emit`.
pub fn write_out(volume: &mut Ext4Volume, remote: &str, local: &Path, tally: &mut ImageExtractProgress, emit: &dyn Fn(&ImageExtractProgress)) -> Result<(), String> {
    let mut out = std::fs::File::create(local).map_err(|e| e.to_string())?;
    volume.read_file(remote, |chunk| {
        out.write_all(chunk).map_err(|e| e.to_string())?;
        tally.bytes += chunk.len() as u64;
        emit(tally);
        Ok(())
    })?;
    tally.files += 1;
    Ok(())
}

/// Extracts a folder and everything under it; links and special files skipped.
pub fn extract_tree(volume: &mut Ext4Volume, remote: &str, local: &Path, tally: &mut ImageExtractProgress, skipped: &mut Vec<String>, emit: &dyn Fn(&ImageExtractProgress)) -> Result<(), String> {
    std::fs::create_dir_all(local).map_err(|e| e.to_string())?;
    for entry in volume.list(remote)? {
        let child = join_path(remote, &entry.name);
        let target = local.join(safe_name(&entry.name));
        tally.name = entry.name.clone();
        if entry.kind == "dir" {
            extract_tree(volume, &child, &target, tally, skipped, emit)?;
        } else if entry.kind == "file" && entry.inline != Some(true) {
            if write_out(volume, &child, &target, tally, emit).is_err() {
                skipped.push(child);
            }
        } else {
            skipped.push(child);
        }
        emit(tally);
    }
    Ok(())
}
