//! The full check and the service report built from it.
//! Pure: turns answers into pass/attention/fail rows and
//! a plain-text report. The session runs the sweep.

use crate::battery::{self, BatterySnapshot};
use crate::hms::HmsFault;
use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};

pub const DIAGNOSTIC_STAGES: &[&str] =
    &["Fault codes", "Serial numbers", "Vision calibration", "Vision sensors", "Battery", "Radio links"];

const HEALTH_WARN: u32 = 80;
const HEALTH_FAIL: u32 = 60;
const CELL_SPREAD_WARN_MV: u16 = 50;
const CELL_SPREAD_FAIL_MV: u16 = 100;
const LEVEL_WARNING: u8 = 2;
const LEVEL_CRITICAL: u8 = 3;

#[derive(Clone, Serialize, Deserialize)]
pub struct DiagnosticCheck {
    pub group: String,
    pub name: String,
    /// ok | warn | fail | info
    pub status: String,
    pub detail: String,
}

impl DiagnosticCheck {
    pub fn new(group: &str, name: &str, status: &str, detail: String) -> Self {
        DiagnosticCheck { group: group.into(), name: name.into(), status: status.into(), detail }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DiagnosticModule {
    pub name: String,
    pub firmware: String,
    pub hardware: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_serial: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    pub modules: Vec<DiagnosticModule>,
    pub faults: Vec<HmsFault>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<BatterySnapshot>,
    pub checks: Vec<DiagnosticCheck>,
}

#[derive(Clone, Serialize)]
pub struct DiagnosticProgress {
    pub done: usize,
    pub total: usize,
    pub label: String,
}

#[derive(Serialize)]
pub struct ReportSaveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn fault_checks(faults: &[HmsFault], answered: bool) -> Vec<DiagnosticCheck> {
    let group = "Fault codes";
    if !answered && faults.is_empty() {
        return vec![DiagnosticCheck::new(group, "Fault codes", "info", "The aircraft did not report its fault list.".into())];
    }
    if faults.is_empty() {
        return vec![DiagnosticCheck::new(group, "Fault codes", "ok", "No faults reported.".into())];
    }
    faults
        .iter()
        .map(|f| {
            let status = if f.level >= LEVEL_CRITICAL { "fail" } else if f.level >= LEVEL_WARNING { "warn" } else { "info" };
            DiagnosticCheck::new(group, &format!("{} · {}", f.code_hex, f.module), status, f.text.clone())
        })
        .collect()
}

pub fn battery_checks(battery: Option<&BatterySnapshot>) -> Vec<DiagnosticCheck> {
    let group = "Battery";
    let battery = match battery {
        Some(b) if b.live.is_some() || b.pack.is_some() || b.cell_voltages.is_some() => b,
        _ => return vec![DiagnosticCheck::new(group, "Battery", "info", "The battery did not answer.".into())],
    };
    let mut checks = Vec::new();
    if let Some(live) = &battery.live {
        checks.push(DiagnosticCheck::new(
            group,
            "Charge",
            "info",
            format!("{} % · {:.2} V · {:.1} °C", live.percent, live.voltage as f64 / 1000.0, live.temperature),
        ));
    }
    match battery::battery_health(battery) {
        Some(health) => {
            let status = if health < HEALTH_FAIL { "fail" } else if health < HEALTH_WARN { "warn" } else { "ok" };
            let cycles = battery.pack.as_ref().map(|p| format!(" · {} cycles", p.cycles)).unwrap_or_default();
            checks.push(DiagnosticCheck::new(group, "Health", status, format!("{health} % of design capacity{cycles}")));
        }
        None => {
            if let Some(pack) = &battery.pack {
                checks.push(DiagnosticCheck::new(group, "Cycles", "info", pack.cycles.to_string()));
            }
        }
    }
    if let Some(cells) = &battery.cell_voltages {
        if cells.len() >= 2 {
            let spread = cells.iter().max().unwrap() - cells.iter().min().unwrap();
            let status = if spread >= CELL_SPREAD_FAIL_MV { "fail" } else if spread >= CELL_SPREAD_WARN_MV { "warn" } else { "ok" };
            checks.push(DiagnosticCheck::new(group, "Cell balance", status, format!("{} cells, {spread} mV between the highest and lowest", cells.len())));
        }
    }
    if let Some(serial) = &battery.serial {
        checks.push(DiagnosticCheck::new(group, "Serial", "info", serial.clone()));
    }
    checks
}

// ── Report formatting ────────────────────────────────────────────────────────

/// Only the fields the text report needs; faults and battery are already folded
/// into `checks` during the run.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReportInput {
    pub at: u64,
    pub model: Option<String>,
    pub model_code: Option<String>,
    pub serial: Option<String>,
    pub camera_serial: Option<String>,
    pub firmware: Option<String>,
    #[serde(default)]
    pub modules: Vec<DiagnosticModule>,
    #[serde(default)]
    pub checks: Vec<DiagnosticCheck>,
}

fn status_word(status: &str) -> &'static str {
    match status {
        "ok" => "OK",
        "warn" => "ATTENTION",
        "fail" => "FAULT",
        _ => "INFO",
    }
}

fn local(at: u64) -> chrono::DateTime<Local> {
    Local.timestamp_millis_opt(at as i64).single().unwrap_or_else(|| Local.timestamp_millis_opt(0).unwrap())
}

fn timestamp(at: u64) -> String {
    local(at).format("%Y-%m-%d %H:%M").to_string()
}

/// A file-name-safe stamp for the report, e.g. "2026-11-22-1843".
pub fn report_file_stamp(at: u64) -> String {
    local(at).format("%Y-%m-%d-%H%M").to_string()
}

fn pad_end(s: &str, width: usize) -> String {
    let mut s = s.to_string();
    while s.chars().count() < width {
        s.push(' ');
    }
    s
}

fn totals(checks: &[DiagnosticCheck]) -> (usize, usize, usize) {
    let mut ok = 0;
    let mut warn = 0;
    let mut fail = 0;
    for c in checks {
        match c.status.as_str() {
            "ok" => ok += 1,
            "warn" => warn += 1,
            "fail" => fail += 1,
            _ => {}
        }
    }
    (ok, warn, fail)
}

/// The report as plain text, one section per group (CRLF line endings).
pub fn format_diagnostic_report(report: &SaveReportInput) -> String {
    let mut lines: Vec<String> = Vec::new();
    let row = |lines: &mut Vec<String>, label: &str, value: &Option<String>| {
        let v = value.as_deref().filter(|s| !s.is_empty()).unwrap_or("—");
        lines.push(format!("{}{}", pad_end(&format!("{label}:"), 18), v));
    };
    let (ok, warn, fail) = totals(&report.checks);

    lines.push("AIRCRAFT SERVICE REPORT".into());
    lines.push("=======================".into());
    lines.push(format!("{}{}", pad_end("Date:", 18), timestamp(report.at)));
    row(&mut lines, "Aircraft", &report.model);
    row(&mut lines, "Factory code", &report.model_code);
    row(&mut lines, "Serial", &report.serial);
    row(&mut lines, "Camera serial", &report.camera_serial);
    row(&mut lines, "Firmware", &report.firmware);
    lines.push(format!("{}{fail} fault, {warn} attention, {ok} OK", pad_end("Result:", 18)));

    let mut groups: Vec<String> = Vec::new();
    for c in &report.checks {
        if !groups.contains(&c.group) {
            groups.push(c.group.clone());
        }
    }
    for group in &groups {
        lines.push(String::new());
        lines.push(group.to_uppercase());
        lines.push("-".repeat(group.chars().count()));
        for c in report.checks.iter().filter(|e| &e.group == group) {
            lines.push(format!("[{}] {}: {}", pad_end(status_word(&c.status), 9), c.name, c.detail));
        }
    }

    lines.push(String::new());
    lines.push("MODULES".into());
    lines.push("-------".into());
    if report.modules.is_empty() {
        lines.push("No module reported a version.".into());
    }
    for m in &report.modules {
        let fw = if m.firmware.is_empty() { "—" } else { &m.firmware };
        let hw = if m.hardware.is_empty() { "—" } else { &m.hardware };
        lines.push(format!("{}firmware {fw}   hardware {hw}", pad_end(&m.name, 26)));
    }
    lines.push(String::new());
    lines.join("\r\n")
}
