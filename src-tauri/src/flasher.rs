//! DJI firmware flashing over DUML. Pure protocol: builds the exact DUML steps
//! and parses upgrade-status reports; the session orchestrates transfer and
//! progress.
//!
//! DANGER: flashing is irreversible and can brick an aircraft. The byte
//! sequences are exact; do not "improve" the byte layouts.

use crate::service::ServiceStep;
use serde::Serialize;
use std::io::Read;

#[derive(Clone, Copy, PartialEq)]
pub enum FlashFamily {
    LegacyMini,
    LegacyAir,
    NewM3,
}

#[derive(Clone)]
pub struct FlashRoute {
    pub drone_type: &'static str,
    pub family: FlashFamily,
    pub receiver: u8,
    pub sender: u8,
}

/// Maps a factory code to its flashing route. Only models the engine flashes are
/// listed; anything else returns None (refuse to flash).
pub fn flash_route_for_code(code: Option<&str>) -> Option<FlashRoute> {
    let u = code?.to_uppercase();
    let mini = |drone_type| FlashRoute { drone_type, family: FlashFamily::LegacyMini, receiver: 0x01, sender: 0x2a };
    let air = |drone_type| FlashRoute { drone_type, family: FlashFamily::LegacyAir, receiver: 0x28, sender: 0x2a };
    let m3 = |drone_type, receiver| FlashRoute { drone_type, family: FlashFamily::NewM3, receiver, sender: 0x2a };
    // Longer codes are matched before their prefixes.
    if u.contains("WM1615") { return Some(mini("MINI2")); }
    if u.contains("WM1605") { return Some(mini("MINISE")); }
    if u.contains("WM160") { return Some(mini("MINI1")); }
    if u.contains("WM161") { return Some(mini("MINI2")); }
    if u.contains("WM163") { return Some(mini("MINI2")); }
    if u.contains("WM162") { return Some(m3("MINI3", 0x48)); }
    if u.contains("WM231") { return Some(air("AIR2")); }
    if u.contains("WM232") { return Some(air("AIR2S")); }
    if u.contains("WM2605") { return Some(m3("MAVIC3", 0x4f)); }
    if u.contains("WM260") { return Some(m3("MAVIC3", 0x4f)); }
    if u.contains("WM261") { return Some(m3("MAVIC3", 0x4f)); }
    None
}

const ACK_AFTER_EXEC: u8 = 0x40;
const NO_ACK: u8 = 0x00;
const CMD_SET_GENERAL: u8 = 0x00;
const CMD_FILE_TRANSFER: u8 = 0x2a;

pub const MAX_BLOCK_SIZE: usize = 980;

struct FamilySpec {
    enter_cmd: u8,
    enter_payload: Vec<u8>,
    prepare_cmd: u8,
    prepare_tail: Vec<u8>,
    data_subop: u8,
    data_ack_enc: u8,
    data_expect_reply: bool,
    file_open_tail: Vec<u8>,
    finish_cmd: u8,
    finish_payload: Vec<u8>,
}

fn family_spec(family: FlashFamily) -> FamilySpec {
    match family {
        FlashFamily::LegacyMini => FamilySpec {
            enter_cmd: 0x07,
            enter_payload: vec![0; 9],
            prepare_cmd: 0x08,
            prepare_tail: vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02],
            data_subop: 0x02,
            data_ack_enc: ACK_AFTER_EXEC,
            data_expect_reply: false,
            file_open_tail: vec![0; 4],
            finish_cmd: 0x0a,
            finish_payload: vec![0; 17],
        },
        FlashFamily::LegacyAir => FamilySpec {
            enter_cmd: 0x07,
            enter_payload: vec![0; 9],
            prepare_cmd: 0x08,
            prepare_tail: vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02],
            data_subop: 0x02,
            data_ack_enc: ACK_AFTER_EXEC,
            data_expect_reply: true,
            file_open_tail: vec![0; 4],
            finish_cmd: 0x0a,
            finish_payload: vec![0; 17],
        },
        FlashFamily::NewM3 => FamilySpec {
            enter_cmd: 0x83,
            enter_payload: vec![0x04],
            prepare_cmd: 0x84,
            prepare_tail: vec![0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01],
            data_subop: 0x04,
            data_ack_enc: NO_ACK,
            data_expect_reply: false,
            file_open_tail: vec![0x00, 0x00, 0x01, 0x01],
            finish_cmd: 0x85,
            finish_payload: vec![0; 16],
        },
    }
}

fn step(route: &FlashRoute, cmd_id: u8, payload: Vec<u8>, ack_enc: u8, expect_reply: bool) -> ServiceStep {
    ServiceStep { sender: route.sender, receiver: route.receiver, ack_enc, cmd_set: CMD_SET_GENERAL, cmd_id, payload, expect_reply, wait_after_ms: 0 }
}

pub fn enter_step(route: &FlashRoute) -> ServiceStep {
    let f = family_spec(route.family);
    step(route, f.enter_cmd, f.enter_payload, ACK_AFTER_EXEC, true)
}

pub fn prepare_step(route: &FlashRoute, total_size: u32) -> ServiceStep {
    let f = family_spec(route.family);
    let mut payload = vec![0x00];
    payload.extend_from_slice(&total_size.to_le_bytes());
    payload.extend_from_slice(&f.prepare_tail);
    step(route, f.prepare_cmd, payload, ACK_AFTER_EXEC, true)
}

pub fn file_open_step(route: &FlashRoute, name: &str, size: u32) -> Result<ServiceStep, String> {
    let f = family_spec(route.family);
    let name_bytes = name.as_bytes();
    if name_bytes.len() + 1 > 0xff {
        return Err(format!("Firmware file name too long: {name}"));
    }
    let mut payload = vec![0x01];
    payload.extend_from_slice(&size.to_le_bytes());
    payload.push((name_bytes.len() + 1) as u8);
    payload.extend_from_slice(name_bytes);
    payload.push(0x00);
    payload.extend_from_slice(&f.file_open_tail);
    Ok(step(route, CMD_FILE_TRANSFER, payload, ACK_AFTER_EXEC, true))
}

pub fn data_step(route: &FlashRoute, index: u32, chunk: &[u8]) -> ServiceStep {
    let f = family_spec(route.family);
    let mut payload = vec![f.data_subop];
    payload.extend_from_slice(&index.to_le_bytes());
    payload.extend_from_slice(chunk);
    step(route, CMD_FILE_TRANSFER, payload, f.data_ack_enc, f.data_expect_reply)
}

pub fn md5_step(route: &FlashRoute, file_bytes: &[u8]) -> ServiceStep {
    let digest = md5::compute(file_bytes);
    let mut payload = vec![0x03];
    payload.extend_from_slice(&digest.0);
    step(route, CMD_FILE_TRANSFER, payload, ACK_AFTER_EXEC, true)
}

pub fn finish_step(route: &FlashRoute) -> ServiceStep {
    let f = family_spec(route.family);
    step(route, f.finish_cmd, f.finish_payload, ACK_AFTER_EXEC, true)
}

/// Block size negotiated from a prepare/file-open reply (bytes[1:3], LE),
/// clamped to MAX_BLOCK_SIZE. None when the reply is too short.
pub fn block_size_from_reply(reply: Option<&[u8]>) -> Option<usize> {
    let r = reply?;
    if r.len() < 3 {
        return None;
    }
    let value = (r[1] as usize) | ((r[2] as usize) << 8);
    if value == 0 {
        return None;
    }
    Some(value.min(MAX_BLOCK_SIZE))
}

// ── Upgrade status (cmd 0x42) ────────────────────────────────────────────────

pub struct UpgradeStatus {
    /// verify | confirm | progress | success | failed | unknown
    pub phase: &'static str,
    pub percent: Option<u8>,
    pub detail: Option<String>,
}

fn result_text(code: u8) -> String {
    match code {
        1 => "success",
        2 => "upgrade failed",
        3 => "firmware error",
        4 => "same version",
        5 => "cancelled",
        6 => "timed out",
        7 => "motors running",
        8 => "firmware mismatch",
        9 => "downgrade rejected",
        10 => "remote controller not connected",
        _ => return format!("result code {code}"),
    }
    .to_string()
}

pub fn decode_upgrade_status(payload: &[u8]) -> UpgradeStatus {
    if payload.is_empty() {
        return UpgradeStatus { phase: "unknown", percent: None, detail: None };
    }
    match payload[0] {
        1 => UpgradeStatus { phase: "verify", percent: None, detail: Some("verifying firmware".into()) },
        2 => UpgradeStatus { phase: "confirm", percent: None, detail: Some("confirming firmware".into()) },
        3 => UpgradeStatus { phase: "progress", percent: payload.get(1).copied(), detail: None },
        4 => {
            let code = payload.get(1).copied().unwrap_or(0);
            UpgradeStatus { phase: if code == 1 { "success" } else { "failed" }, percent: None, detail: Some(result_text(code)) }
        }
        _ => UpgradeStatus { phase: "unknown", percent: None, detail: None },
    }
}

// ── Firmware package extraction ──────────────────────────────────────────────

pub struct FirmwareFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

fn is_sig(name: &str) -> bool {
    name.to_lowercase().ends_with(".sig")
}

fn is_zip(b: &[u8]) -> bool {
    b.len() > 4 && b[0] == 0x50 && b[1] == 0x4b && (b[2] == 0x03 || b[2] == 0x01 || b[2] == 0x05)
}

fn is_gzip(b: &[u8]) -> bool {
    b.len() > 2 && b[0] == 0x1f && b[1] == 0x8b
}

fn base_name(name: &str) -> String {
    name.rsplit('/').next().unwrap_or(name).to_string()
}

fn u16le(b: &[u8], at: usize) -> usize {
    (b[at] as usize) | ((b[at + 1] as usize) << 8)
}
fn u32le(b: &[u8], at: usize) -> usize {
    (b[at] as usize) | ((b[at + 1] as usize) << 8) | ((b[at + 2] as usize) << 16) | ((b[at + 3] as usize) << 24)
}

fn read_tar_sigs(buf: &[u8]) -> Vec<FirmwareFile> {
    let mut files = Vec::new();
    let mut offset = 0usize;
    while offset + 512 <= buf.len() {
        let header = &buf[offset..offset + 512];
        if header.iter().all(|&b| b == 0) {
            break;
        }
        let name_end = header[..100].iter().position(|&b| b == 0).unwrap_or(100);
        let name = String::from_utf8_lossy(&header[..name_end]).to_string();
        let size_field = String::from_utf8_lossy(&header[124..136]);
        let size = usize::from_str_radix(size_field.trim_matches(|c| c == '\0' || c == ' '), 8).unwrap_or(0);
        let data_start = offset + 512;
        if is_sig(&name) && size > 0 && data_start + size <= buf.len() {
            files.push(FirmwareFile { name: base_name(&name), bytes: buf[data_start..data_start + size].to_vec() });
        }
        offset = data_start + size.div_ceil(512) * 512;
    }
    files
}

fn read_zip_sigs(buf: &[u8]) -> Vec<FirmwareFile> {
    const EOCD: usize = 0x06054b50;
    let mut eocd: isize = -1;
    if buf.len() >= 22 {
        let lower = buf.len().saturating_sub(22 + 0xffff);
        let mut i = buf.len() - 22;
        loop {
            if u32le(buf, i) == EOCD {
                eocd = i as isize;
                break;
            }
            if i == 0 || i <= lower {
                break;
            }
            i -= 1;
        }
    }
    if eocd < 0 {
        return Vec::new();
    }
    let eocd = eocd as usize;
    let count = u16le(buf, eocd + 10);
    let mut p = u32le(buf, eocd + 16);
    let mut files = Vec::new();
    for _ in 0..count {
        if p + 46 > buf.len() || u32le(buf, p) != 0x02014b50 {
            break;
        }
        let method = u16le(buf, p + 10);
        let comp_size = u32le(buf, p + 20);
        let name_len = u16le(buf, p + 28);
        let extra_len = u16le(buf, p + 30);
        let comment_len = u16le(buf, p + 32);
        let local_offset = u32le(buf, p + 42);
        let name = String::from_utf8_lossy(&buf[p + 46..(p + 46 + name_len).min(buf.len())]).to_string();
        p += 46 + name_len + extra_len + comment_len;
        if !is_sig(&name) {
            continue;
        }
        if local_offset + 30 > buf.len() || u32le(buf, local_offset) != 0x04034b50 {
            continue;
        }
        let l_name_len = u16le(buf, local_offset + 26);
        let l_extra_len = u16le(buf, local_offset + 28);
        let data_start = local_offset + 30 + l_name_len + l_extra_len;
        if data_start + comp_size > buf.len() {
            continue;
        }
        let comp = &buf[data_start..data_start + comp_size];
        let bytes = match method {
            0 => comp.to_vec(),
            8 => {
                let mut out = Vec::new();
                if flate2::read::DeflateDecoder::new(comp).read_to_end(&mut out).is_err() {
                    continue;
                }
                out
            }
            _ => continue,
        };
        files.push(FirmwareFile { name: base_name(&name), bytes });
    }
    files
}

/// Reads the .sig firmware modules from a package (tar, tar.gz/tgz or zip),
/// sorted by name for a deterministic transfer order.
pub fn read_firmware_package(buffer: &[u8]) -> Vec<FirmwareFile> {
    let data: Vec<u8> = if is_gzip(buffer) {
        let mut out = Vec::new();
        if flate2::read::GzDecoder::new(buffer).read_to_end(&mut out).is_err() {
            return Vec::new();
        }
        out
    } else {
        buffer.to_vec()
    };
    let mut files = if is_zip(&data) { read_zip_sigs(&data) } else { read_tar_sigs(&data) };
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

// ── State types for the UI ───────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareFileInfo {
    pub name: String,
    pub size: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashState {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drone_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_path: Option<String>,
    pub files: Vec<FirmwareFileInfo>,
    pub total_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overall_progress: Option<u32>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
}

impl FlashState {
    pub fn idle() -> Self {
        FlashState {
            phase: "idle".into(),
            model: None,
            model_code: None,
            drone_type: None,
            package_path: None,
            files: Vec::new(),
            total_size: 0,
            file_index: None,
            current_file: None,
            file_progress: None,
            overall_progress: None,
            message: String::new(),
            error: None,
            status_detail: None,
            started_at: None,
            finished_at: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashValidation {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drone_type: Option<String>,
    pub files: Vec<FirmwareFileInfo>,
    pub total_size: usize,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
