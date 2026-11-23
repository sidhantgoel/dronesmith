//! The live drone session: finds a connected DJI aircraft over USB, scans its
//! modules, identifies the model and reads its serial, and pushes a `DroneState`
//! to the UI. One session runs for the life of the app.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use std::collections::HashSet;
use std::collections::VecDeque;

use crate::battery::{self, BatteryReading, BatterySnapshot};
use crate::config::{self, FirmwareManifest};
use crate::console_cmd::{self, ConsoleFrame, ConsoleReply, ConsoleRequest};
use crate::diagnostics::{self, DiagnosticCheck, DiagnosticModule, DiagnosticProgress, DiagnosticReport, ReportSaveResult, SaveReportInput};
use crate::duml::{self, dev, PacketFields, PacketParser};
use crate::ext4::{self, Ext4Volume, ImageSource};
use crate::fastboot::{self, FastbootActionResult, FastbootClient, FastbootFlashProgress, FastbootScanResult};
use crate::image_explorer::{self, ImageExtractProgress, ImageExtractResult, ImageListResult, ImageMountResult, ImageOpenResult, ImagePreview};
use crate::flasher::{self, FirmwareFile, FirmwareFileInfo, FlashRoute, FlashState, FlashValidation};
use crate::ftp::{self, FtpClient, FtpConnectOptions, FtpConnectResult, FtpDownloadProgress, FtpDownloadResult, FtpListResult};
use crate::gimbal_cal::{self, AdvancedCalibrationPlan};
use crate::hms::{self, HmsFault};
use crate::imu_cal::{self, ImuCalibrationPlan, IMU_POSITIONS};
use crate::models::{match_model_code, DroneModel};
use crate::motor_test::{self, GimbalAngles, GimbalAxis, MotorTestResult, PropTestEvent, PropTestMode};
use crate::params::{self, ParamBackupFileResult, ParamEntry, ParamProgress, ParamReadResult, ParamScanResult, ParamWriteResult};
use crate::partition::{self, PartitionBackupResult};
use crate::rc::{self, Adb, RcCommandResult, RcConnectResult, RcInfo, RcPackage, RcPullProgress, RcPullResult, RcRootResult, RcScreenResult};
use crate::repair::{self, RepairState, SerialRow, SerialWriteResult};
use crate::service::{self, ServiceResult, ServiceStep};
use crate::telemetry::{self, TelemetryReading};
use crate::usb0::{connect_bulk, connect_fastboot, BulkTransport};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HmsState {
    pub faults: Vec<HmsFault>,
    pub updated_at: u64,
}

/// Result of a manual HMS read.
#[derive(Serialize)]
pub struct HmsReadResult {
    pub ok: bool,
    pub count: usize,
    pub message: String,
}

/// A running or finished simple/advanced gimbal calibration, for the UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationState {
    pub kind: String,
    /// running | pass | unsure | failed
    pub phase: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub expect_ms: u64,
    pub reports: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_report: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u32>,
    pub message: String,
}

/// A running or finished IMU calibration, for the UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImuCalibrationState {
    /// running | pass | unsure | failed | stopped
    pub phase: String,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u8>,
    pub done: Vec<u8>,
    pub reports: u32,
    pub message: String,
}

const CONNECT_INTERVAL: Duration = Duration::from_millis(1500);
const SCAN_SPACING: Duration = Duration::from_millis(15);
const SCAN_WAIT: Duration = Duration::from_millis(1500);
const CMD_VERSION_INQUIRY: u8 = 0x01;
const CMD_GET_SERIAL: u8 = 0x51;

/// The PC's own DUML address: module_info(PC=10, index 0).
const PC_INFO: u8 = 10;

/// One module's reported versions, as the UI shows them.
#[derive(Clone, Serialize)]
pub struct ModuleVersion {
    pub name: String,
    pub hardware: String,
    pub firmware: String,
    pub loader: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneState {
    pub status: String,
    pub scanning: bool,
    pub modules: Vec<ModuleVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_serial: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hms: Option<HmsState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calibration: Option<CalibrationState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imu_calibration: Option<ImuCalibrationState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair: Option<RepairState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<FirmwareManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DroneState {
    fn searching() -> Self {
        DroneState {
            status: "searching".into(),
            scanning: false,
            modules: Vec::new(),
            model: None,
            model_code: None,
            serial: None,
            camera_serial: None,
            label: None,
            hms: None,
            calibration: None,
            imu_calibration: None,
            repair: None,
            manifest: None,
            error: None,
        }
    }
}

type Listener = Arc<dyn Fn(&duml::Packet) + Send + Sync>;

/// Outcome of applying one report during a monitored run.
#[derive(PartialEq)]
enum Flow {
    Continue,
    Done,
    Error,
}

const ZENMUSE: u8 = 0x04;
const CMD_GIMBAL_CALIBRATION: u8 = 0x08;
const CMD_GIMBAL_CALIBRATION_PROGRESS: u8 = 0x30;

type PacketQueue = Arc<(Mutex<VecDeque<duml::Packet>>, Condvar)>;

/// Waits up to `timeout_ms` for the next queued packet.
fn next_report(q: &PacketQueue, timeout_ms: u64) -> Option<duml::Packet> {
    let (m, cv) = &**q;
    let mut g = m.lock();
    if g.is_empty() {
        cv.wait_for(&mut g, Duration::from_millis(timeout_ms));
    }
    g.pop_front()
}

struct Inner {
    parser: PacketParser,
    listeners: Vec<(u64, Listener)>,
    next_id: u64,
    state: DroneState,
    seq: u16,
    active_model: Option<&'static DroneModel>,
    hms_records: HashMap<String, HmsFault>,
    hms_live: HashMap<String, Vec<HmsFault>>,
    hms_snapshot_received: bool,
    /// Last flight-controller status frame (0x03/0x43) and when it arrived.
    fc_status_frame: Option<(Vec<u8>, u64)>,
    // Motor-test state, reset per connection.
    gimbal_test_enabled: bool,
    gimbal_test_acks: u32,
    gimbal_test_listener: Option<u64>,
    beeping: HashSet<u8>,
    beep_factory_open: bool,
    prop_factory_open: bool,
    console_listener: Option<u64>,
    config_receiver: Option<u8>,
}

pub struct Session {
    inner: Arc<Mutex<Inner>>,
    transport: Arc<Mutex<Option<Arc<BulkTransport>>>>,
    app: AppHandle,
    dll_paths: Vec<String>,
    resolver: Arc<hms::Resolver>,
    param_read_active: Arc<AtomicBool>,
    calibrating: Arc<AtomicBool>,
    imu_stop: Arc<AtomicBool>,
    prop_testing: Arc<AtomicBool>,
    prop_stop: Arc<AtomicBool>,
    prop_test_touched: Arc<AtomicBool>,
    flashing: Arc<AtomicBool>,
    console_watch: Arc<AtomicBool>,
    console_buffer: Arc<Mutex<Vec<ConsoleFrame>>>,
    diagnosing: Arc<AtomicBool>,
    flash_state: Arc<Mutex<FlashState>>,
    flash_cancelled: Arc<AtomicBool>,
    ftp_client: Arc<Mutex<Option<FtpClient>>>,
    ftp_downloading: Arc<AtomicBool>,
    adb: Arc<Adb>,
    rc_last_screen: Arc<Mutex<Option<Vec<u8>>>>,
    fb_client: Arc<Mutex<Option<FastbootClient>>>,
    fb_busy: Arc<AtomicBool>,
    fb_watch: Arc<AtomicBool>,
    img_source: Arc<Mutex<Option<Arc<ImageSource>>>>,
    img_volume: Arc<Mutex<Option<Ext4Volume>>>,
    img_extracting: Arc<AtomicBool>,
}

/// Scan targets: (type, index, display name), mirroring the TS list.
const SCAN_TARGETS: &[(u8, u8, &str)] = &[
    (dev::FLYCONTROLLER, 0, "Flight controller"),
    (dev::CAMERA, 0, "Camera"),
    (dev::GIMBAL, 0, "Gimbal"),
    (dev::CENTER_BOARD, 0, "Center board"),
    (dev::BATTERY, 0, "Battery"),
    (dev::ESC, 0, "ESC 1"),
    (dev::ESC, 1, "ESC 2"),
    (dev::ESC, 2, "ESC 3"),
    (dev::ESC, 3, "ESC 4"),
    (dev::REMOTE_RADIO, 0, "Remote radio"),
    (dev::MVO, 0, "Vision (MVO)"),
    (dev::SVO, 0, "Vision (SVO)"),
    (25, 0, "IMU"),
    (26, 0, "GPS"),
];

fn format_version(value: u32) -> String {
    format!(
        "{:02}.{:02}.{:02}.{:02}",
        value >> 24,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff
    )
}

/// Decodes a General/VersionInquiry (cmd 0x01) reply payload.
fn parse_version_reply(name: &str, payload: &[u8]) -> Option<ModuleVersion> {
    if payload.len() < 18 {
        return None;
    }
    let hw = &payload[2..18];
    let end = hw.iter().position(|&b| b == 0).unwrap_or(hw.len());
    let hardware = String::from_utf8_lossy(&hw[..end]).trim().to_string();
    let loader = if payload.len() >= 22 {
        format_version(u32::from_le_bytes([payload[18], payload[19], payload[20], payload[21]]))
    } else {
        "—".into()
    };
    let firmware = if payload.len() >= 26 {
        format_version(u32::from_le_bytes([payload[22], payload[23], payload[24], payload[25]]))
    } else {
        "—".into()
    };
    Some(ModuleVersion {
        name: name.to_string(),
        hardware: if hardware.is_empty() { "—".into() } else { hardware },
        firmware,
        loader,
    })
}

fn extract_serial(payload: &[u8]) -> Option<String> {
    let text: String = payload
        .iter()
        .filter(|&&b| (0x20..0x7f).contains(&b))
        .map(|&b| b as char)
        .collect();
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .filter(|run| run.len() >= 6)
        .max_by_key(|run| run.len())
        .map(|s| s.to_string())
}

impl Session {
    pub fn new(app: AppHandle, dll_paths: Vec<String>, hms_json: Option<String>, adb_exe: String) -> Arc<Session> {
        let resolver = hms_json.map(|j| hms::load_resolver(&j)).unwrap_or_default();
        Arc::new(Session {
            inner: Arc::new(Mutex::new(Inner {
                parser: PacketParser::new(),
                listeners: Vec::new(),
                next_id: 0,
                state: DroneState::searching(),
                seq: ((std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
                    / 10)
                    & 0xffff) as u16,
                active_model: None,
                hms_records: HashMap::new(),
                hms_live: HashMap::new(),
                hms_snapshot_received: false,
                fc_status_frame: None,
                gimbal_test_enabled: false,
                gimbal_test_acks: 0,
                gimbal_test_listener: None,
                beeping: HashSet::new(),
                beep_factory_open: false,
                prop_factory_open: false,
                console_listener: None,
                config_receiver: None,
            })),
            transport: Arc::new(Mutex::new(None)),
            app,
            dll_paths,
            resolver: Arc::new(resolver),
            param_read_active: Arc::new(AtomicBool::new(false)),
            calibrating: Arc::new(AtomicBool::new(false)),
            imu_stop: Arc::new(AtomicBool::new(false)),
            prop_testing: Arc::new(AtomicBool::new(false)),
            prop_stop: Arc::new(AtomicBool::new(false)),
            prop_test_touched: Arc::new(AtomicBool::new(false)),
            flashing: Arc::new(AtomicBool::new(false)),
            console_watch: Arc::new(AtomicBool::new(false)),
            console_buffer: Arc::new(Mutex::new(Vec::new())),
            diagnosing: Arc::new(AtomicBool::new(false)),
            flash_state: Arc::new(Mutex::new(FlashState::idle())),
            flash_cancelled: Arc::new(AtomicBool::new(false)),
            ftp_client: Arc::new(Mutex::new(None)),
            ftp_downloading: Arc::new(AtomicBool::new(false)),
            adb: Arc::new(Adb::new(adb_exe)),
            rc_last_screen: Arc::new(Mutex::new(None)),
            fb_client: Arc::new(Mutex::new(None)),
            fb_busy: Arc::new(AtomicBool::new(false)),
            fb_watch: Arc::new(AtomicBool::new(false)),
            img_source: Arc::new(Mutex::new(None)),
            img_volume: Arc::new(Mutex::new(None)),
            img_extracting: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn state(&self) -> DroneState {
        self.inner.lock().state.clone()
    }

    fn emit_state(&self) {
        let state = self.inner.lock().state.clone();
        let _ = self.app.emit("drone:state", state);
    }

    fn set_status(&self, status: &str) {
        self.inner.lock().state.status = status.to_string();
    }

    fn subscribe(&self, f: Listener) -> u64 {
        let mut g = self.inner.lock();
        let id = g.next_id;
        g.next_id += 1;
        g.listeners.push((id, f));
        id
    }

    fn unsubscribe(&self, id: u64) {
        self.inner.lock().listeners.retain(|(i, _)| *i != id);
    }

    fn send(
        &self,
        transport: &BulkTransport,
        receiver_type: u8,
        receiver_index: u8,
        cmd_set: u8,
        cmd_id: u8,
        payload: Vec<u8>,
    ) -> Result<(), String> {
        let seq = {
            let mut g = self.inner.lock();
            g.seq = g.seq.wrapping_add(1);
            g.seq
        };
        let pkt = duml::encode_packet(&PacketFields {
            sender_type: dev::PC,
            sender_index: 0,
            receiver_type,
            receiver_index,
            seq_num: seq,
            packet_type: 0,
            ack_type: duml::ack::ACK_AFTER_EXEC,
            encrypt_type: 0,
            cmd_set,
            cmd_id,
            payload,
        })?;
        transport.write(&pkt)
    }

    /// The background loop: connect, scan, hold, and reconnect.
    pub fn run_loop(self: Arc<Self>) {
        std::thread::spawn(move || loop {
            let connected = self.transport.lock().is_some();
            if !connected {
                match connect_bulk(&self.dll_paths) {
                    Ok(transport) => self.on_connected(transport),
                    Err(_) => {}
                }
            }
            std::thread::sleep(CONNECT_INTERVAL);
        });
    }

    fn on_connected(self: &Arc<Self>, transport: Arc<BulkTransport>) {
        {
            let mut g = self.inner.lock();
            g.state = DroneState::searching();
            g.state.status = "connected".into();
            g.state.label = Some(transport.label.clone());
            g.active_model = None;
            g.parser.reset();
            g.hms_records.clear();
            g.hms_live.clear();
            g.hms_snapshot_received = false;
            g.fc_status_frame = None;
            g.gimbal_test_enabled = false;
            g.gimbal_test_acks = 0;
            g.gimbal_test_listener = None;
            g.beeping.clear();
            g.beep_factory_open = false;
            g.prop_factory_open = false;
            g.console_listener = None;
            g.config_receiver = None;
        }
        self.console_watch.store(false, Ordering::SeqCst);
        self.console_buffer.lock().clear();
        self.calibrating.store(false, Ordering::SeqCst);
        self.prop_testing.store(false, Ordering::SeqCst);
        self.prop_test_touched.store(false, Ordering::SeqCst);
        *self.transport.lock() = Some(Arc::clone(&transport));

        // Route USB reads into the parser and out to the subscribers.
        let inner = Arc::clone(&self.inner);
        let me_lost = Arc::clone(self);
        transport.start(
            move |bytes| {
                let packets = {
                    let mut g = inner.lock();
                    g.parser.feed(&bytes)
                };
                for packet in packets {
                    let listeners: Vec<Listener> =
                        inner.lock().listeners.iter().map(|(_, f)| Arc::clone(f)).collect();
                    for f in listeners {
                        f(&packet);
                    }
                }
            },
            move |_reason| me_lost.on_lost(),
        );

        self.start_hms_listener();
        self.emit_state();
        self.scan(&transport);
    }

    fn on_lost(&self) {
        *self.transport.lock() = None;
        {
            let mut g = self.inner.lock();
            g.state = DroneState::searching();
            g.listeners.clear();
        }
        self.emit_state();
    }

    fn scan(self: &Arc<Self>, transport: &BulkTransport) {
        self.set_status("scanning");
        self.inner.lock().state.scanning = true;
        self.emit_state();

        let found: Arc<Mutex<Vec<(u8, ModuleVersion)>>> = Arc::new(Mutex::new(Vec::new()));
        let targets: std::collections::HashMap<u8, &'static str> = SCAN_TARGETS
            .iter()
            .map(|(t, i, name)| (duml::module_info(*t, *i), *name))
            .collect();

        let found_cb = Arc::clone(&found);
        let targets_cb = targets.clone();
        let listener: Listener = Arc::new(move |packet: &duml::Packet| {
            if packet.cmd_set != duml::cmd_set::GENERAL
                || packet.cmd_id != CMD_VERSION_INQUIRY
                || packet.receiver_info != PC_INFO
            {
                return;
            }
            if let Some(name) = targets_cb.get(&packet.sender_info) {
                if let Some(version) = parse_version_reply(name, &packet.payload) {
                    let mut g = found_cb.lock();
                    if !g.iter().any(|(info, _)| *info == packet.sender_info) {
                        g.push((packet.sender_info, version));
                    }
                }
            }
        });
        let id = self.subscribe(listener);

        for (t, i, _) in SCAN_TARGETS {
            if self.transport.lock().is_none() {
                break;
            }
            let _ = self.send(transport, *t, *i, duml::cmd_set::GENERAL, CMD_VERSION_INQUIRY, Vec::new());
            std::thread::sleep(SCAN_SPACING);
        }
        std::thread::sleep(SCAN_WAIT);
        self.unsubscribe(id);

        // Publish modules in scan-target order and detect the model.
        let discovered = found.lock().clone();
        let mut modules: Vec<ModuleVersion> = Vec::new();
        let mut model: Option<&'static DroneModel> = None;
        for (t, i, _) in SCAN_TARGETS {
            let info = duml::module_info(*t, *i);
            if let Some((_, v)) = discovered.iter().find(|(x, _)| *x == info) {
                if model.is_none() {
                    model = match_model_code(&v.hardware);
                }
                modules.push(v.clone());
            }
        }

        let serial = model.and_then(|m| self.read_serial(transport, m));

        {
            let mut g = self.inner.lock();
            g.active_model = model;
            g.state.scanning = false;
            g.state.status = "connected".into();
            g.state.modules = modules;
            if let Some(m) = model {
                g.state.model = Some(m.name.to_string());
                g.state.model_code = Some(m.code.to_string());
            }
            if serial.is_some() {
                g.state.serial = serial;
            }
        }
        self.emit_state();

        // Read the firmware manifest (authoritative model + anti-rollback).
        self.read_config(transport);
    }

    fn encode_step(&self, step: &ServiceStep) -> Result<Vec<u8>, String> {
        Ok(self.encode_step_seq(step)?.0)
    }

    /// Encodes a step and returns the bytes together with the sequence number
    /// assigned to it, so a reply can be matched by sequence.
    fn encode_step_seq(&self, step: &ServiceStep) -> Result<(Vec<u8>, u16), String> {
        let seq = {
            let mut g = self.inner.lock();
            g.seq = g.seq.wrapping_add(1);
            g.seq
        };
        let pkt = duml::encode_packet(&PacketFields {
            sender_type: step.sender & 0x1f,
            sender_index: step.sender >> 5,
            receiver_type: step.receiver & 0x1f,
            receiver_index: step.receiver >> 5,
            seq_num: seq,
            packet_type: 0,
            ack_type: (step.ack_enc >> 5) & 3,
            encrypt_type: step.ack_enc & 7,
            cmd_set: step.cmd_set,
            cmd_id: step.cmd_id,
            payload: step.payload.clone(),
        })?;
        Ok((pkt, seq))
    }

    fn write_step(&self, transport: &BulkTransport, step: &ServiceStep) -> Result<(), String> {
        let pkt = self.encode_step(step)?;
        transport.write(&pkt)
    }

    /// Sends a step and waits up to `timeout_ms` for its matching reply.
    fn request_step(&self, transport: &BulkTransport, step: &ServiceStep, timeout_ms: u64) -> Option<Vec<u8>> {
        let slot: Arc<(Mutex<Option<Vec<u8>>>, Condvar)> = Arc::new((Mutex::new(None), Condvar::new()));
        let slot_cb = Arc::clone(&slot);
        let want_sender = step.receiver;
        let want_receiver = step.sender;
        let (cs, ci) = (step.cmd_set, step.cmd_id);
        let listener: Listener = Arc::new(move |p: &duml::Packet| {
            if p.cmd_set == cs && p.cmd_id == ci && p.sender_info == want_sender && p.receiver_info == want_receiver {
                let (m, cv) = &*slot_cb;
                let mut g = m.lock();
                if g.is_none() {
                    *g = Some(p.payload.clone());
                    cv.notify_all();
                }
            }
        });
        let id = self.subscribe(listener);
        if self.encode_step(step).and_then(|pkt| transport.write(&pkt)).is_err() {
            self.unsubscribe(id);
            return None;
        }
        let (m, cv) = &*slot;
        let mut g = m.lock();
        if g.is_none() {
            cv.wait_for(&mut g, Duration::from_millis(timeout_ms));
        }
        let out = g.clone();
        drop(g);
        self.unsubscribe(id);
        out
    }

    /// Runs a one-shot service command and returns the message for the UI.
    pub fn run_service(&self, action: &str) -> ServiceResult {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => {
                return ServiceResult {
                    action: action.into(),
                    ok: false,
                    message: "No aircraft connected.".into(),
                    details: vec![],
                }
            }
        };
        let steps = service::service_steps(action);
        if steps.is_empty() {
            return ServiceResult {
                action: action.into(),
                ok: false,
                message: "Unknown service action.".into(),
                details: vec![],
            };
        }
        let mut details: Vec<String> = Vec::new();
        let mut serials: Vec<String> = Vec::new();
        let mut replies = 0u32;
        for s in &steps {
            let reply = if s.expect_reply {
                self.request_step(&transport, s, 1500)
            } else {
                let _ = self.write_step(&transport, s);
                None
            };
            let name = service::receiver_label(s.receiver);
            if s.wait_after_ms > 0 {
                std::thread::sleep(Duration::from_millis(s.wait_after_ms));
            }
            if action == "vision-recover" {
                if s.cmd_set == 0x24 && s.cmd_id == 0x26 {
                    let sensor = service::VISION_SENSORS
                        .iter()
                        .find(|(m, _)| *m == service::vision_sensor_of(s))
                        .map(|(_, n)| *n)
                        .unwrap_or("Sensor");
                    let serial = reply.as_ref().and_then(|r| service::vision_sensor_serial(r));
                    if let Some(sr) = &serial {
                        serials.push(sr.clone());
                    }
                    let tail = serial.unwrap_or_else(|| {
                        if reply.is_some() { "no serial reported".into() } else { "no reply".into() }
                    });
                    details.push(format!("{sensor}: {tail}"));
                } else if s.cmd_set == 0x24 && reply.is_some() {
                    replies += 1;
                }
                continue;
            }
            match reply {
                Some(r) => {
                    replies += 1;
                    if action == "camera-serials" || action == "vision-scan" || action == "camera-info" {
                        if let Some(sn) = service::serial_from_reply(&r) {
                            serials.push(sn.clone());
                            details.push(format!("{name}: {sn}"));
                        } else {
                            details.push(format!("{name}: responded ({} bytes)", r.len()));
                        }
                    } else if action == "vision-cal" {
                        let code = r.first().copied().unwrap_or(0xff);
                        let tail = if code == 0 {
                            "calibrated".to_string()
                        } else {
                            format!("not calibrated (code 0x{code:x})")
                        };
                        details.push(format!("{name}: {tail}"));
                    } else if service::is_read_service(action) {
                        let hex = duml::to_hex(&r[..r.len().min(32)]);
                        details.push(format!("{name}: {} bytes [{hex}]", r.len()));
                    } else {
                        details.push(format!("{name}: acknowledged"));
                    }
                }
                None => details.push(format!("{name}: no reply")),
            }
        }
        for c in service::service_cleanup_steps(action) {
            let _ = self.write_step(&transport, &c);
        }
        interpret(action, replies, &serials, details)
    }

    /// Subscribes the persistent HMS listener for this connection.
    fn start_hms_listener(self: &Arc<Self>) {
        let inner = Arc::clone(&self.inner);
        let app = self.app.clone();
        let db = Arc::clone(&self.resolver);
        let listener: Listener = Arc::new(move |p: &duml::Packet| {
            let mut changed = false;
            if p.cmd_set == hms::HMS_CMD_SET && p.cmd_id == hms::HMS_CMD_ID {
                let faults = hms::decode_hms_push(&p.payload, &db);
                let mut g = inner.lock();
                g.hms_snapshot_received = true;
                for f in faults {
                    changed |= upsert_record(&mut g, f);
                }
            } else if p.cmd_set == hms::HMS_TELEMETRY_CMD_SET && p.cmd_id == hms::HMS_TELEMETRY_CMD_ID {
                if let Some(f) = hms::decode_hms_telemetry(&p.payload, &db) {
                    let mut g = inner.lock();
                    changed |= upsert_record(&mut g, f);
                }
            } else if p.cmd_set == hms::GIMBAL_SELFCHECK_CMD_SET
                && p.cmd_id == hms::GIMBAL_SELFCHECK_CMD_ID
                && p.sender_type == hms::GIMBAL_SENDER_TYPE
            {
                let mut g = inner.lock();
                changed = set_live(&mut g, "gimbal", hms::decode_gimbal_self_check(&p.payload));
            } else if p.cmd_set == hms::FC_STATUS_CMD_SET
                && p.cmd_id == hms::FC_STATUS_CMD_ID
                && p.sender_type == hms::FC_SENDER_TYPE
            {
                let gnss = hms::decode_gnss_status(&p.payload).map(|f| vec![f]).unwrap_or_default();
                let mut g = inner.lock();
                g.fc_status_frame = Some((p.payload.clone(), now_ms()));
                changed = set_live(&mut g, "gnss", gnss);
            } else {
                return;
            }
            if changed {
                publish_hms(&app, &inner);
            }
        });
        self.subscribe(listener);
    }

    /// Nudges the aircraft to report HMS, then publishes what accumulated.
    pub fn read_hms_now(&self) -> HmsReadResult {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return HmsReadResult { ok: false, count: 0, message: "No aircraft connected.".into() },
        };
        {
            let mut g = self.inner.lock();
            g.hms_snapshot_received = false;
            g.hms_records.clear();
            g.hms_live.clear();
        }
        let targets: [u8; 5] = [0x12, 0xc3, 0x01, 0x04, 0x02];
        let kick = |receiver: u8, cmd_set: u8, cmd_id: u8, payload: Vec<u8>| {
            let step = ServiceStep {
                sender: 0x2a,
                receiver,
                ack_enc: 0x40,
                cmd_set,
                cmd_id,
                payload,
                expect_reply: true,
                wait_after_ms: 0,
            };
            let _ = self.request_step(&transport, &step, 600);
        };
        for _ in 0..3 {
            if self.transport.lock().is_none() || self.inner.lock().hms_snapshot_received {
                break;
            }
            kick(0x02, 0x00, 0x52, vec![]);
            for r in targets {
                kick(r, hms::HMS_CMD_SET, 0x11, vec![]);
            }
            for r in targets.iter().chain(std::iter::once(&0xfd)) {
                kick(*r, hms::HMS_CMD_SET, 0x05, vec![0x01]);
            }
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(250));
                if self.inner.lock().hms_snapshot_received {
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
        publish_hms(&self.app, &self.inner);
        let count = { hms_faults_of(&self.inner.lock()).len() };
        HmsReadResult { ok: true, count, message: format!("{count} fault(s).") }
    }

    /// Forgets the stored records (live conditions stay).
    pub fn clear_hms(&self) {
        {
            let mut g = self.inner.lock();
            g.hms_records.clear();
            g.hms_snapshot_received = false;
        }
        publish_hms(&self.app, &self.inner);
    }

    fn param_request(&self, transport: &BulkTransport, step: params::Step, timeout_ms: u64) -> Option<Vec<u8>> {
        let (receiver, cmd_id, payload) = step;
        let s = ServiceStep {
            sender: 0x2a,
            receiver,
            ack_enc: 0x40,
            cmd_set: params::FLYC,
            cmd_id,
            payload,
            expect_reply: true,
            wait_after_ms: 0,
        };
        self.request_step(transport, &s, timeout_ms)
    }

    fn emit_param_progress(&self, phase: &str, done: usize, total: usize) {
        let _ = self.app.emit("drone:param-progress", ParamProgress { phase: phase.into(), done, total });
    }

    pub fn cancel_read_params(&self) {
        self.param_read_active.store(false, Ordering::SeqCst);
    }

    /// Reads the whole flight-controller parameter table by index.
    pub fn read_all_params(&self) -> ParamScanResult {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => {
                return ParamScanResult { ok: false, count: None, table_raw: None, entries: vec![], error: Some("No aircraft connected.".into()) }
            }
        };
        self.param_read_active.store(true, Ordering::SeqCst);
        let table_reply = self.param_request(&transport, params::table_info_step(), 1500);
        let table = table_reply.as_ref().and_then(|r| params::parse_table_info(r));
        let table_raw = table_reply.as_ref().map(|r| duml::to_hex(r));
        const HARD_CAP: u32 = 4096;
        let (total, bounded) = match &table {
            Some(t) if t.count > 0 => (t.count.min(HARD_CAP), true),
            _ => (HARD_CAP, false),
        };
        let mut entries: Vec<ParamEntry> = Vec::new();
        let mut consecutive_empty = 0u32;
        let mut replied = 0u32;
        let mut last_raw: Option<String> = None;
        self.emit_param_progress("reading", 0, if bounded { total as usize } else { 0 });
        let mut index = 0u32;
        while index < total {
            if !self.param_read_active.load(Ordering::Relaxed) || self.transport.lock().is_none() {
                break;
            }
            match self.param_request(&transport, params::info_by_index_step(index as u16), 500) {
                None => {
                    consecutive_empty += 1;
                    if consecutive_empty >= if bounded { 48 } else { 16 } {
                        break;
                    }
                }
                Some(reply) => {
                    consecutive_empty = 0;
                    replied += 1;
                    let raw = duml::to_hex(&reply[..reply.len().min(48)]);
                    last_raw = Some(raw.clone());
                    if let Some(info) = params::parse_param_info(&reply) {
                        let mut current = info.value;
                        if let Some(vr) = self.param_request(&transport, params::read_by_index_step(index as u16), 500) {
                            if let Some(parsed) = params::parse_value_by_index(&vr) {
                                if !parsed.value.is_empty() {
                                    current = params::decode_param_value(&parsed.value, info.type_id);
                                }
                            }
                        }
                        entries.push(ParamEntry {
                            index: info.index,
                            name: info.name,
                            value: current,
                            default: info.value,
                            size: info.size,
                            min: info.min,
                            max: info.max,
                            type_id: info.type_id,
                            type_name: info.type_name,
                            ok: true,
                            raw,
                        });
                        if index % 8 == 0 || index == total - 1 {
                            self.emit_param_progress("reading", entries.len(), if bounded { total as usize } else { 0 });
                        }
                    }
                }
            }
            index += 1;
        }
        self.param_read_active.store(false, Ordering::SeqCst);
        self.emit_param_progress("done", entries.len(), entries.len());
        let error = if entries.is_empty() {
            Some(if replied > 0 {
                format!("Aircraft replied to {replied} index queries but none parsed. Last reply: {}", last_raw.unwrap_or_else(|| "(none)".into()))
            } else {
                "The aircraft did not answer any index query (it may use hash-only parameter access).".into()
            })
        } else {
            None
        };
        ParamScanResult { ok: true, count: table.map(|t| t.count), table_raw, entries, error }
    }

    /// Writes one parameter by index, then confirms by reading the live value.
    pub fn write_param(&self, name: String, index: u16, value: f64, size: u16, type_id: u16) -> ParamWriteResult {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return ParamWriteResult { ok: false, message: "No aircraft connected.".into() },
        };
        if !value.is_finite() {
            return ParamWriteResult { ok: false, message: "Enter a numeric value.".into() };
        }
        let is_float = type_id == 8 || type_id == 9;
        let tolerance = if is_float { 1e-3 } else { 0.5 };
        let target = if is_float { value } else { value.trunc() };
        let bytes = params::encode_param_value(value, size, type_id);

        let _unlock = self.param_request(&transport, params::write_unlock_step(), 500);
        let (recv, cmd, payload) = params::write_by_index_step(index, &bytes);
        let write_reply = self.param_request(&transport, (recv, cmd, payload.clone()), 500);
        let after = self
            .param_request(&transport, params::read_by_index_step(index), 500)
            .and_then(|r| params::parse_value_by_index(&r))
            .filter(|p| !p.value.is_empty())
            .map(|p| params::decode_param_value(&p.value, type_id));
        let echo_ok = write_reply.as_ref().map(|w| *w == payload).unwrap_or(false);
        let matches = after.map(|v| (v - target).abs() <= tolerance).unwrap_or(false);
        if matches || echo_ok {
            ParamWriteResult { ok: true, message: format!("Saved {name} = {target}.") }
        } else {
            ParamWriteResult {
                ok: false,
                message: format!("Write not confirmed for {name}. The aircraft did not accept the new value."),
            }
        }
    }

    fn read_serial(&self, transport: &BulkTransport, model: &DroneModel) -> Option<String> {
        let receiver_type = model.serial_receiver & 0x1f;
        let receiver_index = model.serial_receiver >> 5;
        let reply: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let reply_cb = Arc::clone(&reply);
        let want = model.serial_receiver;
        let listener: Listener = Arc::new(move |packet: &duml::Packet| {
            if packet.cmd_set == duml::cmd_set::GENERAL
                && packet.cmd_id == CMD_GET_SERIAL
                && packet.sender_info == want
                && packet.receiver_info == PC_INFO
            {
                if let Some(s) = extract_serial(&packet.payload) {
                    *reply_cb.lock() = Some(s);
                }
            }
        });
        let id = self.subscribe(listener);
        for _ in 0..3 {
            let _ = self.send(
                transport,
                receiver_type,
                receiver_index,
                duml::cmd_set::GENERAL,
                CMD_GET_SERIAL,
                vec![model.serial_payload],
            );
            std::thread::sleep(Duration::from_millis(350));
            if reply.lock().is_some() {
                break;
            }
        }
        self.unsubscribe(id);
        let out = reply.lock().clone();
        out
    }

    /// Reads the smart battery: four fire-and-forget requests, then collects the
    /// battery's replies for ~900 ms and folds them into one snapshot.
    pub fn read_battery(&self) -> BatteryReading {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => {
                return BatteryReading {
                    ok: false,
                    message: Some("No aircraft connected.".into()),
                    at: now_ms(),
                    battery: BatterySnapshot::default(),
                }
            }
        };
        let snapshot: Arc<Mutex<BatterySnapshot>> = Arc::new(Mutex::new(BatterySnapshot::default()));
        let got_any = Arc::new(AtomicBool::new(false));
        let snap_cb = Arc::clone(&snapshot);
        let got_cb = Arc::clone(&got_any);
        let listener: Listener = Arc::new(move |p: &duml::Packet| {
            if p.cmd_set == battery::BATTERY_CMD_SET
                && p.sender_type == battery::BATTERY_SENDER_TYPE
                && (battery::BATTERY_CMD_STATIC..=battery::BATTERY_CMD_SERIAL).contains(&p.cmd_id)
            {
                let mut g = snap_cb.lock();
                if battery::apply_battery_reply(&mut g, p.cmd_id, &p.payload) {
                    got_cb.store(true, Ordering::SeqCst);
                }
            }
        });
        let id = self.subscribe(listener);
        for (receiver, cmd_set, cmd_id, payload) in battery::battery_request_steps() {
            if self.transport.lock().is_none() {
                break;
            }
            let _ = self.send(&transport, receiver & 0x1f, receiver >> 5, cmd_set, cmd_id, payload);
            std::thread::sleep(Duration::from_millis(40));
        }
        std::thread::sleep(Duration::from_millis(750));
        self.unsubscribe(id);
        let battery = snapshot.lock().clone();
        let ok = got_any.load(Ordering::SeqCst);
        BatteryReading {
            ok,
            message: if ok { None } else { Some("The battery did not respond.".into()) },
            at: now_ms(),
            battery,
        }
    }

    /// Decodes the most recent flight-controller status frame, if any has been
    /// pushed on this connection.
    pub fn get_telemetry(&self) -> TelemetryReading {
        let frame = self.inner.lock().fc_status_frame.clone();
        match frame {
            Some((payload, at)) => TelemetryReading {
                status: telemetry::decode_fc_status(&payload),
                at: Some(at),
            },
            None => TelemetryReading { status: None, at: None },
        }
    }

    // ── Shared helpers for monitored runs ────────────────────────────────────

    fn send_with_ack(
        &self,
        transport: &BulkTransport,
        receiver_type: u8,
        receiver_index: u8,
        ack_type: u8,
        cmd_set: u8,
        cmd_id: u8,
        payload: Vec<u8>,
    ) -> Result<(), String> {
        let seq = {
            let mut g = self.inner.lock();
            g.seq = g.seq.wrapping_add(1);
            g.seq
        };
        let pkt = duml::encode_packet(&PacketFields {
            sender_type: dev::PC,
            sender_index: 0,
            receiver_type,
            receiver_index,
            seq_num: seq,
            packet_type: 0,
            ack_type,
            encrypt_type: 0,
            cmd_set,
            cmd_id,
            payload,
        })?;
        transport.write(&pkt)
    }

    fn transport_is(&self, t: &Arc<BulkTransport>) -> bool {
        self.transport.lock().as_ref().map(|cur| Arc::ptr_eq(cur, t)).unwrap_or(false)
    }

    fn model_code(&self) -> Option<String> {
        self.inner.lock().state.model_code.clone()
    }

    fn model_name(&self) -> Option<String> {
        self.inner.lock().state.model.clone()
    }

    /// Subscribes a queue fed by packets matching `filter`.
    fn subscribe_queue<F>(&self, filter: F) -> (PacketQueue, u64)
    where
        F: Fn(&duml::Packet) -> bool + Send + Sync + 'static,
    {
        let q: PacketQueue = Arc::new((Mutex::new(VecDeque::new()), Condvar::new()));
        let qc = Arc::clone(&q);
        let listener: Listener = Arc::new(move |p: &duml::Packet| {
            if filter(p) {
                let (m, cv) = &*qc;
                m.lock().push_back(p.clone());
                cv.notify_all();
            }
        });
        let id = self.subscribe(listener);
        (q, id)
    }

    fn set_calibration(&self, cal: &CalibrationState) {
        self.inner.lock().state.calibration = Some(cal.clone());
        self.emit_state();
    }

    fn set_imu_calibration(&self, cal: &ImuCalibrationState) {
        self.inner.lock().state.imu_calibration = Some(cal.clone());
        self.emit_state();
    }

    // ── Gimbal calibration (simple + advanced) ───────────────────────────────

    /// Blocking checks, then spawns the chosen calibration run. Returns the
    /// reason it cannot start, if any.
    pub fn start_calibration(self: &Arc<Self>, kind: String, allow_restricted: bool) -> Result<(), String> {
        if self.transport.lock().is_none() {
            return Err("No drone connected.".into());
        }
        if self.calibrating.load(Ordering::SeqCst) {
            return Err("A calibration is already running.".into());
        }
        let transport = self.transport.lock().clone().ok_or("No drone connected.")?;
        if kind == "advanced" {
            if self.flashing.load(Ordering::SeqCst) {
                return Err("A firmware flash is in progress.".into());
            }
            let choice = gimbal_cal::plan_advanced_calibration(
                self.model_code().as_deref(),
                self.model_name().as_deref(),
                allow_restricted,
            );
            let plan = choice.plan.ok_or(choice.reason.unwrap_or_else(|| "Advanced calibration is not available for this aircraft.".into()))?;
            let me = Arc::clone(self);
            std::thread::spawn(move || me.run_advanced_calibration(transport, plan));
            return Ok(());
        }
        let spec = gimbal_cal::calibration_spec(&kind).ok_or_else(|| format!("Unknown calibration: {kind}"))?;
        let me = Arc::clone(self);
        std::thread::spawn(move || me.run_calibration_simple(transport, spec));
        Ok(())
    }

    fn run_calibration_simple(self: Arc<Self>, transport: Arc<BulkTransport>, spec: gimbal_cal::CalibrationSpec) {
        self.calibrating.store(true, Ordering::SeqCst);
        let mut cal = CalibrationState {
            kind: spec.kind.to_string(),
            phase: "running".into(),
            started_at: now_ms(),
            finished_at: None,
            expect_ms: spec.expect_ms,
            reports: 0,
            last_report: None,
            progress: None,
            message: "Sending calibration request…".into(),
        };
        self.set_calibration(&cal);
        let gimbal_info = duml::module_info(dev::GIMBAL, 0);
        let (queue, id) = self.subscribe_queue(move |p| {
            p.cmd_set == ZENMUSE
                && (p.cmd_id == CMD_GIMBAL_CALIBRATION || p.cmd_id == CMD_GIMBAL_CALIBRATION_PROGRESS)
                && p.sender_info == gimbal_info
                && p.receiver_info == PC_INFO
        });

        let finish = |me: &Session, cal: &mut CalibrationState, phase: &str, msg: &str| {
            cal.phase = phase.into();
            cal.message = msg.into();
            cal.finished_at = Some(now_ms());
            me.set_calibration(cal);
        };

        // Deliver the request and wait for the gimbal's first answer.
        let mut reply: Option<duml::Packet> = None;
        for _ in 0..3 {
            if reply.is_some() {
                break;
            }
            let _ = self.send_with_ack(&transport, dev::GIMBAL, 0, duml::ack::ACK_BEFORE_EXEC, ZENMUSE, CMD_GIMBAL_CALIBRATION, vec![spec.command]);
            let deadline = now_ms() + 1000;
            while reply.is_none() && now_ms() < deadline {
                if let Some(p) = next_report(&queue, deadline.saturating_sub(now_ms())) {
                    if p.cmd_id == CMD_GIMBAL_CALIBRATION {
                        reply = Some(p);
                    }
                }
            }
        }
        let reply = match reply {
            Some(r) => r,
            None => {
                finish(&self, &mut cal, "failed", "The gimbal did not respond to the calibration request.");
                self.unsubscribe(id);
                self.calibrating.store(false, Ordering::SeqCst);
                return;
            }
        };
        cal.message = "Calibration started; the gimbal is moving. Do not touch the drone.".into();
        self.set_calibration(&cal);

        let is_success = |p: &duml::Packet| -> bool {
            if p.cmd_id == CMD_GIMBAL_CALIBRATION_PROGRESS {
                p.payload.first() == Some(&0x64) && p.payload.get(1) == Some(&0x00)
            } else {
                p.payload.first() == Some(&spec.pass[0]) && p.payload.get(1) == Some(&spec.pass[1])
            }
        };

        let mut report: Option<duml::Packet> = if reply.payload.len() >= 2 { Some(reply) } else { None };
        let start = now_ms();
        let mut last_report = start;
        loop {
            let now = now_ms();
            if let Some(r) = &report {
                if r.payload.len() >= 2 {
                    last_report = now;
                    cal.reports += 1;
                    cal.last_report = Some(duml::to_hex(&r.payload[..2]));
                    self.set_calibration(&cal);
                    if is_success(r) {
                        finish(&self, &mut cal, "pass", "Concluding report received; calibration finished.");
                        break;
                    }
                }
            }
            if !self.transport_is(&transport) {
                finish(&self, &mut cal, "unsure", "Connection lost while calibrating; completion unconfirmed.");
                break;
            }
            if now - start > spec.max_ms {
                finish(&self, &mut cal, "unsure", "Monitoring timed out; completion unconfirmed.");
                break;
            }
            if now - last_report > spec.stall_ms {
                finish(&self, &mut cal, "unsure", "Progress reports stopped; completion unconfirmed.");
                break;
            }
            report = next_report(&queue, 500);
        }
        self.unsubscribe(id);
        self.calibrating.store(false, Ordering::SeqCst);
    }

    fn run_advanced_calibration(self: Arc<Self>, transport: Arc<BulkTransport>, plan: AdvancedCalibrationPlan) {
        self.calibrating.store(true, Ordering::SeqCst);
        let mut cal = CalibrationState {
            kind: "advanced".into(),
            phase: "running".into(),
            started_at: now_ms(),
            finished_at: None,
            expect_ms: plan.expect_ms,
            reports: 0,
            last_report: None,
            progress: None,
            message: "Preparing the aircraft…".into(),
        };
        self.set_calibration(&cal);
        let mut factory_mode_on = false;
        let enterprise = plan.variant == gimbal_cal::AdvancedVariant::Enterprise;

        let finish = |me: &Session, cal: &mut CalibrationState, factory_on: bool, phase: &str, msg: &str| {
            cal.phase = phase.into();
            cal.message = if !factory_on {
                msg.to_string()
            } else if enterprise {
                format!("{msg} The aircraft is still in factory mode.")
            } else {
                format!("{msg} The aircraft is still in factory mode; leave it with Exit factory mode on the Service page when you are done.")
            };
            cal.finished_at = Some(now_ms());
            me.set_calibration(cal);
        };

        let (queue, id) = self.subscribe_queue(move |p| {
            p.cmd_set == ZENMUSE
                && (p.cmd_id == CMD_GIMBAL_CALIBRATION || p.cmd_id == CMD_GIMBAL_CALIBRATION_PROGRESS)
                && p.sender_type == dev::GIMBAL
        });

        // apply one report; mutates cal and publishes.
        let apply = |me: &Session, cal: &mut CalibrationState, factory_on: bool, p: &duml::Packet| -> Flow {
            let first = match p.payload.first() {
                Some(&b) => b,
                None => return Flow::Continue,
            };
            if p.cmd_id == CMD_GIMBAL_CALIBRATION {
                if first == 0 || first == 1 || first == 3 {
                    return Flow::Continue;
                }
                finish(me, cal, factory_on, "failed", &format!("The gimbal refused the calibration (code 0x{first:02x})."));
                return Flow::Error;
            }
            let flag = p.payload.get(1).copied().unwrap_or(0);
            let point_up = plan.asks_point_up && flag == 2 && first < 100;
            cal.reports += 1;
            cal.last_report = Some(duml::to_hex(&p.payload[..p.payload.len().min(2)]));
            cal.progress = Some(first.min(100) as u32);
            cal.message = if point_up {
                "Point the drone up toward the ceiling and hold it still.".into()
            } else {
                "Calibrating; the gimbal is moving. Do not touch the drone.".into()
            };
            me.set_calibration(cal);
            if first >= 100 {
                finish(me, cal, factory_on, "pass", "The gimbal reported 100%; calibration finished.");
                return Flow::Done;
            }
            Flow::Continue
        };

        let mut run = || {
            for prepare in &plan.prepare {
                let _ = self.write_step(&transport, prepare);
                factory_mode_on = factory_mode_on || gimbal_cal::enters_factory_mode(&plan);
                std::thread::sleep(Duration::from_millis(60));
            }
            if plan.pause_ms > 0 {
                std::thread::sleep(Duration::from_millis(plan.pause_ms));
            }
            cal.message = "Calibration command sent; waiting for the gimbal to answer…".into();
            self.set_calibration(&cal);
            let _ = self.write_step(&transport, &plan.trigger);

            let ack_deadline = now_ms() + plan.ack_timeout_ms;
            let mut answered = false;
            while !answered && now_ms() < ack_deadline {
                if !self.transport_is(&transport) {
                    finish(&self, &mut cal, factory_mode_on, "unsure", "Connection lost before the gimbal answered.");
                    return;
                }
                if let Some(p) = next_report(&queue, 500.min(ack_deadline.saturating_sub(now_ms()))) {
                    answered = true;
                    if apply(&self, &mut cal, factory_mode_on, &p) != Flow::Continue {
                        return;
                    }
                }
            }
            if !answered {
                finish(&self, &mut cal, factory_mode_on, "failed", "The gimbal did not answer; the calibration may not have started.");
                return;
            }
            if cal.progress.is_none() {
                cal.message = "Calibration started; waiting for progress. Keep the drone still and level.".into();
                self.set_calibration(&cal);
            }
            let max_ms = (plan.expect_ms * 3).max(300000);
            let stall_ms = 120000u64;
            let start = now_ms();
            let mut last_report = start;
            loop {
                let now = now_ms();
                if !self.transport_is(&transport) {
                    finish(&self, &mut cal, factory_mode_on, "unsure", "Connection lost while calibrating; completion unconfirmed.");
                    return;
                }
                if now - start > max_ms {
                    finish(&self, &mut cal, factory_mode_on, "unsure", "Monitoring timed out; completion unconfirmed.");
                    return;
                }
                if now - last_report > stall_ms {
                    finish(&self, &mut cal, factory_mode_on, "unsure", "Progress reports stopped; completion unconfirmed.");
                    return;
                }
                if let Some(p) = next_report(&queue, 500) {
                    last_report = now_ms();
                    if apply(&self, &mut cal, factory_mode_on, &p) != Flow::Continue {
                        return;
                    }
                }
            }
        };
        run();
        self.unsubscribe(id);
        self.calibrating.store(false, Ordering::SeqCst);
    }

    // ── IMU calibration ──────────────────────────────────────────────────────

    pub fn start_imu_calibration(self: &Arc<Self>) -> Result<(), String> {
        if self.transport.lock().is_none() {
            return Err("No drone connected.".into());
        }
        if self.calibrating.load(Ordering::SeqCst) {
            return Err("A calibration is already running.".into());
        }
        if self.flashing.load(Ordering::SeqCst) {
            return Err("A firmware flash is in progress.".into());
        }
        if self.prop_testing.load(Ordering::SeqCst) {
            return Err("A motor test is running.".into());
        }
        let choice = imu_cal::plan_imu_calibration(self.model_code().as_deref(), self.model_name().as_deref());
        let plan = choice.plan.ok_or(choice.reason.unwrap_or_else(|| "IMU calibration is not available for this aircraft.".into()))?;
        let transport = self.transport.lock().clone().ok_or("No drone connected.")?;
        let me = Arc::clone(self);
        std::thread::spawn(move || me.run_imu_calibration(transport, plan));
        Ok(())
    }

    pub fn stop_imu_calibration(&self) {
        let running = self
            .inner
            .lock()
            .state
            .imu_calibration
            .as_ref()
            .map(|c| c.phase == "running")
            .unwrap_or(false);
        if running {
            self.imu_stop.store(true, Ordering::SeqCst);
        }
    }

    fn run_imu_calibration(self: Arc<Self>, transport: Arc<BulkTransport>, plan: ImuCalibrationPlan) {
        self.calibrating.store(true, Ordering::SeqCst);
        self.imu_stop.store(false, Ordering::SeqCst);
        let mut run = ImuCalibrationState {
            phase: "running".into(),
            started_at: now_ms(),
            finished_at: None,
            progress: None,
            position: None,
            done: Vec::new(),
            reports: 0,
            message: "Preparing the aircraft…".into(),
        };
        self.set_imu_calibration(&run);

        let (queue, id) = self.subscribe_queue(move |p| {
            p.cmd_set == ZENMUSE
                && (p.cmd_id == CMD_GIMBAL_CALIBRATION || p.cmd_id == CMD_GIMBAL_CALIBRATION_PROGRESS)
                && p.sender_type == dev::GIMBAL
        });

        let finish = |me: &Session, run: &mut ImuCalibrationState, phase: &str, msg: &str| {
            run.phase = phase.into();
            run.message = msg.into();
            run.finished_at = Some(now_ms());
            me.set_imu_calibration(run);
        };

        let apply = |me: &Session, run: &mut ImuCalibrationState, p: &duml::Packet| -> Flow {
            if p.cmd_id == CMD_GIMBAL_CALIBRATION {
                let code = p.payload.first().copied();
                if matches!(code, None | Some(0) | Some(1) | Some(3)) {
                    return Flow::Continue;
                }
                let c = code.unwrap();
                finish(me, run, "failed", &format!("The aircraft refused the calibration (code 0x{c:02x})."));
                return Flow::Error;
            }
            let progress = match imu_cal::parse_imu_progress(&p.payload) {
                Some(pr) => pr,
                None => return Flow::Continue,
            };
            if progress.percent >= 100 {
                run.reports += 1;
                run.progress = Some(100);
                run.done = IMU_POSITIONS.iter().map(|p| p.id).collect();
                finish(me, run, "pass", "The aircraft reported 100%; calibration finished. Power-cycle the aircraft.");
                return Flow::Done;
            }
            let position = progress.position;
            run.reports += 1;
            run.progress = Some(progress.percent as u32);
            run.position = position;
            if let Some(pos) = position {
                if progress.percent > 0 {
                    run.done = IMU_POSITIONS.iter().filter(|p| p.id < pos).map(|p| p.id).collect();
                }
            }
            run.message = match position.and_then(|pos| IMU_POSITIONS.iter().find(|p| p.id == pos)) {
                Some(asked) => format!(
                    "Position {} of {}: {}. Hold the aircraft still until the next position is asked for.",
                    asked.id + 1,
                    IMU_POSITIONS.len(),
                    asked.label
                ),
                None => "Calibrating; keep the aircraft still.".into(),
            };
            me.set_imu_calibration(run);
            Flow::Continue
        };

        let stopped = |me: &Session, run: &mut ImuCalibrationState| -> bool {
            if !me.imu_stop.load(Ordering::SeqCst) {
                return false;
            }
            finish(me, run, "stopped", "Stopped, and factory mode was left. Power-cycle the aircraft before using it.");
            true
        };

        let mut body = || {
            for prepare in &plan.prepare {
                let _ = self.write_step(&transport, prepare);
                std::thread::sleep(Duration::from_millis(60));
            }
            std::thread::sleep(Duration::from_millis(plan.pause_ms));
            if stopped(&self, &mut run) {
                return;
            }
            run.message = "Calibration request sent; waiting for the aircraft to answer…".into();
            self.set_imu_calibration(&run);
            let _ = self.write_step(&transport, &plan.trigger);

            let ack_deadline = now_ms() + plan.ack_timeout_ms;
            let mut answered = false;
            while !answered {
                if !self.transport_is(&transport) {
                    finish(&self, &mut run, "unsure", "Connection lost before the aircraft answered.");
                    return;
                }
                if stopped(&self, &mut run) {
                    return;
                }
                if now_ms() >= ack_deadline {
                    finish(&self, &mut run, "failed", "The aircraft did not answer; the calibration did not start.");
                    return;
                }
                if let Some(p) = next_report(&queue, 500.min(ack_deadline.saturating_sub(now_ms()))) {
                    answered = true;
                    if apply(&self, &mut run, &p) != Flow::Continue {
                        return;
                    }
                }
            }
            if run.progress.is_none() {
                run.message = "Request accepted; waiting for the first position. Keep the aircraft level and still.".into();
                self.set_imu_calibration(&run);
            }
            let first_progress_ms = 30000u64;
            let stall_ms = 180000u64;
            let max_ms = 20 * 60000u64;
            let start = now_ms();
            let mut last_report = start;
            loop {
                let now = now_ms();
                if !self.transport_is(&transport) {
                    finish(&self, &mut run, "unsure", "Connection lost while calibrating; completion unconfirmed.");
                    return;
                }
                if stopped(&self, &mut run) {
                    return;
                }
                if run.progress.is_none() && now - start > first_progress_ms {
                    finish(&self, &mut run, "unsure", "The aircraft accepted the request but reported no progress.");
                    return;
                }
                if now - last_report > stall_ms {
                    finish(&self, &mut run, "unsure", "Progress reports stopped; completion unconfirmed.");
                    return;
                }
                if now - start > max_ms {
                    finish(&self, &mut run, "unsure", "Monitoring timed out; completion unconfirmed.");
                    return;
                }
                if let Some(p) = next_report(&queue, 500) {
                    if p.cmd_id == CMD_GIMBAL_CALIBRATION_PROGRESS {
                        last_report = now_ms();
                    }
                    if apply(&self, &mut run, &p) != Flow::Continue {
                        return;
                    }
                }
            }
        };
        body();
        self.unsubscribe(id);
        if self.transport_is(&transport) {
            for cleanup in &plan.cleanup {
                let _ = self.write_step(&transport, cleanup);
                std::thread::sleep(Duration::from_millis(60));
            }
        }
        self.imu_stop.store(false, Ordering::SeqCst);
        self.calibrating.store(false, Ordering::SeqCst);
    }

    // ── Motor tests: shared ──────────────────────────────────────────────────

    fn motor_test_block(&self) -> Option<String> {
        if self.transport.lock().is_none() {
            return Some("No aircraft connected.".into());
        }
        if self.flashing.load(Ordering::SeqCst) {
            return Some("A firmware flash is in progress.".into());
        }
        if self.calibrating.load(Ordering::SeqCst) {
            return Some("A calibration is running.".into());
        }
        None
    }

    fn emit_prop_test(&self, event: PropTestEvent) {
        let _ = self.app.emit("drone:prop-test", event);
    }

    // ── Gimbal motor test ────────────────────────────────────────────────────

    fn gimbal_test_send<F>(&self, allow_untested: bool, build: F) -> MotorTestResult
    where
        F: FnOnce(motor_test::GimbalLimits) -> ServiceStep,
    {
        if let Some(block) = self.motor_test_block() {
            return MotorTestResult { ok: false, message: block, acks: None };
        }
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None },
        };
        let support = motor_test::gimbal_test_support(self.model_code().as_deref());
        if !support.validated && !allow_untested {
            return MotorTestResult { ok: false, message: "The gimbal motor test has not been validated on this aircraft.".into(), acks: None };
        }
        if self.inner.lock().gimbal_test_listener.is_none() {
            let inner = Arc::clone(&self.inner);
            let listener: Listener = Arc::new(move |p: &duml::Packet| {
                if p.sender_type == dev::GIMBAL && p.cmd_set == 0x04 && (p.cmd_id == 0x14 || p.cmd_id == 0x1e) {
                    inner.lock().gimbal_test_acks += 1;
                }
            });
            let id = self.subscribe(listener);
            self.inner.lock().gimbal_test_listener = Some(id);
        }
        if !self.inner.lock().gimbal_test_enabled {
            self.inner.lock().gimbal_test_enabled = true;
            if let Err(e) = self.write_step(&transport, &motor_test::gimbal_enable_step()) {
                self.inner.lock().gimbal_test_enabled = false;
                return MotorTestResult { ok: false, message: e, acks: None };
            }
        }
        match self.write_step(&transport, &build(support.limits)) {
            Ok(()) => MotorTestResult { ok: true, message: String::new(), acks: Some(self.inner.lock().gimbal_test_acks) },
            Err(e) => MotorTestResult { ok: false, message: e, acks: None },
        }
    }

    pub fn gimbal_test_move(&self, axis: Option<String>, target: GimbalAngles, seconds: f64, allow_untested: bool) -> MotorTestResult {
        let axis = match axis {
            None => None,
            Some(a) => match GimbalAxis::from_str(&a) {
                Some(x) => Some(x),
                None => return MotorTestResult { ok: false, message: "Unknown gimbal axis.".into(), acks: None },
            },
        };
        self.gimbal_test_send(allow_untested, move |limits| {
            let bound = |axis, v: f64| {
                let l = limits.for_axis(axis);
                let v = if v.is_finite() { v } else { 0.0 };
                v.max(l.min).min(l.max)
            };
            let bounded = GimbalAngles {
                pitch: bound(GimbalAxis::Pitch, target.pitch),
                roll: bound(GimbalAxis::Roll, target.roll),
                yaw: bound(GimbalAxis::Yaw, target.yaw),
            };
            motor_test::gimbal_absolute_step(axis, bounded, if seconds.is_finite() { seconds } else { 1.0 })
        })
    }

    pub fn gimbal_test_jog(&self, axis: String, delta: f64, seconds: f64, allow_untested: bool) -> MotorTestResult {
        let axis = match GimbalAxis::from_str(&axis) {
            Some(x) => x,
            None => return MotorTestResult { ok: false, message: "Unknown gimbal axis.".into(), acks: None },
        };
        let bounded = (if delta.is_finite() { delta } else { 0.0 }).clamp(-motor_test::GIMBAL_JOG_RATE, motor_test::GIMBAL_JOG_RATE);
        self.gimbal_test_send(allow_untested, move |_| {
            motor_test::gimbal_relative_step(axis, bounded, if seconds.is_finite() { seconds } else { 0.1 })
        })
    }

    pub fn gimbal_test_stop(&self) -> MotorTestResult {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None },
        };
        if !self.inner.lock().gimbal_test_enabled {
            return MotorTestResult { ok: true, message: "Nothing to stop.".into(), acks: Some(self.inner.lock().gimbal_test_acks) };
        }
        for axis in [GimbalAxis::Pitch, GimbalAxis::Roll, GimbalAxis::Yaw] {
            if let Err(e) = self.write_step(&transport, &motor_test::gimbal_relative_step(axis, 0.0, 0.1)) {
                return MotorTestResult { ok: false, message: e, acks: None };
            }
        }
        MotorTestResult { ok: true, message: "All gimbal axes held.".into(), acks: Some(self.inner.lock().gimbal_test_acks) }
    }

    // ── Propeller motor test ─────────────────────────────────────────────────

    fn prop_request(&self, transport: &BulkTransport, step: &ServiceStep, timeout_ms: u64) -> Option<Vec<u8>> {
        let (pkt, seq) = self.encode_step_seq(step).ok()?;
        let slot: Arc<(Mutex<Option<Vec<u8>>>, Condvar)> = Arc::new((Mutex::new(None), Condvar::new()));
        let slot_cb = Arc::clone(&slot);
        let want = step.receiver;
        let (cs, ci) = (step.cmd_set, step.cmd_id);
        let listener: Listener = Arc::new(move |p: &duml::Packet| {
            if p.sender_info == want && p.cmd_set == cs && p.cmd_id == ci && p.seq_num == seq {
                let (m, cv) = &*slot_cb;
                let mut g = m.lock();
                if g.is_none() {
                    *g = Some(p.payload.clone());
                    cv.notify_all();
                }
            }
        });
        let id = self.subscribe(listener);
        if transport.write(&pkt).is_err() {
            self.unsubscribe(id);
            return None;
        }
        let (m, cv) = &*slot;
        let mut g = m.lock();
        if g.is_none() {
            cv.wait_for(&mut g, Duration::from_millis(timeout_ms));
        }
        let out = g.clone();
        drop(g);
        self.unsubscribe(id);
        out
    }

    fn prop_write(&self, transport: &BulkTransport, hash: &[u8], value: u32, width: u8) -> bool {
        let step = motor_test::prop_write_step(hash, value, width);
        let reply = self.prop_request(transport, &step, 1200);
        motor_test::prop_write_accepted(reply.as_deref(), value, width)
    }

    fn prop_restore_defaults(&self, transport: &BulkTransport) {
        self.prop_write(transport, &motor_test::PROP_PARAM_TIMER, 1, 2);
        self.prop_write(transport, &motor_test::PROP_PARAM_OUTPUT, motor_test::PROP_DEFAULT_OUTPUT, 2);
        self.prop_write(transport, &motor_test::PROP_PARAM_TIMER, motor_test::PROP_DEFAULT_TIMER, 2);
    }

    fn prop_factory(&self, transport: &BulkTransport, open: bool) {
        for step in motor_test::prop_factory_steps(open) {
            let _ = self.write_step(transport, &step);
        }
        std::thread::sleep(Duration::from_millis(motor_test::PROP_FACTORY_SETTLE_MS));
        self.inner.lock().prop_factory_open = open;
    }

    fn prop_wait(&self, transport: &Arc<BulkTransport>, ends_at: u64) {
        while !self.prop_stop.load(Ordering::SeqCst) && self.transport_is(transport) && now_ms() < ends_at {
            std::thread::sleep(Duration::from_millis(100.min(ends_at.saturating_sub(now_ms()))));
        }
    }

    /// Catalog method. Returns the reason the motor was not run, or None.
    fn prop_spin_catalog(&self, transport: &Arc<BulkTransport>, motor: motor_test::PropMotor, percent: f64, seconds: f64) -> Option<String> {
        let accepted = self.prop_write(transport, &motor_test::PROP_PARAM_TIMER, 1, 2)
            && self.prop_write(transport, &motor_test::PROP_PARAM_OUTPUT, (percent * 100.0).round() as u32, 2)
            && self.prop_write(transport, &motor_test::PROP_PARAM_TIMER, ((seconds * 1000.0) / motor_test::PROP_TICK_MS).round() as u32, 2);
        if !accepted {
            self.prop_restore_defaults(transport);
            return Some("the flight controller did not accept the test settings.".into());
        }
        let name = motor_test::prop_catalog_name(self.prop_request(transport, &motor_test::prop_catalog_step(motor.ch), 1200).as_deref());
        if name != motor_test::prop_catalog_expected(motor.ch) {
            self.prop_restore_defaults(transport);
            return Some("the flight controller does not offer a motor test for this output, so the motor was not run.".into());
        }
        let run = self.prop_request(transport, &motor_test::prop_run_step(motor.ch), 1200);
        if run.as_ref().and_then(|r| r.first()).copied() != Some(0) {
            self.prop_restore_defaults(transport);
            return Some("the flight controller did not acknowledge the run command.".into());
        }
        let ends_at = now_ms() + (seconds * 1000.0) as u64;
        self.emit_prop_test(PropTestEvent { motor: motor.n, phase: "spinning".into(), ends_at: Some(ends_at), note: None });
        self.prop_wait(transport, ends_at);
        self.prop_restore_defaults(transport);
        None
    }

    /// Throttle method. Returns the reason the motor was not run, or None.
    fn prop_spin_throttle(&self, transport: &Arc<BulkTransport>, motor: motor_test::PropMotor, percent: f64, seconds: f64) -> Option<String> {
        let hash = motor_test::prop_throttle_hash(motor.ch);
        let throttle = motor_test::prop_throttle_value(percent);
        if !self.prop_write(transport, &hash, throttle, 4) {
            self.prop_write(transport, &hash, 0, 4);
            return Some("the flight controller did not accept the throttle.".into());
        }
        let ends_at = now_ms() + (seconds * 1000.0) as u64;
        self.emit_prop_test(PropTestEvent { motor: motor.n, phase: "spinning".into(), ends_at: Some(ends_at), note: None });
        while !self.prop_stop.load(Ordering::SeqCst) && self.transport_is(transport) && now_ms() < ends_at {
            let started = now_ms();
            self.prop_write(transport, &hash, throttle, 4);
            let spent = now_ms().saturating_sub(started);
            std::thread::sleep(Duration::from_millis(motor_test::PROP_WATCHDOG_MS.saturating_sub(spent)));
        }
        self.prop_write(transport, &hash, 0, 4);
        None
    }

    pub fn run_prop_test(&self, motors: Vec<u8>, percent: f64, seconds: f64, props_removed: bool, allow_untested: bool) -> MotorTestResult {
        if let Some(block) = self.motor_test_block() {
            return MotorTestResult { ok: false, message: block, acks: None };
        }
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None },
        };
        if self.prop_testing.load(Ordering::SeqCst) {
            return MotorTestResult { ok: false, message: "A motor test is already running.".into(), acks: None };
        }
        if !props_removed {
            return MotorTestResult { ok: false, message: "Confirm that all propellers are removed first.".into(), acks: None };
        }
        let support = motor_test::prop_test_support(self.model_code().as_deref());
        if !support.validated && !allow_untested {
            return MotorTestResult { ok: false, message: "The propeller motor test has not been validated on this aircraft.".into(), acks: None };
        }
        let list: Vec<motor_test::PropMotor> = motors.iter().filter_map(|&n| motor_test::prop_motor(n)).collect();
        if list.is_empty() || list.len() != motors.len() || list.len() > motor_test::PROP_MOTORS.len() {
            return MotorTestResult { ok: false, message: "Unknown motor.".into(), acks: None };
        }
        if !(percent > 0.0 && percent <= motor_test::PROP_MAX_PERCENT) || !(seconds > 0.0 && seconds <= motor_test::PROP_MAX_SECONDS) {
            return MotorTestResult { ok: false, message: "Output or duration is out of range.".into(), acks: None };
        }

        self.prop_testing.store(true, Ordering::SeqCst);
        self.prop_stop.store(false, Ordering::SeqCst);
        self.prop_test_touched.store(true, Ordering::SeqCst);

        let result = (|| -> MotorTestResult {
            if support.factory_mode && !self.inner.lock().prop_factory_open {
                self.prop_factory(&transport, true);
            }
            for (index, motor) in list.iter().enumerate() {
                if index > 0 {
                    std::thread::sleep(Duration::from_millis(motor_test::PROP_GAP_MS));
                }
                if self.prop_stop.load(Ordering::SeqCst) || !self.transport_is(&transport) {
                    break;
                }
                let failure = if support.mode == PropTestMode::Throttle {
                    self.prop_spin_throttle(&transport, *motor, percent, seconds)
                } else {
                    self.prop_spin_catalog(&transport, *motor, percent, seconds)
                };
                if let Some(reason) = failure {
                    self.emit_prop_test(PropTestEvent { motor: motor.n, phase: "failed".into(), ends_at: None, note: Some(reason.clone()) });
                    return MotorTestResult { ok: false, message: format!("M{}: {reason}", motor.n), acks: None };
                }
                if self.prop_stop.load(Ordering::SeqCst) {
                    self.emit_prop_test(PropTestEvent { motor: motor.n, phase: "stopped".into(), ends_at: None, note: None });
                    break;
                }
                self.emit_prop_test(PropTestEvent { motor: motor.n, phase: "done".into(), ends_at: None, note: Some(format!("{percent} % · {seconds} s")) });
            }
            if !self.transport_is(&transport) {
                return MotorTestResult { ok: false, message: "The aircraft disconnected during the test.".into(), acks: None };
            }
            if self.prop_stop.load(Ordering::SeqCst) {
                return MotorTestResult { ok: false, message: "Motor test stopped.".into(), acks: None };
            }
            let message = if list.len() == 1 {
                format!("M{} ran at {percent} % for {seconds} s.", list[0].n)
            } else {
                format!("{} motors ran one by one at {percent} % for {seconds} s each.", list.len())
            };
            MotorTestResult { ok: true, message, acks: None }
        })();

        if self.inner.lock().prop_factory_open && self.transport_is(&transport) {
            self.prop_factory(&transport, false);
        }
        self.prop_testing.store(false, Ordering::SeqCst);
        result
    }

    pub fn stop_prop_test(&self) -> MotorTestResult {
        self.prop_stop.store(true, Ordering::SeqCst);
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None },
        };
        if !self.prop_test_touched.load(Ordering::SeqCst) {
            return MotorTestResult { ok: true, message: "No motor test has run, nothing to stop.".into(), acks: None };
        }
        if motor_test::prop_test_support(self.model_code().as_deref()).mode == PropTestMode::Throttle {
            for motor in motor_test::PROP_MOTORS {
                self.prop_write(&transport, &motor_test::prop_throttle_hash(motor.ch), 0, 4);
            }
            if !self.prop_testing.load(Ordering::SeqCst) && self.inner.lock().prop_factory_open {
                self.prop_factory(&transport, false);
            }
            return MotorTestResult { ok: true, message: "All motors set to zero.".into(), acks: None };
        }
        self.prop_restore_defaults(&transport);
        MotorTestResult { ok: true, message: "Motor test stopped and its settings restored.".into(), acks: None }
    }

    // ── Motor beep ───────────────────────────────────────────────────────────

    fn close_beep_factory(&self, transport: &BulkTransport) {
        let should = {
            let g = self.inner.lock();
            g.beep_factory_open && g.beeping.is_empty()
        };
        if should {
            self.inner.lock().beep_factory_open = false;
            for step in motor_test::prop_factory_steps(false) {
                let _ = self.write_step(transport, &step);
            }
        }
    }

    pub fn motor_beep(&self, motor_number: u8, on: bool, allow_untested: bool) -> MotorTestResult {
        let block = self.motor_test_block().or_else(|| {
            if self.prop_testing.load(Ordering::SeqCst) { Some("A propeller test is running.".into()) } else { None }
        });
        if let Some(block) = block {
            return MotorTestResult { ok: false, message: block, acks: None };
        }
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None },
        };
        let motor = match motor_test::prop_motor(motor_number) {
            Some(m) => m,
            None => return MotorTestResult { ok: false, message: "Unknown motor.".into(), acks: None },
        };
        let support = motor_test::beep_support(self.model_code().as_deref());
        if on && !support.validated && !allow_untested {
            return MotorTestResult { ok: false, message: "The motor beep was not validated on this aircraft.".into(), acks: None };
        }
        if on && support.factory_mode && !self.inner.lock().beep_factory_open {
            self.prop_factory(&transport, true);
            self.inner.lock().beep_factory_open = true;
        }
        if let Err(e) = self.write_step(&transport, &motor_test::beep_step(motor.ch, on)) {
            return MotorTestResult { ok: false, message: e, acks: None };
        }
        if on {
            self.inner.lock().beeping.insert(motor.n);
        } else {
            self.inner.lock().beeping.remove(&motor.n);
            self.close_beep_factory(&transport);
        }
        MotorTestResult { ok: true, message: format!("M{} beep {}.", motor.n, if on { "on" } else { "off" }), acks: None }
    }

    pub fn motor_beep_stop(&self) -> MotorTestResult {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => {
                self.inner.lock().beeping.clear();
                return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None };
            }
        };
        {
            let g = self.inner.lock();
            if g.beeping.is_empty() && !g.beep_factory_open {
                return MotorTestResult { ok: true, message: "No motor is beeping.".into(), acks: None };
            }
        }
        for motor in motor_test::PROP_MOTORS {
            if let Err(e) = self.write_step(&transport, &motor_test::beep_step(motor.ch, false)) {
                return MotorTestResult { ok: false, message: e, acks: None };
            }
        }
        self.inner.lock().beeping.clear();
        self.close_beep_factory(&transport);
        MotorTestResult { ok: true, message: "All motors silenced.".into(), acks: None }
    }

    // ── Repairs & serial numbers ─────────────────────────────────────────────

    /// Sends a step and waits for its reply; a no-reply step just writes.
    fn flash_send_step(&self, transport: &BulkTransport, step: &ServiceStep, timeout_ms: u64) -> Option<Vec<u8>> {
        if !step.expect_reply {
            let _ = self.write_step(transport, step);
            return None;
        }
        self.request_step(transport, step, timeout_ms)
    }

    fn set_repair(&self, phase: &str, percent: u32, message: &str) {
        self.inner.lock().state.repair = Some(RepairState {
            kind: "gimbal-imu".into(),
            phase: phase.into(),
            percent,
            message: message.into(),
        });
        self.emit_state();
    }

    /// Runs the gimbal IMU repair, emitting progress as `repair`.
    pub fn repair_gimbal_imu(&self, method: String) -> MotorTestResult {
        let block = self.motor_test_block().or_else(|| {
            if self.prop_testing.load(Ordering::SeqCst) { Some("A propeller test is running.".into()) } else { None }
        });
        if let Some(block) = block {
            return MotorTestResult { ok: false, message: block, acks: None };
        }
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return MotorTestResult { ok: false, message: "No aircraft connected.".into(), acks: None },
        };
        if method != "value" && method != "calibrate" {
            return MotorTestResult { ok: false, message: "Unknown repair.".into(), acks: None };
        }
        let choice = repair::plan_imu_repair(&method, self.model_code().as_deref(), self.model_name().as_deref());
        let plan = match choice.plan {
            Some(p) => p,
            None => return MotorTestResult { ok: false, message: choice.reason.unwrap_or_else(|| "This repair is not available for this aircraft.".into()), acks: None },
        };

        self.calibrating.store(true, Ordering::SeqCst);
        let total = repair::repair_duration_ms(&plan).max(1);
        let mut elapsed = 0u64;
        let pct = |elapsed: u64| -> u32 { (99).min(((elapsed as f64 / total as f64) * 100.0).round() as u32) };

        let result = (|| -> MotorTestResult {
            let count = plan.steps.len();
            for (index, entry) in plan.steps.iter().enumerate() {
                if !self.transport_is(&transport) {
                    return MotorTestResult { ok: false, message: "The aircraft disconnected during the repair.".into(), acks: None };
                }
                self.set_repair("running", pct(elapsed), &format!("{}…", entry.label));
                let reply = self.flash_send_step(&transport, &entry.step, 2500);
                if entry.write {
                    let more = if index < count - 1 { " Nothing further was sent." } else { "" };
                    match &reply {
                        None => {
                            let m = format!("The gimbal did not acknowledge the write, so it may not have been applied.{more}");
                            self.set_repair("failed", pct(elapsed), &m);
                            return MotorTestResult { ok: false, message: m, acks: None };
                        }
                        Some(r) if r.first().copied().unwrap_or(0) != 0 => {
                            let m = format!("The gimbal refused the write (code {}).{more}", r.first().copied().unwrap_or(0));
                            self.set_repair("failed", pct(elapsed), &m);
                            return MotorTestResult { ok: false, message: m, acks: None };
                        }
                        _ => {}
                    }
                }
                elapsed += repair::REPAIR_STEP_MS;
                let wait_until = now_ms() + entry.wait_after_ms;
                while now_ms() < wait_until {
                    if !self.transport_is(&transport) {
                        return MotorTestResult { ok: false, message: "The aircraft disconnected during the repair.".into(), acks: None };
                    }
                    let slice = 500.min(wait_until.saturating_sub(now_ms()));
                    std::thread::sleep(Duration::from_millis(slice));
                    elapsed += slice;
                    self.set_repair("running", pct(elapsed), &format!("{}…", entry.label));
                }
            }
            let message = "Repair sent and acknowledged. Restart the aircraft, then read the fault codes again to see whether the fault has cleared.".to_string();
            self.set_repair("done", 100, &message);
            MotorTestResult { ok: true, message, acks: None }
        })();

        if self.transport_is(&transport) {
            for cleanup in &plan.cleanup {
                let _ = self.write_step(&transport, cleanup);
                std::thread::sleep(Duration::from_millis(60));
            }
        }
        self.calibrating.store(false, Ordering::SeqCst);
        result
    }

    fn read_module_serial(&self, transport: &BulkTransport, receiver: u8) -> Option<String> {
        for _ in 0..2 {
            let reply = self.flash_send_step(transport, &repair::serial_read_step(receiver), 900);
            if let Some(s) = reply.as_deref().and_then(service::serial_from_reply) {
                return Some(s);
            }
        }
        None
    }

    pub fn read_serials(&self) -> Vec<SerialRow> {
        let mut rows: Vec<SerialRow> = repair::SERIAL_TARGETS
            .iter()
            .map(|t| SerialRow { component: t.id.into(), label: t.label.into(), serial: None, writable: t.writable })
            .collect();
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return rows,
        };
        if self.flashing.load(Ordering::SeqCst) || self.calibrating.load(Ordering::SeqCst) {
            return rows;
        }
        for row in rows.iter_mut() {
            if !self.transport_is(&transport) {
                break;
            }
            if let Some(target) = repair::serial_target(&row.component) {
                row.serial = self.read_module_serial(&transport, target.receiver);
            }
        }
        rows
    }

    pub fn write_serial(&self, component: String, value: String) -> SerialWriteResult {
        let block = self.motor_test_block().or_else(|| {
            if self.prop_testing.load(Ordering::SeqCst) { Some("A propeller test is running.".into()) } else { None }
        });
        if let Some(block) = block {
            return SerialWriteResult { ok: false, message: block, before: None, after: None };
        }
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return SerialWriteResult { ok: false, message: "No aircraft connected.".into(), before: None, after: None },
        };
        let target = match repair::serial_target(&component) {
            Some(t) if t.writable => t,
            _ => return SerialWriteResult { ok: false, message: "This module does not take a serial number write.".into(), before: None, after: None },
        };
        let serial = value.trim().to_string();
        if let Some(problem) = repair::serial_problem(&serial) {
            return SerialWriteResult { ok: false, message: problem, before: None, after: None };
        }

        self.calibrating.store(true, Ordering::SeqCst);
        let result = (|| -> SerialWriteResult {
            let before = self.read_module_serial(&transport, target.receiver);
            let before = match before {
                None => {
                    return SerialWriteResult {
                        ok: false,
                        message: format!("The {} did not report its current serial number, so nothing was written.", target.label.to_lowercase()),
                        before: None,
                        after: None,
                    };
                }
                Some(b) => b,
            };
            if before == serial {
                return SerialWriteResult { ok: true, message: "The module already has this serial number.".into(), before: Some(before.clone()), after: Some(before) };
            }
            // Enter factory mode, write, leave factory mode.
            for fs in repair::serial_factory_steps(true) {
                let _ = self.write_step(&transport, &fs);
            }
            std::thread::sleep(Duration::from_millis(repair::SERIAL_FACTORY_SETTLE_MS));
            let reply = self.flash_send_step(&transport, &repair::serial_write_step(target.receiver, &serial), 2000);
            let code = reply.as_ref().map(|r| r.first().copied().unwrap_or(0));
            std::thread::sleep(Duration::from_millis(repair::SERIAL_FACTORY_SETTLE_MS));
            if self.transport_is(&transport) {
                for fs in repair::serial_factory_steps(false) {
                    let _ = self.write_step(&transport, &fs);
                }
            }
            std::thread::sleep(Duration::from_millis(400));
            let after = self.read_module_serial(&transport, target.receiver);
            if after.as_deref() == Some(serial.as_str()) {
                return SerialWriteResult {
                    ok: true,
                    message: format!("Serial number written and read back. The previous one was {before}."),
                    before: Some(before),
                    after,
                };
            }
            let answer = match code {
                None => "did not answer the write".to_string(),
                Some(0) => "acknowledged the write".to_string(),
                Some(c) => format!("refused the write (code {c})"),
            };
            SerialWriteResult {
                ok: false,
                message: format!("The {} {answer} and still reports {}.", target.label.to_lowercase(), after.clone().unwrap_or_else(|| "no serial number".into())),
                before: Some(before),
                after,
            }
        })();
        self.calibrating.store(false, Ordering::SeqCst);
        result
    }

    // ── Single parameter read (by name hash) ─────────────────────────────────

    pub fn read_param(&self, name: String) -> ParamReadResult {
        let hash_hex = format!("0x{:08x}", params::dji_param_hash(&name));
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return ParamReadResult { name, hash_hex, value_hex: String::new(), ok: false, note: Some("no reply".into()) },
        };
        if self.flashing.load(Ordering::SeqCst) {
            return ParamReadResult { name, hash_hex, value_hex: String::new(), ok: false, note: Some("no reply".into()) };
        }
        let (receiver, cmd_id, payload) = params::read_by_hash_step(&name);
        let step = ServiceStep { sender: 0x2a, receiver, ack_enc: 0x40, cmd_set: params::FLYC, cmd_id, payload, expect_reply: true, wait_after_ms: 0 };
        let reply = self.flash_send_step(&transport, &step, 1500);
        match reply {
            None => ParamReadResult { name, hash_hex, value_hex: String::new(), ok: false, note: Some("no reply".into()) },
            Some(r) => match params::parse_value_by_hash(&r) {
                Some(value) => ParamReadResult { name, hash_hex, value_hex: duml::to_hex(&value), ok: true, note: None },
                None => ParamReadResult { name, hash_hex, value_hex: duml::to_hex(&r), ok: false, note: Some("short reply".into()) },
            },
        }
    }

    // ── Command console ──────────────────────────────────────────────────────

    pub fn console_send(&self, request: ConsoleRequest) -> ConsoleReply {
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return ConsoleReply { ok: false, message: "No aircraft connected.".into(), reply: None, ms: None },
        };
        if self.flashing.load(Ordering::SeqCst) {
            return ConsoleReply { ok: false, message: "A firmware flash is in progress.".into(), reply: None, ms: None };
        }
        if self.calibrating.load(Ordering::SeqCst) {
            return ConsoleReply { ok: false, message: "A calibration or repair is running.".into(), reply: None, ms: None };
        }
        if let Some(problem) = console_cmd::console_request_problem(&request) {
            return ConsoleReply { ok: false, message: problem, reply: None, ms: None };
        }
        let expect_reply = request.ack_enc != 0x00;
        let step = ServiceStep {
            sender: request.sender as u8,
            receiver: request.receiver as u8,
            ack_enc: request.ack_enc as u8,
            cmd_set: request.cmd_set as u8,
            cmd_id: request.cmd_id as u8,
            payload: request.payload.iter().map(|&b| b as u8).collect(),
            expect_reply,
            wait_after_ms: 0,
        };
        let started = now_ms();
        let reply = self.flash_send_step(&transport, &step, console_cmd::CONSOLE_REPLY_WAIT_MS);
        if !expect_reply {
            return ConsoleReply { ok: true, message: "Sent. No answer was requested.".into(), reply: None, ms: None };
        }
        match reply {
            None => ConsoleReply { ok: false, message: "Sent. No answer arrived.".into(), reply: None, ms: None },
            Some(r) => {
                let n = r.len();
                ConsoleReply {
                    ok: true,
                    message: format!("Answered with {n} byte{}.", if n == 1 { "" } else { "s" }),
                    reply: Some(r),
                    ms: Some(now_ms().saturating_sub(started)),
                }
            }
        }
    }

    /// Starts or stops forwarding received frames to the console page, batched.
    pub fn console_watch(self: &Arc<Self>, on: bool) {
        if let Some(id) = self.inner.lock().console_listener.take() {
            self.unsubscribe(id);
        }
        self.console_watch.store(false, Ordering::SeqCst);
        self.console_buffer.lock().clear();
        if !on {
            return;
        }
        let buffer = Arc::clone(&self.console_buffer);
        let listener: Listener = Arc::new(move |p: &duml::Packet| {
            let mut buf = buffer.lock();
            if buf.len() >= console_cmd::CONSOLE_KEEP_FRAMES {
                buf.remove(0);
            }
            buf.push(ConsoleFrame {
                at: now_ms(),
                from: p.sender_info,
                to: p.receiver_info,
                cmd_set: p.cmd_set,
                cmd_id: p.cmd_id,
                ack: p.packet_type == 1,
                length: p.payload.len(),
                hex: duml::to_hex(&p.payload[..p.payload.len().min(console_cmd::CONSOLE_FRAME_BYTES)]),
            });
        });
        let id = self.subscribe(listener);
        self.inner.lock().console_listener = Some(id);
        self.console_watch.store(true, Ordering::SeqCst);

        let watch = Arc::clone(&self.console_watch);
        let buffer = Arc::clone(&self.console_buffer);
        let app = self.app.clone();
        std::thread::spawn(move || {
            while watch.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
                let frames: Vec<ConsoleFrame> = {
                    let mut buf = buffer.lock();
                    if buf.is_empty() {
                        continue;
                    }
                    std::mem::take(&mut *buf)
                };
                let _ = app.emit("drone:console-frames", frames);
            }
        });
    }

    // ── Firmware manifest (config / cfg.sig) ─────────────────────────────────

    fn transport_is_ref(&self, t: &BulkTransport) -> bool {
        self.transport.lock().as_ref().map(|cur| std::ptr::eq(Arc::as_ptr(cur), t as *const _)).unwrap_or(false)
    }

    /// One paged config request (GENERAL 0x4F) at the given byte offset.
    fn config_request(&self, transport: &BulkTransport, receiver: u8, offset: u32) -> Option<Vec<u8>> {
        let mut payload = vec![0u8; 9];
        payload[0] = 0x01;
        payload[1..5].copy_from_slice(&offset.to_le_bytes());
        payload[5] = 0xff;
        payload[6] = 0xff;
        payload[7] = 0xff;
        payload[8] = 0xff;
        let step = ServiceStep { sender: 0x2a, receiver, ack_enc: 0x40, cmd_set: duml::cmd_set::GENERAL, cmd_id: 0x4f, payload, expect_reply: true, wait_after_ms: 0 };
        self.flash_send_step(transport, &step, 1500)
    }

    fn find_config_receiver(&self, transport: &BulkTransport) -> Option<u8> {
        for receiver in [0x48u8, 0x4f, 0x01, 0x28] {
            if !self.transport_is_ref(transport) {
                return None;
            }
            if let Some(reply) = self.config_request(transport, receiver, 0) {
                if reply.len() >= 9 && reply[0] == 0 {
                    return Some(receiver);
                }
            }
        }
        None
    }

    /// Reads the full firmware manifest to completion and parses it.
    fn read_config(&self, transport: &BulkTransport) {
        let receiver = match self.inner.lock().config_receiver {
            Some(r) => Some(r),
            None => self.find_config_receiver(transport),
        };
        let receiver = match receiver {
            Some(r) if self.transport_is_ref(transport) => r,
            _ => return,
        };
        self.inner.lock().config_receiver = Some(receiver);

        let mut parts: Vec<u8> = Vec::new();
        let mut offset: u32 = 0;
        for _ in 0..8192 {
            if !self.transport_is_ref(transport) {
                return;
            }
            let reply = match self.config_request(transport, receiver, offset) {
                Some(r) if r.len() >= 9 && r[0] == 0 => r,
                _ => break,
            };
            let remaining = u32::from_le_bytes([reply[5], reply[6], reply[7], reply[8]]);
            let chunk = &reply[9..];
            if chunk.is_empty() {
                break;
            }
            parts.extend_from_slice(chunk);
            offset += chunk.len() as u32;
            if remaining == 0 || offset > 2_000_000 {
                break;
            }
        }

        let manifest = match config::parse_config(&parts) {
            Some(m) => m,
            None => return,
        };
        if !self.transport_is_ref(transport) {
            return;
        }
        let model = manifest.device_id.as_deref().and_then(match_model_code);
        {
            let mut g = self.inner.lock();
            g.state.manifest = Some(manifest);
            if let Some(m) = model {
                g.active_model = Some(m);
                g.state.model = Some(m.name.to_string());
                g.state.model_code = Some(m.code.to_string());
            }
        }
        self.emit_state();
    }

    // ── Serial reads used by the full check ──────────────────────────────────

    fn read_camera_serial(&self, transport: &BulkTransport) -> Option<String> {
        let multiple = self.inner.lock().active_model.map(|m| m.camera_count > 1).unwrap_or(false);
        let payload = if multiple { vec![0x03, 0x00, 0x00, 0x00] } else { vec![0, 0, 0, 0] };
        let step = ServiceStep { sender: 0x2a, receiver: 0x01, ack_enc: 0x40, cmd_set: 0x02, cmd_id: 0xb5, payload, expect_reply: true, wait_after_ms: 0 };
        for _ in 0..3 {
            if let Some(reply) = self.flash_send_step(transport, &step, 1000) {
                if let Some(s) = service::serial_from_reply(&reply) {
                    return Some(s);
                }
                if reply.len() > 2 {
                    return Some(format!("raw: {}", duml::to_hex(&reply)));
                }
            }
        }
        None
    }

    fn read_drone_serial(&self, transport: &BulkTransport) -> Option<String> {
        let step = ServiceStep { sender: 0x0a, receiver: 0x68, ack_enc: 0x40, cmd_set: duml::cmd_set::GENERAL, cmd_id: CMD_GET_SERIAL, payload: vec![0x04], expect_reply: true, wait_after_ms: 0 };
        for _ in 0..3 {
            if let Some(reply) = self.flash_send_step(transport, &step, 1000) {
                if let Some(s) = service::serial_from_reply(&reply) {
                    return Some(s);
                }
            }
        }
        None
    }

    // ── Full check ───────────────────────────────────────────────────────────

    fn emit_diag_progress(&self, done: usize, label: &str) {
        let _ = self.app.emit("drone:diag-progress", DiagnosticProgress { done, total: diagnostics::DIAGNOSTIC_STAGES.len(), label: label.into() });
    }

    pub fn run_diagnostics(&self) -> Option<DiagnosticReport> {
        let transport = self.transport.lock().clone()?;
        if self.flashing.load(Ordering::SeqCst) || self.calibrating.load(Ordering::SeqCst) || self.diagnosing.load(Ordering::SeqCst) {
            return None;
        }
        self.diagnosing.store(true, Ordering::SeqCst);
        let linked = |me: &Session| me.transport_is(&transport);
        let mut checks: Vec<DiagnosticCheck> = Vec::new();
        let mut stage = 0usize;

        // Fault codes.
        self.emit_diag_progress(stage, diagnostics::DIAGNOSTIC_STAGES[stage]);
        stage += 1;
        let hms = self.read_hms_now();
        let faults = hms_faults_of(&self.inner.lock());
        checks.extend(diagnostics::fault_checks(&faults, hms.ok));

        // Serial numbers.
        self.emit_diag_progress(stage, diagnostics::DIAGNOSTIC_STAGES[stage]);
        stage += 1;
        let mut serial = self.inner.lock().state.serial.clone();
        let mut camera_serial = self.inner.lock().state.camera_serial.clone();
        if linked(self) && serial.is_none() {
            serial = self.read_drone_serial(&transport);
        }
        if linked(self) && camera_serial.is_none() {
            camera_serial = self.read_camera_serial(&transport);
        }
        checks.push(DiagnosticCheck::new("Identity", "Aircraft serial", if serial.is_some() { "ok" } else { "warn" }, serial.clone().unwrap_or_else(|| "Not reported.".into())));
        checks.push(DiagnosticCheck::new("Identity", "Camera serial", if camera_serial.is_some() { "ok" } else { "warn" }, camera_serial.clone().unwrap_or_else(|| "Not reported.".into())));

        // Vision calibration.
        self.emit_diag_progress(stage, diagnostics::DIAGNOSTIC_STAGES[stage]);
        stage += 1;
        for cal in service::vision_cal_steps() {
            if !linked(self) {
                break;
            }
            let reply = self.flash_send_step(&transport, &cal, 1200);
            let code = reply.as_ref().map(|r| r.first().copied().unwrap_or(0xff));
            let (status, detail) = match code {
                None => ("info", "No answer.".to_string()),
                Some(0) => ("ok", "Calibrated.".to_string()),
                Some(c) => ("fail", format!("Not calibrated (code {c}).")),
            };
            checks.push(DiagnosticCheck::new("Vision", &format!("{} calibration", service::receiver_label(cal.receiver)), status, detail));
        }

        // Vision sensors.
        self.emit_diag_progress(stage, diagnostics::DIAGNOSTIC_STAGES[stage]);
        stage += 1;
        let mut sensor_rows: Vec<DiagnosticCheck> = Vec::new();
        let mut sensor_answers = 0;
        for (mask, name) in service::VISION_SENSORS {
            if !linked(self) {
                break;
            }
            let reply = self.flash_send_step(&transport, &service::vision_sensor_step(*mask), 900);
            let sensor_serial = reply.as_deref().and_then(service::vision_sensor_serial);
            if reply.is_some() {
                sensor_answers += 1;
            }
            let (status, detail) = match &sensor_serial {
                Some(s) => ("ok", s.clone()),
                None => ("info", if reply.is_some() { "No serial reported.".into() } else { "No answer.".into() }),
            };
            sensor_rows.push(DiagnosticCheck::new("Vision", &format!("{name} sensor"), status, detail));
        }
        if sensor_answers > 0 {
            checks.extend(sensor_rows);
        } else {
            checks.push(DiagnosticCheck::new("Vision", "Vision sensors", "info", "This aircraft did not answer the per-sensor query.".into()));
        }

        // Battery.
        self.emit_diag_progress(stage, diagnostics::DIAGNOSTIC_STAGES[stage]);
        stage += 1;
        let battery = if linked(self) { Some(self.read_battery()) } else { None };
        let battery_snapshot = battery.as_ref().filter(|b| b.ok).map(|b| b.battery.clone());
        checks.extend(diagnostics::battery_checks(battery_snapshot.as_ref()));

        // Radio links.
        self.emit_diag_progress(stage, diagnostics::DIAGNOSTIC_STAGES[stage]);
        let radio_steps = service::link_test_steps();
        let mut radios = 0;
        for radio in &radio_steps {
            if !linked(self) {
                break;
            }
            if self.flash_send_step(&transport, radio, 1200).is_some() {
                radios += 1;
            }
        }
        checks.push(DiagnosticCheck::new("Radio", "Radio links", if radios > 0 { "ok" } else { "info" }, format!("{radios} of {} answered.", radio_steps.len())));
        self.emit_diag_progress(diagnostics::DIAGNOSTIC_STAGES.len(), "Done");

        let report = {
            let g = self.inner.lock();
            DiagnosticReport {
                at: now_ms(),
                model: g.state.model.clone(),
                model_code: g.state.model_code.clone(),
                serial,
                camera_serial,
                firmware: g.state.manifest.as_ref().and_then(|m| m.formal_version.clone()),
                modules: g.state.modules.iter().map(|m| DiagnosticModule { name: m.name.clone(), firmware: m.firmware.clone(), hardware: m.hardware.clone() }).collect(),
                faults,
                battery: battery_snapshot,
                checks,
            }
        };
        self.diagnosing.store(false, Ordering::SeqCst);
        Some(report)
    }

    pub fn save_report(&self, report: SaveReportInput) -> ReportSaveResult {
        let non_alnum = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' }).collect::<String>().split_whitespace().collect::<String>();
        let model = report.model.as_deref().map(non_alnum).filter(|s| !s.is_empty()).unwrap_or_else(|| "aircraft".into());
        let serial = report.serial.as_deref().map(non_alnum).filter(|s| !s.is_empty()).map(|s| format!("-{s}")).unwrap_or_default();
        let default_name = format!("service-report-{model}{serial}-{}.txt", diagnostics::report_file_stamp(report.at));

        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title("Save service report")
            .set_file_name(&default_name)
            .add_filter("Text file", &["txt"])
            .blocking_save_file();
        let path = match path.and_then(|p| p.into_path().ok()) {
            Some(p) => p,
            None => return ReportSaveResult { ok: false, path: None, message: None },
        };
        match std::fs::write(&path, diagnostics::format_diagnostic_report(&report)) {
            Ok(()) => ReportSaveResult { ok: true, path: Some(path.to_string_lossy().into_owned()), message: None },
            Err(e) => ReportSaveResult { ok: false, path: None, message: Some(e.to_string()) },
        }
    }

    // ── Parameter backup / restore ───────────────────────────────────────────

    pub fn save_param_backup(&self, json: String) -> ParamBackupFileResult {
        let sanitize = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>();
        let model = self.inner.lock().state.model.as_deref().map(sanitize).filter(|s| !s.is_empty()).unwrap_or_else(|| "dji".into());
        let serial = self.inner.lock().state.serial.as_deref().map(|s| format!("-{s}")).unwrap_or_default();
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let default_name = format!("params-{model}{serial}-{date}.json");

        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title("Save parameter backup")
            .set_file_name(&default_name)
            .add_filter("Parameter backup", &["json"])
            .blocking_save_file();
        let path = match path.and_then(|p| p.into_path().ok()) {
            Some(p) => p,
            None => return ParamBackupFileResult { ok: false, path: None, text: None, error: Some("cancelled".into()) },
        };
        match std::fs::write(&path, json) {
            Ok(()) => ParamBackupFileResult { ok: true, path: Some(path.to_string_lossy().into_owned()), text: None, error: None },
            Err(e) => ParamBackupFileResult { ok: false, path: None, text: None, error: Some(e.to_string()) },
        }
    }

    pub fn load_param_backup(&self) -> ParamBackupFileResult {
        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title("Open parameter backup")
            .add_filter("Parameter backup", &["json"])
            .add_filter("All files", &["*"])
            .blocking_pick_file();
        let path = match path.and_then(|p| p.into_path().ok()) {
            Some(p) => p,
            None => return ParamBackupFileResult { ok: false, path: None, text: None, error: Some("cancelled".into()) },
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => ParamBackupFileResult { ok: true, path: Some(path.to_string_lossy().into_owned()), text: Some(text), error: None },
            Err(e) => ParamBackupFileResult { ok: false, path: None, text: None, error: Some(e.to_string()) },
        }
    }

    // ── Partition backup (read-only) ─────────────────────────────────────────

    pub fn backup_partition(&self, id: u8) -> PartitionBackupResult {
        let part = match partition::partition_by_id(id) {
            Some(p) => p,
            None => return PartitionBackupResult { ok: false, name: format!("#{id}"), pages: 0, bytes: 0, saved_path: None, message: "Unknown partition.".into() },
        };
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => return PartitionBackupResult { ok: false, name: part.name.into(), pages: 0, bytes: 0, saved_path: None, message: "No aircraft connected.".into() },
        };
        if self.flashing.load(Ordering::SeqCst) {
            return PartitionBackupResult { ok: false, name: part.name.into(), pages: 0, bytes: 0, saved_path: None, message: "A firmware flash is in progress.".into() };
        }
        const MAX_PAGES: u8 = 64;
        let mut data: Vec<u8> = Vec::new();
        let mut pages = 0usize;
        for page in 0..MAX_PAGES {
            match self.flash_send_step(&transport, &partition::partition_page_step(part.target, page), 1500) {
                Some(reply) if !reply.is_empty() => {
                    data.extend_from_slice(&reply);
                    pages += 1;
                }
                _ => break,
            }
        }
        let total = data.len();
        if pages == 0 || total == 0 {
            let probe = |receiver: u8| -> String {
                match self.flash_send_step(&transport, &partition::partition_page_step(receiver, 0), 1200) {
                    Some(r) if !r.is_empty() => format!("0x{receiver:x}→{}", duml::to_hex(&r[..r.len().min(24)])),
                    _ => format!("0x{receiver:x}→no reply"),
                }
            };
            let probes = format!("{}, {}", probe(part.target), probe(0x48));
            return PartitionBackupResult { ok: false, name: part.name.into(), pages: 0, bytes: 0, saved_path: None, message: format!("{} returned no data. Page-0 probe: {probes}.", part.name) };
        }

        let slug: String = part.name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let serial = self.inner.lock().state.serial.as_deref().map(|s| format!("-{s}")).unwrap_or_default();
        let default_name = format!("partition-{slug}{serial}.bin");

        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title(&format!("Save {} backup", part.name))
            .set_file_name(&default_name)
            .add_filter("Partition image", &["bin"])
            .blocking_save_file();
        match path.and_then(|p| p.into_path().ok()) {
            None => PartitionBackupResult {
                ok: true,
                name: part.name.into(),
                pages,
                bytes: total,
                saved_path: None,
                message: format!("Read {total} bytes from {} over {pages} pages (save cancelled).", part.name),
            },
            Some(p) => match std::fs::write(&p, &data) {
                Ok(()) => PartitionBackupResult {
                    ok: true,
                    name: part.name.into(),
                    pages,
                    bytes: total,
                    saved_path: Some(p.to_string_lossy().into_owned()),
                    message: format!("Saved {total} bytes from {} ({pages} pages).", part.name),
                },
                Err(e) => PartitionBackupResult { ok: false, name: part.name.into(), pages, bytes: total, saved_path: None, message: e.to_string() },
            },
        }
    }

    // ── Firmware flasher ─────────────────────────────────────────────────────

    pub fn get_flash_state(&self) -> FlashState {
        self.flash_state.lock().clone()
    }

    fn update_flash<F: FnOnce(&mut FlashState)>(&self, f: F) {
        let snapshot = {
            let mut g = self.flash_state.lock();
            f(&mut g);
            g.clone()
        };
        let _ = self.app.emit("drone:flash", snapshot);
    }

    fn flash_fail(&self, message: &str) {
        self.update_flash(|fs| {
            fs.phase = "failed".into();
            fs.error = Some(message.into());
            fs.message = message.into();
            fs.finished_at = Some(now_ms());
        });
    }

    pub fn pick_firmware(&self) -> Option<String> {
        use tauri_plugin_dialog::DialogExt;
        self.app
            .dialog()
            .file()
            .set_title("Select firmware package")
            .add_filter("Firmware package", &["bin", "tar", "gz", "tgz", "zip"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    }

    fn file_info(files: &[FirmwareFile]) -> Vec<FirmwareFileInfo> {
        files.iter().map(|f| FirmwareFileInfo { name: f.name.clone(), size: f.bytes.len() }).collect()
    }

    pub fn validate_flash(&self, package_path: String) -> FlashValidation {
        let model = self.inner.lock().active_model;
        let route = model.and_then(|m| flasher::flash_route_for_code(Some(m.code)));
        let (model_name, model_code) = model.map(|m| (Some(m.name.to_string()), Some(m.code.to_string()))).unwrap_or((None, None));
        let drone_type = route.as_ref().map(|r| r.drone_type.to_string());
        let err = |error: String| FlashValidation {
            ok: false,
            model: model_name.clone(),
            model_code: model_code.clone(),
            drone_type: drone_type.clone(),
            files: Vec::new(),
            total_size: 0,
            warnings: Vec::new(),
            error: Some(error),
        };
        if self.transport.lock().is_none() {
            return FlashValidation { model: None, model_code: None, drone_type: None, ..err("No aircraft connected.".into()) };
        }
        let model = match model {
            Some(m) => m,
            None => return FlashValidation { model: None, model_code: None, drone_type: None, ..err("Aircraft model has not been identified yet.".into()) },
        };
        if route.is_none() {
            return err(format!("Flashing is not supported for {} ({}).", model.name, model.code));
        }
        let bytes = match std::fs::read(&package_path) {
            Ok(b) => b,
            Err(e) => return err(format!("Could not read firmware package: {e}")),
        };
        let files = flasher::read_firmware_package(&bytes);
        if files.is_empty() {
            return err("No .sig firmware modules were found in the package (expected a DJI .bin/tar/zip).".into());
        }
        let total_size: usize = files.iter().map(|f| f.bytes.len()).sum();
        let mut warnings = vec!["Flashing is irreversible. A wrong package or an interruption can permanently brick the aircraft.".to_string()];
        if let Some(manifest) = &self.inner.lock().state.manifest {
            if let Some(ar) = manifest.anti_rollback {
                warnings.push(format!(
                    "Aircraft anti-rollback level is {ar} (firmware {}). Flashing firmware built below this level will permanently brick the aircraft.",
                    manifest.formal_version.as_deref().unwrap_or("?")
                ));
            }
        }
        if model.needs_factory_mode {
            warnings.push(format!("{} normally requires factory mode before firmware service.", model.name));
        }
        let prefix = model.code[..model.code.len().min(5)].to_lowercase();
        if !files.iter().any(|f| f.name.to_lowercase().contains(&prefix)) {
            warnings.push(format!("None of the firmware files name \"{}\" — confirm this package is for the connected aircraft.", model.code));
        }
        FlashValidation {
            ok: true,
            model: model_name,
            model_code,
            drone_type,
            files: Self::file_info(&files),
            total_size,
            warnings,
            error: None,
        }
    }

    pub fn start_flash(self: &Arc<Self>, package_path: String) -> Result<(), String> {
        if self.flashing.load(Ordering::SeqCst) {
            return Err("A flash is already running.".into());
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || me.run_flash(package_path));
        Ok(())
    }

    pub fn cancel_flash(&self) {
        self.flash_cancelled.store(true, Ordering::SeqCst);
    }

    fn flash_aborted(&self, transport: &Arc<BulkTransport>) -> bool {
        if !self.transport_is(transport) {
            self.flash_fail("The aircraft disconnected during flashing.");
            return true;
        }
        if self.flash_cancelled.load(Ordering::SeqCst) {
            self.update_flash(|fs| {
                fs.phase = "failed".into();
                fs.error = Some("Flash cancelled.".into());
                fs.message = "Flash cancelled.".into();
                fs.finished_at = Some(now_ms());
            });
            return true;
        }
        false
    }

    fn flash_enter_mode(&self, transport: &Arc<BulkTransport>, route: &FlashRoute) -> bool {
        let is_m3 = route.family == flasher::FlashFamily::NewM3;
        let tries = if is_m3 { 10 } else { 3 };
        for _ in 0..tries {
            if !self.transport_is(transport) {
                return false;
            }
            let reply = self.flash_send_step(transport, &flasher::enter_step(route), 1200);
            if is_m3 {
                if let Some(r) = &reply {
                    if r.first() == Some(&0x00) {
                        return true;
                    }
                    if r.first() == Some(&0xc5) {
                        return false;
                    }
                }
            } else if reply.is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
        false
    }

    fn run_flash(self: Arc<Self>, package_path: String) {
        const STEP_TIMEOUT: u64 = 10000;
        let transport = match self.transport.lock().clone() {
            Some(t) => t,
            None => {
                self.flash_fail("No aircraft connected.");
                return;
            }
        };
        let model = self.inner.lock().active_model;
        let route = model.and_then(|m| flasher::flash_route_for_code(Some(m.code)));
        let (model, route) = match (model, route) {
            (Some(m), Some(r)) => (m, r),
            _ => {
                self.flash_fail("This aircraft is not supported for flashing.");
                return;
            }
        };
        let bytes = match std::fs::read(&package_path) {
            Ok(b) => b,
            Err(e) => {
                self.flash_fail(&format!("Could not read firmware package: {e}"));
                return;
            }
        };
        let files = flasher::read_firmware_package(&bytes);
        if files.is_empty() {
            self.flash_fail("No .sig firmware modules were found in the package.");
            return;
        }
        let total_size: usize = files.iter().map(|f| f.bytes.len()).sum();

        self.flashing.store(true, Ordering::SeqCst);
        self.flash_cancelled.store(false, Ordering::SeqCst);
        let info = Self::file_info(&files);
        self.update_flash(|fs| {
            *fs = FlashState::idle();
            fs.phase = "entering".into();
            fs.model = Some(model.name.to_string());
            fs.model_code = Some(model.code.to_string());
            fs.drone_type = Some(route.drone_type.to_string());
            fs.package_path = Some(package_path.clone());
            fs.files = info;
            fs.total_size = total_size;
            fs.file_index = Some(0);
            fs.file_progress = Some(0);
            fs.overall_progress = Some(0);
            fs.message = "Entering upgrade mode…".into();
            fs.started_at = Some(now_ms());
        });

        let outcome = (|| -> bool {
            if !self.flash_enter_mode(&transport, &route) {
                self.flash_fail("The aircraft did not enter upgrade mode. Reboot it and try again.");
                return false;
            }
            if self.flash_aborted(&transport) {
                return false;
            }
            self.update_flash(|fs| {
                fs.phase = "preparing".into();
                fs.message = "Negotiating transfer…".into();
            });
            let prep_reply = self.flash_send_step(&transport, &flasher::prepare_step(&route, total_size as u32), STEP_TIMEOUT);
            let prep_block = flasher::block_size_from_reply(prep_reply.as_deref());

            self.update_flash(|fs| fs.phase = "transferring".into());
            let is_m3 = route.family == flasher::FlashFamily::NewM3;
            let mut locked_block: Option<usize> = if is_m3 { None } else { prep_block };
            let mut sent_total = 0usize;
            let mut last_overall: i64 = -1;

            for (i, file) in files.iter().enumerate() {
                if self.flash_aborted(&transport) {
                    return false;
                }
                let open_step = match flasher::file_open_step(&route, &file.name, file.bytes.len() as u32) {
                    Ok(s) => s,
                    Err(e) => {
                        self.flash_fail(&e);
                        return false;
                    }
                };
                let open_reply = self.flash_send_step(&transport, &open_step, STEP_TIMEOUT);
                let mut block_size = flasher::block_size_from_reply(open_reply.as_deref()).or(prep_block).or(locked_block);
                if is_m3 {
                    match locked_block {
                        None => locked_block = block_size,
                        Some(b) => block_size = Some(b),
                    }
                } else if route.family == flasher::FlashFamily::LegacyMini {
                    if let Some(b) = block_size {
                        if b > file.bytes.len() {
                            block_size = Some(file.bytes.len());
                        }
                    }
                }
                let block_size = match block_size {
                    Some(b) if b > 0 => b,
                    _ => {
                        self.flash_fail("The aircraft did not negotiate a transfer block size.");
                        return false;
                    }
                };

                let fname = file.name.clone();
                let total_files = files.len();
                self.update_flash(|fs| {
                    fs.file_index = Some(i + 1);
                    fs.current_file = Some(fname.clone());
                    fs.file_progress = Some(0);
                    fs.message = format!("Transferring {fname} ({}/{})…", i + 1, total_files);
                });

                let mut index = 0u32;
                let mut offset = 0usize;
                while offset < file.bytes.len() {
                    if (index & 0x1f) == 0 && self.flash_aborted(&transport) {
                        return false;
                    }
                    let end = (offset + block_size).min(file.bytes.len());
                    let chunk = &file.bytes[offset..end];
                    let _ = self.flash_send_step(&transport, &flasher::data_step(&route, index, chunk), STEP_TIMEOUT);
                    index += 1;
                    let overall = ((100 * (sent_total + end)) as f64 / total_size as f64).round() as i64;
                    if overall != last_overall {
                        last_overall = overall;
                        let fp = ((100 * end) as f64 / file.bytes.len() as f64).round() as u32;
                        self.update_flash(|fs| {
                            fs.file_progress = Some(fp);
                            fs.overall_progress = Some(overall as u32);
                        });
                    }
                    offset += block_size;
                }
                sent_total += file.bytes.len();

                let md5_reply = self.flash_send_step(&transport, &flasher::md5_step(&route, &file.bytes), STEP_TIMEOUT);
                if let Some(r) = &md5_reply {
                    if !r.is_empty() {
                        let rejected = if is_m3 { r[0] == 0xe0 } else { r[0] != 0x00 };
                        if rejected {
                            self.flash_fail(&format!("The aircraft rejected the checksum of {}.", file.name));
                            return false;
                        }
                    }
                }
            }

            if self.flash_aborted(&transport) {
                return false;
            }
            self.update_flash(|fs| {
                fs.phase = "finishing".into();
                fs.overall_progress = Some(100);
                fs.message = "Committing firmware…".into();
            });
            let _ = self.flash_send_step(&transport, &flasher::finish_step(&route), STEP_TIMEOUT);
            self.update_flash(|fs| {
                fs.phase = "monitoring".into();
                fs.message = "The aircraft is installing the firmware. Do not disconnect it.".into();
            });
            self.monitor_upgrade(&transport);
            true
        })();
        let _ = outcome;
        self.flashing.store(false, Ordering::SeqCst);
    }

    /// Listens for GENERAL 0x42 upgrade-status reports until a verdict or timeout.
    fn monitor_upgrade(&self, transport: &Arc<BulkTransport>) {
        const MONITOR_MS: u64 = 240000;
        let (queue, id) = self.subscribe_queue(|p| p.cmd_set == 0x00 && p.cmd_id == 0x42);
        let deadline = now_ms() + MONITOR_MS;
        loop {
            if let Some(p) = next_report(&queue, 1000) {
                let status = flasher::decode_upgrade_status(&p.payload);
                if status.phase == "progress" {
                    if let Some(pct) = status.percent {
                        self.update_flash(|fs| {
                            fs.overall_progress = Some(pct as u32);
                            fs.status_detail = Some(format!("installing {pct}%"));
                        });
                    }
                } else if let Some(d) = &status.detail {
                    let d = d.clone();
                    self.update_flash(|fs| fs.status_detail = Some(d));
                }
                if status.phase == "success" {
                    self.update_flash(|fs| {
                        fs.phase = "done".into();
                        fs.overall_progress = Some(100);
                        fs.message = "Firmware installed. The aircraft will reboot.".into();
                        fs.finished_at = Some(now_ms());
                    });
                    break;
                }
                if status.phase == "failed" {
                    let detail = status.detail.unwrap_or_else(|| "upgrade failed".into());
                    self.update_flash(|fs| {
                        fs.phase = "failed".into();
                        fs.error = Some(format!("Aircraft reported: {detail}."));
                        fs.finished_at = Some(now_ms());
                    });
                    break;
                }
            }
            if !self.transport_is(transport) {
                self.update_flash(|fs| {
                    fs.phase = "done".into();
                    fs.message = "Firmware sent; the aircraft disconnected to reboot (status unconfirmed).".into();
                    fs.finished_at = Some(now_ms());
                });
                break;
            }
            if now_ms() > deadline {
                self.update_flash(|fs| {
                    fs.phase = "done".into();
                    fs.message = "Firmware sent. Installation status was not confirmed before monitoring ended.".into();
                    fs.finished_at = Some(now_ms());
                });
                break;
            }
        }
        self.unsubscribe(id);
    }

    // ── Drone files (USB FTP) ────────────────────────────────────────────────

    fn ftp_disconnect_now(&self) {
        if let Some(mut client) = self.ftp_client.lock().take() {
            client.quit();
        }
    }

    pub fn ftp_connect(&self, options: Option<FtpConnectOptions>) -> FtpConnectResult {
        self.ftp_disconnect_now();
        let options = options.unwrap_or_default();
        let host = options.host.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(ftp::DRONE_FTP_HOST).to_string();
        let logins: Vec<(String, String)> = match &options.user {
            Some(user) => vec![(user.clone(), options.password.clone().unwrap_or_default())],
            None => ftp::DRONE_FTP_LOGINS.iter().map(|(u, p)| (u.to_string(), p.to_string())).collect(),
        };
        let (mut client, banner) = match FtpClient::connect(&host, ftp::DRONE_FTP_PORT) {
            Ok(v) => v,
            Err(e) => {
                return FtpConnectResult {
                    ok: false,
                    message: format!("{e} The drone must be on and showing as a USB network device (host 192.168.42.1)."),
                    user: None,
                    banner: None,
                }
            }
        };
        for (user, password) in &logins {
            match client.login(user, password) {
                Ok(true) => {
                    if let Err(e) = client.binary() {
                        return FtpConnectResult { ok: false, message: e, user: None, banner: Some(banner) };
                    }
                    *self.ftp_client.lock() = Some(client);
                    return FtpConnectResult { ok: true, message: format!("Signed in as {user}."), user: Some(user.clone()), banner: Some(banner) };
                }
                Ok(false) => continue,
                Err(e) => {
                    client.quit();
                    return FtpConnectResult { ok: false, message: format!("{e} The drone must be on and showing as a USB network device (host 192.168.42.1)."), user: None, banner: Some(banner) };
                }
            }
        }
        client.quit();
        FtpConnectResult { ok: false, message: "The drone refused the sign-in. Check the credentials.".into(), user: None, banner: Some(banner) }
    }

    pub fn ftp_list(&self, dir: String) -> FtpListResult {
        let mut guard = self.ftp_client.lock();
        let client = match guard.as_mut() {
            Some(c) => c,
            None => return FtpListResult { ok: false, message: Some("Not connected to the drone FTP.".into()), path: None, entries: None },
        };
        let target = if dir.is_empty() { "/".to_string() } else { dir };
        match client.list(&target) {
            Ok(text) => FtpListResult { ok: true, message: None, path: Some(target), entries: Some(ftp::parse_ftp_list(&text)) },
            Err(e) => FtpListResult { ok: false, message: Some(e), path: None, entries: None },
        }
    }

    pub fn ftp_download(&self, dir: String, name: String) -> FtpDownloadResult {
        if self.ftp_client.lock().is_none() {
            return FtpDownloadResult { ok: false, message: "Not connected to the drone FTP.".into(), file: None, bytes: None };
        }
        if self.ftp_downloading.load(Ordering::SeqCst) {
            return FtpDownloadResult { ok: false, message: "A download is already running.".into(), file: None, bytes: None };
        }
        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title("Save file from the drone")
            .set_file_name(&ftp::safe_name(&name))
            .blocking_save_file()
            .and_then(|p| p.into_path().ok());
        let path = match path {
            Some(p) => p,
            None => return FtpDownloadResult { ok: false, message: String::new(), file: None, bytes: None },
        };
        self.ftp_downloading.store(true, Ordering::SeqCst);
        let remote = ftp::join_remote(&dir, &name);
        let result = {
            let mut guard = self.ftp_client.lock();
            match guard.as_mut() {
                None => FtpDownloadResult { ok: false, message: "Not connected to the drone FTP.".into(), file: None, bytes: None },
                Some(client) => {
                    let total = client.size(&remote).max(0) as u64;
                    let app = self.app.clone();
                    let name_cl = name.clone();
                    match client.retrieve(&remote, &path, |received| {
                        let _ = app.emit("ftp:progress", FtpDownloadProgress { name: name_cl.clone(), bytes: received, total });
                    }) {
                        Ok(bytes) => FtpDownloadResult { ok: true, message: format!("Saved {bytes} bytes to {}", path.to_string_lossy()), file: Some(path.to_string_lossy().into_owned()), bytes: Some(bytes) },
                        Err(e) => FtpDownloadResult { ok: false, message: e, file: None, bytes: None },
                    }
                }
            }
        };
        self.ftp_downloading.store(false, Ordering::SeqCst);
        result
    }

    pub fn ftp_disconnect(&self) {
        if !self.ftp_downloading.load(Ordering::SeqCst) {
            self.ftp_disconnect_now();
        }
    }

    // ── Remote controller (ADB) ──────────────────────────────────────────────

    pub fn rc_connect(&self) -> RcConnectResult {
        self.adb.start_server();
        let devices = self.adb.list_devices();
        let device = match devices.into_iter().next() {
            Some(d) => d,
            None => return RcConnectResult { ok: false, info: None, serial: None, state: None, error: Some("No remote controller found. Connect it over USB with the screen on, enable USB debugging, and make sure the cable carries data.".into()) },
        };
        if device.state == "unauthorized" {
            return RcConnectResult { ok: false, info: None, error: Some(format!("Controller {} has not authorised this computer. Accept \"Allow USB debugging\" on its screen.", device.serial)), serial: Some(device.serial.clone()), state: Some(device.state) };
        }
        if device.state != "device" {
            return RcConnectResult { ok: false, info: None, error: Some(format!("Controller {} is \"{}\". Unplug and replug it; if it stays that way, revoke USB-debugging authorisations on the controller and restart it.", device.serial, device.state)), serial: Some(device.serial.clone()), state: Some(device.state) };
        }
        RcConnectResult { ok: true, info: Some(self.adb.device_info(&device.serial)), error: None, serial: None, state: None }
    }

    pub fn rc_info(&self, serial: String) -> RcInfo {
        self.adb.device_info(&serial)
    }

    pub fn rc_packages(&self, serial: String, third_party_only: bool) -> Vec<RcPackage> {
        self.adb.list_packages(&serial, third_party_only)
    }

    pub fn rc_pick_apk(&self) -> Option<Vec<String>> {
        use tauri_plugin_dialog::DialogExt;
        let picked = self.app.dialog().file().set_title("Select APKs to install").add_filter("Android package", &["apk"]).blocking_pick_files();
        let picked = picked?;
        let paths: Vec<String> = picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    pub fn rc_install(&self, serial: String, apk_path: String, grant_perms: bool, downgrade: bool) -> RcCommandResult {
        let res = self.adb.install(&serial, &apk_path, grant_perms, downgrade);
        let output = rc::text(&res);
        let lower = output.to_lowercase();
        RcCommandResult { ok: res.ok && !lower.contains("failure") && !lower.contains("install_failed"), output, file: None }
    }

    pub fn rc_uninstall(&self, serial: String, pkg: String) -> RcCommandResult {
        let output = rc::text(&self.adb.uninstall(&serial, &pkg));
        RcCommandResult { ok: output.to_lowercase().contains("success"), output, file: None }
    }

    pub fn rc_set_home(&self, serial: String, component: String) -> RcCommandResult {
        let res = self.adb.set_home_activity(&serial, &component);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    pub fn rc_launchers(&self, serial: String) -> Vec<String> {
        self.adb.list_launchers(&serial)
    }

    pub fn rc_shell(&self, serial: String, command: String) -> RcCommandResult {
        let res = self.adb.shell(&serial, &command);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    pub fn rc_app_action(&self, serial: String, pkg: String, action: String) -> RcCommandResult {
        let res = match action.as_str() {
            "launch" => self.adb.launch_app(&serial, &pkg),
            "force-stop" => self.adb.force_stop(&serial, &pkg),
            "enable" => self.adb.set_enabled(&serial, &pkg, true),
            "disable" => self.adb.set_enabled(&serial, &pkg, false),
            "clear" => self.adb.clear_data(&serial, &pkg),
            other => return RcCommandResult { ok: false, output: format!("Unknown action: {other}"), file: None },
        };
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    pub fn rc_root(&self, serial: String) -> RcRootResult {
        self.adb.try_root(&serial)
    }

    pub fn rc_disconnect(&self) -> RcCommandResult {
        self.adb.kill_server();
        RcCommandResult { ok: true, output: String::new(), file: None }
    }

    pub fn rc_pick_folder(&self) -> Option<String> {
        use tauri_plugin_dialog::DialogExt;
        self.app.dialog().file().set_title("Choose a folder").blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
    }

    pub fn rc_pull_apks(&self, serial: String, pkgs: Vec<String>, out_dir: String) -> Vec<RcPullResult> {
        let dir = std::path::PathBuf::from(&out_dir);
        let total = pkgs.len();
        let mut results = Vec::new();
        for (index, pkg) in pkgs.iter().enumerate() {
            let _ = self.app.emit("rc:pull-progress", RcPullProgress { pkg: pkg.clone(), index: index + 1, total });
            results.push(self.adb.pull_apk(&serial, pkg, &dir));
        }
        results
    }

    pub fn rc_ls(&self, serial: String, dir: String) -> RcCommandResult {
        let res = self.adb.list_dir(&serial, &dir);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    pub fn rc_screen(&self, serial: String) -> RcScreenResult {
        use base64::Engine;
        match self.adb.screencap(&serial) {
            None => RcScreenResult { ok: false, image: None },
            Some(png) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                *self.rc_last_screen.lock() = Some(png);
                RcScreenResult { ok: true, image: Some(format!("data:image/png;base64,{b64}")) }
            }
        }
    }

    pub fn rc_screen_save(&self) -> RcCommandResult {
        let png = match self.rc_last_screen.lock().clone() {
            Some(p) => p,
            None => return RcCommandResult { ok: false, output: "There is no capture to save yet.".into(), file: None },
        };
        let stamp = chrono::Local::now().format("%Y-%m-%d-%H-%M-%S").to_string();
        use tauri_plugin_dialog::DialogExt;
        let path = self.app.dialog().file().set_title("Save screenshot").set_file_name(&format!("controller-{stamp}.png")).add_filter("PNG image", &["png"]).blocking_save_file().and_then(|p| p.into_path().ok());
        let path = match path {
            Some(p) => p,
            None => return RcCommandResult { ok: false, output: "cancelled".into(), file: None },
        };
        match std::fs::write(&path, &png) {
            Ok(()) => RcCommandResult { ok: true, output: String::new(), file: Some(path.to_string_lossy().into_owned()) },
            Err(e) => RcCommandResult { ok: false, output: e.to_string(), file: None },
        }
    }

    pub fn rc_pull(&self, serial: String, remote: String) -> RcCommandResult {
        let base = remote.split('/').filter(|s| !s.is_empty()).next_back().unwrap_or("file").to_string();
        use tauri_plugin_dialog::DialogExt;
        let path = self.app.dialog().file().set_title("Save pulled file").set_file_name(&base).blocking_save_file().and_then(|p| p.into_path().ok());
        let path = match path {
            Some(p) => p,
            None => return RcCommandResult { ok: false, output: "cancelled".into(), file: None },
        };
        let path_str = path.to_string_lossy().into_owned();
        let res = self.adb.pull(&serial, &remote, &path_str);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: if res.ok { Some(path_str) } else { None } }
    }

    pub fn rc_push(&self, serial: String, remote_dir: String) -> RcCommandResult {
        use tauri_plugin_dialog::DialogExt;
        let local = self.app.dialog().file().set_title("Select a file to push").blocking_pick_file().and_then(|p| p.into_path().ok());
        let local = match local {
            Some(p) => p,
            None => return RcCommandResult { ok: false, output: "cancelled".into(), file: None },
        };
        let base = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let remote = format!("{}/{base}", remote_dir.trim_end_matches('/'));
        let res = self.adb.push(&serial, &local.to_string_lossy(), &remote);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    pub fn rc_settings_get(&self, serial: String, ns: String, key: String) -> RcCommandResult {
        let res = self.adb.settings_get(&serial, &ns, &key);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    pub fn rc_settings_put(&self, serial: String, ns: String, key: String, value: String) -> RcCommandResult {
        let res = self.adb.settings_put(&serial, &ns, &key, &value);
        RcCommandResult { ok: res.ok, output: rc::text(&res), file: None }
    }

    // ── Fastboot explorer ────────────────────────────────────────────────────

    fn fb_disconnect_now(&self) {
        if let Some(client) = self.fb_client.lock().take() {
            client.close();
        }
    }

    fn fb_connect(&self) -> FastbootActionResult {
        self.fb_disconnect_now();
        match connect_fastboot(&self.dll_paths) {
            Ok(transport) => {
                let label = transport.label.clone();
                *self.fb_client.lock() = Some(FastbootClient::new(transport));
                FastbootActionResult { ok: true, message: format!("Connected to {label}.") }
            }
            Err(e) => FastbootActionResult {
                ok: false,
                message: if e.is_empty() { "No device is in fastboot mode. Put the aircraft into fastboot first, and make sure its fastboot interface is bound to the libusb-win32 driver.".into() } else { e },
            },
        }
    }

    pub fn fastboot_scan(&self) -> FastbootScanResult {
        if self.fb_busy.load(Ordering::SeqCst) {
            return FastbootScanResult { ok: false, message: "A fastboot operation is already running.".into(), variables: None };
        }
        let connected = self.fb_connect();
        if !connected.ok {
            return FastbootScanResult { ok: false, message: connected.message, variables: None };
        }
        let mut guard = self.fb_client.lock();
        match guard.as_mut() {
            Some(client) => FastbootScanResult { ok: true, message: connected.message, variables: Some(client.getvar_all()) },
            None => FastbootScanResult { ok: false, message: "Connected, but the device went away.".into(), variables: None },
        }
    }

    pub fn fastboot_reboot(&self, target: String) -> FastbootActionResult {
        if !["reboot", "reboot-bootloader", "reboot-fastboot", "continue"].contains(&target.as_str()) {
            return FastbootActionResult { ok: false, message: "Unknown reboot target.".into() };
        }
        let result = {
            let mut guard = self.fb_client.lock();
            match guard.as_mut() {
                None => return FastbootActionResult { ok: false, message: "Not connected to a fastboot device.".into() },
                Some(client) => client.reboot(&target),
            }
        };
        match result {
            Ok(()) => {
                self.fb_disconnect_now();
                FastbootActionResult { ok: true, message: format!("Sent \"{target}\". The device is leaving fastboot.") }
            }
            Err(e) => FastbootActionResult { ok: false, message: e },
        }
    }

    pub fn fastboot_erase(&self, partition: String) -> FastbootActionResult {
        if self.fb_client.lock().is_none() {
            return FastbootActionResult { ok: false, message: "Not connected to a fastboot device.".into() };
        }
        if self.fb_busy.load(Ordering::SeqCst) {
            return FastbootActionResult { ok: false, message: "A fastboot operation is already running.".into() };
        }
        if let Some(problem) = fastboot::partition_problem(&partition) {
            return FastbootActionResult { ok: false, message: problem };
        }
        self.fb_busy.store(true, Ordering::SeqCst);
        let result = {
            let mut guard = self.fb_client.lock();
            guard.as_mut().map(|c| c.erase(&partition))
        };
        self.fb_busy.store(false, Ordering::SeqCst);
        match result {
            Some(Ok(())) => FastbootActionResult { ok: true, message: format!("Erased \"{partition}\".") },
            Some(Err(e)) => FastbootActionResult { ok: false, message: e },
            None => FastbootActionResult { ok: false, message: "Not connected to a fastboot device.".into() },
        }
    }

    pub fn fastboot_flash(&self, partition: String) -> FastbootActionResult {
        if self.fb_client.lock().is_none() {
            return FastbootActionResult { ok: false, message: "Not connected to a fastboot device.".into() };
        }
        if self.fb_busy.load(Ordering::SeqCst) {
            return FastbootActionResult { ok: false, message: "A fastboot operation is already running.".into() };
        }
        if let Some(problem) = fastboot::partition_problem(&partition) {
            return FastbootActionResult { ok: false, message: problem };
        }
        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title(&format!("Choose the image to write to \"{partition}\""))
            .add_filter("Partition image", &["img", "bin", "mbn", "elf", "raw"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok());
        let path = match path {
            Some(p) => p,
            None => return FastbootActionResult { ok: false, message: String::new() },
        };
        self.fb_busy.store(true, Ordering::SeqCst);
        let result = (|| -> FastbootActionResult {
            let image = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => return FastbootActionResult { ok: false, message: e.to_string() },
            };
            let mut guard = self.fb_client.lock();
            let client = match guard.as_mut() {
                Some(c) => c,
                None => return FastbootActionResult { ok: false, message: "Not connected to a fastboot device.".into() },
            };
            if let Some(max) = client.max_download_size() {
                if image.len() as u64 > max {
                    return FastbootActionResult { ok: false, message: format!("The image is {} bytes but the device accepts at most {max}. A larger partition needs a sparse image, which this tool does not build.", image.len()) };
                }
            }
            let app = self.app.clone();
            let part = partition.clone();
            let mut on_progress = |p: fastboot::FlashProgress| {
                let _ = app.emit("fastboot:flash-progress", FastbootFlashProgress { partition: part.clone(), sent: p.sent, total: p.total });
            };
            match client.flash(&partition, &image, &mut on_progress) {
                Ok(()) => FastbootActionResult { ok: true, message: format!("Wrote {} bytes to \"{partition}\".", image.len()) },
                Err(e) => FastbootActionResult { ok: false, message: e },
            }
        })();
        self.fb_busy.store(false, Ordering::SeqCst);
        result
    }

    pub fn fastboot_watch(self: &Arc<Self>, on: bool) -> FastbootActionResult {
        if !on {
            self.fb_watch.store(false, Ordering::SeqCst);
            return FastbootActionResult { ok: true, message: "Stopped waiting.".into() };
        }
        // Already connected: report straight away.
        if self.fb_client.lock().is_some() {
            let vars = self.fb_client.lock().as_mut().map(|c| c.getvar_all());
            let _ = self.app.emit("fastboot:found", FastbootScanResult { ok: true, message: "Connected.".into(), variables: vars });
            return FastbootActionResult { ok: true, message: "Waiting for a fastboot device — power-cycle the aircraft now.".into() };
        }
        self.fb_watch.store(true, Ordering::SeqCst);
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let started = now_ms();
            const WATCH_TIMEOUT_MS: u64 = 180000;
            while me.fb_watch.load(Ordering::SeqCst) {
                if me.fb_busy.load(Ordering::SeqCst) || me.fb_client.lock().is_some() {
                    std::thread::sleep(Duration::from_millis(150));
                    continue;
                }
                if now_ms() - started > WATCH_TIMEOUT_MS {
                    me.fb_watch.store(false, Ordering::SeqCst);
                    let _ = me.app.emit("fastboot:watch-stopped", serde_json::json!({ "reason": "timeout" }));
                    return;
                }
                match connect_fastboot(&me.dll_paths) {
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    Ok(transport) => {
                        me.fb_watch.store(false, Ordering::SeqCst);
                        let label = transport.label.clone();
                        let mut client = FastbootClient::new(transport);
                        let variables = client.getvar_all();
                        *me.fb_client.lock() = Some(client);
                        let _ = me.app.emit("fastboot:found", FastbootScanResult { ok: true, message: format!("Caught {label} in fastboot."), variables: Some(variables) });
                        return;
                    }
                }
            }
        });
        FastbootActionResult { ok: true, message: "Waiting for a fastboot device — power-cycle the aircraft now.".into() }
    }

    pub fn fastboot_disconnect(&self) {
        self.fb_watch.store(false, Ordering::SeqCst);
        if !self.fb_busy.load(Ordering::SeqCst) {
            self.fb_disconnect_now();
        }
    }

    // ── Partition image explorer ─────────────────────────────────────────────

    fn img_close_now(&self) {
        *self.img_volume.lock() = None;
        *self.img_source.lock() = None;
    }

    pub fn image_open(&self) -> ImageOpenResult {
        if self.img_extracting.load(Ordering::SeqCst) {
            return ImageOpenResult { ok: false, message: Some("An extraction is still running.".into()), path: None, size: None, partitions: None };
        }
        use tauri_plugin_dialog::DialogExt;
        let path = self
            .app
            .dialog()
            .file()
            .set_title("Open a partition image")
            .add_filter("Partition images", &["img", "bin", "ext4", "dd", "raw", "dump"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok());
        let path = match path {
            Some(p) => p,
            None => return ImageOpenResult { ok: false, message: None, path: None, size: None, partitions: None },
        };
        self.img_close_now();
        match ImageSource::open(&path) {
            Ok(source) => {
                let partitions = ext4::probe_partitions(&source);
                let size = source.size;
                *self.img_source.lock() = Some(source);
                ImageOpenResult { ok: true, message: None, path: Some(path.to_string_lossy().into_owned()), size: Some(size), partitions: Some(partitions) }
            }
            Err(e) => {
                self.img_close_now();
                ImageOpenResult { ok: false, message: Some(e), path: None, size: None, partitions: None }
            }
        }
    }

    pub fn image_mount(&self, offset: u64) -> ImageMountResult {
        let source = match self.img_source.lock().clone() {
            Some(s) => s,
            None => return ImageMountResult { ok: false, message: Some("No image is open.".into()), stats: None },
        };
        match Ext4Volume::open(source, offset) {
            Ok(volume) => {
                let stats = volume.stats();
                *self.img_volume.lock() = Some(volume);
                ImageMountResult { ok: true, message: None, stats: Some(stats) }
            }
            Err(e) => {
                *self.img_volume.lock() = None;
                ImageMountResult { ok: false, message: Some(e), stats: None }
            }
        }
    }

    pub fn image_list(&self, folder: String) -> ImageListResult {
        let mut guard = self.img_volume.lock();
        match guard.as_mut() {
            None => ImageListResult { ok: false, message: Some("No filesystem is open.".into()), entries: None },
            Some(volume) => match volume.list(&folder) {
                Ok(entries) => ImageListResult { ok: true, message: None, entries: Some(entries) },
                Err(e) => ImageListResult { ok: false, message: Some(e), entries: None },
            },
        }
    }

    pub fn image_preview(&self, file: String) -> ImagePreview {
        let mut guard = self.img_volume.lock();
        let volume = match guard.as_mut() {
            Some(v) => v,
            None => return ImagePreview { ok: false, message: Some("No filesystem is open.".into()), text: None, hex: None, truncated: None },
        };
        let entry = match volume.stat(&file) {
            Ok(e) => e,
            Err(e) => return ImagePreview { ok: false, message: Some(e), text: None, hex: None, truncated: None },
        };
        let head = match volume.read_head(&file, image_explorer::PREVIEW_BYTES) {
            Ok(h) => h,
            Err(e) => return ImagePreview { ok: false, message: Some(e), text: None, hex: None, truncated: None },
        };
        if image_explorer::looks_textual(&head) {
            ImagePreview { ok: true, message: None, text: Some(String::from_utf8_lossy(&head).into_owned()), hex: None, truncated: Some(entry.size > head.len() as u64) }
        } else {
            let shown = &head[..head.len().min(image_explorer::HEX_PREVIEW_BYTES)];
            ImagePreview { ok: true, message: None, text: None, hex: Some(image_explorer::hex_dump(shown)), truncated: Some(entry.size > shown.len() as u64) }
        }
    }

    pub fn image_extract(&self, remote: String) -> ImageExtractResult {
        if self.img_volume.lock().is_none() {
            return ImageExtractResult { ok: false, message: "No filesystem is open.".into(), files: None, bytes: None };
        }
        if self.img_extracting.load(Ordering::SeqCst) {
            return ImageExtractResult { ok: false, message: "An extraction is already running.".into(), files: None, bytes: None };
        }
        // Determine the entry type under the lock, without holding it over dialogs.
        let entry = {
            let mut guard = self.img_volume.lock();
            match guard.as_mut().map(|v| v.stat(&remote)) {
                Some(Ok(e)) => e,
                Some(Err(e)) => return ImageExtractResult { ok: false, message: e, files: None, bytes: None },
                None => return ImageExtractResult { ok: false, message: "No filesystem is open.".into(), files: None, bytes: None },
            }
        };
        use tauri_plugin_dialog::DialogExt;
        let app = self.app.clone();
        let emit = move |t: &ImageExtractProgress| {
            let _ = app.emit("image:progress", t.clone());
        };

        if entry.kind == "file" {
            if entry.inline == Some(true) {
                return ImageExtractResult { ok: false, message: "This file is stored inside its record, which is not supported.".into(), files: None, bytes: None };
            }
            let path = self.app.dialog().file().set_title("Extract file").set_file_name(&image_explorer::safe_name(&entry.name)).blocking_save_file().and_then(|p| p.into_path().ok());
            let path = match path {
                Some(p) => p,
                None => return ImageExtractResult { ok: false, message: String::new(), files: None, bytes: None },
            };
            self.img_extracting.store(true, Ordering::SeqCst);
            let mut tally = ImageExtractProgress { files: 0, bytes: 0, name: entry.name.clone() };
            let result = {
                let mut guard = self.img_volume.lock();
                match guard.as_mut() {
                    Some(volume) => image_explorer::write_out(volume, &remote, &path, &mut tally, &emit),
                    None => Err("No filesystem is open.".into()),
                }
            };
            self.img_extracting.store(false, Ordering::SeqCst);
            return match result {
                Ok(()) => ImageExtractResult { ok: true, message: format!("Extracted to {}", path.to_string_lossy()), files: Some(1), bytes: Some(tally.bytes) },
                Err(e) => ImageExtractResult { ok: false, message: e, files: Some(tally.files), bytes: Some(tally.bytes) },
            };
        }
        if entry.kind != "dir" {
            return ImageExtractResult { ok: false, message: "Only files and folders can be extracted.".into(), files: None, bytes: None };
        }
        let dir = self.app.dialog().file().set_title("Choose where to extract the folder").blocking_pick_folder().and_then(|p| p.into_path().ok());
        let dir = match dir {
            Some(p) => p,
            None => return ImageExtractResult { ok: false, message: String::new(), files: None, bytes: None },
        };
        self.img_extracting.store(true, Ordering::SeqCst);
        let folder_name = if remote == "/" || remote.is_empty() { "image-root".to_string() } else { image_explorer::safe_name(&entry.name) };
        let target = dir.join(folder_name);
        let mut tally = ImageExtractProgress { files: 0, bytes: 0, name: String::new() };
        let mut skipped: Vec<String> = Vec::new();
        let start = if remote.is_empty() { "/".to_string() } else { remote.clone() };
        let result = {
            let mut guard = self.img_volume.lock();
            match guard.as_mut() {
                Some(volume) => image_explorer::extract_tree(volume, &start, &target, &mut tally, &mut skipped, &emit),
                None => Err("No filesystem is open.".into()),
            }
        };
        self.img_extracting.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                let note = if skipped.is_empty() { String::new() } else { format!(" {} link or special entries were skipped.", skipped.len()) };
                ImageExtractResult { ok: true, message: format!("Extracted {} file{} to {}.{note}", tally.files, if tally.files == 1 { "" } else { "s" }, target.to_string_lossy()), files: Some(tally.files), bytes: Some(tally.bytes) }
            }
            Err(e) => ImageExtractResult { ok: false, message: e, files: Some(tally.files), bytes: Some(tally.bytes) },
        }
    }

    pub fn image_close(&self) {
        if !self.img_extracting.load(Ordering::SeqCst) {
            self.img_close_now();
        }
    }
}

fn hms_faults_of(inner: &Inner) -> Vec<HmsFault> {
    let mut out: Vec<HmsFault> = inner.hms_records.values().cloned().collect();
    for list in inner.hms_live.values() {
        out.extend(list.iter().cloned());
    }
    out
}

fn upsert_record(inner: &mut Inner, fault: HmsFault) -> bool {
    let key = format!("{}:{}", fault.code_hex, fault.sensor_index);
    if let Some(existing) = inner.hms_records.get_mut(&key) {
        existing.level = fault.level;
        false
    } else {
        inner.hms_records.insert(key, fault);
        true
    }
}

fn set_live(inner: &mut Inner, source: &str, faults: Vec<HmsFault>) -> bool {
    let sig = |list: &[HmsFault]| {
        list.iter().map(|f| format!("{}|{}", f.code_hex, f.text)).collect::<Vec<_>>().join("\n")
    };
    let previous = inner.hms_live.get(source).map(|v| sig(v)).unwrap_or_default();
    if previous == sig(&faults) {
        return false;
    }
    if faults.is_empty() {
        inner.hms_live.remove(source);
    } else {
        inner.hms_live.insert(source.to_string(), faults);
    }
    true
}

fn publish_hms(app: &AppHandle, inner: &Arc<Mutex<Inner>>) {
    let state = {
        let mut g = inner.lock();
        let faults = hms_faults_of(&g);
        g.state.hms = Some(HmsState { faults, updated_at: now_ms() });
        g.state.clone()
    };
    let _ = app.emit("drone:state", state);
}

/// Maps the reply counts of a service run to the message the UI shows.
fn interpret(action: &str, replies: u32, serials: &[String], details: Vec<String>) -> ServiceResult {
    let acked = replies > 0;
    let message = match action {
        "factory-enter" => if acked { "Factory mode entered." } else { "No module acknowledged factory mode." }.to_string(),
        "factory-exit" => if acked { "Factory mode exited." } else { "No module acknowledged the exit." }.to_string(),
        "esc-repair" => if acked {
            "ESC repair command accepted. Restart the aircraft, then recheck the fault codes."
        } else {
            "The flight controller did not acknowledge the command."
        }
        .to_string(),
        "rc-pair" => if acked {
            "Pairing started. Put the remote controller into pairing mode."
        } else {
            "The aircraft did not acknowledge pairing."
        }
        .to_string(),
        "camera-serials" => {
            if serials.is_empty() { "No camera serial was reported.".to_string() } else { format!("Camera serial: {}", serials.join(", ")) }
        }
        "link-test" => format!("{replies} of 3 radios responded."),
        "battery-info" => if acked { "Battery responded (see raw reply below)." } else { "The battery did not respond." }.to_string(),
        "imu-status" => if acked { "Flight controller IMU status returned." } else { "The flight controller did not respond." }.to_string(),
        "vision-scan" => {
            if !serials.is_empty() {
                format!("Vision/ToF serials: {}", serials.join(", "))
            } else if acked {
                format!("{replies} vision sensor(s) responded.")
            } else {
                "No vision/ToF sensor responded.".to_string()
            }
        }
        "fc-param-count" => if acked { "Parameter table info returned (see details below)." } else { "The flight controller did not respond." }.to_string(),
        "camera-info" => {
            if !serials.is_empty() {
                format!("Camera serial: {}. Calibration faults, if any, appear in the HMS scan.", serials.join(", "))
            } else if acked {
                "Camera responded. Calibration faults, if any, appear in the HMS scan.".to_string()
            } else {
                "The camera did not respond.".to_string()
            }
        }
        "vision-cal" => {
            let not_cal = details.iter().filter(|d| d.contains("not calibrated")).count();
            if !acked {
                "No vision module reported calibration status.".to_string()
            } else if not_cal == 0 {
                "Vision sensors report calibrated.".to_string()
            } else {
                format!("{not_cal} vision module(s) report NOT calibrated.")
            }
        }
        "tof-reset" => if acked {
            "ToF calibration reset sent. Power-cycle the aircraft, then let it recalibrate on a flat, level surface."
        } else {
            "The ToF module did not acknowledge the reset."
        }
        .to_string(),
        "vision-recover" => {
            if acked {
                format!(
                    "Vision recovery sent; {} of {} sensors report a serial. Restart the aircraft, then read the fault codes again.",
                    serials.len(),
                    service::VISION_SENSORS.len()
                )
            } else {
                "The vision module did not acknowledge the recovery command.".to_string()
            }
        }
        "aircraft-restart" => if acked { "The aircraft is restarting." } else { "The battery did not acknowledge the restart." }.to_string(),
        "aircraft-power-off" => if acked { "The aircraft is switching off." } else { "The battery did not acknowledge the command." }.to_string(),
        _ => "Done.".to_string(),
    };
    let ok = match action {
        "camera-serials" => !serials.is_empty(),
        "vision-cal" => acked && !details.iter().any(|d| d.contains("not calibrated")),
        _ => acked,
    };
    let details = if action == "aircraft-restart" || action == "aircraft-power-off" { Vec::new() } else { details };
    ServiceResult { action: action.into(), ok, message, details }
}

// A monotonically increasing id is handy if several sessions ever exist.
#[allow(dead_code)]
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);
#[allow(dead_code)]
fn next_session_id() -> u64 {
    SESSION_SEQ.fetch_add(1, Ordering::Relaxed)
}
