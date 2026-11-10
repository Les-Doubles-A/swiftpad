//! Fonctions propres au système. Sous Windows, une FFI minimale déclarée à la
//! main remplace la caisse `windows-sys` pour garder le noyau sans
//! dépendance : seules quatre fonctions Win32 documentées sont utilisées
//! (`ReplaceFileW`, `GetCurrentProcess`, `GetProcessTimes`,
//! `K32GetProcessMemoryInfo`).

use std::io;
use std::path::Path;

/// Informations sur le processus courant (mesures de performance).
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessInfo {
    /// Date de création du processus (ms depuis l'époque Unix), si connue.
    pub started_at_ms: Option<f64>,
    /// Mémoire résidente (octets) : « working set » sous Windows, VmRSS sous Linux.
    pub resident_bytes: Option<u64>,
    /// Pic de mémoire résidente (octets), si connu.
    pub peak_resident_bytes: Option<u64>,
}

#[cfg(windows)]
mod win {
    #![allow(non_snake_case, non_camel_case_types, clippy::upper_case_acronyms)]
    use std::ffi::c_void;

    pub type BOOL = i32;
    pub type HANDLE = *mut c_void;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct FILETIME {
        pub dwLowDateTime: u32,
        pub dwHighDateTime: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct PROCESS_MEMORY_COUNTERS {
        pub cb: u32,
        pub PageFaultCount: u32,
        pub PeakWorkingSetSize: usize,
        pub WorkingSetSize: usize,
        pub QuotaPeakPagedPoolUsage: usize,
        pub QuotaPagedPoolUsage: usize,
        pub QuotaPeakNonPagedPoolUsage: usize,
        pub QuotaNonPagedPoolUsage: usize,
        pub PagefileUsage: usize,
        pub PeakPagefileUsage: usize,
    }

    pub const REPLACEFILE_IGNORE_MERGE_ERRORS: u32 = 0x0000_0002;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn ReplaceFileW(
            lpReplacedFileName: *const u16,
            lpReplacementFileName: *const u16,
            lpBackupFileName: *const u16,
            dwReplaceFlags: u32,
            lpExclude: *mut c_void,
            lpReserved: *mut c_void,
        ) -> BOOL;
        pub fn GetCurrentProcess() -> HANDLE;
        pub fn GetProcessTimes(
            hProcess: HANDLE,
            lpCreationTime: *mut FILETIME,
            lpExitTime: *mut FILETIME,
            lpKernelTime: *mut FILETIME,
            lpUserTime: *mut FILETIME,
        ) -> BOOL;
        pub fn K32GetProcessMemoryInfo(Process: HANDLE, ppsmemCounters: *mut PROCESS_MEMORY_COUNTERS, cb: u32) -> BOOL;
    }

    pub fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
}

/// Remplace `target` par `replacement` de façon atomique en conservant les
/// attributs, la date de création et les droits (ACL) de `target`
/// (`ReplaceFileW`). Une copie de secours temporaire protège le contenu
/// d'origine si le second renommage échouait.
#[cfg(windows)]
pub fn replace_file(target: &Path, replacement: &Path, backup: &Path) -> io::Result<()> {
    let t = win::wide(verbatim(target).as_os_str());
    let r = win::wide(verbatim(replacement).as_os_str());
    let b = win::wide(verbatim(backup).as_os_str());
    // SAFETY : chaînes UTF-16 terminées par zéro, valides pendant l'appel.
    let ok = unsafe {
        win::ReplaceFileW(
            t.as_ptr(),
            r.as_ptr(),
            b.as_ptr(),
            win::REPLACEFILE_IGNORE_MERGE_ERRORS,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok != 0 {
        let _ = std::fs::remove_file(backup);
        return Ok(());
    }
    let err = io::Error::last_os_error();
    // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 (1177) : l'original a été renommé en
    // copie de secours mais le remplacement n'a pas pu prendre sa place.
    if err.raw_os_error() == Some(1177) && backup.exists() && !target.exists() {
        let _ = std::fs::rename(backup, target);
    }
    Err(err)
}

/// Sous Windows, chemins longs : préfixe `\\?\` (le chemin doit être absolu).
#[cfg(windows)]
fn verbatim(p: &Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if s.len() < 240 || s.starts_with(r"\\?\") || !p.is_absolute() {
        return p.to_path_buf();
    }
    std::path::PathBuf::from(crate::paths::to_verbatim_str(&crate::paths::lexical_normalize(p).to_string_lossy()))
}

#[cfg(not(windows))]
pub fn replace_file(target: &Path, replacement: &Path, _backup: &Path) -> io::Result<()> {
    // rename(2) est atomique et remplace la cible ; les droits ont été copiés
    // sur le fichier temporaire par l'appelant.
    std::fs::rename(replacement, target)
}

/// Erreurs pour lesquelles `ReplaceFileW` n'est pas gérée par le volume
/// (certains systèmes de fichiers réseau ou FAT) et où un simple renommage
/// reste acceptable.
pub fn replace_unsupported(err: &io::Error) -> bool {
    cfg!(windows) && matches!(err.raw_os_error(), Some(1) | Some(50) | Some(87))
}

#[cfg(windows)]
pub fn process_info() -> ProcessInfo {
    let mut info = ProcessInfo::default();
    // SAFETY : pseudo-handle du processus courant, structures initialisées.
    unsafe {
        let h = win::GetCurrentProcess();
        let (mut c, mut e, mut k, mut u) = (win::FILETIME::default(), win::FILETIME::default(), win::FILETIME::default(), win::FILETIME::default());
        if win::GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
            let ticks = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
            // 100 ns depuis 1601 → ms depuis 1970.
            info.started_at_ms = Some((ticks as f64 - 116_444_736_000_000_000.0) / 10_000.0);
        }
        let mut pmc = win::PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<win::PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
        if win::K32GetProcessMemoryInfo(h, &mut pmc, pmc.cb) != 0 {
            info.resident_bytes = Some(pmc.WorkingSetSize as u64);
            info.peak_resident_bytes = Some(pmc.PeakWorkingSetSize as u64);
        }
    }
    info
}

#[cfg(target_os = "linux")]
pub fn process_info() -> ProcessInfo {
    let mut info = ProcessInfo::default();
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            let kb = |l: &str| l.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()).map(|v| v * 1024);
            if line.starts_with("VmRSS:") {
                info.resident_bytes = kb(line);
            } else if line.starts_with("VmHWM:") {
                info.peak_resident_bytes = kb(line);
            }
        }
    }
    // Champ 22 de /proc/self/stat : démarrage en tops d'horloge depuis le
    // boot (CLK_TCK = 100 sur Linux x86-64), btime dans /proc/stat.
    let stat = std::fs::read_to_string("/proc/self/stat").ok();
    let btime = std::fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("btime ")).and_then(|l| l[6..].trim().parse::<f64>().ok()));
    if let (Some(stat), Some(btime)) = (stat, btime) {
        if let Some(end) = stat.rfind(')') {
            let fields: Vec<&str> = stat[end + 2..].split_whitespace().collect();
            // Après « (comm) », le champ 3 est en position 0 : le 22e est en 19.
            if let Some(ticks) = fields.get(19).and_then(|v| v.parse::<f64>().ok()) {
                info.started_at_ms = Some((btime + ticks / 100.0) * 1000.0);
            }
        }
    }
    info
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn process_info() -> ProcessInfo {
    ProcessInfo::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn process_info_linux() {
        let p = process_info();
        assert!(p.resident_bytes.unwrap_or(0) > 0);
        let start = p.started_at_ms.expect("date de démarrage");
        let now = crate::time::now_ms();
        assert!(start <= now + 50.0 && now - start < 3_600_000.0, "start={start} now={now}");
    }
}
