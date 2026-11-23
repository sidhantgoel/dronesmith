//! IMU calibration planning and progress decoding. What it sends is the
//! gimbal's calibration command (ZENMUSE 0x04/0x08) with mode 5, inside factory
//! mode. Pure; the session runs the plan.

use crate::gimbal_cal::is_firmware_only_model;
use crate::service::ServiceStep;

const PC1: u8 = 0x2a;
const GIMBAL: u8 = 0x04;
const OSD3: u8 = 0x68;
const FACTORY4: u8 = 0x8f;
const ACK_AFTER: u8 = 0x40;

const CMD_SET_GENERAL: u8 = 0x00;
const CMD_SET_ZENMUSE: u8 = 0x04;
const CMD_FACTORY_MODE: u8 = 0x44;
const CMD_CALIBRATION: u8 = 0x08;
const MODE_IMU: u8 = 0x05;

pub struct ImuPosition {
    pub id: u8,
    pub label: &'static str,
}

pub const IMU_POSITIONS: &[ImuPosition] = &[
    ImuPosition { id: 0, label: "Level, top up" },
    ImuPosition { id: 1, label: "Inverted, top down" },
    ImuPosition { id: 2, label: "Nose down" },
    ImuPosition { id: 3, label: "Nose up" },
    ImuPosition { id: 4, label: "Left side" },
    ImuPosition { id: 5, label: "Right side" },
];

pub struct ImuCalibrationPlan {
    pub prepare: Vec<ServiceStep>,
    pub pause_ms: u64,
    pub trigger: ServiceStep,
    pub cleanup: Vec<ServiceStep>,
    pub ack_timeout_ms: u64,
}

pub struct ImuCalibrationChoice {
    pub plan: Option<ImuCalibrationPlan>,
    pub reason: Option<String>,
}

fn step(receiver: u8, cmd_set: u8, cmd_id: u8, payload: Vec<u8>) -> ServiceStep {
    ServiceStep { sender: PC1, receiver, ack_enc: ACK_AFTER, cmd_set, cmd_id, payload, expect_reply: false, wait_after_ms: 0 }
}

fn factory(receiver: u8, tag: &str) -> ServiceStep {
    let mut payload = vec![0x80, 0x0a];
    payload.extend(tag.bytes());
    payload.push(0x00);
    step(receiver, CMD_SET_GENERAL, CMD_FACTORY_MODE, payload)
}

pub fn plan_imu_calibration(model_code: Option<&str>, model_name: Option<&str>) -> ImuCalibrationChoice {
    if model_code.is_none() && model_name.is_none() {
        return ImuCalibrationChoice { plan: None, reason: Some("The aircraft model has not been identified yet.".into()) };
    }
    if is_firmware_only_model(model_code, model_name) {
        return ImuCalibrationChoice {
            plan: None,
            reason: Some("This model calibrates by reflashing its service firmware, not by command. A command calibration can put its camera into download mode, so it is not sent.".into()),
        };
    }
    ImuCalibrationChoice {
        plan: Some(ImuCalibrationPlan {
            prepare: vec![factory(FACTORY4, "start_factory"), factory(OSD3, "start_factory")],
            pause_ms: 500,
            trigger: step(GIMBAL, CMD_SET_ZENMUSE, CMD_CALIBRATION, vec![MODE_IMU]),
            cleanup: vec![factory(FACTORY4, "stop_factory"), factory(OSD3, "stop_factory")],
            ack_timeout_ms: 10000,
        }),
        reason: None,
    }
}

pub struct ImuProgress {
    pub percent: u8,
    pub position: Option<u8>,
}

/// Decodes a progress report: [percent, step].
pub fn parse_imu_progress(payload: &[u8]) -> Option<ImuProgress> {
    if payload.is_empty() {
        return None;
    }
    let step_value = if payload.len() >= 2 { payload[1] } else { 0 };
    Some(ImuProgress {
        percent: payload[0],
        position: if (step_value as usize) < IMU_POSITIONS.len() { Some(step_value) } else { None },
    })
}
