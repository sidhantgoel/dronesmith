//! One-shot DUML service commands. Pure builders: each action yields a list of
//! steps the session sends, and `interpret` turns the reply counts into the
//! message the UI shows.

use serde::Serialize;

const SENDER: u8 = 0x2a;
/// ack-after-exec, no encryption.
const CONTROL: u8 = 0x40;

const BATTERY: u8 = 0x0b;
const FLIGHT_CONTROLLER: u8 = 0x03;
const CAMERA: u8 = 0x01;
const VISION_MONOCULAR: u8 = 0x11;
const VISION_BINOCULAR: u8 = 0x12;
const FACTORY_MODULE: u8 = 0x8f;

/// A single DUML step, with an optional pause before the next one.
#[derive(Clone)]
pub struct ServiceStep {
    pub sender: u8,
    pub receiver: u8,
    pub ack_enc: u8,
    pub cmd_set: u8,
    pub cmd_id: u8,
    pub payload: Vec<u8>,
    pub expect_reply: bool,
    pub wait_after_ms: u64,
}

fn step(receiver: u8, cmd_set: u8, cmd_id: u8, payload: Vec<u8>) -> ServiceStep {
    ServiceStep {
        sender: SENDER,
        receiver,
        ack_enc: CONTROL,
        cmd_set,
        cmd_id,
        payload,
        expect_reply: true,
        wait_after_ms: 0,
    }
}

fn ascii(text: &str) -> Vec<u8> {
    text.bytes().collect()
}

fn factory_payload(tag: &str) -> Vec<u8> {
    let mut v = vec![0x80, 0x0a];
    v.extend(ascii(tag));
    v
}

/// Sensor ids the vision module reports serials for (two-byte bitmask).
pub const VISION_SENSORS: &[(u16, &str)] = &[
    (1, "Front left"),
    (2, "Front right"),
    (4, "Rear left"),
    (8, "Rear right"),
    (64, "Bottom"),
    (128, "Top"),
    (1024, "ToF left"),
    (2048, "ToF right"),
];

pub fn vision_sensor_step(mask: u16) -> ServiceStep {
    step(
        VISION_BINOCULAR,
        0x24,
        0x26,
        vec![15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 161, (mask >> 8) as u8, (mask & 0xff) as u8],
    )
}

/// Vision-calibration status query to each vision module (0x0A/0x01).
pub fn vision_cal_steps() -> Vec<ServiceStep> {
    [VISION_MONOCULAR, VISION_BINOCULAR].iter().map(|&r| step(r, 0x0a, 0x01, Vec::new())).collect()
}

/// RF link test: GENERAL 0x5F to the three radios.
pub fn link_test_steps() -> Vec<ServiceStep> {
    [0xc3u8, 0x04, 0x12].iter().map(|&r| step(r, 0x00, 0x5f, vec![r & 0x1f, 0xff, 0xff, 0xff, 0xff])).collect()
}

/// The sensor mask a per-sensor query step asks about.
pub fn vision_sensor_of(query: &ServiceStep) -> u16 {
    ((*query.payload.get(13).unwrap_or(&0) as u16) << 8) | *query.payload.get(14).unwrap_or(&0) as u16
}

/// Reads a per-sensor serial from a reply; None for an absent sensor.
pub fn vision_sensor_serial(reply: &[u8]) -> Option<String> {
    let text: String = reply.iter().skip(4).filter(|&&b| (0x20..=0x7e).contains(&b)).map(|&b| b as char).collect();
    if text.len() >= 6 && !text.starts_with("???") {
        Some(text)
    } else {
        None
    }
}

/// Builds the steps for an action. Unknown actions yield an empty list.
pub fn service_steps(action: &str) -> Vec<ServiceStep> {
    match action {
        "factory-enter" => [FACTORY_MODULE, 0x68]
            .iter()
            .map(|&r| step(r, 0x00, 0x44, factory_payload("start_factory")))
            .collect(),
        "factory-exit" => [FACTORY_MODULE, 0x68]
            .iter()
            .map(|&r| step(r, 0x00, 0x44, factory_payload("stop_factory")))
            .collect(),
        "esc-repair" => vec![step(FLIGHT_CONTROLLER, 0x03, 0xf3, vec![])],
        "rc-pair" => vec![step(0x09, 0x06, 0x2f, vec![0x01])],
        "camera-serials" => vec![step(CAMERA, 0x02, 0xb5, vec![0, 0, 0, 0])],
        "link-test" => [0xc3u8, 0x04, 0x12]
            .iter()
            .map(|&r| step(r, 0x00, 0x5f, vec![r & 0x1f, 0xff, 0xff, 0xff, 0xff]))
            .collect(),
        "battery-info" => vec![step(BATTERY, 0x0d, 0x02, vec![0x01])],
        "imu-status" => vec![step(FLIGHT_CONTROLLER, 0x00, 0x52, vec![])],
        "vision-scan" => [VISION_MONOCULAR, VISION_BINOCULAR]
            .iter()
            .map(|&r| step(r, 0x00, 0x51, vec![0x04]))
            .collect(),
        "fc-param-count" => vec![step(FLIGHT_CONTROLLER, 0x03, 0xe0, vec![0x00, 0x00])],
        "camera-info" => vec![
            step(CAMERA, 0x00, 0x01, vec![]),
            step(CAMERA, 0x02, 0xb5, vec![0, 0, 0, 0]),
        ],
        "vision-cal" => [VISION_MONOCULAR, VISION_BINOCULAR]
            .iter()
            .map(|&r| step(r, 0x0a, 0x01, vec![]))
            .collect(),
        "tof-reset" => vec![
            step(VISION_MONOCULAR, 0x24, 0x28, vec![0x01, 0x00, 0x00, 0x00]),
            step(VISION_MONOCULAR, 0x24, 0x26, vec![15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 161, 0, 1]),
        ],
        "vision-recover" => {
            let mut steps = Vec::new();
            let mut enter = step(FACTORY_MODULE, 0x00, 0x44, factory_payload("start_factory"));
            enter.wait_after_ms = 500;
            steps.push(enter);
            let mut reset = step(VISION_BINOCULAR, 0x24, 0x20, vec![0x01, 0x00, 0x00, 0x00]);
            reset.wait_after_ms = 1000;
            steps.push(reset);
            for (mask, _) in VISION_SENSORS {
                steps.push(vision_sensor_step(*mask));
            }
            steps
        }
        "aircraft-restart" => vec![step(BATTERY, 0x00, 0x0b, vec![0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
        "aircraft-power-off" => vec![step(BATTERY, 0x00, 0x0b, vec![0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
        _ => Vec::new(),
    }
}

/// Steps sent after an action whether or not it completed (leave factory mode).
pub fn service_cleanup_steps(action: &str) -> Vec<ServiceStep> {
    if action == "vision-recover" {
        vec![step(FACTORY_MODULE, 0x00, 0x44, factory_payload("stop_factory"))]
    } else {
        Vec::new()
    }
}

pub fn is_read_service(action: &str) -> bool {
    matches!(
        action,
        "camera-serials" | "link-test" | "battery-info" | "imu-status" | "vision-scan"
            | "fc-param-count" | "camera-info" | "vision-cal"
    )
}

pub fn is_destructive_service(action: &str) -> bool {
    matches!(
        action,
        "factory-enter" | "factory-exit" | "esc-repair" | "rc-pair" | "tof-reset"
            | "vision-recover" | "aircraft-restart" | "aircraft-power-off"
    )
}

/// The longest printable identifier run in a reply, as the serial read uses.
pub fn serial_from_reply(payload: &[u8]) -> Option<String> {
    let text: String = payload.iter().map(|&b| b as char).collect();
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .filter(|run| run.len() >= 6)
        .max_by_key(|run| run.len())
        .map(|s| s.to_string())
}

pub fn receiver_label(receiver: u8) -> String {
    match receiver {
        0x01 => "Camera".into(),
        0x03 => "Flight controller".into(),
        0x04 => "Gimbal".into(),
        0x08 | 0x0b => "Battery".into(),
        0x09 => "Remote link".into(),
        0x11 => "Monocular vision".into(),
        0x12 => "Binocular vision".into(),
        0xc3 => "Radio".into(),
        other => format!("Module 0x{:02x}", other),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResult {
    pub action: String,
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<String>,
}
