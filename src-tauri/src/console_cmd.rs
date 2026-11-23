//! The command console: one hand-built DUML command to a module, and the
//! frames the aircraft sends while the console is open.
//! Pure parsing/limits; the session sends and watches.

use serde::{Deserialize, Serialize};

pub const CONSOLE_PAYLOAD_MAX: usize = 512;
pub const CONSOLE_FRAME_BYTES: usize = 48;
pub const CONSOLE_KEEP_FRAMES: usize = 500;
pub const CONSOLE_REPLY_WAIT_MS: u64 = 2000;

/// Raw request from the UI. Fields are byte-sized but kept wide so an
/// out-of-range value is reported, not rejected at deserialize time.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleRequest {
    pub sender: i64,
    pub receiver: i64,
    pub cmd_set: i64,
    pub cmd_id: i64,
    pub ack_enc: i64,
    pub payload: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleReply {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleFrame {
    pub at: u64,
    pub from: u8,
    pub to: u8,
    pub cmd_set: u8,
    pub cmd_id: u8,
    pub ack: bool,
    pub length: usize,
    pub hex: String,
}

const CONSOLE_ACKS: &[i64] = &[0x40, 0x20, 0x00];

fn is_byte(v: i64) -> bool {
    (0..=0xff).contains(&v)
}

/// Returns why a request cannot be sent, or None when it can.
pub fn console_request_problem(request: &ConsoleRequest) -> Option<String> {
    if !is_byte(request.sender) || !is_byte(request.receiver) {
        return Some("The sender and receiver are one byte each.".into());
    }
    if !is_byte(request.cmd_set) || !is_byte(request.cmd_id) {
        return Some("The command set and command id are one byte each.".into());
    }
    if !CONSOLE_ACKS.contains(&request.ack_enc) {
        return Some("Choose how the command is acknowledged.".into());
    }
    if request.payload.len() > CONSOLE_PAYLOAD_MAX || !request.payload.iter().all(|&b| is_byte(b)) {
        return Some(format!("The payload is up to {CONSOLE_PAYLOAD_MAX} bytes."));
    }
    None
}
