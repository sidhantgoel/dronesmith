//! Smart-battery readout. Four reads to the
//! battery on cmd set 0x0D; pure parsers fold each reply into a snapshot.

use serde::Serialize;

pub const BATTERY_CMD_SET: u8 = 0x0d;
pub const BATTERY_SENDER_TYPE: u8 = 0x0b;
pub const BATTERY_CMD_STATIC: u8 = 0x01;
pub const BATTERY_CMD_SERIAL: u8 = 0x04;
const BATTERY_RECEIVER: u8 = 0x0b;

/// (receiver, cmd_set, cmd_id, payload) for the four reads; fire-and-forget.
pub fn battery_request_steps() -> Vec<(u8, u8, u8, Vec<u8>)> {
    [0x01u8, 0x02, 0x03, 0x04].iter().map(|&c| (BATTERY_RECEIVER, BATTERY_CMD_SET, c, vec![0x01])).collect()
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryPack {
    pub design_capacity: u32,
    pub cycles: u16,
    pub design_voltage: u32,
    pub cells: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufactured: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryLive {
    pub voltage: u32,
    pub current: i32,
    pub full_capacity: u32,
    pub remaining: u32,
    pub temperature: f64,
    pub cells: u8,
    pub percent: u8,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatterySnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack: Option<BatteryPack>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live: Option<BatteryLive>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_voltages: Option<Vec<u16>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
}

fn u16(p: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([p[at], p[at + 1]])
}
fn s16(p: &[u8], at: usize) -> i16 {
    i16::from_le_bytes([p[at], p[at + 1]])
}
fn u32(p: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]])
}
fn s32(p: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]])
}

fn parse_pack(p: &[u8]) -> Option<BatteryPack> {
    if p.len() < 14 {
        return None;
    }
    let date = u16(p, 12);
    let year = (date >> 9) as u32 + 1980;
    let month = (date >> 5) & 0x0f;
    let day = date & 0x1f;
    let design_voltage = u32(p, 8);
    let plausible = (1..=12).contains(&month) && day >= 1 && (2010..=2040).contains(&year);
    Some(BatteryPack {
        design_capacity: u32(p, 2),
        cycles: u16(p, 6),
        design_voltage,
        cells: if design_voltage != 0 { (design_voltage as f64 / 3800.0).round() as u32 } else { 0 },
        manufactured: if plausible { Some(format!("{year:04}-{month:02}-{day:02}")) } else { None },
    })
}

fn parse_live(p: &[u8]) -> Option<BatteryLive> {
    if p.len() < 22 {
        return None;
    }
    let raw = s16(p, 18) as f64;
    let temperature = if raw > 2000.0 { (raw - 2731.0) / 10.0 } else { raw / 10.0 };
    Some(BatteryLive {
        voltage: u32(p, 2),
        current: s32(p, 6),
        full_capacity: u32(p, 10),
        remaining: u32(p, 14),
        temperature,
        cells: p[20],
        percent: p[21],
    })
}

fn parse_cells(p: &[u8]) -> Option<Vec<u16>> {
    if p.len() < 3 {
        return None;
    }
    let mut cells = Vec::new();
    for i in 0..p[2] as usize {
        let at = 3 + i * 2;
        if at + 2 <= p.len() {
            cells.push(u16(p, at));
        }
    }
    if cells.len() >= 2 {
        Some(cells)
    } else {
        None
    }
}

fn parse_serial(p: &[u8]) -> Option<String> {
    if p.len() < 3 {
        return None;
    }
    let text: String = p[2..].iter().filter(|&&b| (0x20..=0x7e).contains(&b)).map(|&b| b as char).collect();
    if text.len() >= 3 {
        Some(text)
    } else {
        None
    }
}

/// Folds one battery reply into the snapshot; true when it was usable.
pub fn apply_battery_reply(snapshot: &mut BatterySnapshot, cmd_id: u8, payload: &[u8]) -> bool {
    match cmd_id {
        0x01 => parse_pack(payload).map(|v| snapshot.pack = Some(v)).is_some(),
        0x02 => parse_live(payload).map(|v| snapshot.live = Some(v)).is_some(),
        0x03 => parse_cells(payload).map(|v| snapshot.cell_voltages = Some(v)).is_some(),
        0x04 => parse_serial(payload).map(|v| snapshot.serial = Some(v)).is_some(),
        _ => false,
    }
}

pub fn battery_health(snapshot: &BatterySnapshot) -> Option<u32> {
    let design = snapshot.pack.as_ref().map(|p| p.design_capacity).unwrap_or(0);
    let full = snapshot.live.as_ref().map(|l| l.full_capacity).unwrap_or(0);
    if design == 0 || full == 0 || full as f64 > design as f64 * 1.2 {
        return None;
    }
    Some((100.0_f64).min((full as f64 / design as f64 * 100.0).round()) as u32)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryReading {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub at: u64,
    pub battery: BatterySnapshot,
}
