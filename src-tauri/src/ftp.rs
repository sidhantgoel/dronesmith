//! Read-only FTP client for the aircraft's USB-network FTP server. The drone
//! appears as a USB network adapter (host 192.168.42.1, drone 192.168.42.2).
//! Strictly read-only: list, size, retrieve. A minimal passive-mode client over
//! std TcpStream so no FTP dep is needed.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub const DRONE_FTP_HOST: &str = "192.168.42.2";
pub const DRONE_FTP_PORT: u16 = 21;

/// Login credentials tried in order.
pub const DRONE_FTP_LOGINS: &[(&str, &str)] = &[("dji_ftp", "Dji_dajiang001"), ("anonymous", "anonymous@")];

const CONTROL_TIMEOUT: Duration = Duration::from_millis(8000);
const DATA_IDLE_TIMEOUT: Duration = Duration::from_millis(20000);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpEntry {
    pub name: String,
    /// dir | file | link | other
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub modified: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConnectResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpListResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<FtpEntry>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpDownloadResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpDownloadProgress {
    pub name: String,
    pub bytes: u64,
    pub total: u64,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpConnectOptions {
    pub host: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
}

struct Reply {
    code: u32,
    text: String,
}

pub struct FtpClient {
    control: TcpStream,
    host: String,
    buf: String,
}

impl FtpClient {
    pub fn connect(host: &str, port: u16) -> Result<(FtpClient, String), String> {
        let addr = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Could not resolve the drone FTP address.")?;
        let control = TcpStream::connect_timeout(&addr, CONTROL_TIMEOUT).map_err(|_| "Could not reach the drone FTP.".to_string())?;
        control.set_read_timeout(Some(CONTROL_TIMEOUT)).ok();
        control.set_write_timeout(Some(CONTROL_TIMEOUT)).ok();
        let mut client = FtpClient { control, host: host.to_string(), buf: String::new() };
        let greeting = client.read_reply()?;
        Ok((client, greeting.text))
    }

    fn read_reply(&mut self) -> Result<Reply, String> {
        loop {
            while let Some(nl) = self.buf.find('\n') {
                let line = self.buf[..nl].trim_end_matches('\r').to_string();
                self.buf.drain(..=nl);
                let b = line.as_bytes();
                if b.len() >= 4 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2].is_ascii_digit() && b[3] == b' ' {
                    let code = line[..3].parse().unwrap_or(0);
                    return Ok(Reply { code, text: line });
                }
            }
            let mut tmp = [0u8; 4096];
            let n = self.control.read(&mut tmp).map_err(|_| "The drone FTP did not answer in time.".to_string())?;
            if n == 0 {
                return Err("The FTP connection closed.".into());
            }
            for &byte in &tmp[..n] {
                self.buf.push(byte as char);
            }
        }
    }

    fn command(&mut self, line: &str) -> Result<Reply, String> {
        self.control.write_all(format!("{line}\r\n").as_bytes()).map_err(|_| "The FTP connection is closed.".to_string())?;
        self.read_reply()
    }

    pub fn login(&mut self, user: &str, password: &str) -> Result<bool, String> {
        let user_reply = self.command(&format!("USER {user}"))?;
        if user_reply.code == 230 {
            return Ok(true);
        }
        if user_reply.code != 331 && user_reply.code != 332 {
            return Ok(false);
        }
        let pass_reply = self.command(&format!("PASS {password}"))?;
        Ok(pass_reply.code == 230 || pass_reply.code == 202)
    }

    pub fn binary(&mut self) -> Result<(), String> {
        self.command("TYPE I")?;
        Ok(())
    }

    fn open_passive(&mut self) -> Result<TcpStream, String> {
        let reply = self.command("PASV")?;
        let re = regex::Regex::new(r"\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)").unwrap();
        let caps = re.captures(&reply.text);
        let caps = match caps {
            Some(c) if reply.code == 227 => c,
            _ => return Err("The drone refused a data connection (PASV).".into()),
        };
        let p1: u16 = caps[5].parse().unwrap_or(0);
        let p2: u16 = caps[6].parse().unwrap_or(0);
        let port = p1 * 256 + p2;
        let addr = (self.host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Could not resolve the data address.")?;
        let socket = TcpStream::connect_timeout(&addr, CONTROL_TIMEOUT).map_err(|e| e.to_string())?;
        Ok(socket)
    }

    /// Collects a directory listing (LIST) as raw text.
    pub fn list(&mut self, dir: &str) -> Result<String, String> {
        let mut data = self.open_passive()?;
        let reply = self.command(&format!("LIST {dir}"))?;
        if reply.code >= 400 {
            return Err(format!("The drone could not list {dir}."));
        }
        data.set_read_timeout(Some(DATA_IDLE_TIMEOUT)).ok();
        let mut text = String::new();
        let mut tmp = [0u8; 8192];
        loop {
            match data.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => text.extend(tmp[..n].iter().map(|&b| b as char)),
                Err(_) => break,
            }
        }
        self.read_reply()?; // trailing 226
        Ok(text)
    }

    /// Asks the server for a file's size; -1 when it will not say.
    pub fn size(&mut self, file: &str) -> i64 {
        match self.command(&format!("SIZE {file}")) {
            Ok(reply) if reply.code == 213 => reply.text.get(4..).and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(-1),
            _ => -1,
        }
    }

    /// Streams a file to a local path, reporting bytes as they arrive.
    pub fn retrieve(&mut self, remote: &str, local_path: &std::path::Path, mut on_bytes: impl FnMut(u64)) -> Result<u64, String> {
        let mut data = self.open_passive()?;
        let reply = self.command(&format!("RETR {remote}"))?;
        if reply.code >= 400 {
            return Err(format!("The drone could not read {remote}."));
        }
        let mut out = std::fs::File::create(local_path).map_err(|e| e.to_string())?;
        data.set_read_timeout(Some(DATA_IDLE_TIMEOUT)).ok();
        let mut received: u64 = 0;
        let mut tmp = [0u8; 16384];
        loop {
            match data.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    out.write_all(&tmp[..n]).map_err(|e| e.to_string())?;
                    received += n as u64;
                    on_bytes(received);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                    return Err("The download stalled.".into());
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        self.read_reply()?; // trailing 226
        Ok(received)
    }

    pub fn quit(&mut self) {
        let _ = self.command("QUIT");
        let _ = self.control.shutdown(std::net::Shutdown::Both);
    }
}

/// Parses a Unix `ls -l` style FTP listing. Non-matching lines are skipped.
pub fn parse_ftp_list(text: &str) -> Vec<FtpEntry> {
    let re = regex::Regex::new(r"^([dlbcps-])([rwxsStT-]{9})\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.+)$").unwrap();
    let mut entries: Vec<FtpEntry> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        let caps = match re.captures(line) {
            Some(c) => c,
            None => continue,
        };
        let kind_char = &caps[1];
        let size_text = &caps[3];
        let modified = caps[4].to_string();
        let rest = caps[5].to_string();
        if rest == "." || rest == ".." {
            continue;
        }
        let kind = match kind_char {
            "d" => "dir",
            "l" => "link",
            "-" => "file",
            _ => "other",
        };
        let mut name = rest.clone();
        let mut target = None;
        if kind == "link" {
            if let Some(arrow) = rest.find(" -> ") {
                name = rest[..arrow].to_string();
                target = Some(rest[arrow + 4..].to_string());
            }
        }
        entries.push(FtpEntry { name, kind: kind.into(), size: size_text.parse().unwrap_or(0), modified, target });
    }
    entries.sort_by(|a, b| {
        let dir_rank = |e: &FtpEntry| if e.kind == "dir" { 0 } else { 1 };
        dir_rank(a).cmp(&dir_rank(b)).then_with(|| a.name.cmp(&b.name))
    });
    entries
}

/// Sanitizes a remote name into a safe default local file name.
pub fn safe_name(name: &str) -> String {
    let printable: String = name.chars().map(|c| if (c as u32) < 32 { '_' } else { c }).collect();
    let cleaned: String = printable.chars().map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed
    }
}

pub fn join_remote(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}
