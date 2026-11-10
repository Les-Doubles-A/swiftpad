//! Dates sans dépendance (UTC ; l'heure locale est gérée par l'interface).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> f64 {
    system_time_ms(SystemTime::now())
}

/// Millisecondes depuis l'époque Unix (négatif avant 1970).
pub fn system_time_ms(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64() * 1000.0,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    }
}

/// Nanosecondes depuis l'époque Unix (négatif avant 1970), exact.
pub fn system_time_ns(t: SystemTime) -> i128 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    }
}

/// Conversion jours depuis 1970-01-01 → (année, mois, jour), algorithme de H. Hinnant.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// « 2026-10-12T17:05:03Z ».
pub fn iso_utc(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Horodatage compact pour des noms de fichiers (« 20261012-170503 »).
pub fn compact_utc(ms: f64) -> String {
    iso_utc(ms).replace(['-', ':'], "").replace('T', "-").trim_end_matches('Z').to_string()
}

pub fn now_local_iso() -> String {
    iso_utc(now_ms()).trim_end_matches('Z').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(iso_utc(0.0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400_000.0), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_791_824_703_000.0), "2026-10-12T17:05:03Z");
        assert_eq!(iso_utc(-86_400_000.0), "1969-12-31T00:00:00Z");
        assert_eq!(compact_utc(1_791_824_703_000.0), "20261012-170503");
    }
}
