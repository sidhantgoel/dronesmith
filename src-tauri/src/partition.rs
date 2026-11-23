//! Read-only partition dump. A partition is read by paging the aircraft's
//! firmware-page query (GENERAL 0x00/0x4F) against the device that owns it.
//! Read-only; the builders are pure.

use crate::service::ServiceStep;
use serde::Serialize;

const PART_FC: u8 = 0x02;
const PART_CENTER: u8 = 0x04;

pub struct PartitionDef {
    pub id: u8,
    pub name: &'static str,
    pub target: u8,
}

pub const PARTITIONS: &[PartitionDef] = &[
    PartitionDef { id: 1, name: "Bootloader", target: PART_FC },
    PartitionDef { id: 2, name: "Flight Controller FW", target: PART_FC },
    PartitionDef { id: 3, name: "FC Parameters", target: PART_FC },
    PartitionDef { id: 4, name: "Gimbal Params", target: PART_CENTER },
    PartitionDef { id: 5, name: "Camera Params", target: PART_CENTER },
    PartitionDef { id: 6, name: "Vision Calibration", target: PART_CENTER },
    PartitionDef { id: 7, name: "NFZ Database", target: PART_FC },
    PartitionDef { id: 8, name: "Serial Numbers", target: PART_FC },
    PartitionDef { id: 9, name: "Factory Data", target: PART_FC },
    PartitionDef { id: 10, name: "Flight Logs Index", target: PART_FC },
];

pub fn partition_by_id(id: u8) -> Option<&'static PartitionDef> {
    PARTITIONS.iter().find(|p| p.id == id)
}

/// The firmware-page query for one page of a partition's target device.
pub fn partition_page_step(target: u8, page: u8) -> ServiceStep {
    ServiceStep { sender: 0x2a, receiver: target, ack_enc: 0x40, cmd_set: 0x00, cmd_id: 0x4f, payload: vec![page], expect_reply: true, wait_after_ms: 0 }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionBackupResult {
    pub ok: bool,
    pub name: String,
    pub pages: usize,
    pub bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    pub message: String,
}
