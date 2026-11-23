//! The standard Android fastboot protocol, as DJI drones speak it once rebooted
//! into bootloader/fastboot mode. On-the-wire
//! protocol only; the USB transport is in usb0.rs (connect_fastboot).
//!
//! Reads (getvar) are safe. Writes (flash, erase) can brick the aircraft and are
//! gated by the caller, not here.

use crate::usb0::BulkTransport;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;

const COMMAND_TIMEOUT_MS: i32 = 8000;
const DATA_TIMEOUT_MS: i32 = 30000;
const REPLY_BYTES: usize = 256;
const COMMAND_MAX: usize = 64;
const CHUNK_BYTES: usize = 256 * 1024;

struct Reply {
    status: [u8; 4],
    text: String,
}

fn parse_reply(packet: &[u8]) -> Result<Reply, String> {
    if packet.len() < 4 {
        return Err(format!("Unexpected fastboot reply: {}", String::from_utf8_lossy(packet)));
    }
    let prefix = [packet[0], packet[1], packet[2], packet[3]];
    match &prefix {
        b"OKAY" | b"FAIL" | b"DATA" | b"INFO" => {}
        _ => return Err(format!("Unexpected fastboot reply: {}", String::from_utf8_lossy(&prefix))),
    }
    let text: String = packet[4..].iter().map(|&b| b as char).collect::<String>().trim_end_matches('\0').to_string();
    Ok(Reply { status: prefix, text })
}

pub fn partition_problem(name: &str) -> Option<String> {
    let ok = (1..=36).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok {
        None
    } else {
        Some("A partition name uses letters, digits, dot, dash or underscore.".into())
    }
}

fn command_problem(command: &str) -> Option<String> {
    if command.is_empty() || command.len() > COMMAND_MAX {
        return Some(format!("A fastboot command is 1 to {COMMAND_MAX} characters."));
    }
    if !command.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Some("A fastboot command is printable ASCII only.".into());
    }
    None
}

pub struct FlashProgress {
    pub sent: usize,
    pub total: usize,
}

pub struct FastbootClient {
    transport: Arc<BulkTransport>,
    info: Vec<String>,
}

impl FastbootClient {
    pub fn new(transport: Arc<BulkTransport>) -> FastbootClient {
        FastbootClient { transport, info: Vec::new() }
    }

    pub fn close(&self) {
        self.transport.close();
    }

    /// Sends a command and reads replies until a terminal OKAY/FAIL (or DATA,
    /// when `expect_data`). INFO lines are collected into `self.info`.
    fn command(&mut self, command: &str, expect_data: bool, timeout_ms: i32) -> Result<String, String> {
        if let Some(problem) = command_problem(command) {
            return Err(problem);
        }
        let bytes: Vec<u8> = command.bytes().collect();
        self.transport.send(&bytes, COMMAND_TIMEOUT_MS)?;
        self.info.clear();
        for _ in 0..10000 {
            let packet = self.transport.recv(REPLY_BYTES, timeout_ms)?;
            let reply = parse_reply(&packet)?;
            match &reply.status {
                b"INFO" => {
                    self.info.push(reply.text);
                    continue;
                }
                b"FAIL" => return Err(if reply.text.is_empty() { "The device rejected the command.".into() } else { reply.text }),
                b"DATA" => {
                    if !expect_data {
                        return Err("The device asked for data unexpectedly.".into());
                    }
                    return Ok(reply.text);
                }
                _ => return Ok(reply.text), // OKAY
            }
        }
        Err("The device never finished answering.".into())
    }

    pub fn getvar(&mut self, name: &str) -> String {
        self.command(&format!("getvar:{name}"), false, COMMAND_TIMEOUT_MS).unwrap_or_default()
    }

    pub fn getvar_all(&mut self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        let _ = self.command("getvar:all", false, COMMAND_TIMEOUT_MS);
        let info = self.info.clone();
        for raw in &info {
            let line = raw.strip_prefix("(bootloader)").map(|s| s.trim_start()).unwrap_or(raw.as_str());
            if let Some(colon) = line.rfind(':') {
                if colon > 0 {
                    out.insert(line[..colon].trim().to_string(), line[colon + 1..].trim().to_string());
                    continue;
                }
            }
            if !line.is_empty() {
                out.insert(line.to_string(), String::new());
            }
        }
        if out.is_empty() {
            for name in ["product", "version", "version-bootloader", "serialno", "secure", "max-download-size", "current-slot", "slot-count"] {
                let value = self.getvar(name);
                if !value.is_empty() {
                    out.insert(name.to_string(), value);
                }
            }
        }
        out
    }

    pub fn max_download_size(&mut self) -> Option<u64> {
        let raw = self.getvar("max-download-size");
        let value = if let Some(hex) = raw.strip_prefix("0x") { u64::from_str_radix(hex, 16).ok() } else { raw.parse::<u64>().ok() };
        value.filter(|&v| v > 0)
    }

    fn download(&mut self, data: &[u8], on_progress: &mut dyn FnMut(FlashProgress)) -> Result<(), String> {
        let size = format!("{:08x}", data.len());
        let reply = self.command(&format!("download:{size}"), true, COMMAND_TIMEOUT_MS)?;
        let expected = u64::from_str_radix(reply.trim(), 16).unwrap_or(0);
        if expected != data.len() as u64 {
            return Err(format!("The device expected {reply} bytes for the download."));
        }
        let mut offset = 0;
        while offset < data.len() {
            let end = (offset + CHUNK_BYTES).min(data.len());
            self.transport.send(&data[offset..end], DATA_TIMEOUT_MS)?;
            on_progress(FlashProgress { sent: end, total: data.len() });
            offset = end;
        }
        let done = self.transport.recv(REPLY_BYTES, DATA_TIMEOUT_MS)?;
        let final_reply = parse_reply(&done)?;
        match &final_reply.status {
            b"FAIL" => Err(if final_reply.text.is_empty() { "The device rejected the download.".into() } else { final_reply.text }),
            b"OKAY" => Ok(()),
            s => Err(format!("Unexpected reply after the download: {}.", String::from_utf8_lossy(s))),
        }
    }

    pub fn flash(&mut self, partition: &str, data: &[u8], on_progress: &mut dyn FnMut(FlashProgress)) -> Result<(), String> {
        if let Some(problem) = partition_problem(partition) {
            return Err(problem);
        }
        self.download(data, on_progress)?;
        self.command(&format!("flash:{partition}"), false, DATA_TIMEOUT_MS)?;
        Ok(())
    }

    pub fn erase(&mut self, partition: &str) -> Result<(), String> {
        if let Some(problem) = partition_problem(partition) {
            return Err(problem);
        }
        self.command(&format!("erase:{partition}"), false, DATA_TIMEOUT_MS)?;
        Ok(())
    }

    pub fn reboot(&mut self, target: &str) -> Result<(), String> {
        self.command(target, false, COMMAND_TIMEOUT_MS)?;
        Ok(())
    }
}

// ── Result types for the UI ──────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastbootScanResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variables: Option<BTreeMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastbootActionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FastbootFlashProgress {
    pub partition: String,
    pub sent: usize,
    pub total: usize,
}
