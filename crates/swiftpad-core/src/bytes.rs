//! Recherche d'octets rapide (technique SWAR, 8 octets à la fois), sans
//! dépendance. Utilisé pour les fins de ligne et la recherche dans les
//! fichiers volumineux.

const LO: u64 = 0x0101_0101_0101_0101;
const HI: u64 = 0x8080_8080_8080_8080;

#[inline(always)]
fn has_zero(x: u64) -> bool {
    x.wrapping_sub(LO) & !x & HI != 0
}

#[inline(always)]
fn splat(b: u8) -> u64 {
    LO.wrapping_mul(b as u64)
}

#[inline(always)]
fn word(chunk: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(chunk);
    u64::from_le_bytes(a)
}

/// Position du premier octet `b`.
pub fn memchr(b: u8, hay: &[u8]) -> Option<usize> {
    let s = splat(b);
    let mut i = 0;
    let n = hay.len();
    while i + 8 <= n {
        if has_zero(word(&hay[i..i + 8]) ^ s) {
            break;
        }
        i += 8;
    }
    hay[i..].iter().position(|&x| x == b).map(|p| p + i)
}

/// Position du premier octet égal à `b1` ou `b2`.
pub fn memchr2(b1: u8, b2: u8, hay: &[u8]) -> Option<usize> {
    let s1 = splat(b1);
    let s2 = splat(b2);
    let mut i = 0;
    let n = hay.len();
    while i + 8 <= n {
        let w = word(&hay[i..i + 8]);
        if has_zero(w ^ s1) || has_zero(w ^ s2) {
            break;
        }
        i += 8;
    }
    hay[i..].iter().position(|&x| x == b1 || x == b2).map(|p| p + i)
}

/// Nombre d'occurrences de `b` (boucle vectorisée par le compilateur).
pub fn count(b: u8, hay: &[u8]) -> usize {
    hay.iter().filter(|&&x| x == b).count()
}

/// Première occurrence de `needle` dans `hay`.
pub fn find(needle: &[u8], hay: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > hay.len() {
        return None;
    }
    let first = needle[0];
    let last_start = hay.len() - needle.len();
    let mut i = 0;
    while i <= last_start {
        match memchr(first, &hay[i..=last_start]) {
            None => return None,
            Some(p) => {
                let at = i + p;
                if &hay[at..at + needle.len()] == needle {
                    return Some(at);
                }
                i = at + 1;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memchr_matches_naive() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();
        for b in [0u8, 1, 7, 13, 200, 250, 255] {
            for start in [0, 1, 5, 9, 500] {
                let h = &data[start..];
                assert_eq!(memchr(b, h), h.iter().position(|&x| x == b), "b={b} start={start}");
                assert_eq!(memchr2(b, 13, h), h.iter().position(|&x| x == b || x == 13));
                assert_eq!(count(b, h), h.iter().filter(|&&x| x == b).count());
            }
        }
        assert_eq!(memchr(b'x', b""), None);
    }

    #[test]
    fn find_substring() {
        assert_eq!(find(b"abc", b"xxabxabcx"), Some(5));
        assert_eq!(find(b"abc", b"ab"), None);
        assert_eq!(find(b"", b"ab"), Some(0));
        assert_eq!(find(b"zz", b"azazz"), Some(3));
        let big = vec![b'a'; 10_000];
        let mut big2 = big.clone();
        big2.extend_from_slice(b"needle");
        assert_eq!(find(b"needle", &big2), Some(10_000));
        assert_eq!(find(b"needle", &big), None);
    }
}
