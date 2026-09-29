//! The authenticated `/api/capabilities` handshake.
//!
//! Nothing is saved, retargeted, or re-credentialed until this succeeds. It is
//! also where a daemon's instance identity is pinned: the proxy re-checks that
//! same value immediately before every later write or terminal handshake.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::urls::join_upstream;

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The most bytes read from an identity or compatibility answer.
///
/// A daemon's `/api/capabilities` is a few hundred bytes. The address being
/// probed is not trusted yet, so an endless body must not become an endless
/// allocation: past this size the answer is not a Wisp daemon identity.
pub const MAX_IDENTITY_BODY_BYTES: usize = 64 * 1024;

/// Why a bounded body read stopped before the body ended.
#[derive(Debug, thiserror::Error)]
pub enum BodyReadError {
    #[error("the response is larger than {MAX_IDENTITY_BODY_BYTES} bytes")]
    TooLarge,
    #[error("the response did not finish in time")]
    TimedOut,
    #[error("the response could not be read: {0}")]
    Read(#[from] reqwest::Error),
}

/// Read at most `limit` bytes of `response`, and stop at `deadline`.
///
/// `Response::json` buffers whatever arrives for as long as it keeps
/// arriving. This stops at whichever comes first: the end of the body, the
/// byte limit, or the deadline.
pub async fn read_capped(
    mut response: reqwest::Response,
    limit: usize,
    deadline: tokio::time::Instant,
) -> Result<Vec<u8>, BodyReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(BodyReadError::TooLarge);
    }
    let mut body = Vec::new();
    loop {
        let chunk = tokio::time::timeout_at(deadline, response.chunk())
            .await
            .map_err(|_| BodyReadError::TimedOut)??;
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(BodyReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
}

/// Native shell/daemon contracts this Desktop build actually implements.
///
/// Keep this as a set even while it contains one value: a protocol transition
/// must first ship a Desktop that genuinely implements both versions. Adding a
/// number here without matching request/response behavior is not compatibility.
pub const SUPPORTED_API_PROTOCOL_VERSIONS: &[u32] = &[1];

pub fn supports_api_protocol(version: u32) -> bool {
    SUPPORTED_API_PROTOCOL_VERSIONS.contains(&version)
}

fn supported_api_protocols() -> String {
    SUPPORTED_API_PROTOCOL_VERSIONS
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn is_instance_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 || !value.is_ascii() || value.contains('+') {
        return false;
    }
    let (core, suffix) = value
        .split_once('-')
        .map_or((value, None), |(head, tail)| (head, Some(tail)));
    let mut parts = core.split('.');
    let numeric = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    }) && parts.next().is_none();
    numeric
        && suffix.is_none_or(|tail| {
            !tail.is_empty()
                && tail
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        })
}

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("could not reach that daemon: {0}")]
    Unreachable(String),
    #[error("that token was rejected — check `wisp token` on the daemon host")]
    Unauthorized,
    #[error("that address answered with status {0}, which is not a Wisp daemon API")]
    Refused(u16),
    #[error("that address answered, but not with a Wisp daemon identity")]
    Malformed,
    #[error("that daemon uses API protocol {seen}, but this Desktop supports {supported}; update Desktop when the daemon is newer, or update the daemon out of band when it is older", supported = supported_api_protocols())]
    IncompatibleProtocol { seen: u32 },
}

/// The subset of `/api/capabilities` the desktop shell acts on. Extra fields
/// are ignored so a newer daemon stays connectable.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonIdentity {
    pub instance_id: String,
    #[serde(default)]
    pub api_protocol_version: u32,
    #[serde(default)]
    pub version: String,
}

pub async fn probe(
    client: &reqwest::Client,
    base: &Url,
    token: &str,
) -> Result<DaemonIdentity, ProbeError> {
    let url = join_upstream(base, "api/capabilities", None)
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;
    // One budget for the whole exchange, body included.
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let response = client
        .get(url)
        .header(
            http::header::AUTHORIZATION,
            format!("Bearer {}", token.trim()),
        )
        .timeout(PROBE_TIMEOUT)
        .send()
        .await
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;

    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(ProbeError::Unauthorized),
        other => return Err(ProbeError::Refused(other)),
    }

    let body = read_capped(response, MAX_IDENTITY_BODY_BYTES, deadline)
        .await
        .map_err(|_| ProbeError::Malformed)?;
    let identity: DaemonIdentity =
        serde_json::from_slice(&body).map_err(|_| ProbeError::Malformed)?;
    if !is_instance_id(&identity.instance_id) || !is_version(&identity.version) {
        return Err(ProbeError::Malformed);
    }
    if !supports_api_protocol(identity.api_protocol_version) {
        return Err(ProbeError::IncompatibleProtocol {
            seen: identity.api_protocol_version,
        });
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::{is_instance_id, DaemonIdentity};

    #[test]
    fn identity_parses_a_daemon_payload_and_tolerates_new_fields() {
        let identity: DaemonIdentity = serde_json::from_str(
            r#"{"apiProtocolVersion":1,"instanceId":"00000000-0000-4000-8000-000000000001","version":"0.4.0","commit":"abc","dirty":false,"capabilities":{"terminal":true},"somethingNew":1}"#,
        )
        .expect("parses");
        assert_eq!(identity.instance_id, "00000000-0000-4000-8000-000000000001");
        assert_eq!(identity.api_protocol_version, 1);
        assert_eq!(identity.version, "0.4.0");
    }

    #[test]
    fn a_payload_without_an_instance_id_is_not_a_daemon() {
        let identity: DaemonIdentity =
            serde_json::from_str(r#"{"instanceId":""}"#).expect("parses");
        assert!(identity.instance_id.is_empty());
    }

    #[test]
    fn daemon_instance_ids_are_canonical_uuid_shapes() {
        assert!(is_instance_id("00000000-0000-4000-8000-000000000001"));
        assert!(!is_instance_id("synthetic-token-000000000000000"));
        assert!(!is_instance_id("00000000-0000-0000-0000-000000000000"));
        assert!(!is_instance_id(&"a".repeat(1_000_000)));
    }
}
