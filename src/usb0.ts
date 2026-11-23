/**
 * USB bulk transport for DJI products using libusb-win32 (libusb0.dll).
 *
 * The DJI vendor interfaces on this machine are bound to the libusb-win32
 * driver, which libusb-1.0 based packages cannot open, so this talks to
 * libusb0.dll directly. Structure layouts and the interface selection logic
 * mirror PyUSB's libusb0 backend and dji-firmware-tools' comm_serialtalk.py.
 */
import koffi from 'koffi';

const DJI_VENDOR_ID = 0x2ca3;
const DUML_INTERFACE_SUBCLASS = 0x43;
const ENDPOINT_DIR_IN = 0x80;
const TRANSFER_TYPE_MASK = 0x03;
const TRANSFER_TYPE_BULK = 0x02;
const READ_TIMEOUT_MS = 100;
const WRITE_TIMEOUT_MS = 1000;
const MAX_CONSECUTIVE_READ_ERRORS = 3;

type Pointer = bigint | null;

// libusb-win32 packs every structure (see lusb0_usb.h / PyUSB _PackPolicy).
const EndpointDescriptor = koffi.pack('usb0_endpoint_descriptor', {
  bLength: 'uint8_t',
  bDescriptorType: 'uint8_t',
  bEndpointAddress: 'uint8_t',
  bmAttributes: 'uint8_t',
  wMaxPacketSize: 'uint16_t',
  bInterval: 'uint8_t',
  bRefresh: 'uint8_t',
  bSynchAddress: 'uint8_t',
  extra: 'void *',
  extralen: 'int',
});

const InterfaceDescriptor = koffi.pack('usb0_interface_descriptor', {
  bLength: 'uint8_t',
  bDescriptorType: 'uint8_t',
  bInterfaceNumber: 'uint8_t',
  bAlternateSetting: 'uint8_t',
  bNumEndpoints: 'uint8_t',
  bInterfaceClass: 'uint8_t',
  bInterfaceSubClass: 'uint8_t',
  bInterfaceProtocol: 'uint8_t',
  iInterface: 'uint8_t',
  endpoint: 'void *',
  extra: 'void *',
  extralen: 'int',
});

const Interface = koffi.pack('usb0_interface', {
  altsetting: 'void *',
  num_altsetting: 'int',
});

const ConfigDescriptor = koffi.pack('usb0_config_descriptor', {
  bLength: 'uint8_t',
  bDescriptorType: 'uint8_t',
  wTotalLength: 'uint16_t',
  bNumInterfaces: 'uint8_t',
  bConfigurationValue: 'uint8_t',
  iConfiguration: 'uint8_t',
  bmAttributes: 'uint8_t',
  MaxPower: 'uint8_t',
  interface: 'void *',
  extra: 'void *',
  extralen: 'int',
});

const DeviceDescriptor = koffi.pack('usb0_device_descriptor', {
  bLength: 'uint8_t',
  bDescriptorType: 'uint8_t',
  bcdUSB: 'uint16_t',
  bDeviceClass: 'uint8_t',
  bDeviceSubClass: 'uint8_t',
  bDeviceProtocol: 'uint8_t',
  bMaxPacketSize0: 'uint8_t',
  idVendor: 'uint16_t',
  idProduct: 'uint16_t',
  bcdDevice: 'uint16_t',
  iManufacturer: 'uint8_t',
  iProduct: 'uint8_t',
  iSerialNumber: 'uint8_t',
  bNumConfigurations: 'uint8_t',
});

const Device = koffi.pack('usb0_device', {
  next: 'void *',
  prev: 'void *',
  filename: koffi.array('char', 512),
  bus: 'void *',
  descriptor: DeviceDescriptor,
  config: 'void *',
  dev: 'void *',
  devnum: 'uint8_t',
  num_children: 'uint8_t',
  children: 'void *',
});

const Bus = koffi.pack('usb0_bus', {
  next: 'void *',
  prev: 'void *',
  dirname: koffi.array('char', 512),
  devices: 'void *',
  location: 'uint32_t',
  root_dev: 'void *',
});

interface EndpointInfo {
  address: number;
  maxPacketSize: number;
  bulk: boolean;
}

interface InterfaceInfo {
  number: number;
  interfaceClass: number;
  subClass: number;
  protocol: number;
  endpoints: EndpointInfo[];
}

type AsyncCallback = (err: Error | null, result: number) => void;

interface TransferFn {
  (handle: Pointer, ep: number, bytes: Buffer, size: number, timeout: number): number;
  async: (
    handle: Pointer,
    ep: number,
    bytes: Buffer,
    size: number,
    timeout: number,
    callback: AsyncCallback,
  ) => void;
}

interface Api {
  findBusses: () => number;
  findDevices: () => number;
  getBusses: () => Pointer;
  open: (device: Pointer) => Pointer;
  close: (handle: Pointer) => number;
  setConfiguration: (handle: Pointer, configuration: number) => number;
  claimInterface: (handle: Pointer, iface: number) => number;
  releaseInterface: (handle: Pointer, iface: number) => number;
  getStringSimple: (handle: Pointer, index: number, buf: Buffer, len: number) => number;
  bulkRead: TransferFn;
  bulkWrite: TransferFn;
  controlMsg: {
    async: (
      handle: Pointer,
      requestType: number,
      request: number,
      value: number,
      index: number,
      bytes: Buffer,
      size: number,
      timeout: number,
      callback: AsyncCallback,
    ) => void;
  };
  strerror: () => string;
}

let api: Api | null = null;

function loadApi(dllPaths: string[]): Api {
  if (api) {
    return api;
  }
  const errors: string[] = [];
  for (const dllPath of dllPaths) {
    try {
      const lib = koffi.load(dllPath);
      const loaded: Api = {
        findBusses: lib.func('usb_find_busses', 'int', []),
        findDevices: lib.func('usb_find_devices', 'int', []),
        getBusses: lib.func('usb_get_busses', 'void *', []),
        open: lib.func('usb_open', 'void *', ['void *']),
        close: lib.func('usb_close', 'int', ['void *']),
        setConfiguration: lib.func('usb_set_configuration', 'int', ['void *', 'int']),
        claimInterface: lib.func('usb_claim_interface', 'int', ['void *', 'int']),
        releaseInterface: lib.func('usb_release_interface', 'int', ['void *', 'int']),
        getStringSimple: lib.func('usb_get_string_simple', 'int', [
          'void *',
          'int',
          'void *',
          'size_t',
        ]),
        bulkRead: lib.func('usb_bulk_read', 'int', [
          'void *',
          'int',
          'void *',
          'int',
          'int',
        ]) as unknown as TransferFn,
        bulkWrite: lib.func('usb_bulk_write', 'int', [
          'void *',
          'int',
          'void *',
          'int',
          'int',
        ]) as unknown as TransferFn,
        controlMsg: lib.func('usb_control_msg', 'int', [
          'void *',
          'int',
          'int',
          'int',
          'int',
          'void *',
          'int',
          'int',
        ]) as unknown as Api['controlMsg'],
        strerror: lib.func('usb_strerror', 'str', []),
      };
      lib.func('usb_init', 'void', [])();
      api = loaded;
      return loaded;
    } catch (error) {
      errors.push(`${dllPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not load libusb0.dll (${errors.join('; ')})`);
}

function readInterfaces(config: Record<string, unknown>): InterfaceInfo[] {
  const interfaces: InterfaceInfo[] = [];
  const interfacePtr = config.interface as Pointer;
  if (!interfacePtr) {
    return interfaces;
  }
  const count = config.bNumInterfaces as number;
  for (let i = 0; i < count; i += 1) {
    const iface = koffi.decode(interfacePtr, i * koffi.sizeof(Interface), Interface);
    if (!iface.altsetting || iface.num_altsetting < 1) {
      continue;
    }
    const alt = koffi.decode(iface.altsetting, InterfaceDescriptor);
    const endpoints: EndpointInfo[] = [];
    if (alt.endpoint) {
      for (let j = 0; j < alt.bNumEndpoints; j += 1) {
        const ep = koffi.decode(
          alt.endpoint,
          j * koffi.sizeof(EndpointDescriptor),
          EndpointDescriptor,
        );
        endpoints.push({
          address: ep.bEndpointAddress,
          maxPacketSize: ep.wMaxPacketSize,
          bulk: (ep.bmAttributes & TRANSFER_TYPE_MASK) === TRANSFER_TYPE_BULK,
        });
      }
    }
    interfaces.push({
      number: alt.bInterfaceNumber,
      interfaceClass: alt.bInterfaceClass,
      subClass: alt.bInterfaceSubClass,
      protocol: alt.bInterfaceProtocol,
      endpoints,
    });
  }
  return interfaces;
}

/**
 * Picks the DUML bulk interface the same way comm_serialtalk.py does: the
 * configuration string lists the functions of the composite device.
 *   aircraft:           "rndis,…,acm,…"  -> interface number index("acm") + 1
 *   remote controllers: "mtp_bulk_adb"   -> first interface with subclass 0x43
 */
function selectInterface(
  configString: string,
  interfaces: InterfaceInfo[],
): InterfaceInfo | null {
  const usable = (i: InterfaceInfo | undefined): i is InterfaceInfo =>
    !!i &&
    i.endpoints.some((e) => e.bulk && (e.address & ENDPOINT_DIR_IN) !== 0) &&
    i.endpoints.some((e) => e.bulk && (e.address & ENDPOINT_DIR_IN) === 0);

  if (configString.includes(',')) {
    const index = configString.split(',').indexOf('acm');
    if (index < 0) {
      return null;
    }
    const match = interfaces.find((i) => i.number === index + 1);
    return usable(match) ? match : null;
  }
  if (configString.includes('_') && !configString.split('_').includes('bulk')) {
    return null;
  }
  // "mtp_bulk_adb" style, or no readable configuration string at all.
  const match = interfaces.find(
    (i) => i.subClass === DUML_INTERFACE_SUBCLASS && usable(i),
  );
  return match ?? null;
}

/** Identifies a device across enumerations (libusb-win32 device node name). */
function deviceKey(bus: Record<string, unknown>, device: Record<string, unknown>): string {
  return `${String(bus.dirname)}/${String(device.filename)}`;
}

function isEnumerated(lib: Api, key: string): boolean {
  lib.findBusses();
  lib.findDevices();
  let busPtr = lib.getBusses();
  while (busPtr) {
    const bus = koffi.decode(busPtr, Bus);
    let devicePtr = bus.devices as Pointer;
    while (devicePtr) {
      const device = koffi.decode(devicePtr, Device);
      if (deviceKey(bus, device) === key) {
        return true;
      }
      devicePtr = device.next as Pointer;
    }
    busPtr = bus.next as Pointer;
  }
  return false;
}

function isTimeout(code: number, message: string): boolean {
  // libusb-win32 uses its own ETIMEDOUT (116); accept the CRT and Winsock
  // values too in case of a differently built DLL.
  return (
    code === -116 || code === -138 || code === -10060 || /timed? ?out/i.test(message)
  );
}

export interface BulkTransportEvents {
  onData: (data: Buffer) => void;
  /** Called once when the link drops without close() having been called. */
  onLost: (reason: string) => void;
}

export class BulkTransport {
  readonly label: string;
  private closed = false;
  private readLoop: Promise<void> | null = null;

  constructor(
    private readonly lib: Api,
    private readonly handle: Pointer,
    private readonly interfaceNumber: number,
    private readonly epIn: number,
    private readonly epOut: number,
    private readonly readSize: number,
    private readonly key: string,
    /** USB product string reported by the device; may be empty. */
    readonly product: string,
    label: string,
  ) {
    this.label = label;
  }

  /** Whether the control-request probe worked while the device was known good. */
  private probeUsable = false;

  start(events: BulkTransportEvents): void {
    this.readLoop = this.runReadLoop(events);
    void this.probe().then((ok) => {
      this.probeUsable = ok;
    });
  }

  /** Standard GET_STATUS request; fails once the device is gone. */
  private probe(): Promise<boolean> {
    const buffer = Buffer.alloc(2);
    return new Promise<boolean>((resolve) => {
      this.lib.controlMsg.async(
        this.handle,
        0x80,
        0x00,
        0,
        0,
        buffer,
        buffer.length,
        500,
        (err, result) => resolve(!err && result >= 0),
      );
    });
  }

  /**
   * Checks that the device is still plugged in. Reads on an unplugged device
   * do not reliably fail, so this is polled independently of the read loop.
   */
  async isAlive(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    if (!isEnumerated(this.lib, this.key)) {
      return false;
    }
    if (this.probeUsable && !this.closed) {
      return this.probe();
    }
    return true;
  }

  private async runReadLoop(events: BulkTransportEvents): Promise<void> {
    const buffer = Buffer.alloc(this.readSize);
    let errors = 0;
    while (!this.closed) {
      let count: number;
      try {
        count = await new Promise<number>((resolve, reject) => {
          this.lib.bulkRead.async(
            this.handle,
            this.epIn,
            buffer,
            buffer.length,
            READ_TIMEOUT_MS,
            (err, result) => (err ? reject(err) : resolve(result)),
          );
        });
      } catch (error) {
        count = -1;
      }
      if (this.closed) {
        return;
      }
      if (count > 0) {
        errors = 0;
        events.onData(Buffer.from(buffer.subarray(0, count)));
      } else if (count === 0) {
        // Avoid spinning if the driver returns empty reads immediately.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      } else {
        const message = this.lib.strerror();
        if (isTimeout(count, message)) {
          errors = 0; // an idle read is not a disconnected device
          continue;
        }
        errors += 1;
        if (errors >= MAX_CONSECUTIVE_READ_ERRORS) {
          events.onLost(`USB read failed: ${message} (${count})`);
          return;
        }
      }
    }
  }

  write(data: Buffer): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Device is not connected.'));
    }
    return new Promise<void>((resolve, reject) => {
      this.lib.bulkWrite.async(
        this.handle,
        this.epOut,
        data,
        data.length,
        WRITE_TIMEOUT_MS,
        (err, result) => {
          if (err) {
            reject(err);
          } else if (result < 0) {
            reject(new Error(`USB write failed: ${this.lib.strerror()} (${result})`));
          } else {
            resolve();
          }
        },
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Let the in-flight read (at most READ_TIMEOUT_MS) finish before the
    // handle is released underneath it. A read on an unplugged device may
    // never return, so do not wait for it indefinitely.
    await Promise.race([
      this.readLoop?.catch((): void => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    this.lib.releaseInterface(this.handle, this.interfaceNumber);
    this.lib.close(this.handle);
  }
}

export interface ConnectResult {
  transport: BulkTransport | null;
  /** Set when a DJI device was seen but could not be opened. */
  error?: string;
}

/**
 * Looks for a connected DJI product and opens its DUML bulk interface.
 * Returns `{ transport: null }` with no error when nothing is plugged in.
 */
export function connectBulk(dllPaths: string[]): ConnectResult {
  const lib = loadApi(dllPaths);
  lib.findBusses();
  lib.findDevices();

  let lastError: string | undefined;
  let busPtr = lib.getBusses();
  while (busPtr) {
    const bus = koffi.decode(busPtr, Bus);
    let devicePtr = bus.devices as Pointer;
    while (devicePtr) {
      const device = koffi.decode(devicePtr, Device);
      const current = devicePtr;
      devicePtr = device.next as Pointer;

      if (device.descriptor.idVendor !== DJI_VENDOR_ID || !device.config) {
        continue;
      }
      const productId = (device.descriptor.idProduct as number)
        .toString(16)
        .padStart(4, '0');
      const name = `DJI USB 2ca3:${productId}`;

      const handle = lib.open(current);
      if (!handle) {
        lastError = `${name}: could not open (${lib.strerror()})`;
        continue;
      }

      const config = koffi.decode(device.config, ConfigDescriptor);
      const readString = (index: number): string => {
        if (!index) {
          return '';
        }
        const buffer = Buffer.alloc(256);
        const length = lib.getStringSimple(handle, index, buffer, buffer.length);
        return length > 0 ? buffer.toString('latin1', 0, length).trim() : '';
      };
      const configString = readString(config.iConfiguration);
      const product = readString(device.descriptor.iProduct);

      const iface = selectInterface(configString, readInterfaces(config));
      if (!iface) {
        lastError = `${name}: no DUML bulk interface (configuration "${configString}")`;
        lib.close(handle);
        continue;
      }

      let claimed = lib.claimInterface(handle, iface.number);
      if (claimed < 0) {
        lib.setConfiguration(handle, config.bConfigurationValue);
        claimed = lib.claimInterface(handle, iface.number);
      }
      if (claimed < 0) {
        lastError = `${name}: could not claim interface ${iface.number} (${lib.strerror()})`;
        lib.close(handle);
        continue;
      }

      const epIn = iface.endpoints.find(
        (e) => e.bulk && (e.address & ENDPOINT_DIR_IN) !== 0,
      );
      const epOut = iface.endpoints.find(
        (e) => e.bulk && (e.address & ENDPOINT_DIR_IN) === 0,
      );
      if (!epIn || !epOut) {
        lib.releaseInterface(handle, iface.number);
        lib.close(handle);
        continue;
      }

      return {
        transport: new BulkTransport(
          lib,
          handle,
          iface.number,
          epIn.address,
          epOut.address,
          Math.max(epIn.maxPacketSize, 64) * 8,
          deviceKey(bus, device),
          product,
          `${name}, interface ${iface.number}`,
        ),
      };
    }
    busPtr = bus.next as Pointer;
  }

  return { transport: null, error: lastError };
}

// ── Fastboot transport ───────────────────────────────────────────────────────
// A DJI drone in fastboot/recovery re-enumerates as DJI Recovery at VID 0x2CA3
// PID 0x0040 (confirmed from AirForge: "DJI Recovery detected (PID 0040)"),
// exposing a vendor-specific bulk interface — not the standard Android fastboot
// interface class. Some models may instead present a standard fastboot
// interface (class 0xFF, subclass 0x42, protocol 0x03), so both are accepted.
// The fastboot protocol itself lives in fastboot.ts. Transfers are async so a
// large flash does not block the main thread.

const DJI_RECOVERY_PID = 0x0040;
const FASTBOOT_CLASS = 0xff;
const FASTBOOT_SUBCLASS = 0x42;
const FASTBOOT_PROTOCOL = 0x03;

/** True for an interface with a bulk IN and a bulk OUT endpoint. */
function hasBulkPair(i: InterfaceInfo): boolean {
  return (
    i.endpoints.some((e) => e.bulk && (e.address & ENDPOINT_DIR_IN) !== 0) &&
    i.endpoints.some((e) => e.bulk && (e.address & ENDPOINT_DIR_IN) === 0)
  );
}

/** True for the standard Android fastboot interface signature. */
function isAndroidFastboot(i: InterfaceInfo): boolean {
  return i.interfaceClass === FASTBOOT_CLASS && i.subClass === FASTBOOT_SUBCLASS && i.protocol === FASTBOOT_PROTOCOL;
}

/** A claimed fastboot interface: raw bulk in/out, nothing protocol-specific. */
export interface FastbootTransport {
  readonly label: string;
  /** Bulk-OUT some bytes. */
  send(data: Buffer, timeoutMs: number): Promise<void>;
  /** Bulk-IN up to maxLen bytes; resolves with what arrived. */
  recv(maxLen: number, timeoutMs: number): Promise<Buffer>;
  close(): void;
}

export interface FastbootConnectResult {
  transport: FastbootTransport | null;
  error?: string;
}

class Libusb0FastbootTransport implements FastbootTransport {
  constructor(
    private readonly lib: Api,
    private readonly handle: Pointer,
    private readonly interfaceNumber: number,
    private readonly epIn: number,
    private readonly epOut: number,
    readonly label: string,
  ) {}

  send(data: Buffer, timeoutMs: number): Promise<void> {
    const buffer = Buffer.from(data);
    return new Promise((resolve, reject) => {
      this.lib.bulkWrite.async(this.handle, this.epOut, buffer, buffer.length, timeoutMs, (err, result) => {
        if (err || (typeof result === 'number' && result < 0)) {
          reject(new Error(`fastboot write failed (${err ?? result})`));
        } else {
          resolve();
        }
      });
    });
  }

  recv(maxLen: number, timeoutMs: number): Promise<Buffer> {
    const buffer = Buffer.alloc(maxLen);
    return new Promise((resolve, reject) => {
      this.lib.bulkRead.async(this.handle, this.epIn, buffer, maxLen, timeoutMs, (err, result) => {
        if (err || typeof result !== 'number' || result < 0) {
          reject(new Error(`fastboot read failed (${err ?? result})`));
        } else {
          resolve(buffer.subarray(0, result));
        }
      });
    });
  }

  close(): void {
    try {
      this.lib.releaseInterface(this.handle, this.interfaceNumber);
    } catch {
      // closing anyway
    }
    this.lib.close(this.handle);
  }
}

/** Finds and opens a device exposing a standard Android fastboot interface. */
export function connectFastboot(dllPaths: string[]): FastbootConnectResult {
  const lib = loadApi(dllPaths);
  lib.findBusses();
  lib.findDevices();

  let lastError: string | undefined;
  let busPtr = lib.getBusses();
  while (busPtr) {
    const bus = koffi.decode(busPtr, Bus);
    let devicePtr = bus.devices as Pointer;
    while (devicePtr) {
      const device = koffi.decode(devicePtr, Device);
      const current = devicePtr;
      devicePtr = device.next as Pointer;
      if (!device.config) {
        continue;
      }
      const vendor = device.descriptor.idVendor as number;
      const product = device.descriptor.idProduct as number;
      const isDjiRecovery = vendor === DJI_VENDOR_ID && product === DJI_RECOVERY_PID;
      const config = koffi.decode(device.config, ConfigDescriptor);
      const interfaces = readInterfaces(config);
      // On the DJI recovery device take its bulk interface; otherwise require the
      // standard Android fastboot interface signature so we never grab something
      // unrelated on another vendor's device.
      const iface = isDjiRecovery
        ? interfaces.find(hasBulkPair)
        : interfaces.find((i) => isAndroidFastboot(i) && hasBulkPair(i));
      if (!iface) {
        continue;
      }
      const vid = vendor.toString(16).padStart(4, '0');
      const pid = product.toString(16).padStart(4, '0');
      const name = `${isDjiRecovery ? 'DJI recovery' : 'fastboot'} ${vid}:${pid}`;

      const handle = lib.open(current);
      if (!handle) {
        lastError = `${name}: could not open (${lib.strerror()})`;
        continue;
      }
      let claimed = lib.claimInterface(handle, iface.number);
      if (claimed < 0) {
        lib.setConfiguration(handle, config.bConfigurationValue);
        claimed = lib.claimInterface(handle, iface.number);
      }
      if (claimed < 0) {
        lastError = `${name}: could not claim interface ${iface.number} (${lib.strerror()})`;
        lib.close(handle);
        continue;
      }
      const epIn = iface.endpoints.find((e) => e.bulk && (e.address & ENDPOINT_DIR_IN) !== 0);
      const epOut = iface.endpoints.find((e) => e.bulk && (e.address & ENDPOINT_DIR_IN) === 0);
      if (!epIn || !epOut) {
        lib.releaseInterface(handle, iface.number);
        lib.close(handle);
        continue;
      }
      return {
        transport: new Libusb0FastbootTransport(lib, handle, iface.number, epIn.address, epOut.address, name),
      };
    }
    busPtr = bus.next as Pointer;
  }
  return { transport: null, error: lastError ?? 'No device is in fastboot mode.' };
}
