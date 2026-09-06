//! The per-launch proxy capability.
//!
//! A loopback port is not authorization: every local process can reach
//! `127.0.0.1`, and a local client can forge an `Origin` header. The capability
//! is a fresh secret minted at launch, handed only to the packaged webview, and
//! required on every proxied REST, SSE, media, and WebSocket route.
//!
//! It travels in the URL path rather than a header because `EventSource`,
//! `WebSocket`, and `<img>` cannot set headers. That is safe here in a way it
//! is not for the daemon's own token: the capability authorizes talking to the
//! proxy, never to a daemon, it dies with the process, and it is never written
//! to disk or a log.

use subtle::ConstantTimeEq;

/// 32 bytes of CSPRNG output, hex encoded.
const CAPABILITY_BYTES: usize = 32;

#[derive(Clone)]
pub struct Capability(String);

impl Capability {
    pub fn generate() -> Self {
        Self(crate::random::random_hex(CAPABILITY_BYTES))
    }

    /// Only the proxy base handed to the webview may read this back.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Constant-time equality. A byte-by-byte compare of a path segment is a
    /// locally observable oracle, and the comparison is one line either way.
    pub fn matches(&self, candidate: &str) -> bool {
        let expected = self.0.as_bytes();
        let given = candidate.as_bytes();
        // Length is public (it is fixed by CAPABILITY_BYTES); guard on it, then
        // compare the contents without an early exit.
        if expected.len() != given.len() {
            return false;
        }
        expected.ct_eq(given).into()
    }
}

/// Never let a capability reach a log line, a panic message, or a serialized
/// payload by accident.
impl std::fmt::Debug for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Capability(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::Capability;

    #[test]
    fn matches_only_itself() {
        let capability = Capability::generate();
        assert!(capability.matches(capability.expose()));
        assert!(!capability.matches(""));
        assert!(!capability.matches("nope"));
        assert!(!capability.matches(&format!("{}0", capability.expose())));
        assert!(!capability.matches(Capability::generate().expose()));
    }

    #[test]
    fn a_near_miss_is_rejected() {
        let capability = Capability::generate();
        let mut wrong = capability.expose().to_string();
        let last = wrong.pop().expect("capability is non-empty");
        wrong.push(if last == '0' { '1' } else { '0' });
        assert!(!capability.matches(&wrong));
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let capability = Capability::generate();
        let rendered = format!("{capability:?}");
        assert_eq!(rendered, "Capability(<redacted>)");
        assert!(!rendered.contains(capability.expose()));
    }
}
