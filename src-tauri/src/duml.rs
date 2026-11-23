//! DUML ("DUPC") v1 packet encoding and stream parsing.
//!
//! The encoding is byte-exact and deterministic: a given set of fields always
//! produces the same frame, matching what the device sends on the wire.
//!
//! Frame layout (little endian):
//!   0      sof            0x55
//!   1..2   ver_length     bits 0-9 whole packet length, bits 10-15 version (1)
//!   3      header_crc8    CRC8 (seed 0x77) of bytes 0..2
//!   4      sender         bits 0-4 module type, bits 5-7 module index
//!   5      receiver       bits 0-4 module type, bits 5-7 module index
//!   6..7   seq_num
//!   8      cmd_type       bit 7 response, bits 5-6 ack type, bits 0-2 encryption
//!   9      cmd_set
//!   10     cmd_id
//!   11..   payload
//!   last 2 crc16          CRC16 (seed 0x3692) of everything before it

pub const HEADER_LENGTH: usize = 11;
pub const FOOTER_LENGTH: usize = 2;
const MAX_PACKET_LENGTH: usize = 0x3ff;

// ── Device / command constants ───────────────────────────────────────────────

#[allow(dead_code)]
pub mod dev {
    pub const ANY: u8 = 0;
    pub const CAMERA: u8 = 1;
    pub const MOBILE_APP: u8 = 2;
    pub const FLYCONTROLLER: u8 = 3;
    pub const GIMBAL: u8 = 4;
    pub const CENTER_BOARD: u8 = 5;
    pub const REMOTE_RADIO: u8 = 6;
    pub const PC: u8 = 10;
    pub const BATTERY: u8 = 11;
    pub const ESC: u8 = 12;
    pub const MVO: u8 = 17;
    pub const SVO: u8 = 18;
}

#[allow(dead_code)]
pub mod ack {
    pub const NO_ACK_NEEDED: u8 = 0;
    pub const ACK_BEFORE_EXEC: u8 = 1;
    pub const ACK_AFTER_EXEC: u8 = 2;
}

#[allow(dead_code)]
pub mod cmd_set {
    pub const GENERAL: u8 = 0;
    pub const SPECIAL: u8 = 1;
    pub const CAMERA: u8 = 2;
    pub const FLYCONTROLLER: u8 = 3;
    pub const ZENMUSE: u8 = 4;
    pub const CENTER_BOARD: u8 = 5;
}

// ── CRC tables (built at compile time) ───────────────────────────────────────

const fn build_crc8() -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u8;
        let mut bit = 0;
        while bit < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0x8c } else { c >> 1 };
            bit += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

const fn build_crc16() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut c = i as u16;
        let mut bit = 0;
        while bit < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0x8408 } else { c >> 1 };
            bit += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
}

static CRC8_TABLE: [u8; 256] = build_crc8();
static CRC16_TABLE: [u16; 256] = build_crc16();

pub fn header_crc8(data: &[u8], len: usize) -> u8 {
    let mut crc: u8 = 0x77;
    for &byte in &data[..len] {
        crc = CRC8_TABLE[(byte ^ crc) as usize];
    }
    crc
}

pub fn packet_crc16(data: &[u8], len: usize) -> u16 {
    let mut crc: u16 = 0x3692;
    for &byte in &data[..len] {
        crc = (crc >> 8) ^ CRC16_TABLE[((byte as u16 ^ crc) & 0xff) as usize];
    }
    crc
}

pub fn module_info(dev_type: u8, index: u8) -> u8 {
    (dev_type & 0x1f) | ((index & 0x07) << 5)
}

// ── Encode ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct PacketFields {
    pub sender_type: u8,
    pub sender_index: u8,
    pub receiver_type: u8,
    pub receiver_index: u8,
    pub seq_num: u16,
    pub packet_type: u8,
    pub ack_type: u8,
    pub encrypt_type: u8,
    pub cmd_set: u8,
    pub cmd_id: u8,
    pub payload: Vec<u8>,
}

/// Encodes a v1 DUML packet. Returns an error if the payload makes it too long.
pub fn encode_packet(fields: &PacketFields) -> Result<Vec<u8>, String> {
    let length = HEADER_LENGTH + fields.payload.len() + FOOTER_LENGTH;
    if length > MAX_PACKET_LENGTH {
        return Err(format!("DUML payload too long ({} bytes).", fields.payload.len()));
    }
    let mut buf = vec![0u8; length];
    buf[0] = 0x55;
    let ver_length = ((length & 0x3ff) | (1 << 10)) as u16;
    buf[1..3].copy_from_slice(&ver_length.to_le_bytes());
    buf[3] = header_crc8(&buf, 3);
    buf[4] = module_info(fields.sender_type, fields.sender_index);
    buf[5] = module_info(fields.receiver_type, fields.receiver_index);
    buf[6..8].copy_from_slice(&fields.seq_num.to_le_bytes());
    buf[8] = ((fields.packet_type & 1) << 7) | ((fields.ack_type & 3) << 5) | (fields.encrypt_type & 7);
    buf[9] = fields.cmd_set;
    buf[10] = fields.cmd_id;
    buf[HEADER_LENGTH..HEADER_LENGTH + fields.payload.len()].copy_from_slice(&fields.payload);
    let crc = packet_crc16(&buf, length - 2);
    buf[length - 2..].copy_from_slice(&crc.to_le_bytes());
    Ok(buf)
}

// ── Decode + parse ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Packet {
    pub sender_info: u8,
    pub receiver_info: u8,
    pub sender_type: u8,
    pub sender_index: u8,
    pub receiver_type: u8,
    pub receiver_index: u8,
    pub seq_num: u16,
    pub packet_type: u8,
    pub ack_type: u8,
    pub encrypt_type: u8,
    pub cmd_set: u8,
    pub cmd_id: u8,
    pub payload: Vec<u8>,
    pub raw: Vec<u8>,
}

fn decode_packet(raw: &[u8]) -> Packet {
    let seq_num = u16::from_le_bytes([raw[6], raw[7]]);
    Packet {
        sender_info: raw[4],
        receiver_info: raw[5],
        sender_type: raw[4] & 0x1f,
        sender_index: raw[4] >> 5,
        receiver_type: raw[5] & 0x1f,
        receiver_index: raw[5] >> 5,
        seq_num,
        packet_type: raw[8] >> 7,
        ack_type: (raw[8] >> 5) & 3,
        encrypt_type: raw[8] & 7,
        cmd_set: raw[9],
        cmd_id: raw[10],
        payload: raw[HEADER_LENGTH..raw.len() - FOOTER_LENGTH].to_vec(),
        raw: raw.to_vec(),
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ")
}

/// Incremental parser: feed bytes as they arrive and get back every complete,
/// checksum-valid v1 packet.
#[derive(Default)]
pub struct PacketParser {
    buffer: Vec<u8>,
}

impl PacketParser {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Packet> {
        self.buffer.extend_from_slice(chunk);
        let mut packets = Vec::new();
        let mut pos = 0usize;

        loop {
            // Find the next start-of-frame byte.
            let start = match self.buffer[pos..].iter().position(|&b| b == 0x55) {
                Some(offset) => pos + offset,
                None => {
                    pos = self.buffer.len();
                    break;
                }
            };
            pos = start;
            if self.buffer.len() - pos < 4 {
                break; // wait for the rest of the header
            }
            if header_crc8(&self.buffer[pos..], 3) != self.buffer[pos + 3] {
                pos += 1;
                continue;
            }
            let ver_length = u16::from_le_bytes([self.buffer[pos + 1], self.buffer[pos + 2]]);
            let length = (ver_length & 0x3ff) as usize;
            if length < HEADER_LENGTH + FOOTER_LENGTH {
                pos += 1;
                continue;
            }
            if self.buffer.len() - pos < length {
                break; // wait for the rest of the body
            }
            let raw = &self.buffer[pos..pos + length];
            let crc = u16::from_le_bytes([raw[length - 2], raw[length - 1]]);
            if packet_crc16(raw, length - 2) != crc {
                pos += 1;
                continue;
            }
            if ver_length >> 10 == 1 {
                packets.push(decode_packet(raw));
            }
            pos += length;
        }

        self.buffer.drain(..pos);
        packets
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_the_reference_ping() {
        // The reference ping used to probe the drone over USB.
        let pkt = encode_packet(&PacketFields {
            sender_type: dev::PC,
            sender_index: 1,
            receiver_type: dev::FLYCONTROLLER,
            receiver_index: 0,
            seq_num: 0x1122,
            packet_type: 0,
            ack_type: ack::ACK_AFTER_EXEC,
            encrypt_type: 0,
            cmd_set: cmd_set::GENERAL,
            cmd_id: 0x00,
            payload: vec![],
        })
        .unwrap();
        assert_eq!(to_hex(&pkt), "55 0d 04 33 2a 03 22 11 40 00 00 3e ed");
    }

    #[test]
    fn round_trips_through_the_parser() {
        let pkt = encode_packet(&PacketFields {
            sender_type: dev::PC,
            sender_index: 0,
            receiver_type: dev::FLYCONTROLLER,
            receiver_index: 0,
            seq_num: 7,
            packet_type: 0,
            ack_type: ack::ACK_AFTER_EXEC,
            encrypt_type: 0,
            cmd_set: cmd_set::GENERAL,
            cmd_id: 0x01,
            payload: vec![0xaa, 0xbb],
        })
        .unwrap();
        let mut parser = PacketParser::new();
        // Feed with a leading junk byte and split across two chunks.
        let mut out = parser.feed(&[0xff]);
        assert!(out.is_empty());
        out = parser.feed(&pkt[..5]);
        assert!(out.is_empty());
        out = parser.feed(&pkt[5..]);
        assert_eq!(out.len(), 1);
        let p = &out[0];
        assert_eq!(p.cmd_set, cmd_set::GENERAL);
        assert_eq!(p.cmd_id, 0x01);
        assert_eq!(p.payload, vec![0xaa, 0xbb]);
        assert_eq!(p.receiver_type, dev::FLYCONTROLLER);
    }
}
