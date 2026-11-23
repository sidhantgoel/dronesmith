//! Health Management System (HMS) fault decoding. Read-only: the app only
//! listens for the aircraft's HMS pushes and derives a couple of live rows from
//! status frames.

use std::collections::HashMap;

use serde::Serialize;

pub const HMS_CMD_SET: u8 = 0x21;
pub const HMS_CMD_ID: u8 = 0x06;
pub const HMS_TELEMETRY_CMD_SET: u8 = 0x03;
pub const HMS_TELEMETRY_CMD_ID: u8 = 0xce;
pub const GIMBAL_SELFCHECK_CMD_SET: u8 = 0x00;
pub const GIMBAL_SELFCHECK_CMD_ID: u8 = 0xf1;
pub const GIMBAL_SENDER_TYPE: u8 = 0x04;
pub const FC_STATUS_CMD_SET: u8 = 0x03;
pub const FC_STATUS_CMD_ID: u8 = 0x43;
pub const FC_SENDER_TYPE: u8 = 0x03;

const HEADER_LENGTH: usize = 3;
const RECORD_LENGTH: usize = 6;
const GNSS_WEAK_BELOW: u32 = 3;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HmsFault {
    pub code: u32,
    pub code_hex: String,
    pub level: u8,
    pub sensor_index: u8,
    pub module: String,
    pub text: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub live: bool,
}

fn u32le(p: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([p[off], p[off + 1], p[off + 2], p[off + 3]])
}

pub fn looks_like_hms_code(code: u32) -> bool {
    let class = (code >> 24) & 0xff;
    (0x10..=0x1f).contains(&class)
}

pub fn module_for_code(code: u32) -> String {
    match (code >> 24) & 0xff {
        0x16 => "Flight controller",
        0x1a => "Vision system",
        0x1d => "Gimbal",
        0x1c => "Camera",
        0x11 | 0x12 => "Vision sensor",
        0x15 => "ESC / motor",
        0x17 => "Remote controller",
        _ => "Aircraft",
    }
    .to_string()
}

/// Maps a code to its description, built from the bundled hms.json.
pub type Resolver = HashMap<String, String>;

pub fn resolve(db: &Resolver, code: u32) -> Option<String> {
    let hex = format!("{:08x}", code);
    db.get(&format!("fpv_tip_0x{hex}"))
        .or_else(|| db.get(&format!("dock_tip_0x{hex}")))
        .cloned()
}

/// Builds the resolver map from the raw hms.json text ({ key: { "en": ... } }).
pub fn load_resolver(json: &str) -> Resolver {
    let mut out = Resolver::new();
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(json) {
        for (key, value) in map {
            let text = match &value {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Object(o) => o.get("en").and_then(|v| v.as_str()).map(|s| s.to_string()),
                _ => None,
            };
            if let Some(t) = text {
                out.insert(key, t);
            }
        }
    }
    out
}

fn fault(code: u32, level: u8, sensor_index: u8, db: &Resolver) -> HmsFault {
    let code_hex = format!("0x{:08x}", code);
    let text = resolve(db, code).unwrap_or_else(|| format!("Unknown fault {code_hex}"));
    HmsFault {
        code,
        code_hex,
        level,
        sensor_index,
        module: module_for_code(code),
        text,
        live: false,
    }
}

/// Decodes a 0x21/0x06 snapshot: a 3-byte header then 6-byte records.
pub fn decode_hms_push(payload: &[u8], db: &Resolver) -> Vec<HmsFault> {
    let mut out = Vec::new();
    let mut off = HEADER_LENGTH;
    while off + RECORD_LENGTH <= payload.len() {
        let code = u32le(payload, off);
        if code != 0 {
            out.push(fault(code, payload[off + 5], payload[off + 4], db));
        }
        off += RECORD_LENGTH;
    }
    out
}

/// Decodes one 0x03/0xCE telemetry frame into a fault, when it carries a code.
pub fn decode_hms_telemetry(payload: &[u8], db: &Resolver) -> Option<HmsFault> {
    if payload.len() < RECORD_LENGTH {
        return None;
    }
    let code = u32le(payload, 0);
    if !looks_like_hms_code(code) {
        return None;
    }
    Some(fault(code, payload[5], payload[4], db))
}

/// Live gimbal self-check rows: bit 7 is error 40021; other bits are unknown.
pub fn decode_gimbal_self_check(payload: &[u8]) -> Vec<HmsFault> {
    if payload.len() < 4 {
        return Vec::new();
    }
    let mask = u32le(payload, 0);
    let mut out = Vec::new();
    for bit in 0..32 {
        if (mask >> bit) & 1 == 0 {
            continue;
        }
        if bit == 7 {
            out.push(HmsFault {
                code: 40021,
                code_hex: "40021".into(),
                level: 2,
                sensor_index: 0,
                module: "Gimbal (self-check)".into(),
                text: "Gimbal IMU data mismatch (gimbal self-check bit 7).".into(),
                live: true,
            });
        } else {
            out.push(HmsFault {
                code: 0,
                code_hex: format!("GIMBAL-BIT{bit}"),
                level: 1,
                sensor_index: 0,
                module: "Gimbal (self-check)".into(),
                text: format!("Gimbal self-check flag set (bit {bit}); its meaning is not identified."),
                live: true,
            });
        }
    }
    out
}

/// A live row when the FC status push reports a weak GPS signal.
pub fn decode_gnss_status(payload: &[u8]) -> Option<HmsFault> {
    if payload.len() < 37 {
        return None;
    }
    let state = u32le(payload, 32);
    let level = (state >> 18) & 0x0f;
    let satellites = payload[36];
    if level >= GNSS_WEAK_BELOW {
        return None;
    }
    Some(HmsFault {
        code: 0,
        code_hex: "GNSS".into(),
        level: 2,
        sensor_index: 0,
        module: "GNSS / positioning".into(),
        text: format!(
            "GPS / GNSS signal weak: quality {level}/5, {satellites} satellite{}.",
            if satellites == 1 { "" } else { "s" }
        ),
        live: true,
    })
}
