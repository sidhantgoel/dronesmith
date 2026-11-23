//! Tauri backend for the DJI service app. Exposes the service features as Tauri
//! commands; the React UI calls them through the bridge in
//! src/renderer/tauriBridge.ts.

mod battery;
mod config;
mod console_cmd;
mod diagnostics;
mod duml;
mod ext4;
mod fastboot;
mod flasher;
mod ftp;
mod image_explorer;
mod gimbal_cal;
mod hms;
mod imu_cal;
mod models;
mod motor_test;
mod params;
mod partition;
mod rc;
mod repair;
mod service;
mod session;
mod telemetry;
mod usb0;

use std::sync::Arc;
use battery::BatteryReading;
use console_cmd::{ConsoleReply, ConsoleRequest};
use diagnostics::{DiagnosticReport, ReportSaveResult, SaveReportInput};
use fastboot::{FastbootActionResult, FastbootScanResult};
use flasher::{FlashState, FlashValidation};
use ftp::{FtpConnectOptions, FtpConnectResult, FtpDownloadResult, FtpListResult};
use image_explorer::{ImageExtractResult, ImageListResult, ImageMountResult, ImageOpenResult, ImagePreview};
use motor_test::{GimbalAngles, MotorTestResult};
use params::{ParamBackupFileResult, ParamReadResult, ParamScanResult, ParamWriteResult};
use partition::PartitionBackupResult;
use rc::{RcCommandResult, RcConnectResult, RcInfo, RcPackage, RcPullResult, RcRootResult, RcScreenResult};
use repair::{SerialRow, SerialWriteResult};
use service::ServiceResult;
use session::{DroneState, HmsReadResult, Session};
use telemetry::TelemetryReading;
use tauri::Manager;

/// Returns the current drone state (status, model, modules, serial).
#[tauri::command]
fn drone_get_state(session: tauri::State<'_, Arc<Session>>) -> DroneState {
    session.state()
}

/// Runs a one-shot service command (factory mode, reads, restart, etc.).
#[tauri::command]
fn service_run(session: tauri::State<'_, Arc<Session>>, action: String) -> ServiceResult {
    session.run_service(&action)
}

/// Nudges the aircraft to report HMS faults and returns a summary.
#[tauri::command]
fn hms_read(session: tauri::State<'_, Arc<Session>>) -> HmsReadResult {
    session.read_hms_now()
}

/// Clears the accumulated HMS fault records.
#[tauri::command]
fn hms_clear(session: tauri::State<'_, Arc<Session>>) {
    session.clear_hms();
}

#[tauri::command]
fn param_read_all(session: tauri::State<'_, Arc<Session>>) -> ParamScanResult {
    session.read_all_params()
}

#[tauri::command]
fn param_cancel_read(session: tauri::State<'_, Arc<Session>>) {
    session.cancel_read_params();
}

#[tauri::command]
fn param_write(
    session: tauri::State<'_, Arc<Session>>,
    name: String,
    index: u16,
    value: f64,
    size: u16,
    type_id: u16,
) -> ParamWriteResult {
    session.write_param(name, index, value, size, type_id)
}

/// Reads the smart battery (static pack info, live telemetry, cells, serial).
#[tauri::command]
fn battery_read(session: tauri::State<'_, Arc<Session>>) -> BatteryReading {
    session.read_battery()
}

/// Returns the most recent decoded flight-controller status frame.
#[tauri::command]
fn telemetry_get(session: tauri::State<'_, Arc<Session>>) -> TelemetryReading {
    session.get_telemetry()
}

/// Starts a gimbal calibration (jointCoarse, linearHall, or advanced). Progress
/// arrives in the state's `calibration` field.
#[tauri::command]
fn drone_calibrate(session: tauri::State<'_, Arc<Session>>, kind: String, allow_restricted: Option<bool>) -> Result<(), String> {
    session.inner().start_calibration(kind, allow_restricted.unwrap_or(false))
}

/// Starts the IMU calibration; progress arrives in the state's `imuCalibration`.
#[tauri::command]
fn imu_calibrate(session: tauri::State<'_, Arc<Session>>) -> Result<(), String> {
    session.inner().start_imu_calibration()
}

/// Requests a running IMU calibration to stop.
#[tauri::command]
fn imu_stop(session: tauri::State<'_, Arc<Session>>) {
    session.stop_imu_calibration();
}

#[tauri::command]
fn gimbal_move(session: tauri::State<'_, Arc<Session>>, axis: Option<String>, target: GimbalAngles, seconds: f64, allow_untested: bool) -> MotorTestResult {
    session.gimbal_test_move(axis, target, seconds, allow_untested)
}

#[tauri::command]
fn gimbal_jog(session: tauri::State<'_, Arc<Session>>, axis: String, delta: f64, seconds: f64, allow_untested: bool) -> MotorTestResult {
    session.gimbal_test_jog(axis, delta, seconds, allow_untested)
}

#[tauri::command]
fn gimbal_stop(session: tauri::State<'_, Arc<Session>>) -> MotorTestResult {
    session.gimbal_test_stop()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PropTestOptions {
    props_removed: bool,
    allow_untested: bool,
}

#[tauri::command]
fn prop_run(session: tauri::State<'_, Arc<Session>>, motors: Vec<u8>, percent: f64, seconds: f64, options: PropTestOptions) -> MotorTestResult {
    session.run_prop_test(motors, percent, seconds, options.props_removed, options.allow_untested)
}

#[tauri::command]
fn prop_stop(session: tauri::State<'_, Arc<Session>>) -> MotorTestResult {
    session.stop_prop_test()
}

#[tauri::command]
fn motor_beep(session: tauri::State<'_, Arc<Session>>, motor: u8, on: bool, allow_untested: bool) -> MotorTestResult {
    session.motor_beep(motor, on, allow_untested)
}

#[tauri::command]
fn motor_beep_stop(session: tauri::State<'_, Arc<Session>>) -> MotorTestResult {
    session.motor_beep_stop()
}

/// Runs the gimbal IMU repair; progress arrives in the state's `repair` field.
#[tauri::command]
fn repair_gimbal_imu(session: tauri::State<'_, Arc<Session>>, method: String) -> MotorTestResult {
    session.repair_gimbal_imu(method)
}

/// Reads the serial number of every module that reports one.
#[tauri::command]
fn serial_read_all(session: tauri::State<'_, Arc<Session>>) -> Vec<SerialRow> {
    session.read_serials()
}

/// Writes a module's serial number in factory mode and reads it back.
#[tauri::command]
fn serial_write(session: tauri::State<'_, Arc<Session>>, component: String, serial: String) -> SerialWriteResult {
    session.write_serial(component, serial)
}

/// Reads one flight-controller parameter by name (hash addressing).
#[tauri::command]
fn param_read(session: tauri::State<'_, Arc<Session>>, name: String) -> ParamReadResult {
    session.read_param(name)
}

/// Command console: sends one command and returns the answer, if any.
#[tauri::command]
fn console_send(session: tauri::State<'_, Arc<Session>>, request: ConsoleRequest) -> ConsoleReply {
    session.console_send(request)
}

/// Command console: starts or stops forwarding received frames.
#[tauri::command]
fn console_watch(session: tauri::State<'_, Arc<Session>>, on: bool) {
    session.inner().console_watch(on);
}

/// Runs the full read-only check and returns the report.
#[tauri::command]
fn diag_run(session: tauri::State<'_, Arc<Session>>) -> Option<DiagnosticReport> {
    session.run_diagnostics()
}

/// Saves a full-check report as a text file the operator chooses.
#[tauri::command]
fn diag_save_report(session: tauri::State<'_, Arc<Session>>, report: SaveReportInput) -> ReportSaveResult {
    session.save_report(report)
}

/// Writes the given parameter-backup JSON to a file the user picks.
#[tauri::command]
fn param_save_backup(session: tauri::State<'_, Arc<Session>>, json: String) -> ParamBackupFileResult {
    session.save_param_backup(json)
}

/// Opens a parameter-backup file the user picks and returns its text.
#[tauri::command]
fn param_load_backup(session: tauri::State<'_, Arc<Session>>) -> ParamBackupFileResult {
    session.load_param_backup()
}

/// Reads a partition by id and offers to save it. Read-only.
#[tauri::command]
fn partition_backup(session: tauri::State<'_, Arc<Session>>, id: u8) -> PartitionBackupResult {
    session.backup_partition(id)
}

/// Opens a file dialog to choose a firmware package; returns its path.
#[tauri::command]
fn flash_pick(session: tauri::State<'_, Arc<Session>>) -> Option<String> {
    session.pick_firmware()
}

/// Dry-run: reads the package and plans the flash without touching the device.
#[tauri::command]
fn flash_validate(session: tauri::State<'_, Arc<Session>>, package_path: String) -> FlashValidation {
    session.validate_flash(package_path)
}

/// Begins the real flash. Progress arrives via the `drone:flash` event.
#[tauri::command]
fn flash_start(session: tauri::State<'_, Arc<Session>>, package_path: String) -> Result<(), String> {
    session.inner().start_flash(package_path)
}

/// Requests the running flash stop at the next safe point.
#[tauri::command]
fn flash_cancel(session: tauri::State<'_, Arc<Session>>) {
    session.cancel_flash();
}

#[tauri::command]
fn flash_get_state(session: tauri::State<'_, Arc<Session>>) -> FlashState {
    session.get_flash_state()
}

/// Connects to the drone's USB FTP and signs in.
#[tauri::command]
fn ftp_connect(session: tauri::State<'_, Arc<Session>>, options: Option<FtpConnectOptions>) -> FtpConnectResult {
    session.ftp_connect(options)
}

#[tauri::command]
fn ftp_list(session: tauri::State<'_, Arc<Session>>, dir: String) -> FtpListResult {
    session.ftp_list(dir)
}

#[tauri::command]
fn ftp_download(session: tauri::State<'_, Arc<Session>>, dir: String, name: String) -> FtpDownloadResult {
    session.ftp_download(dir, name)
}

#[tauri::command]
fn ftp_disconnect(session: tauri::State<'_, Arc<Session>>) {
    session.ftp_disconnect();
}

// ── Remote controller (ADB) ──────────────────────────────────────────────────

#[tauri::command]
fn rc_connect(session: tauri::State<'_, Arc<Session>>) -> RcConnectResult {
    session.rc_connect()
}

#[tauri::command]
fn rc_info(session: tauri::State<'_, Arc<Session>>, serial: String) -> RcInfo {
    session.rc_info(serial)
}

#[tauri::command]
fn rc_packages(session: tauri::State<'_, Arc<Session>>, serial: String, third_party_only: bool) -> Vec<RcPackage> {
    session.rc_packages(serial, third_party_only)
}

#[tauri::command]
fn rc_pick_apk(session: tauri::State<'_, Arc<Session>>) -> Option<Vec<String>> {
    session.rc_pick_apk()
}

#[tauri::command]
fn rc_install(session: tauri::State<'_, Arc<Session>>, serial: String, apk_path: String, grant_perms: bool, downgrade: bool) -> RcCommandResult {
    session.rc_install(serial, apk_path, grant_perms, downgrade)
}

#[tauri::command]
fn rc_uninstall(session: tauri::State<'_, Arc<Session>>, serial: String, pkg: String) -> RcCommandResult {
    session.rc_uninstall(serial, pkg)
}

#[tauri::command]
fn rc_set_home(session: tauri::State<'_, Arc<Session>>, serial: String, component: String) -> RcCommandResult {
    session.rc_set_home(serial, component)
}

#[tauri::command]
fn rc_launchers(session: tauri::State<'_, Arc<Session>>, serial: String) -> Vec<String> {
    session.rc_launchers(serial)
}

#[tauri::command]
fn rc_shell(session: tauri::State<'_, Arc<Session>>, serial: String, command: String) -> RcCommandResult {
    session.rc_shell(serial, command)
}

#[tauri::command]
fn rc_app_action(session: tauri::State<'_, Arc<Session>>, serial: String, pkg: String, action: String) -> RcCommandResult {
    session.rc_app_action(serial, pkg, action)
}

#[tauri::command]
fn rc_root(session: tauri::State<'_, Arc<Session>>, serial: String) -> RcRootResult {
    session.rc_root(serial)
}

#[tauri::command]
fn rc_disconnect(session: tauri::State<'_, Arc<Session>>) -> RcCommandResult {
    session.rc_disconnect()
}

#[tauri::command]
fn rc_pick_folder(session: tauri::State<'_, Arc<Session>>) -> Option<String> {
    session.rc_pick_folder()
}

#[tauri::command]
fn rc_pull_apks(session: tauri::State<'_, Arc<Session>>, serial: String, pkgs: Vec<String>, out_dir: String) -> Vec<RcPullResult> {
    session.rc_pull_apks(serial, pkgs, out_dir)
}

#[tauri::command]
fn rc_ls(session: tauri::State<'_, Arc<Session>>, serial: String, dir: String) -> RcCommandResult {
    session.rc_ls(serial, dir)
}

#[tauri::command]
fn rc_screen(session: tauri::State<'_, Arc<Session>>, serial: String) -> RcScreenResult {
    session.rc_screen(serial)
}

#[tauri::command]
fn rc_screen_save(session: tauri::State<'_, Arc<Session>>) -> RcCommandResult {
    session.rc_screen_save()
}

#[tauri::command]
fn rc_pull(session: tauri::State<'_, Arc<Session>>, serial: String, remote: String) -> RcCommandResult {
    session.rc_pull(serial, remote)
}

#[tauri::command]
fn rc_push(session: tauri::State<'_, Arc<Session>>, serial: String, remote_dir: String) -> RcCommandResult {
    session.rc_push(serial, remote_dir)
}

#[tauri::command]
fn rc_settings_get(session: tauri::State<'_, Arc<Session>>, serial: String, ns: String, key: String) -> RcCommandResult {
    session.rc_settings_get(serial, ns, key)
}

#[tauri::command]
fn rc_settings_put(session: tauri::State<'_, Arc<Session>>, serial: String, ns: String, key: String, value: String) -> RcCommandResult {
    session.rc_settings_put(serial, ns, key, value)
}

// ── Fastboot explorer ─────────────────────────────────────────────────────────

#[tauri::command]
fn fastboot_scan(session: tauri::State<'_, Arc<Session>>) -> FastbootScanResult {
    session.fastboot_scan()
}

#[tauri::command]
fn fastboot_watch(session: tauri::State<'_, Arc<Session>>, on: bool) -> FastbootActionResult {
    session.inner().fastboot_watch(on)
}

#[tauri::command]
fn fastboot_reboot(session: tauri::State<'_, Arc<Session>>, target: String) -> FastbootActionResult {
    session.fastboot_reboot(target)
}

#[tauri::command]
fn fastboot_erase(session: tauri::State<'_, Arc<Session>>, partition: String) -> FastbootActionResult {
    session.fastboot_erase(partition)
}

#[tauri::command]
fn fastboot_flash(session: tauri::State<'_, Arc<Session>>, partition: String) -> FastbootActionResult {
    session.fastboot_flash(partition)
}

#[tauri::command]
fn fastboot_disconnect(session: tauri::State<'_, Arc<Session>>) {
    session.fastboot_disconnect();
}

// ── Partition image explorer ──────────────────────────────────────────────────

#[tauri::command]
fn image_open(session: tauri::State<'_, Arc<Session>>) -> ImageOpenResult {
    session.image_open()
}

#[tauri::command]
fn image_mount(session: tauri::State<'_, Arc<Session>>, offset: u64) -> ImageMountResult {
    session.image_mount(offset)
}

#[tauri::command]
fn image_list(session: tauri::State<'_, Arc<Session>>, folder: String) -> ImageListResult {
    session.image_list(folder)
}

#[tauri::command]
fn image_preview(session: tauri::State<'_, Arc<Session>>, file: String) -> ImagePreview {
    session.image_preview(file)
}

#[tauri::command]
fn image_extract(session: tauri::State<'_, Arc<Session>>, remote: String) -> ImageExtractResult {
    session.image_extract(remote)
}

#[tauri::command]
fn image_close(session: tauri::State<'_, Arc<Session>>) {
    session.image_close();
}

/// Candidate paths for the libusb-win32 DLL: the bundled resource, then the
/// project's resources folder for `tauri dev`.
fn read_hms_json(app: &tauri::AppHandle) -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("hms.json"));
        candidates.push(dir.join("resources").join("hms.json"));
    }
    candidates.push(std::path::PathBuf::from("resources/hms.json"));
    candidates.push(std::path::PathBuf::from("../resources/hms.json"));
    candidates.into_iter().find_map(|p| std::fs::read_to_string(p).ok())
}

/// Resolves the bundled adb executable path, falling back to PATH.
fn adb_exe(app: &tauri::AppHandle) -> String {
    let dir = app.path().resource_dir().ok();
    rc::adb_path(dir.as_deref())
}

fn libusb_paths(app: &tauri::AppHandle) -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        paths.push(dir.join("libusb0.dll").to_string_lossy().into_owned());
        paths.push(dir.join("resources").join("libusb0.dll").to_string_lossy().into_owned());
    }
    paths.push("resources/libusb0.dll".to_string());
    paths.push("../resources/libusb0.dll".to_string());
    paths
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let session = Session::new(handle.clone(), libusb_paths(&handle), read_hms_json(&handle), adb_exe(&handle));
            app.manage(Arc::clone(&session));
            session.run_loop();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            drone_get_state, service_run, hms_read, hms_clear,
            param_read_all, param_cancel_read, param_write,
            battery_read, telemetry_get,
            drone_calibrate, imu_calibrate, imu_stop,
            gimbal_move, gimbal_jog, gimbal_stop,
            prop_run, prop_stop, motor_beep, motor_beep_stop,
            repair_gimbal_imu, serial_read_all, serial_write,
            param_read, console_send, console_watch,
            diag_run, diag_save_report,
            param_save_backup, param_load_backup, partition_backup,
            flash_pick, flash_validate, flash_start, flash_cancel, flash_get_state,
            ftp_connect, ftp_list, ftp_download, ftp_disconnect,
            rc_connect, rc_info, rc_packages, rc_pick_apk, rc_install, rc_uninstall,
            rc_set_home, rc_launchers, rc_shell, rc_app_action, rc_root, rc_disconnect,
            rc_pick_folder, rc_pull_apks, rc_ls, rc_screen, rc_screen_save, rc_pull,
            rc_push, rc_settings_get, rc_settings_put,
            fastboot_scan, fastboot_watch, fastboot_reboot, fastboot_erase, fastboot_flash, fastboot_disconnect,
            image_open, image_mount, image_list, image_preview, image_extract, image_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running the DJI service app");
}
