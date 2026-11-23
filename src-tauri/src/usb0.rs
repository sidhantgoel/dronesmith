//! USB bulk transport for DJI products via libusb-win32 (`libusb0.dll`).
//!
//! The DJI vendor interfaces on this machine are bound to the libusb-win32
//! driver, which libusb-1.0 crates cannot open, so this calls the legacy
//! libusb-0.1 API in `libusb0.dll` directly. Struct fields are read at fixed
//! offsets from the packed libusb-win32 layouts (lusb0_usb.h), so no Rust struct
//! layout has to match the C one.
//!
//! The link is read on a dedicated thread that feeds raw bytes to a callback;
//! writes are blocking calls on the caller's thread. There is no runtime test
//! here (the drone is not on this machine); this is compile-verified only.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::os::raw::c_uint;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use libloading::Library;
use parking_lot::Mutex;

pub const DJI_VENDOR_ID: u16 = 0x2ca3;

const ENDPOINT_DIR_IN: u8 = 0x80;
const TRANSFER_TYPE_MASK: u8 = 0x03;
const TRANSFER_TYPE_BULK: u8 = 0x02;
const DUML_INTERFACE_SUBCLASS: u8 = 0x43;

const READ_TIMEOUT_MS: c_int = 200;
const WRITE_TIMEOUT_MS: c_int = 1000;
const MAX_CONSECUTIVE_READ_ERRORS: u32 = 20;

// ── Packed libusb-win32 struct offsets (alignment 1) ─────────────────────────

mod off {
    // usb_device
    pub const DEV_DESCRIPTOR: usize = 536;
    pub const DEV_CONFIG: usize = 554;
    pub const DEV_NEXT: usize = 0;
    // usb_device_descriptor (relative to DEV_DESCRIPTOR)
    pub const DD_ID_VENDOR: usize = 8;
    pub const DD_ID_PRODUCT: usize = 10;
    pub const DD_I_PRODUCT: usize = 15;
    pub const DD_I_SERIAL: usize = 16;
    // usb_bus
    pub const BUS_DEVICES: usize = 528;
    pub const BUS_NEXT: usize = 0;
    // usb_config_descriptor
    pub const CFG_B_NUM_INTERFACES: usize = 4;
    pub const CFG_B_CONFIG_VALUE: usize = 5;
    pub const CFG_I_CONFIGURATION: usize = 6;
    pub const CFG_INTERFACE: usize = 9;
    // usb_interface
    pub const INTF_ALTSETTING: usize = 0;
    pub const INTF_NUM_ALTSETTING: usize = 8;
    pub const INTF_SIZE: usize = 12;
    // usb_interface_descriptor
    pub const ID_B_INTERFACE_NUMBER: usize = 2;
    pub const ID_B_NUM_ENDPOINTS: usize = 4;
    pub const ID_B_INTERFACE_CLASS: usize = 5;
    pub const ID_B_INTERFACE_SUBCLASS: usize = 6;
    pub const ID_B_INTERFACE_PROTOCOL: usize = 7;
    pub const ID_ENDPOINT: usize = 9;
    // usb_endpoint_descriptor
    pub const EP_B_ENDPOINT_ADDRESS: usize = 2;
    pub const EP_BM_ATTRIBUTES: usize = 3;
    pub const EP_W_MAX_PACKET_SIZE: usize = 4;
    pub const EP_SIZE: usize = 21;
}

unsafe fn rd_u8(base: *const u8, offset: usize) -> u8 {
    std::ptr::read_unaligned(base.add(offset))
}
unsafe fn rd_u16(base: *const u8, offset: usize) -> u16 {
    std::ptr::read_unaligned(base.add(offset) as *const u16)
}
unsafe fn rd_ptr(base: *const u8, offset: usize) -> *const u8 {
    std::ptr::read_unaligned(base.add(offset) as *const usize) as *const u8
}

// ── FFI binding ──────────────────────────────────────────────────────────────

type FnVoid = unsafe extern "C" fn();
type FnInt = unsafe extern "C" fn() -> c_int;
type FnGetBusses = unsafe extern "C" fn() -> *const u8;
type FnOpen = unsafe extern "C" fn(*const u8) -> *const u8;
type FnHandleInt = unsafe extern "C" fn(*const u8) -> c_int;
type FnHandleIntInt = unsafe extern "C" fn(*const u8, c_int) -> c_int;
type FnStringSimple = unsafe extern "C" fn(*const u8, c_int, *mut c_char, usize) -> c_int;
type FnBulk = unsafe extern "C" fn(*const u8, c_int, *mut c_char, c_int, c_int) -> c_int;
type FnStrerror = unsafe extern "C" fn() -> *const c_char;
type FnControl =
    unsafe extern "C" fn(*const u8, c_int, c_int, c_int, c_int, *mut c_char, c_int, c_int) -> c_int;

struct Api {
    _lib: Library,
    init: FnVoid,
    find_busses: FnInt,
    find_devices: FnInt,
    get_busses: FnGetBusses,
    open: FnOpen,
    close: FnHandleInt,
    set_configuration: FnHandleIntInt,
    claim_interface: FnHandleIntInt,
    release_interface: FnHandleIntInt,
    get_string_simple: FnStringSimple,
    bulk_read: FnBulk,
    bulk_write: FnBulk,
    control_msg: FnControl,
    strerror: FnStrerror,
}

// Raw function pointers and handles; libusb-win32 is used from the read thread
// and the writer, which is safe for bulk transfers on distinct endpoints.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Api {
    fn load(dll_paths: &[String]) -> Result<Arc<Api>, String> {
        let mut errors = Vec::new();
        for path in dll_paths {
            match unsafe { Library::new(path) } {
                Ok(lib) => match unsafe { Self::bind(lib) } {
                    Ok(api) => {
                        unsafe { (api.init)() };
                        return Ok(Arc::new(api));
                    }
                    Err(e) => errors.push(format!("{path}: {e}")),
                },
                Err(e) => errors.push(format!("{path}: {e}")),
            }
        }
        Err(format!("could not load libusb0.dll ({})", errors.join("; ")))
    }

    unsafe fn bind(lib: Library) -> Result<Api, String> {
        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                let s: libloading::Symbol<$ty> =
                    lib.get($name).map_err(|e| format!("{}: {e}", stringify!($name)))?;
                *s
            }};
        }
        Ok(Api {
            init: sym!(b"usb_init\0", FnVoid),
            find_busses: sym!(b"usb_find_busses\0", FnInt),
            find_devices: sym!(b"usb_find_devices\0", FnInt),
            get_busses: sym!(b"usb_get_busses\0", FnGetBusses),
            open: sym!(b"usb_open\0", FnOpen),
            close: sym!(b"usb_close\0", FnHandleInt),
            set_configuration: sym!(b"usb_set_configuration\0", FnHandleIntInt),
            claim_interface: sym!(b"usb_claim_interface\0", FnHandleIntInt),
            release_interface: sym!(b"usb_release_interface\0", FnHandleIntInt),
            get_string_simple: sym!(b"usb_get_string_simple\0", FnStringSimple),
            bulk_read: sym!(b"usb_bulk_read\0", FnBulk),
            bulk_write: sym!(b"usb_bulk_write\0", FnBulk),
            control_msg: sym!(b"usb_control_msg\0", FnControl),
            strerror: sym!(b"usb_strerror\0", FnStrerror),
            _lib: lib,
        })
    }

    fn strerror(&self) -> String {
        unsafe {
            let ptr = (self.strerror)();
            if ptr.is_null() {
                String::new()
            } else {
                CStr::from_ptr(ptr).to_string_lossy().into_owned()
            }
        }
    }

    fn read_string(&self, handle: *const u8, index: u8) -> String {
        if index == 0 {
            return String::new();
        }
        let mut buf = vec![0u8; 256];
        let n = unsafe {
            (self.get_string_simple)(handle, index as c_int, buf.as_mut_ptr() as *mut c_char, buf.len())
        };
        if n > 0 {
            String::from_utf8_lossy(&buf[..n as usize]).trim().to_string()
        } else {
            String::new()
        }
    }
}

// ── Interface description ────────────────────────────────────────────────────

#[derive(Clone)]
struct EndpointInfo {
    address: u8,
    max_packet_size: u16,
    bulk: bool,
}

#[derive(Clone)]
struct InterfaceInfo {
    number: u8,
    interface_class: u8,
    sub_class: u8,
    protocol: u8,
    endpoints: Vec<EndpointInfo>,
}

impl InterfaceInfo {
    fn has_bulk_pair(&self) -> bool {
        self.endpoints.iter().any(|e| e.bulk && e.address & ENDPOINT_DIR_IN != 0)
            && self.endpoints.iter().any(|e| e.bulk && e.address & ENDPOINT_DIR_IN == 0)
    }
}

unsafe fn read_interfaces(config: *const u8) -> Vec<InterfaceInfo> {
    let mut out = Vec::new();
    let intf_array = rd_ptr(config, off::CFG_INTERFACE);
    if intf_array.is_null() {
        return out;
    }
    let count = rd_u8(config, off::CFG_B_NUM_INTERFACES) as usize;
    for i in 0..count {
        let intf = intf_array.add(i * off::INTF_SIZE);
        let altsetting = rd_ptr(intf, off::INTF_ALTSETTING);
        let num_alt = rd_u16(intf, off::INTF_NUM_ALTSETTING); // low 16 bits of an int
        if altsetting.is_null() || num_alt < 1 {
            continue;
        }
        let ep_array = rd_ptr(altsetting, off::ID_ENDPOINT);
        let num_ep = rd_u8(altsetting, off::ID_B_NUM_ENDPOINTS) as usize;
        let mut endpoints = Vec::new();
        if !ep_array.is_null() {
            for j in 0..num_ep {
                let ep = ep_array.add(j * off::EP_SIZE);
                let attrs = rd_u8(ep, off::EP_BM_ATTRIBUTES);
                endpoints.push(EndpointInfo {
                    address: rd_u8(ep, off::EP_B_ENDPOINT_ADDRESS),
                    max_packet_size: rd_u16(ep, off::EP_W_MAX_PACKET_SIZE),
                    bulk: attrs & TRANSFER_TYPE_MASK == TRANSFER_TYPE_BULK,
                });
            }
        }
        out.push(InterfaceInfo {
            number: rd_u8(altsetting, off::ID_B_INTERFACE_NUMBER),
            interface_class: rd_u8(altsetting, off::ID_B_INTERFACE_CLASS),
            sub_class: rd_u8(altsetting, off::ID_B_INTERFACE_SUBCLASS),
            protocol: rd_u8(altsetting, off::ID_B_INTERFACE_PROTOCOL),
            endpoints,
        });
    }
    out
}

/// Picks the DUML bulk interface from the configuration string and interface subclass.
fn select_duml_interface(config_string: &str, interfaces: &[InterfaceInfo]) -> Option<InterfaceInfo> {
    let usable = |i: &InterfaceInfo| i.has_bulk_pair();
    if config_string.contains(',') {
        let index = config_string.split(',').position(|p| p == "acm")?;
        let target = interfaces.iter().find(|i| i.number as usize == index + 1)?;
        return if usable(target) { Some(target.clone()) } else { None };
    }
    if config_string.contains('_') && !config_string.split('_').any(|p| p == "bulk") {
        return None;
    }
    interfaces
        .iter()
        .find(|i| i.sub_class == DUML_INTERFACE_SUBCLASS && usable(i))
        .cloned()
}

// ── Bulk transport ───────────────────────────────────────────────────────────

/// A handle wrapper so the raw pointer can cross the read thread boundary.
struct Handle(*const u8);
unsafe impl Send for Handle {}

pub struct BulkTransport {
    api: Arc<Api>,
    handle: Mutex<Handle>,
    interface_number: c_int,
    ep_in: c_int,
    ep_out: c_int,
    read_size: usize,
    closed: Arc<AtomicBool>,
    reader: Mutex<Option<JoinHandle<()>>>,
    pub label: String,
    pub product: String,
}

unsafe impl Sync for BulkTransport {}

impl BulkTransport {
    /// Spawns the background read loop, delivering each USB read to `on_data`
    /// and calling `on_lost` once if the link drops.
    pub fn start<F, G>(self: &Arc<Self>, on_data: F, on_lost: G)
    where
        F: Fn(Vec<u8>) + Send + 'static,
        G: FnOnce(String) + Send + 'static,
    {
        let me = Arc::clone(self);
        let handle_ptr = { me.handle.lock().0 };
        let handle = Handle(handle_ptr);
        let api = Arc::clone(&me.api);
        let closed = Arc::clone(&me.closed);
        let ep_in = me.ep_in;
        let read_size = me.read_size;
        let join = std::thread::spawn(move || {
            let handle = handle; // move the Send wrapper in
            let mut buf = vec![0u8; read_size];
            let mut errors = 0u32;
            let mut on_lost = Some(on_lost);
            while !closed.load(Ordering::Relaxed) {
                let count = unsafe {
                    (api.bulk_read)(
                        handle.0,
                        ep_in,
                        buf.as_mut_ptr() as *mut c_char,
                        buf.len() as c_int,
                        READ_TIMEOUT_MS,
                    )
                };
                if closed.load(Ordering::Relaxed) {
                    return;
                }
                if count > 0 {
                    errors = 0;
                    on_data(buf[..count as usize].to_vec());
                } else if count == 0 {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                } else {
                    let message = api.strerror();
                    if is_timeout(count, &message) {
                        errors = 0;
                        continue;
                    }
                    errors += 1;
                    if errors >= MAX_CONSECUTIVE_READ_ERRORS {
                        if let Some(cb) = on_lost.take() {
                            cb(format!("USB read failed: {message} ({count})"));
                        }
                        return;
                    }
                }
            }
        });
        *me.reader.lock() = Some(join);
    }

    /// Blocking bulk write of a whole buffer.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        if self.closed.load(Ordering::Relaxed) {
            return Err("Device is not connected.".to_string());
        }
        let handle = self.handle.lock().0;
        let result = unsafe {
            (self.api.bulk_write)(
                handle,
                self.ep_out,
                data.as_ptr() as *mut c_char,
                data.len() as c_int,
                WRITE_TIMEOUT_MS,
            )
        };
        if result < 0 {
            Err(format!("USB write failed: {} ({result})", self.api.strerror()))
        } else {
            Ok(())
        }
    }

    /// Blocking bulk write with an explicit timeout (for the fastboot protocol).
    pub fn send(&self, data: &[u8], timeout_ms: c_int) -> Result<(), String> {
        if self.closed.load(Ordering::Relaxed) {
            return Err("Device is not connected.".to_string());
        }
        let handle = self.handle.lock().0;
        let result = unsafe {
            (self.api.bulk_write)(handle, self.ep_out, data.as_ptr() as *mut c_char, data.len() as c_int, timeout_ms)
        };
        if result < 0 {
            Err(format!("USB write failed: {} ({result})", self.api.strerror()))
        } else {
            Ok(())
        }
    }

    /// Blocking synchronous bulk read (for the fastboot protocol). Must not be
    /// used together with `start`, which owns the read endpoint.
    pub fn recv(&self, max_len: usize, timeout_ms: c_int) -> Result<Vec<u8>, String> {
        if self.closed.load(Ordering::Relaxed) {
            return Err("Device is not connected.".to_string());
        }
        let handle = self.handle.lock().0;
        let mut buf = vec![0u8; max_len];
        let count = unsafe {
            (self.api.bulk_read)(handle, self.ep_in, buf.as_mut_ptr() as *mut c_char, buf.len() as c_int, timeout_ms)
        };
        if count < 0 {
            Err(format!("USB read failed: {} ({count})", self.api.strerror()))
        } else {
            buf.truncate(count as usize);
            Ok(buf)
        }
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(join) = self.reader.lock().take() {
            let _ = join.join();
        }
        let handle = self.handle.lock().0;
        unsafe {
            (self.api.release_interface)(handle, self.interface_number);
            (self.api.close)(handle);
        }
    }
}

fn is_timeout(code: c_int, message: &str) -> bool {
    code == -116
        || code == -138
        || code == -10060
        || message.to_ascii_lowercase().contains("timed out")
        || message.to_ascii_lowercase().contains("timeout")
}

// ── Enumerate + open ─────────────────────────────────────────────────────────

/// Opens the DUML bulk interface of a connected DJI product.
pub fn connect_bulk(dll_paths: &[String]) -> Result<Arc<BulkTransport>, String> {
    open_interface(dll_paths, InterfaceKind::Duml)
}

/// Opens a device in fastboot/recovery: the DJI recovery device (2CA3:0040) by
/// its vendor bulk interface, or any device exposing the standard Android
/// fastboot interface (class 0xFF, sub 0x42, protocol 0x03).
pub fn connect_fastboot(dll_paths: &[String]) -> Result<Arc<BulkTransport>, String> {
    open_interface(dll_paths, InterfaceKind::Fastboot)
}

const DJI_RECOVERY_PID: u16 = 0x0040;

enum InterfaceKind {
    Duml,
    Fastboot,
}

fn open_interface(dll_paths: &[String], kind: InterfaceKind) -> Result<Arc<BulkTransport>, String> {
    let api = Api::load(dll_paths)?;
    unsafe {
        (api.find_busses)();
        (api.find_devices)();
    }
    let mut last_error = String::from(match kind {
        InterfaceKind::Duml => "no DJI device found",
        InterfaceKind::Fastboot => "no device is in fastboot mode",
    });

    let mut bus = unsafe { (api.get_busses)() };
    while !bus.is_null() {
        let mut dev = unsafe { rd_ptr(bus, off::BUS_DEVICES) };
        while !dev.is_null() {
            let current = dev;
            dev = unsafe { rd_ptr(current, off::DEV_NEXT) };

            let vendor = unsafe { rd_u16(current, off::DEV_DESCRIPTOR + off::DD_ID_VENDOR) };
            let product = unsafe { rd_u16(current, off::DEV_DESCRIPTOR + off::DD_ID_PRODUCT) };
            let config = unsafe { rd_ptr(current, off::DEV_CONFIG) };
            if config.is_null() {
                continue;
            }

            let want = match kind {
                InterfaceKind::Duml => vendor == DJI_VENDOR_ID,
                InterfaceKind::Fastboot => true,
            };
            if !want {
                continue;
            }

            let handle = unsafe { (api.open)(current) };
            if handle.is_null() {
                last_error = format!("{vendor:04x}:{product:04x}: could not open ({})", api.strerror());
                continue;
            }
            let interfaces = unsafe { read_interfaces(config) };
            let i_configuration = unsafe { rd_u8(config, off::CFG_I_CONFIGURATION) };
            let config_string = api.read_string(handle, i_configuration);
            let i_product = unsafe { rd_u8(current, off::DEV_DESCRIPTOR + off::DD_I_PRODUCT) };
            let product_string = api.read_string(handle, i_product);
            let _serial_index = unsafe { rd_u8(current, off::DEV_DESCRIPTOR + off::DD_I_SERIAL) };

            let chosen = match kind {
                InterfaceKind::Duml => select_duml_interface(&config_string, &interfaces),
                InterfaceKind::Fastboot => select_fastboot_interface(vendor, product, &interfaces),
            };
            let Some(iface) = chosen else {
                unsafe { (api.close)(handle) };
                if matches!(kind, InterfaceKind::Duml) {
                    last_error =
                        format!("{vendor:04x}:{product:04x}: no DUML bulk interface (\"{config_string}\")");
                }
                continue;
            };

            let mut claimed = unsafe { (api.claim_interface)(handle, iface.number as c_int) };
            if claimed < 0 {
                let config_value = unsafe { rd_u8(config, off::CFG_B_CONFIG_VALUE) };
                unsafe { (api.set_configuration)(handle, config_value as c_int) };
                claimed = unsafe { (api.claim_interface)(handle, iface.number as c_int) };
            }
            if claimed < 0 {
                last_error = format!(
                    "{vendor:04x}:{product:04x}: could not claim interface {} ({})",
                    iface.number,
                    api.strerror()
                );
                unsafe { (api.close)(handle) };
                continue;
            }

            let ep_in = iface.endpoints.iter().find(|e| e.bulk && e.address & ENDPOINT_DIR_IN != 0);
            let ep_out = iface.endpoints.iter().find(|e| e.bulk && e.address & ENDPOINT_DIR_IN == 0);
            let (Some(ep_in), Some(ep_out)) = (ep_in, ep_out) else {
                unsafe {
                    (api.release_interface)(handle, iface.number as c_int);
                    (api.close)(handle);
                }
                continue;
            };

            let read_size = (ep_in.max_packet_size.max(64) as usize) * 8;
            let label = match kind {
                InterfaceKind::Duml => format!("DJI USB {vendor:04x}:{product:04x}, interface {}", iface.number),
                InterfaceKind::Fastboot if vendor == DJI_VENDOR_ID && product == DJI_RECOVERY_PID => {
                    format!("DJI recovery {vendor:04x}:{product:04x}")
                }
                InterfaceKind::Fastboot => format!("fastboot {vendor:04x}:{product:04x}"),
            };

            return Ok(Arc::new(BulkTransport {
                api: Arc::clone(&api),
                handle: Mutex::new(Handle(handle)),
                interface_number: iface.number as c_int,
                ep_in: ep_in.address as c_int,
                ep_out: ep_out.address as c_int,
                read_size,
                closed: Arc::new(AtomicBool::new(false)),
                reader: Mutex::new(None),
                label,
                product: product_string,
            }));
        }
        bus = unsafe { rd_ptr(bus, off::BUS_NEXT) };
    }
    Err(last_error)
}

fn select_fastboot_interface(
    vendor: u16,
    product: u16,
    interfaces: &[InterfaceInfo],
) -> Option<InterfaceInfo> {
    let is_recovery = vendor == DJI_VENDOR_ID && product == DJI_RECOVERY_PID;
    if is_recovery {
        interfaces.iter().find(|i| i.has_bulk_pair()).cloned()
    } else {
        interfaces
            .iter()
            .find(|i| {
                i.interface_class == 0xff && i.sub_class == 0x42 && i.protocol == 0x03 && i.has_bulk_pair()
            })
            .cloned()
    }
}

// Keep the control-message type referenced (used by a later aliveness probe).
#[allow(dead_code)]
fn _control_signature(_: FnControl, _: c_uint) {}
