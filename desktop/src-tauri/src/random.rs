//! The one place this crate asks the OS for randomness.

/// Hex-encode `len` fresh CSPRNG bytes.
///
/// `getrandom` is infallible on macOS in practice; a failure here means the
/// system entropy source is gone, and continuing with a predictable capability
/// or connection ID would be worse than stopping.
pub fn random_hex(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("system CSPRNG unavailable");
    let mut out = String::with_capacity(len * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).expect("nibble is hex"));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("nibble is hex"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::random_hex;

    #[test]
    fn produces_lowercase_hex_of_the_requested_width() {
        let value = random_hex(16);
        assert_eq!(value.len(), 32);
        assert!(value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn does_not_repeat() {
        assert_ne!(random_hex(32), random_hex(32));
    }
}
