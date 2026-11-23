//! DJI aircraft firmware manifest (cfg.sig), read over DUML with GENERAL 0x4F.
//! The device returns a signed config blob: a
//! binary signature header followed by an XML manifest. The full blob must be
//! read to completion for the XML to be well formed; this parser requires a
//! complete <dji>…</dji> document. Read-only.

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestModule {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareManifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formal_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anti_rollback: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enforce: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expire: Option<String>,
    pub modules: Vec<ManifestModule>,
}

/// An attribute, or a child element's text, named `key` — mirroring how
/// fast-xml-parser exposes both without a prefix.
fn field<'a>(node: roxmltree::Node<'a, 'a>, key: &str) -> Option<String> {
    if let Some(v) = node.attribute(key) {
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(key))
        .and_then(|c| c.text())
        .map(|t| t.to_string())
        .filter(|s| !s.is_empty())
}

fn int_of(v: Option<String>) -> Option<i64> {
    v.and_then(|s| s.trim().parse::<i64>().ok())
}

/// Extracts the complete <dji>…</dji> document from a config blob and parses it.
/// Returns None when no complete document is present (an incomplete read).
pub fn parse_config(bytes: &[u8]) -> Option<FirmwareManifest> {
    let start = find(bytes, b"<dji")?;
    let end_rel = find(&bytes[start..], b"</dji>")?;
    let end = start + end_rel + "</dji>".len();
    let xml = String::from_utf8_lossy(&bytes[start..end]);
    let doc = roxmltree::Document::parse(&xml).ok()?;

    let device = doc.descendants().find(|n| n.is_element() && n.has_tag_name("device"))?;
    let firmware = device.children().find(|c| c.is_element() && c.has_tag_name("firmware"));
    let firmware = match firmware {
        Some(f) => f,
        None => {
            // A device with no firmware element still yields a device id.
            return Some(FirmwareManifest {
                device_id: field(device, "id"),
                formal_version: None,
                release_version: None,
                anti_rollback: None,
                enforce: None,
                from: None,
                expire: None,
                modules: Vec::new(),
            });
        }
    };
    let release = firmware.children().find(|c| c.is_element() && c.has_tag_name("release"));

    let (release_version, anti_rollback, enforce, from, expire, modules) = match release {
        Some(release) => {
            let mut seen = std::collections::HashSet::new();
            let mut modules = Vec::new();
            for raw in release.children().filter(|c| c.is_element() && c.has_tag_name("module")) {
                let id = field(raw, "id").unwrap_or_default();
                let name = field(raw, "name").unwrap_or_default();
                let version = field(raw, "version").unwrap_or_default();
                let key = format!("{id}|{name}|{version}");
                if !seen.insert(key) {
                    continue;
                }
                modules.push(ManifestModule {
                    name: if !name.is_empty() { name } else if !id.is_empty() { id.clone() } else { "—".into() },
                    id,
                    version: if version.is_empty() { "—".into() } else { version },
                    size: int_of(field(raw, "size")).map(|n| n as u64),
                });
            }
            let enforce = field(release, "enforce").map(|e| e != "0");
            (
                field(release, "version"),
                int_of(field(release, "antirollback")),
                enforce,
                field(release, "from"),
                field(release, "expire"),
                modules,
            )
        }
        None => (None, None, None, None, None, Vec::new()),
    };

    Some(FirmwareManifest {
        device_id: field(device, "id"),
        formal_version: field(firmware, "formal"),
        release_version,
        anti_rollback,
        enforce,
        from,
        expire,
        modules,
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
