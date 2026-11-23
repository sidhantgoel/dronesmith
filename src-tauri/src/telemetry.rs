//! Live flight-controller status (FLYC 0x03/0x43 push).
//! Pure: decodes the classic OSD layout of the frame the
//! flight controller pushes several times a second. Bytes past 37 differ
//! between firmware generations and are not decoded.

use serde::Serialize;

const MIN_LENGTH: usize = 37;

fn flight_mode_name(mode: u8) -> Option<&'static str> {
    Some(match mode {
        0 => "Manual",
        1 => "Attitude",
        6 => "Positioning (normal)",
        10 => "Assisted take-off",
        11 => "Auto take-off",
        12 => "Auto landing",
        13 => "Attitude landing",
        14 => "Waypoint",
        15 => "Return to home",
        17 => "Joystick",
        31 => "Sport",
        _ => return None,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FcStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    pub height: f64,
    pub horizontal_speed: f64,
    pub vertical_speed: f64,
    pub pitch: f64,
    pub roll: f64,
    pub yaw: f64,
    pub flight_mode: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flight_mode_name: Option<String>,
    pub motors_on: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_air: Option<bool>,
    pub gps_level: u8,
    pub satellites: u8,
}

fn f64le(p: &[u8], at: usize) -> f64 {
    f64::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3], p[at + 4], p[at + 5], p[at + 6], p[at + 7]])
}
fn s16(p: &[u8], at: usize) -> i16 {
    i16::from_le_bytes([p[at], p[at + 1]])
}
fn u32le(p: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]])
}

pub fn decode_fc_status(payload: &[u8]) -> Option<FcStatus> {
    if payload.len() < MIN_LENGTH {
        return None;
    }
    let degrees = 180.0 / std::f64::consts::PI;
    let longitude = f64le(payload, 0);
    let latitude = f64le(payload, 8);
    let has_position = latitude.is_finite()
        && longitude.is_finite()
        && (latitude != 0.0 || longitude != 0.0)
        && latitude.abs() <= std::f64::consts::FRAC_PI_2
        && longitude.abs() <= std::f64::consts::PI;
    let speed_x = s16(payload, 18) as f64 / 10.0;
    let speed_y = s16(payload, 20) as f64 / 10.0;
    let flight_mode = payload[30] & 0x7f;
    let state = u32le(payload, 32);
    let air_state = (state >> 1) & 0x03;
    Some(FcStatus {
        latitude: if has_position { Some(latitude * degrees) } else { None },
        longitude: if has_position { Some(longitude * degrees) } else { None },
        height: s16(payload, 16) as f64 / 10.0,
        horizontal_speed: speed_x.hypot(speed_y),
        vertical_speed: s16(payload, 22) as f64 / 10.0,
        pitch: s16(payload, 24) as f64 / 10.0,
        roll: s16(payload, 26) as f64 / 10.0,
        yaw: s16(payload, 28) as f64 / 10.0,
        flight_mode,
        flight_mode_name: flight_mode_name(flight_mode).map(|s| s.to_string()),
        motors_on: ((state >> 3) & 1) == 1,
        in_air: match air_state {
            2 => Some(true),
            0 => Some(false),
            _ => None,
        },
        gps_level: ((state >> 18) & 0x0f) as u8,
        satellites: payload[36],
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryReading {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<FcStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}
