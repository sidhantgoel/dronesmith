//! Bench tests for the gimbal motors, the propeller motors, and the motor beep.
//! Pure: step builders, limits and support decisions; the session drives them.

use crate::service::ServiceStep;

const PC1: u8 = 0x2a;
const PC0: u8 = 0x0a;
const FLIGHT_CONTROLLER: u8 = 0x03;
const GIMBAL: u8 = 0x04;
const OSD3: u8 = 0x68;
const FACTORY4: u8 = 0x8f;
const ACK_AFTER: u8 = 0x40;

const CMD_SET_GENERAL: u8 = 0x00;
const CMD_SET_FLYC: u8 = 0x03;
const CMD_SET_ZENMUSE: u8 = 0x04;

fn step(sender: u8, receiver: u8, cmd_set: u8, cmd_id: u8, payload: Vec<u8>, expect_reply: bool) -> ServiceStep {
    ServiceStep { sender, receiver, ack_enc: ACK_AFTER, cmd_set, cmd_id, payload, expect_reply, wait_after_ms: 0 }
}

fn u16v(v: u16) -> Vec<u8> {
    vec![(v & 0xff) as u8, (v >> 8) as u8]
}
fn u32v(v: u32) -> Vec<u8> {
    vec![(v & 0xff) as u8, ((v >> 8) & 0xff) as u8, ((v >> 16) & 0xff) as u8, ((v >> 24) & 0xff) as u8]
}
fn i16v(v: f64) -> Vec<u8> {
    let clamped = v.round().clamp(-32768.0, 32767.0) as i32;
    u16v((clamped & 0xffff) as u16)
}

fn matches(code: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| code.starts_with(p))
}

// ── Gimbal motors ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
pub enum GimbalAxis {
    Pitch,
    Roll,
    Yaw,
}

impl GimbalAxis {
    pub fn from_str(s: &str) -> Option<GimbalAxis> {
        match s {
            "pitch" => Some(GimbalAxis::Pitch),
            "roll" => Some(GimbalAxis::Roll),
            "yaw" => Some(GimbalAxis::Yaw),
            _ => None,
        }
    }
    fn ignore_bit(self) -> u8 {
        match self {
            GimbalAxis::Pitch => 0x08,
            GimbalAxis::Roll => 0x04,
            GimbalAxis::Yaw => 0x02,
        }
    }
}

#[derive(Clone, Copy, Default, serde::Deserialize)]
pub struct GimbalAngles {
    pub pitch: f64,
    pub roll: f64,
    pub yaw: f64,
}

#[derive(Clone, Copy)]
pub struct AxisLimit {
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Copy)]
pub struct GimbalLimits {
    pub pitch: AxisLimit,
    pub roll: AxisLimit,
    pub yaw: AxisLimit,
}

impl GimbalLimits {
    pub fn for_axis(&self, axis: GimbalAxis) -> AxisLimit {
        match axis {
            GimbalAxis::Pitch => self.pitch,
            GimbalAxis::Roll => self.roll,
            GimbalAxis::Yaw => self.yaw,
        }
    }
}

pub const GIMBAL_JOG_RATE: f64 = 1.5;

const ABSOLUTE: u8 = 0x01;
const IGNORE_ALL: u8 = 0x0e;

const GIMBAL_LIMITS: &[(&str, GimbalLimits)] = &[
    ("WM162", GimbalLimits { pitch: AxisLimit { min: -90.0, max: 60.0 }, roll: AxisLimit { min: -135.0, max: 45.0 }, yaw: AxisLimit { min: -30.0, max: 30.0 } }),
    ("WA152", GimbalLimits { pitch: AxisLimit { min: -40.0, max: 30.0 }, roll: AxisLimit { min: -20.0, max: 20.0 }, yaw: AxisLimit { min: -20.0, max: 20.0 } }),
    ("WA140", GimbalLimits { pitch: AxisLimit { min: -75.0, max: 45.0 }, roll: AxisLimit { min: -20.0, max: 20.0 }, yaw: AxisLimit { min: -20.0, max: 20.0 } }),
    ("WA150", GimbalLimits { pitch: AxisLimit { min: -75.0, max: 45.0 }, roll: AxisLimit { min: -20.0, max: 20.0 }, yaw: AxisLimit { min: -20.0, max: 20.0 } }),
];

const GIMBAL_LIMITS_UNTESTED: GimbalLimits = GimbalLimits {
    pitch: AxisLimit { min: -40.0, max: 30.0 },
    roll: AxisLimit { min: -20.0, max: 20.0 },
    yaw: AxisLimit { min: -20.0, max: 20.0 },
};

pub struct GimbalTestSupport {
    pub validated: bool,
    pub limits: GimbalLimits,
}

pub fn gimbal_test_support(model_code: Option<&str>) -> GimbalTestSupport {
    let code = model_code.unwrap_or("").to_uppercase();
    match GIMBAL_LIMITS.iter().find(|(prefix, _)| code.starts_with(prefix)) {
        Some((_, limits)) => GimbalTestSupport { validated: true, limits: *limits },
        None => GimbalTestSupport { validated: false, limits: GIMBAL_LIMITS_UNTESTED },
    }
}

/// Move duration in the command's unit of 0.1 s.
fn tenths(seconds: f64) -> u8 {
    (seconds * 10.0).round().clamp(1.0, 255.0) as u8
}

pub fn gimbal_enable_step() -> ServiceStep {
    step(PC0, GIMBAL, CMD_SET_ZENMUSE, 0x1e, vec![0x01], false)
}

/// Moves to absolute angles over `seconds`. With an axis only that axis moves.
pub fn gimbal_absolute_step(axis: Option<GimbalAxis>, target: GimbalAngles, seconds: f64) -> ServiceStep {
    let control = axis.map(|a| IGNORE_ALL & !a.ignore_bit()).unwrap_or(0) | ABSOLUTE;
    let mut payload = Vec::new();
    payload.extend(i16v(target.yaw * 10.0));
    payload.extend(i16v(target.roll * 10.0));
    payload.extend(i16v(target.pitch * 10.0));
    payload.push(control);
    payload.push(tenths(seconds));
    step(PC0, GIMBAL, CMD_SET_ZENMUSE, 0x14, payload, false)
}

/// Non-absolute command for one axis: keeps it moving while `amount` is non-zero.
pub fn gimbal_relative_step(axis: GimbalAxis, amount: f64, seconds: f64) -> ServiceStep {
    let mut moved = GimbalAngles::default();
    match axis {
        GimbalAxis::Pitch => moved.pitch = amount,
        GimbalAxis::Roll => moved.roll = amount,
        GimbalAxis::Yaw => moved.yaw = amount,
    }
    let mut payload = Vec::new();
    payload.extend(i16v(moved.yaw * 10.0));
    payload.extend(i16v(moved.roll * 10.0));
    payload.extend(i16v(moved.pitch * 10.0));
    payload.push(IGNORE_ALL & !axis.ignore_bit());
    payload.push(tenths(seconds));
    step(PC0, GIMBAL, CMD_SET_ZENMUSE, 0x14, payload, false)
}

// ── Propeller motors ─────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct PropMotor {
    pub n: u8,
    pub ch: u8,
}

pub const PROP_MOTORS: &[PropMotor] = &[
    PropMotor { n: 1, ch: 0 },
    PropMotor { n: 2, ch: 1 },
    PropMotor { n: 3, ch: 2 },
    PropMotor { n: 4, ch: 3 },
];

pub fn prop_motor(n: u8) -> Option<PropMotor> {
    PROP_MOTORS.iter().copied().find(|m| m.n == n)
}

pub const PROP_MAX_PERCENT: f64 = 20.0;
pub const PROP_MAX_SECONDS: f64 = 10.0;
pub const PROP_GAP_MS: u64 = 600;

const THROTTLE_CODES: &[&str] = &["WA152", "WA140", "WA150", "WA521"];
const FACTORY_MODE_CODES: &[&str] = &["WA521"];

#[derive(Clone, Copy, PartialEq)]
pub enum PropTestMode {
    Catalog,
    Throttle,
}

pub struct PropTestSupport {
    pub validated: bool,
    pub mode: PropTestMode,
    pub factory_mode: bool,
}

pub fn prop_test_support(model_code: Option<&str>) -> PropTestSupport {
    let code = model_code.unwrap_or("").to_uppercase();
    let validated_codes = {
        let mut v = vec!["WM162"];
        v.extend_from_slice(THROTTLE_CODES);
        v
    };
    PropTestSupport {
        validated: matches(&code, &validated_codes),
        mode: if matches(&code, THROTTLE_CODES) { PropTestMode::Throttle } else { PropTestMode::Catalog },
        factory_mode: matches(&code, FACTORY_MODE_CODES),
    }
}

pub const PROP_PARAM_OUTPUT: [u8; 4] = [0x20, 0x0a, 0x52, 0x24];
pub const PROP_PARAM_TIMER: [u8; 4] = [0x06, 0xac, 0x2a, 0xf9];
pub const PROP_DEFAULT_OUTPUT: u32 = 500;
pub const PROP_DEFAULT_TIMER: u32 = 20;
pub const PROP_TICK_MS: f64 = 20.0;
pub const PROP_WATCHDOG_MS: u64 = 130;
pub const PROP_FACTORY_SETTLE_MS: u64 = 400;
const PROP_THROTTLE_MAX: u32 = 2571;

pub fn prop_throttle_hash(ch: u8) -> [u8; 4] {
    [0x8f, 0x74, 0x1c + ch, 0xaf]
}

pub fn prop_throttle_value(percent: f64) -> u32 {
    PROP_THROTTLE_MAX.min(((percent / PROP_MAX_PERCENT) * PROP_THROTTLE_MAX as f64).round() as u32)
}

/// FLYC 0xF9: write a parameter by hash. The reply echoes the hash and value.
pub fn prop_write_step(hash: &[u8], value: u32, width: u8) -> ServiceStep {
    let mut payload = hash.to_vec();
    payload.extend(if width == 2 { u16v(value as u16) } else { u32v(value) });
    step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xf9, payload, true)
}

/// True when a 0xF9 reply reports success and echoes the value that was sent.
pub fn prop_write_accepted(reply: Option<&[u8]>, value: u32, width: u8) -> bool {
    let r = match reply {
        Some(r) => r,
        None => return false,
    };
    if r.is_empty() || r[0] != 0 || r.len() < 5 + width as usize {
        return false;
    }
    let echoed = if width == 2 {
        (r[5] as u32) | ((r[6] as u32) << 8)
    } else {
        (r[5] as u32) | ((r[6] as u32) << 8) | ((r[7] as u32) << 16) | ((r[8] as u32) << 24)
    };
    echoed == value
}

/// FLYC 0xE9: asks for the name of the command behind a motor's test entry.
pub fn prop_catalog_step(ch: u8) -> ServiceStep {
    step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xe9, u16v(0xfffe - (ch as u16 + 1)), true)
}

/// FLYC 0xE9: runs a motor's test entry.
pub fn prop_run_step(ch: u8) -> ServiceStep {
    step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xe9, u16v(ch as u16 + 1), true)
}

pub fn prop_catalog_expected(ch: u8) -> String {
    format!("Motor{ch} user test")
}

pub fn prop_catalog_name(reply: Option<&[u8]>) -> String {
    match reply {
        None => String::new(),
        Some(r) if r.len() <= 4 => String::new(),
        Some(r) => r[4..].iter().filter(|&&b| (32..127).contains(&b)).map(|&b| b as char).collect(),
    }
}

// ── Motor beep ───────────────────────────────────────────────────────────────

const BEEP_VALIDATED_CODES: &[&str] = &["WM162", "WA152", "WA140", "WA150", "WA521"];
const BEEP_FACTORY_CODES: &[&str] = &["WA521"];
const BEEP_START: u8 = 4;
const BEEP_STOP: u8 = 3;

pub struct BeepSupport {
    pub validated: bool,
    pub factory_mode: bool,
}

pub fn beep_support(model_code: Option<&str>) -> BeepSupport {
    let code = model_code.unwrap_or("").to_uppercase();
    BeepSupport { validated: matches(&code, BEEP_VALIDATED_CODES), factory_mode: matches(&code, BEEP_FACTORY_CODES) }
}

pub fn beep_step(ch: u8, on: bool) -> ServiceStep {
    step(PC1, FLIGHT_CONTROLLER, CMD_SET_FLYC, 0xed, vec![if on { BEEP_START } else { BEEP_STOP }, ch & 0x03], false)
}

/// GENERAL 0x44 factory-mode request to the two modules that gate the throttle.
pub fn prop_factory_steps(open: bool) -> Vec<ServiceStep> {
    let tag = if open { "start_factory" } else { "stop_factory" };
    [FACTORY4, OSD3]
        .iter()
        .map(|&receiver| {
            let mut payload = vec![0x80, 0x0a];
            payload.extend(tag.bytes());
            payload.push(0x00);
            step(PC1, receiver, CMD_SET_GENERAL, 0x44, payload, false)
        })
        .collect()
}

// ── Result types for the UI ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotorTestResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acks: Option<u32>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropTestEvent {
    pub motor: u8,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
