//! Repairs that write to the aircraft: the gimbal IMU repair (two routines)
//! and module serial-number read/write.
//! Pure: step plans and helpers; the session runs them.

use crate::gimbal_cal::is_firmware_only_model;
use crate::service::ServiceStep;
use serde::Serialize;

const PC1: u8 = 0x2a;
const PC0: u8 = 0x0a;

const CAMERA: u8 = 0x01;
const FLIGHT_CONTROLLER: u8 = 0x03;
const GIMBAL: u8 = 0x04;
const CENTER_BOARD: u8 = 0x05;
const BATTERY: u8 = 0x0b;
const OSD3: u8 = 0x68;
const FACTORY4: u8 = 0x8f;

const ACK_AFTER: u8 = 0x40;
const ACK_BEFORE: u8 = 0x20;

const CMD_SET_GENERAL: u8 = 0x00;
const CMD_SET_CAMERA: u8 = 0x02;
const CMD_SET_ZENMUSE: u8 = 0x04;

const CMD_FACTORY: u8 = 0x44;
const CMD_SERIAL: u8 = 0x51;
const CMD_GIMBAL_CALIBRATE: u8 = 0x08;
const CMD_GIMBAL_IMU_PREPARE: u8 = 0x1d;
const CMD_GIMBAL_IMU_WRITE: u8 = 0x36;

fn step(sender: u8, receiver: u8, ack_enc: u8, cmd_set: u8, cmd_id: u8, payload: Vec<u8>, expect_reply: bool) -> ServiceStep {
    ServiceStep { sender, receiver, ack_enc, cmd_set, cmd_id, payload, expect_reply, wait_after_ms: 0 }
}

fn factory_step(receiver: u8, open: bool, sub_type: u8, ack_enc: u8) -> ServiceStep {
    let mut payload = vec![0x80, sub_type];
    payload.extend((if open { "start_factory" } else { "stop_factory" }).bytes());
    payload.push(0x00);
    step(PC1, receiver, ack_enc, CMD_SET_GENERAL, CMD_FACTORY, payload, false)
}

// ── Gimbal IMU repair ────────────────────────────────────────────────────────

pub struct RepairStep {
    pub step: ServiceStep,
    pub label: String,
    pub wait_after_ms: u64,
    pub write: bool,
}

pub struct ImuRepairPlan {
    pub steps: Vec<RepairStep>,
    pub cleanup: Vec<ServiceStep>,
    #[allow(dead_code)]
    pub foreign_block: bool,
    #[allow(dead_code)]
    pub moves: bool,
}

pub struct ImuRepairChoice {
    pub plan: Option<ImuRepairPlan>,
    pub reason: Option<String>,
}

const REPAIR_VALUE: [u8; 4] = [0x42, 0xe9, 0x7f, 0x3f];

const MINI4PRO_BLOCK_HEX: &str = concat!(
    "b8e57f3fc72de63c89d2de39bc07e8bc2ee67f3fd66ebb3be65ab4ba4a792dbb47ff7f3ffce17f3fcf65ea3c4d2ec639bc22f8bc",
    "ebe57f3f66d9133b52d243ba41ba583b6d00803f9c53c938368fc3b97b690a38bd3706b882a8fbb87233dcb8f6cf533941d7beb8",
    "f6cfd3b89692e5bba12de73b348037bc3a3b19bd76896a3c9a5d77bc3a02803ff5d77f3f43ca7f3f001f803f9a41803fe010803f",
);

fn mini4pro_block() -> Vec<u8> {
    (0..MINI4PRO_BLOCK_HEX.len() / 2)
        .map(|i| u8::from_str_radix(&MINI4PRO_BLOCK_HEX[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect()
}

const ENTERPRISE_CODES: &[&str] = &["WM265T", "WM265E", "WM265M"];

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

fn is_mini4pro(code: &str, name: &str) -> bool {
    code.starts_with("WA140") || (name.contains("mini") && has_word(name, "4"))
}

fn prepare() -> ServiceStep {
    step(PC1, GIMBAL, ACK_AFTER, CMD_SET_ZENMUSE, CMD_GIMBAL_IMU_PREPARE, vec![0x43], true)
}

fn write_value(sender: u8, payload: &[u8]) -> ServiceStep {
    step(sender, GIMBAL, ACK_AFTER, CMD_SET_ZENMUSE, CMD_GIMBAL_IMU_WRITE, payload.to_vec(), true)
}

fn identify(receivers: &[u8], cmd_id: u8, payload: &[u8]) -> Vec<RepairStep> {
    receivers
        .iter()
        .map(|&receiver| RepairStep {
            step: step(PC1, receiver, ACK_AFTER, CMD_SET_GENERAL, cmd_id, payload.to_vec(), false),
            label: "Reading the aircraft identity".into(),
            wait_after_ms: 0,
            write: false,
        })
        .collect()
}

fn rstep(s: ServiceStep, label: &str, wait_after_ms: u64, write: bool) -> RepairStep {
    RepairStep { step: s, label: label.into(), wait_after_ms, write }
}

pub fn plan_imu_repair(method: &str, model_code: Option<&str>, model_name: Option<&str>) -> ImuRepairChoice {
    let code = model_code.unwrap_or("").to_uppercase();
    let name = model_name.unwrap_or("").to_lowercase();
    if code.is_empty() && name.is_empty() {
        return ImuRepairChoice { plan: None, reason: Some("The aircraft model is not identified yet.".into()) };
    }

    if method == "value" {
        if is_mini4pro(&code, &name) {
            let mut warm_up = identify(&[0x1f], 0x01, &[]);
            warm_up.extend(identify(&[OSD3], CMD_SERIAL, &[0x04]));
            if let Some(last) = warm_up.last_mut() {
                last.wait_after_ms = 2000;
            }
            let mut steps = warm_up;
            steps.push(rstep(prepare(), "Preparing the gimbal", 3000, false));
            steps.push(rstep(write_value(PC1, &mini4pro_block()), "Writing the calibration block", 6000, true));
            return ImuRepairChoice { plan: Some(ImuRepairPlan { steps, cleanup: vec![], foreign_block: true, moves: false }), reason: None };
        }
        let mut warm_up = identify(&[0x1f, 0x28], 0x01, &[]);
        warm_up.extend(identify(&[OSD3, 0xc3], CMD_SERIAL, &[0x04]));
        if let Some(last) = warm_up.last_mut() {
            last.wait_after_ms = 3000;
        }
        let mut steps = warm_up;
        steps.push(rstep(step(PC1, CAMERA, ACK_AFTER, CMD_SET_CAMERA, 0xb5, vec![0, 0, 0, 0], false), "Reading the camera serial", 3500, false));
        steps.push(rstep(write_value(PC1, &REPAIR_VALUE), "Writing the repair value", 6000, true));
        return ImuRepairChoice { plan: Some(ImuRepairPlan { steps, cleanup: vec![], foreign_block: false, moves: false }), reason: None };
    }

    if ENTERPRISE_CODES.contains(&code.as_str()) {
        let steps = vec![
            rstep(factory_step(FLIGHT_CONTROLLER, true, 0x0e, ACK_BEFORE), "Entering factory mode", 1500, false),
            rstep(prepare(), "Preparing the gimbal", 0, false),
            rstep(step(PC1, GIMBAL, ACK_AFTER, CMD_SET_ZENMUSE, 0x68, vec![0x2e, 0x02, 0x7f, 0x00], false), "Preparing the gimbal", 0, false),
            rstep(write_value(PC0, &REPAIR_VALUE), "Writing the repair value", 0, true),
            rstep(step(PC1, GIMBAL, ACK_BEFORE, CMD_SET_ZENMUSE, CMD_GIMBAL_CALIBRATE, vec![0x00], false), "Calibrating the gimbal", 40000, false),
        ];
        return ImuRepairChoice {
            plan: Some(ImuRepairPlan {
                steps,
                cleanup: vec![
                    factory_step(FLIGHT_CONTROLLER, false, 0x0e, ACK_BEFORE),
                    factory_step(FACTORY4, false, 0x0a, ACK_AFTER),
                    factory_step(OSD3, false, 0x0a, ACK_AFTER),
                ],
                foreign_block: false,
                moves: true,
            }),
            reason: None,
        };
    }

    if is_firmware_only_model(model_code, model_name) {
        return ImuRepairChoice {
            plan: None,
            reason: Some("This aircraft must not be sent a command calibration, so the repair that recalibrates is not available on it.".into()),
        };
    }

    let pass = |n: u8| -> Vec<RepairStep> {
        vec![
            rstep(write_value(PC0, &REPAIR_VALUE), &format!("Writing the repair value (pass {n} of 2)"), 0, true),
            rstep(step(PC0, GIMBAL, ACK_BEFORE, CMD_SET_ZENMUSE, CMD_GIMBAL_CALIBRATE, vec![0x01], false), &format!("Calibrating the gimbal (pass {n} of 2)"), 18000, false),
        ]
    };
    let mut steps = vec![rstep(prepare(), "Preparing the gimbal", 0, false)];
    steps.extend(pass(1));
    steps.extend(pass(2));
    ImuRepairChoice {
        plan: Some(ImuRepairPlan {
            steps,
            cleanup: vec![factory_step(FACTORY4, false, 0x0a, ACK_AFTER), factory_step(OSD3, false, 0x0a, ACK_AFTER)],
            foreign_block: false,
            moves: true,
        }),
        reason: None,
    }
}

pub const REPAIR_STEP_MS: u64 = 150;

pub fn repair_duration_ms(plan: &ImuRepairPlan) -> u64 {
    plan.steps.iter().map(|e| e.wait_after_ms + REPAIR_STEP_MS).sum()
}

// ── Serial numbers ───────────────────────────────────────────────────────────

pub struct SerialTarget {
    pub id: &'static str,
    pub label: &'static str,
    pub receiver: u8,
    pub writable: bool,
}

pub const SERIAL_TARGETS: &[SerialTarget] = &[
    SerialTarget { id: "aircraft", label: "Aircraft", receiver: OSD3, writable: false },
    SerialTarget { id: "camera", label: "Camera", receiver: CAMERA, writable: true },
    SerialTarget { id: "flight-controller", label: "Flight controller", receiver: FLIGHT_CONTROLLER, writable: true },
    SerialTarget { id: "gimbal", label: "Gimbal", receiver: GIMBAL, writable: true },
    SerialTarget { id: "center-board", label: "Center board", receiver: CENTER_BOARD, writable: true },
    SerialTarget { id: "battery", label: "Battery", receiver: BATTERY, writable: false },
];

pub fn serial_target(id: &str) -> Option<&'static SerialTarget> {
    SERIAL_TARGETS.iter().find(|t| t.id == id)
}

pub const SERIAL_MIN_LENGTH: usize = 6;
pub const SERIAL_MAX_LENGTH: usize = 24;
const SERIAL_PAD_LENGTH: usize = 16;

pub fn serial_problem(value: &str) -> Option<String> {
    if value.len() < SERIAL_MIN_LENGTH || value.len() > SERIAL_MAX_LENGTH {
        return Some(format!("A serial number has {SERIAL_MIN_LENGTH} to {SERIAL_MAX_LENGTH} characters."));
    }
    if !value.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase()) || value.is_empty() {
        return Some("A serial number uses only the digits 0–9 and the capital letters A–Z.".into());
    }
    None
}

pub fn serial_read_step(receiver: u8) -> ServiceStep {
    step(PC1, receiver, ACK_AFTER, CMD_SET_GENERAL, CMD_SERIAL, vec![0x04], true)
}

pub fn serial_write_step(receiver: u8, serial: &str) -> ServiceStep {
    let mut bytes = serial.bytes().collect::<Vec<u8>>();
    while bytes.len() < SERIAL_PAD_LENGTH {
        bytes.push(0);
    }
    let mut payload = vec![0x05];
    payload.extend(bytes);
    step(PC1, receiver, ACK_AFTER, CMD_SET_GENERAL, CMD_SERIAL, payload, true)
}

pub fn serial_factory_steps(open: bool) -> Vec<ServiceStep> {
    vec![factory_step(FACTORY4, open, 0x0a, ACK_AFTER), factory_step(OSD3, open, 0x0a, ACK_AFTER)]
}

pub const SERIAL_FACTORY_SETTLE_MS: u64 = 500;

// ── Result types for the UI ──────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairState {
    pub kind: String,
    pub phase: String,
    pub percent: u32,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialRow {
    pub component: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    pub writable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialWriteResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}
