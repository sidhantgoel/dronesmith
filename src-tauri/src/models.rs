//! DJI aircraft model table and factory-code detection. Each aircraft reports a
//! factory code such as "WM260" in its version-inquiry reply; matching it
//! against this table yields the name and a few service-relevant attributes.

#[derive(Clone, Copy, Debug)]
pub struct DroneModel {
    pub code: &'static str,
    pub name: &'static str,
    /// Raw DUML address (type | index << 5) that answers the serial request.
    pub serial_receiver: u8,
    pub serial_payload: u8,
    pub camera_count: u8,
    pub needs_factory_mode: bool,
}

const fn m(
    code: &'static str,
    name: &'static str,
    serial_receiver: u8,
    camera_count: u8,
    needs_factory_mode: bool,
) -> DroneModel {
    DroneModel { code, name, serial_receiver, serial_payload: 0x04, camera_count, needs_factory_mode }
}

pub static DRONE_MODELS: &[DroneModel] = &[
    m("WM1605", "DJI Mini SE", 195, 1, false),
    m("WM160", "DJI Mini", 195, 1, false),
    m("WM1615", "DJI Mini 2 SE", 195, 1, false),
    m("WM161", "DJI Mini 2", 195, 1, false),
    m("WM163", "DJI Mini 3", 195, 1, false),
    m("WA1617", "DJI Mini 4K", 195, 1, false),
    m("WM162", "DJI Mini 3 Pro", 104, 1, false),
    m("WA140", "DJI Mini 4 Pro", 104, 1, false),
    m("WA150", "DJI Mini 5 Pro", 104, 1, true),
    m("WM169", "DJI Avata", 104, 1, false),
    m("WA520", "DJI Avata 2", 104, 1, false),
    m("WA521", "DJI Neo", 104, 1, true),
    m("WA020", "DJI Neo 2", 104, 1, false),
    m("WA141", "DJI Flip", 104, 1, false),
    m("WM231", "DJI Air 2", 104, 1, false),
    m("WM232", "DJI Air 2S", 104, 1, false),
    m("WA233", "DJI Air 3", 104, 2, false),
    m("WA234", "DJI Air 3S", 104, 2, false),
    m("WM240", "DJI Mavic 2", 104, 1, false),
    m("WM245", "DJI Mavic 2 Enterprise", 104, 1, false),
    m("WM246", "DJI Mavic 2 Enterprise Dual", 104, 1, false),
    m("WM247", "DJI Mavic 2 Enterprise Advanced", 104, 1, false),
    m("WM2605", "DJI Mavic 3 Classic", 143, 1, false),
    m("WM260", "DJI Mavic 3", 143, 2, false),
    m("WM261", "DJI Mavic 3 Pro", 143, 3, false),
    m("WM265E", "DJI Mavic 3 Enterprise", 104, 2, false),
    m("WM265T", "DJI Mavic 3 Thermal", 104, 3, false),
    m("WM265M", "DJI Mavic 3 Multispectral", 104, 1, false),
    m("WA345T", "DJI Matrice 4 Thermal", 104, 3, false),
    m("WA345E", "DJI Matrice 4 Enterprise", 104, 2, false),
    m("EA220E", "DJI Matrice 3 Enterprise Dock", 104, 2, false),
    m("EA220T", "DJI Matrice 3 Thermal Dock", 104, 3, false),
    m("WA32222T", "DJI Osmo Pocket 3", 104, 1, false),
    m("WA341", "DJI Mavic 4 Pro", 104, 3, true),
];

/// Finds the model whose factory code appears in `text`, preferring the most
/// specific (longest) code, case-insensitive. None when no known code is present.
pub fn match_model_code(text: &str) -> Option<&'static DroneModel> {
    if text.is_empty() {
        return None;
    }
    let haystack = text.to_uppercase();
    let mut best: Option<&'static DroneModel> = None;
    for model in DRONE_MODELS {
        if haystack.contains(model.code) && best.map_or(true, |b| model.code.len() > b.code.len()) {
            best = Some(model);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_most_specific_code() {
        assert_eq!(match_model_code("WM1615 FC").unwrap().name, "DJI Mini 2 SE");
        assert_eq!(match_model_code("hw WM161 rev").unwrap().name, "DJI Mini 2");
        assert_eq!(match_model_code("wm162_e1e").unwrap().name, "DJI Mini 3 Pro");
        assert_eq!(match_model_code("WM260").unwrap().name, "DJI Mavic 3");
        assert!(match_model_code("nothing here").is_none());
    }
}
