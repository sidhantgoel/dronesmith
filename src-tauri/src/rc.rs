//! ADB wrapper for the DJI smart-controller service tools. Shells out to a
//! bundled `adb` executable. Independent of the DUML drone link.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct AdbResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcInfo {
    pub serial: String,
    pub state: String,
    pub model: String,
    pub android: String,
    pub sdk: String,
    pub firmware: String,
    pub battery: i64,
    pub root: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcPackage {
    pub pkg: String,
    pub apk_path: String,
    pub system: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcConnectResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<RcInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcCommandResult {
    pub ok: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcRootResult {
    pub root: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcPullResult {
    pub pkg: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcPullProgress {
    pub pkg: String,
    pub index: usize,
    pub total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcScreenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

pub struct RcDevice {
    pub serial: String,
    pub state: String,
}

const SCREENCAP_MAX_BYTES: usize = 32 * 1024 * 1024;

pub struct Adb {
    exe: String,
}

/// Resolves the bundled adb executable, falling back to PATH.
pub fn adb_path(resources_dir: Option<&Path>) -> String {
    let exe_name = if cfg!(windows) { "adb.exe" } else { "adb" };
    if let Some(dir) = resources_dir {
        let bundled = dir.join("adb").join(exe_name);
        if bundled.exists() {
            return bundled.to_string_lossy().into_owned();
        }
    }
    exe_name.to_string()
}

pub fn text(res: &AdbResult) -> String {
    format!("{}\n{}", res.stdout, res.stderr).trim().to_string()
}

/// Wraps a value in single quotes for an adb shell command.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn configure(cmd: &mut Command, exe: &str) {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if exe.contains("adb") {
        if let Some(parent) = Path::new(exe).parent() {
            if parent.as_os_str().len() > 0 {
                cmd.current_dir(parent);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
}

impl Adb {
    pub fn new(exe: String) -> Adb {
        Adb { exe }
    }

    /// Runs one adb invocation; stdout/stderr captured as text with a timeout.
    pub fn run(&self, args: &[&str], timeout_ms: u64) -> AdbResult {
        let mut cmd = Command::new(&self.exe);
        cmd.args(args);
        configure(&mut cmd, &self.exe);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return AdbResult { ok: false, stdout: String::new(), stderr: format!("adb not available: {e}"), code: None },
        };
        let mut out = child.stdout.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let out_h = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        });
        let err_h = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break None,
            }
        };
        let stdout = out_h.join().unwrap_or_default().trim().to_string();
        let stderr = err_h.join().unwrap_or_default().trim().to_string();
        AdbResult { ok: code == Some(0), stdout, stderr, code }
    }

    /// Runs an adb invocation capturing raw stdout bytes (for screencap).
    fn run_bytes(&self, args: &[&str], timeout_ms: u64) -> Option<Vec<u8>> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(args);
        configure(&mut cmd, &self.exe);
        let mut child = cmd.spawn().ok()?;
        let mut out = child.stdout.take().unwrap();
        let out_h = std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = out.read_to_end(&mut v);
            v
        });
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let ok = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break false,
            }
        };
        let bytes = out_h.join().unwrap_or_default();
        if ok {
            Some(bytes)
        } else {
            None
        }
    }

    pub fn start_server(&self) -> AdbResult {
        self.run(&["start-server"], 15000)
    }

    pub fn kill_server(&self) -> AdbResult {
        self.run(&["kill-server"], 10000)
    }

    pub fn list_devices(&self) -> Vec<RcDevice> {
        let res = self.run(&["devices", "-l"], 10000);
        if !res.ok && res.stdout.is_empty() {
            return Vec::new();
        }
        res.stdout
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let serial = parts.next().unwrap_or("").to_string();
                let state = parts.next().unwrap_or("unknown").to_string();
                if serial.is_empty() || serial.starts_with('*') {
                    None
                } else {
                    Some(RcDevice { serial, state })
                }
            })
            .collect()
    }

    pub fn screencap(&self, serial: &str) -> Option<Vec<u8>> {
        let png = self.run_bytes(&["-s", serial, "exec-out", "screencap", "-p"], 8000)?;
        let is_png = png.len() > 8 && png[0] == 0x89 && png[1] == 0x50 && png[2] == 0x4e && png[3] == 0x47;
        if is_png && png.len() <= SCREENCAP_MAX_BYTES {
            Some(png)
        } else {
            None
        }
    }

    fn prop(&self, serial: &str, key: &str) -> String {
        let res = self.run(&["-s", serial, "shell", "getprop", key], 8000);
        if res.ok {
            res.stdout.trim().to_string()
        } else {
            String::new()
        }
    }

    pub fn device_info(&self, serial: &str) -> RcInfo {
        let model = {
            let m = self.prop(serial, "ro.product.model");
            if m.is_empty() { self.prop(serial, "ro.product.name") } else { m }
        };
        let android = self.prop(serial, "ro.build.version.release");
        let sdk = self.prop(serial, "ro.build.version.sdk");
        let firmware = {
            let a = self.prop(serial, "ro.dji.device.version");
            if !a.is_empty() {
                a
            } else {
                let b = self.prop(serial, "persist.sys.dji.version");
                if !b.is_empty() { b } else { self.prop(serial, "ro.build.display.id") }
            }
        };
        let battery_res = self.run(&["-s", serial, "shell", "dumpsys", "battery"], 8000);
        let battery = regex::Regex::new(r"level:\s*(\d+)")
            .unwrap()
            .captures(&battery_res.stdout)
            .and_then(|c| c[1].parse::<i64>().ok())
            .unwrap_or(0);
        let id = self.run(&["-s", serial, "shell", "id"], 8000);
        let root = id.stdout.contains("uid=0(root)");
        RcInfo { serial: serial.into(), state: "device".into(), model, android, sdk, firmware, battery, root }
    }

    pub fn list_packages(&self, serial: &str, third_party_only: bool) -> Vec<RcPackage> {
        let mut args = vec!["-s", serial, "shell", "pm", "list", "packages", "-f"];
        if third_party_only {
            args.push("-3");
        }
        let res = self.run(&args, 20000);
        res.stdout
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("package:"))
            .filter_map(|line| {
                let body = &line["package:".len()..];
                let (apk_path, pkg) = match body.rfind('=') {
                    Some(eq) if eq > 0 => (body[..eq].to_string(), body[eq + 1..].to_string()),
                    _ => (String::new(), body.to_string()),
                };
                if pkg.is_empty() {
                    None
                } else {
                    let system = apk_path.starts_with("/system") || apk_path.starts_with("/product");
                    Some(RcPackage { pkg, apk_path, system })
                }
            })
            .collect()
    }

    pub fn install(&self, serial: &str, apk_path: &str, grant_perms: bool, downgrade: bool) -> AdbResult {
        let mut args = vec!["-s", serial, "install", "-r"];
        if grant_perms {
            args.push("-g");
        }
        if downgrade {
            args.push("-d");
        }
        args.push(apk_path);
        self.run(&args, 180000)
    }

    pub fn uninstall(&self, serial: &str, pkg: &str) -> AdbResult {
        self.run(&["-s", serial, "uninstall", pkg], 30000)
    }

    pub fn set_home_activity(&self, serial: &str, component: &str) -> AdbResult {
        self.run(&["-s", serial, "shell", "cmd", "package", "set-home-activity", component], 15000)
    }

    pub fn list_launchers(&self, serial: &str) -> Vec<String> {
        let res = self.run(
            &["-s", serial, "shell", "cmd", "package", "query-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"],
            15000,
        );
        let re = regex::Regex::new(r"([a-zA-Z0-9_.]+/[a-zA-Z0-9_.$]+)").unwrap();
        let mut out: Vec<String> = Vec::new();
        for m in re.captures_iter(&res.stdout) {
            let s = m[1].to_string();
            if !out.contains(&s) {
                out.push(s);
            }
        }
        out
    }

    pub fn shell(&self, serial: &str, command: &str) -> AdbResult {
        self.run(&["-s", serial, "shell", command], 30000)
    }

    pub fn launch_app(&self, serial: &str, pkg: &str) -> AdbResult {
        self.shell(serial, &format!("monkey -p {pkg} -c android.intent.category.LAUNCHER 1"))
    }

    pub fn force_stop(&self, serial: &str, pkg: &str) -> AdbResult {
        self.shell(serial, &format!("am force-stop {pkg}"))
    }

    pub fn set_enabled(&self, serial: &str, pkg: &str, enabled: bool) -> AdbResult {
        let cmd = if enabled { format!("pm enable {pkg}") } else { format!("pm disable-user --user 0 {pkg}") };
        self.shell(serial, &cmd)
    }

    pub fn clear_data(&self, serial: &str, pkg: &str) -> AdbResult {
        self.shell(serial, &format!("pm clear {pkg}"))
    }

    pub fn pull_apk(&self, serial: &str, pkg: &str, out_dir: &Path) -> RcPullResult {
        let res = self.run(&["-s", serial, "shell", "pm", "path", pkg], 15000);
        let paths: Vec<String> = res.stdout.lines().map(str::trim).filter(|l| l.starts_with("package:")).map(|l| l["package:".len()..].to_string()).collect();
        if paths.is_empty() {
            return RcPullResult { pkg: pkg.into(), ok: false, file: None, split: None, error: Some(format!("No APK path for {pkg}")) };
        }
        let src = paths.iter().find(|p| p.ends_with("base.apk")).cloned().unwrap_or_else(|| paths[0].clone());
        let dest = out_dir.join(format!("{pkg}.apk"));
        let dest_str = dest.to_string_lossy().into_owned();
        let pull = self.run(&["-s", serial, "pull", &src, &dest_str], 180000);
        if !dest.exists() {
            let why = if !pull.stderr.is_empty() { pull.stderr } else if !pull.stdout.is_empty() { pull.stdout } else { "pull failed".into() };
            return RcPullResult { pkg: pkg.into(), ok: false, file: None, split: None, error: Some(format!("{pkg}: {why}")) };
        }
        RcPullResult { pkg: pkg.into(), ok: true, file: Some(dest_str), split: Some(paths.len() > 1), error: None }
    }

    pub fn pull(&self, serial: &str, remote: &str, local: &str) -> AdbResult {
        self.run(&["-s", serial, "pull", remote, local], 180000)
    }

    pub fn push(&self, serial: &str, local: &str, remote: &str) -> AdbResult {
        self.run(&["-s", serial, "push", local, remote], 180000)
    }

    pub fn list_dir(&self, serial: &str, dir: &str) -> AdbResult {
        self.shell(serial, &format!("ls -la {}", shell_quote(dir)))
    }

    pub fn settings_get(&self, serial: &str, namespace: &str, key: &str) -> AdbResult {
        self.shell(serial, &format!("settings get {namespace} {key}"))
    }

    pub fn settings_put(&self, serial: &str, namespace: &str, key: &str, value: &str) -> AdbResult {
        self.shell(serial, &format!("settings put {namespace} {key} {}", shell_quote(value)))
    }

    pub fn try_root(&self, serial: &str) -> RcRootResult {
        let root = self.run(&["-s", serial, "root"], 15000);
        let out = format!("{} {}", root.stdout, root.stderr).trim().to_string();
        if out.to_lowercase().contains("cannot run as root") {
            return RcRootResult { root: false, message: out };
        }
        let id = self.run(&["-s", serial, "shell", "id"], 10000);
        RcRootResult { root: id.stdout.contains("uid=0(root)"), message: if out.is_empty() { id.stdout } else { out } }
    }
}
