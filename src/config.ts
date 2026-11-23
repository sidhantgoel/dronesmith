/**
 * DJI aircraft firmware manifest (cfg.sig), read over DUML with GENERAL 0x4F.
 *
 * The device returns a signed config blob: a binary signature header followed
 * by an XML manifest listing the formal firmware version, the anti-rollback
 * level and every firmware module. The full blob must be read to completion
 * (until the device reports zero bytes remaining) for the XML to be well
 * formed; this parser requires a complete <dji>…</dji> document and parses it
 * with a real XML parser rather than tolerating truncation.
 *
 * Read-only. The anti-rollback level is surfaced to the firmware flasher as a
 * brick-prevention warning.
 */
import { XMLParser } from 'fast-xml-parser';

export interface ManifestModule {
  /** Module id, e.g. "1100". */
  id: string;
  /** Human name, e.g. "Battery". */
  name: string;
  /** Firmware version, e.g. "10.75.00.21". */
  version: string;
  /** Firmware size in bytes, when stated. */
  size?: number;
}

export interface FirmwareManifest {
  /** Device/model id, e.g. "wm162". */
  deviceId?: string;
  /** Formal firmware version, e.g. "01.00.0900". */
  formalVersion?: string;
  /** Release version string. */
  releaseVersion?: string;
  /** Anti-rollback counter — flashing below this bricks the aircraft. */
  antiRollback?: number;
  /** Whether anti-rollback enforcement is on. */
  enforce?: boolean;
  /** Build date (as stated, e.g. "2024/07/19"). */
  from?: string;
  /** Expiry date (as stated, e.g. "2025/07/19"). */
  expire?: string;
  /** Distinct firmware modules, de-duplicated by id/name/version. */
  modules: ManifestModule[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'module' || name === 'release',
});

const str = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  const s = String(value);
  return s.length > 0 ? s : undefined;
};

const intOf = (value: unknown): number | undefined => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Extracts the complete <dji>…</dji> document from a config blob and parses it.
 * Returns null when no complete document is present (an incomplete read), so a
 * truncated blob yields no manifest rather than a partial one.
 */
export function parseConfig(bytes: Uint8Array): FirmwareManifest | null {
  const text = Buffer.from(bytes).toString('latin1');
  const start = text.indexOf('<dji');
  const end = text.indexOf('</dji>', start);
  if (start < 0 || end < 0) {
    return null; // no complete document — the read did not finish
  }
  const xml = text.slice(start, end + '</dji>'.length);

  let doc: {
    dji?: {
      device?: {
        id?: string;
        firmware?: { formal?: string; release?: unknown[] };
      };
    };
  };
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  const device = doc?.dji?.device;
  if (!device) {
    return null;
  }
  const firmware = device.firmware ?? {};
  const release = (firmware.release?.[0] ?? {}) as Record<string, unknown> & {
    module?: Record<string, unknown>[];
  };

  const seen = new Set<string>();
  const modules: ManifestModule[] = [];
  for (const raw of release.module ?? []) {
    const id = str(raw.id) ?? '';
    const name = str(raw.name) ?? '';
    const version = str(raw.version) ?? '';
    const key = `${id}|${name}|${version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    modules.push({ id, name: name || id || '—', version: version || '—', size: intOf(raw.size) });
  }

  const enforce = str(release.enforce);

  return {
    deviceId: str(device.id),
    formalVersion: str(firmware.formal),
    releaseVersion: str(release.version),
    antiRollback: intOf(release.antirollback),
    enforce: enforce != null ? enforce !== '0' : undefined,
    from: str(release.from),
    expire: str(release.expire),
    modules,
  };
}
