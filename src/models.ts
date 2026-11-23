/**
 * DJI aircraft model table and factory-code detection.
 *
 * Ported from the model table and detection method used by the reference tool
 * (its bundled Data/models.json and the GENERAL VersionInquiry probe in its
 * flashing engine). Each aircraft reports a factory code such as "WM260" in
 * the ASCII of its version-inquiry reply; matching that code against this
 * table yields the marketing name and a few service-relevant attributes.
 *
 * The detection itself is read-only: it is the same GENERAL (cmd 0x01)
 * version inquiry this app already sends, just mapped to a friendly name.
 */

export interface DroneModel {
  /** Factory code as it appears in the device's version string, e.g. "WM260". */
  code: string;
  /** Marketing name, e.g. "DJI Mavic 3". */
  name: string;
  /**
   * Raw DUML address (type | index << 5) that answers the serial-number
   * request (GENERAL 0x51) for this model.
   */
  serialReceiver: number;
  /** Payload byte sent with the serial-number request. */
  serialPayload: number;
  /** Number of cameras the aircraft carries. */
  cameraCount: number;
  /** Whether servicing this model requires entering factory mode first. */
  needsFactoryMode: boolean;
}

/**
 * The 34 models the reference tool recognises. Order matters only for readability;
 * {@link matchModelCode} sorts by code length so that longer codes (WM1615)
 * win over their own prefixes (WM161).
 */
export const DRONE_MODELS: readonly DroneModel[] = [
  { code: 'WM1605', name: 'DJI Mini SE', serialReceiver: 195, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM160', name: 'DJI Mini', serialReceiver: 195, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM1615', name: 'DJI Mini 2 SE', serialReceiver: 195, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM161', name: 'DJI Mini 2', serialReceiver: 195, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM163', name: 'DJI Mini 3', serialReceiver: 195, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA1617', name: 'DJI Mini 4K', serialReceiver: 195, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM162', name: 'DJI Mini 3 Pro', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA140', name: 'DJI Mini 4 Pro', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA150', name: 'DJI Mini 5 Pro', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: true },
  { code: 'WM169', name: 'DJI Avata', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA520', name: 'DJI Avata 2', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA521', name: 'DJI Neo', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: true },
  { code: 'WA020', name: 'DJI Neo 2', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA141', name: 'DJI Flip', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM231', name: 'DJI Air 2', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM232', name: 'DJI Air 2S', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA233', name: 'DJI Air 3', serialReceiver: 104, serialPayload: 0x04, cameraCount: 2, needsFactoryMode: false },
  { code: 'WA234', name: 'DJI Air 3S', serialReceiver: 104, serialPayload: 0x04, cameraCount: 2, needsFactoryMode: false },
  { code: 'WM240', name: 'DJI Mavic 2', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM245', name: 'DJI Mavic 2 Enterprise', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM246', name: 'DJI Mavic 2 Enterprise Dual', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM247', name: 'DJI Mavic 2 Enterprise Advanced', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM2605', name: 'DJI Mavic 3 Classic', serialReceiver: 143, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WM260', name: 'DJI Mavic 3', serialReceiver: 143, serialPayload: 0x04, cameraCount: 2, needsFactoryMode: false },
  { code: 'WM261', name: 'DJI Mavic 3 Pro', serialReceiver: 143, serialPayload: 0x04, cameraCount: 3, needsFactoryMode: false },
  { code: 'WM265E', name: 'DJI Mavic 3 Enterprise', serialReceiver: 104, serialPayload: 0x04, cameraCount: 2, needsFactoryMode: false },
  { code: 'WM265T', name: 'DJI Mavic 3 Thermal', serialReceiver: 104, serialPayload: 0x04, cameraCount: 3, needsFactoryMode: false },
  { code: 'WM265M', name: 'DJI Mavic 3 Multispectral', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA345T', name: 'DJI Matrice 4 Thermal', serialReceiver: 104, serialPayload: 0x04, cameraCount: 3, needsFactoryMode: false },
  { code: 'WA345E', name: 'DJI Matrice 4 Enterprise', serialReceiver: 104, serialPayload: 0x04, cameraCount: 2, needsFactoryMode: false },
  { code: 'EA220E', name: 'DJI Matrice 3 Enterprise Dock', serialReceiver: 104, serialPayload: 0x04, cameraCount: 2, needsFactoryMode: false },
  { code: 'EA220T', name: 'DJI Matrice 3 Thermal Dock', serialReceiver: 104, serialPayload: 0x04, cameraCount: 3, needsFactoryMode: false },
  { code: 'WA32222T', name: 'DJI Osmo Pocket 3', serialReceiver: 104, serialPayload: 0x04, cameraCount: 1, needsFactoryMode: false },
  { code: 'WA341', name: 'DJI Mavic 4 Pro', serialReceiver: 104, serialPayload: 0x04, cameraCount: 3, needsFactoryMode: true },
];

// Longest codes first so that, e.g., a device reporting "WM1615" matches
// DJI Mini 2 SE rather than DJI Mini 2 ("WM161").
const MODELS_BY_SPECIFICITY = [...DRONE_MODELS].sort(
  (a, b) => b.code.length - a.code.length,
);

/**
 * Finds the DJI model whose factory code appears in `text` (the ASCII of a
 * version-inquiry reply or a module's hardware string). Matching is
 * case-insensitive and prefers the most specific code. Returns null when no
 * known code is present.
 */
export function matchModelCode(text: string | undefined | null): DroneModel | null {
  if (!text) {
    return null;
  }
  const haystack = text.toUpperCase();
  for (const model of MODELS_BY_SPECIFICITY) {
    if (haystack.includes(model.code)) {
      return model;
    }
  }
  return null;
}
