//! Advanced (full automatic) gimbal calibration planning, and the two simple
//! command calibrations. Pure: chooses the per-model sequence, or the reason
//! it must not be sent. The session runs the chosen plan.

use crate::service::ServiceStep;

const PC1: u8 = 0x2a;
const PC0: u8 = 0x0a;
const FLIGHT_CONTROLLER: u8 = 0x03;
const GIMBAL: u8 = 0x04;
const OSD3: u8 = 0x68;
const FACTORY4: u8 = 0x8f;

const ACK_AFTER: u8 = 0x40;
const ACK_BEFORE: u8 = 0x20;

const CMD_SET_GENERAL: u8 = 0x00;
const CMD_SET_ZENMUSE: u8 = 0x04;

const TRIGGER_ADVANCED: u8 = 0x71;
const TRIGGER_ENTERPRISE: u8 = 0x00;

const ENTERPRISE_CODES: &[&str] = &["WM265T", "WM265E", "WM265M"];
const FIRMWARE_ONLY_CODES: &[&str] = &["WM160", "WM161", "WM162", "WM163"];

#[derive(Clone, Copy, PartialEq)]
pub enum AdvancedVariant {
    Standard,
    Command,
    Neo2,
    Lito,
    Enterprise,
}

pub struct AdvancedCalibrationPlan {
    pub variant: AdvancedVariant,
    pub label: &'static str,
    pub prepare: Vec<ServiceStep>,
    pub pause_ms: u64,
    pub trigger: ServiceStep,
    pub ack_timeout_ms: u64,
    pub expect_ms: u64,
    pub asks_point_up: bool,
}

pub struct AdvancedCalibrationChoice {
    pub plan: Option<AdvancedCalibrationPlan>,
    pub reason: Option<String>,
}

fn step(sender: u8, receiver: u8, ack_enc: u8, cmd_set: u8, cmd_id: u8, payload: Vec<u8>) -> ServiceStep {
    ServiceStep { sender, receiver, ack_enc, cmd_set, cmd_id, payload, expect_reply: false, wait_after_ms: 0 }
}

/// GENERAL 0x44 factory-mode request: 0x80, a sub-type byte, then a C string.
fn factory(receiver: u8, tag: &str, sub_type: u8, ack_enc: u8) -> ServiceStep {
    let mut payload = vec![0x80, sub_type];
    payload.extend(tag.bytes());
    payload.push(0x00);
    step(PC1, receiver, ack_enc, CMD_SET_GENERAL, 0x44, payload)
}

fn trigger(sender: u8, ack_enc: u8, value: u8) -> ServiceStep {
    step(sender, GIMBAL, ack_enc, CMD_SET_ZENMUSE, 0x08, vec![value])
}

/// The two-frame preamble sent ahead of the trigger on newer aircraft.
fn captured_preamble() -> Vec<ServiceStep> {
    vec![
        step(PC0, OSD3, ACK_AFTER, CMD_SET_GENERAL, 0x51, vec![0x04]),
        step(PC0, OSD3, ACK_AFTER, CMD_SET_GENERAL, 0x36, vec![0x03, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]
}

/// True when `w` appears in `s` as a whole word (ASCII, lowercase input).
fn has_word(s: &str, w: &str) -> bool {
    let bytes = s.as_bytes();
    let mut from = 0;
    while let Some(pos) = s[from..].find(w) {
        let start = from + pos;
        let end = start + w.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after_ok = end == s.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_firmware_only(code: &str, name: &str) -> bool {
    if FIRMWARE_ONLY_CODES.contains(&code) {
        return true;
    }
    if name.is_empty() || name.contains("pro") {
        return false;
    }
    if name.contains("mini") && has_word(name, "5") {
        return false;
    }
    name.contains("4k") || name.contains("mini")
}

/// True for aircraft that must not be sent a command calibration at all.
pub fn is_firmware_only_model(model_code: Option<&str>, model_name: Option<&str>) -> bool {
    is_firmware_only(&model_code.unwrap_or("").to_uppercase(), &model_name.unwrap_or("").to_lowercase())
}

fn is_air3(code: &str, name: &str) -> bool {
    code.starts_with("WA341")
        || code.starts_with("WA345")
        || (name.contains("air") && (has_word(name, "3") || has_word(name, "3s")))
}

fn is_command_model(code: &str, name: &str) -> bool {
    if ["WA150", "WA140", "WA341", "WA345"].iter().any(|p| code.starts_with(p)) {
        return true;
    }
    if name.contains("air") && (has_word(name, "3") || has_word(name, "3s")) {
        return true;
    }
    name.contains("mini") && (has_word(name, "4") || has_word(name, "5"))
}

fn is_neo2(code: &str, name: &str) -> bool {
    code.starts_with("WA020") || (name.contains("neo") && has_word(name, "2"))
}

fn is_lito(code: &str, name: &str) -> bool {
    code.starts_with("WA152") || (name.contains("lito") && has_word(name, "1"))
}

/// Chooses the advanced-calibration sequence for an aircraft, or explains why
/// it must not be run.
pub fn plan_advanced_calibration(
    model_code: Option<&str>,
    model_name: Option<&str>,
    allow_restricted: bool,
) -> AdvancedCalibrationChoice {
    let code = model_code.unwrap_or("").to_uppercase();
    let name = model_name.unwrap_or("").to_lowercase();
    if code.is_empty() && name.is_empty() {
        return AdvancedCalibrationChoice { plan: None, reason: Some("The aircraft model has not been identified yet.".into()) };
    }
    let firmware_only = is_firmware_only(&code, &name);

    if is_lito(&code, &name) {
        return AdvancedCalibrationChoice {
            plan: Some(AdvancedCalibrationPlan {
                variant: AdvancedVariant::Lito,
                label: "Direct calibration, two phases",
                prepare: captured_preamble(),
                pause_ms: 0,
                trigger: trigger(PC0, ACK_BEFORE, TRIGGER_ADVANCED),
                ack_timeout_ms: 12000,
                expect_ms: 110000,
                asks_point_up: true,
            }),
            reason: None,
        };
    }
    if is_neo2(&code, &name) {
        return AdvancedCalibrationChoice {
            plan: Some(AdvancedCalibrationPlan {
                variant: AdvancedVariant::Neo2,
                label: "Direct calibration in factory mode",
                prepare: vec![factory(OSD3, "start_factory", 0x0a, ACK_AFTER)],
                pause_ms: 500,
                trigger: trigger(PC0, ACK_BEFORE, TRIGGER_ADVANCED),
                ack_timeout_ms: 12000,
                expect_ms: 180000,
                asks_point_up: true,
            }),
            reason: None,
        };
    }
    if is_command_model(&code, &name) {
        return AdvancedCalibrationChoice {
            plan: Some(AdvancedCalibrationPlan {
                variant: AdvancedVariant::Command,
                label: "Direct calibration, three stages",
                prepare: captured_preamble(),
                pause_ms: 0,
                trigger: trigger(PC0, ACK_BEFORE, TRIGGER_ADVANCED),
                ack_timeout_ms: 12000,
                expect_ms: 100000,
                asks_point_up: is_air3(&code, &name),
            }),
            reason: None,
        };
    }
    if firmware_only && !allow_restricted {
        return AdvancedCalibrationChoice {
            plan: None,
            reason: Some("This model calibrates by reflashing its service firmware, not by command. A command calibration can put its camera into download mode, so it is not sent.".into()),
        };
    }
    if ENTERPRISE_CODES.contains(&code.as_str()) {
        return AdvancedCalibrationChoice {
            plan: Some(AdvancedCalibrationPlan {
                variant: AdvancedVariant::Enterprise,
                label: "Enterprise gimbal, factory mode through the flight controller",
                prepare: vec![factory(FLIGHT_CONTROLLER, "start_factory", 0x0e, ACK_BEFORE)],
                pause_ms: 1500,
                trigger: trigger(PC1, ACK_BEFORE, TRIGGER_ENTERPRISE),
                ack_timeout_ms: 40000,
                expect_ms: 60000,
                asks_point_up: false,
            }),
            reason: None,
        };
    }
    AdvancedCalibrationChoice {
        plan: Some(AdvancedCalibrationPlan {
            variant: AdvancedVariant::Standard,
            label: "Factory mode, then full auto calibration",
            prepare: vec![
                factory(FACTORY4, "start_factory", 0x0a, ACK_AFTER),
                factory(OSD3, "start_factory", 0x0a, ACK_AFTER),
            ],
            pause_ms: 500,
            trigger: trigger(PC1, ACK_AFTER, TRIGGER_ADVANCED),
            ack_timeout_ms: 8000,
            expect_ms: 95000,
            asks_point_up: false,
        }),
        reason: None,
    }
}

/// True when a plan puts the aircraft into factory mode (GENERAL 0x44).
pub fn enters_factory_mode(plan: &AdvancedCalibrationPlan) -> bool {
    plan.prepare.iter().any(|s| s.cmd_set == CMD_SET_GENERAL && s.cmd_id == 0x44)
}

// ── Simple command calibrations (jointCoarse, linearHall) ────────────────────

pub struct CalibrationSpec {
    pub kind: &'static str,
    pub command: u8,
    pub expect_ms: u64,
    pub max_ms: u64,
    pub stall_ms: u64,
    pub pass: [u8; 2],
}

pub fn calibration_spec(kind: &str) -> Option<CalibrationSpec> {
    match kind {
        "jointCoarse" => Some(CalibrationSpec { kind: "jointCoarse", command: 1, expect_ms: 15000, max_ms: 22500, stall_ms: 3750, pass: [16, 1] }),
        "linearHall" => Some(CalibrationSpec { kind: "linearHall", command: 2, expect_ms: 200000, max_ms: 300000, stall_ms: 50000, pass: [40, 1] }),
        _ => None,
    }
}
