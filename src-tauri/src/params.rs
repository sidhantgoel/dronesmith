//! DJI flight-controller parameter protocol (FLYC cmd set 0x03).
//! Pure: step payloads and reply parsers, unit-testable.

use serde::Serialize;

pub const FLYC: u8 = 0x03;
pub const FC_RECEIVER: u8 = 0x03;

/// DJI parameter name hash: rolling fold mod (2^32 - 5).
pub fn dji_param_hash(name: &str) -> u32 {
    let mut h: u64 = 0;
    for b in name.bytes() {
        h = ((h << 8) + b as u64) % 0xffff_fffb;
    }
    h as u32
}

/// A step is (receiver, cmd_id, payload); the session wraps it in a request.
pub type Step = (u8, u8, Vec<u8>);

fn u16le(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

pub fn table_info_step() -> Step {
    (FC_RECEIVER, 0xe0, vec![0x00, 0x00])
}

pub fn info_by_index_step(index: u16) -> Step {
    let mut p = Vec::from(u16le(0)); // table 0
    p.extend_from_slice(&u16le(index));
    (FC_RECEIVER, 0xe1, p)
}

pub fn read_by_index_step(index: u16) -> Step {
    let mut p = Vec::from(u16le(0));
    p.extend_from_slice(&[0x01, 0x00]);
    p.extend_from_slice(&u16le(index));
    (FC_RECEIVER, 0xe2, p)
}

pub fn write_unlock_step() -> Step {
    (FC_RECEIVER, 0xdf, vec![0x01, 0x00, 0x00, 0x00])
}

/// FLYC 0xF8: read one parameter by name hash.
pub fn read_by_hash_step(name: &str) -> Step {
    (FC_RECEIVER, 0xf8, dji_param_hash(name).to_le_bytes().to_vec())
}

/// Decodes a by-hash reply: hash (u32 LE) then the value bytes.
pub fn parse_value_by_hash(payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() < 4 {
        return None;
    }
    Some(payload[4..].to_vec())
}

pub fn write_by_index_step(index: u16, value: &[u8]) -> Step {
    let mut p = vec![0, 0, 0, 0];
    p.extend_from_slice(&u16le(index));
    p.extend_from_slice(value);
    (FC_RECEIVER, 0xe3, p)
}

// ── Parsers ──────────────────────────────────────────────────────────────────

pub struct TableInfo {
    pub count: u32,
    pub table_crc: u32,
}

pub fn parse_table_info(p: &[u8]) -> Option<TableInfo> {
    if p.len() >= 10 {
        let table_crc = u32::from_le_bytes([p[4], p[5], p[6], p[7]]);
        return Some(TableInfo { count: (p[8] as u32) | ((p[9] as u32) << 8), table_crc });
    }
    if p.len() >= 4 {
        return Some(TableInfo { count: (p[0] as u32) | ((p[1] as u32) << 8), table_crc: 0 });
    }
    None
}

pub fn param_type_name(type_id: u16) -> String {
    match type_id {
        0 => "u8",
        1 => "u16",
        2 => "u32",
        3 => "u64",
        4 => "i8",
        5 => "i16",
        6 => "i32",
        7 => "i64",
        8 => "float",
        9 => "double",
        _ => return format!("type{type_id}"),
    }
    .to_string()
}

fn is_signed(type_id: u16) -> bool {
    (4..=7).contains(&type_id)
}
fn is_float(type_id: u16) -> bool {
    type_id == 8 || type_id == 9
}

pub struct ParamInfo {
    pub index: u16,
    pub type_id: u16,
    pub type_name: String,
    pub size: u16,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub name: String,
}

/// Reads a field of `sz` bytes at `o`, decoding per type (float/signed/unsigned).
fn read_field(p: &[u8], o: usize, type_id: u16, sz: usize) -> f64 {
    if is_float(type_id) && sz == 4 && o + 4 <= p.len() {
        return f32::from_le_bytes([p[o], p[o + 1], p[o + 2], p[o + 3]]) as f64;
    }
    let mut v: f64 = 0.0;
    for i in 0..sz {
        if o + i < p.len() {
            v += p[o + i] as f64 * 2f64.powi(8 * i as i32);
        }
    }
    if is_signed(type_id) && sz < 8 {
        let span = 2f64.powi(8 * sz as i32);
        if v >= span / 2.0 {
            v -= span;
        }
    }
    v
}

pub fn parse_param_info(p: &[u8]) -> Option<ParamInfo> {
    if p.len() < 23 {
        return None;
    }
    let u16 = |o: usize| (p[o] as u16) | ((p[o + 1] as u16) << 8);
    let type_id = u16(6);
    let size = u16(8);
    let sz = if (1..=4).contains(&size) { size as usize } else { 4 };
    let name: String = p[22..].iter().filter(|&&b| (0x20..=0x7e).contains(&b)).map(|&b| b as char).collect();
    if name.is_empty() {
        return None;
    }
    Some(ParamInfo {
        index: u16(4),
        type_id,
        type_name: param_type_name(type_id),
        size,
        value: read_field(p, 10, type_id, sz),
        min: read_field(p, 14, type_id, sz),
        max: read_field(p, 18, type_id, sz),
        name,
    })
}

pub struct ValueByIndex {
    pub index: u16,
    pub value: Vec<u8>,
}

pub fn parse_value_by_index(p: &[u8]) -> Option<ValueByIndex> {
    if p.len() < 6 {
        return None;
    }
    Some(ValueByIndex { index: (p[4] as u16) | ((p[5] as u16) << 8), value: p[6..].to_vec() })
}

pub fn decode_param_value(bytes: &[u8], type_id: u16) -> f64 {
    let sz = bytes.len();
    if is_float(type_id) && sz == 4 {
        return f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64;
    }
    if is_float(type_id) && sz == 8 {
        return f64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]);
    }
    let mut v: f64 = 0.0;
    for (i, &b) in bytes.iter().enumerate() {
        v += b as f64 * 2f64.powi(8 * i as i32);
    }
    if is_signed(type_id) && sz < 8 {
        let span = 2f64.powi(8 * sz as i32);
        if v >= span / 2.0 {
            v -= span;
        }
    }
    v
}

pub fn encode_param_value(value: f64, size: u16, type_id: u16) -> Vec<u8> {
    let sz = if (1..=4).contains(&size) { size as usize } else { 4 };
    if is_float(type_id) && sz == 4 {
        return (value as f32).to_le_bytes().to_vec();
    }
    let mut v = value.trunc();
    if v < 0.0 {
        v += 2f64.powi(8 * sz as i32);
    }
    let mut v = v as u64;
    let mut out = vec![0u8; sz];
    for b in out.iter_mut() {
        *b = (v & 0xff) as u8;
        v >>= 8;
    }
    out
}

// ── Result types for the UI ──────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamEntry {
    pub index: u16,
    pub name: String,
    pub value: f64,
    pub default: f64,
    pub size: u16,
    pub min: f64,
    pub max: f64,
    pub type_id: u16,
    pub type_name: String,
    pub ok: bool,
    pub raw: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamScanResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_raw: Option<String>,
    pub entries: Vec<ParamEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamProgress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Serialize)]
pub struct ParamWriteResult {
    pub ok: bool,
    pub message: String,
}

/// Result of saving or loading a parameter-backup file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamBackupFileResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of a single by-name (hash) parameter read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamReadResult {
    pub name: String,
    pub hash_hex: String,
    pub value_hex: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_a_known_name() {
        // Rolling fold mod 2^32-5; stable for a fixed name.
        let h = dji_param_hash("g_config.flying_limit.max_height_0");
        assert_eq!(h, dji_param_hash("g_config.flying_limit.max_height_0"));
        assert_ne!(h, dji_param_hash("other"));
    }

    #[test]
    fn encodes_and_decodes_round_trip() {
        let bytes = encode_param_value(-5.0, 2, 5); // i16
        assert_eq!(decode_param_value(&bytes, 5), -5.0);
        let f = encode_param_value(1.5, 4, 8); // float
        assert_eq!(decode_param_value(&f, 8), 1.5);
        let u = encode_param_value(300.0, 2, 1); // u16
        assert_eq!(decode_param_value(&u, 1), 300.0);
    }
}
